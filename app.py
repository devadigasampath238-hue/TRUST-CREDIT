"""
Trust Credit - Flask Backend (hardened for production)
--------------------------------------------------------
- Saves loan applications submitted from the website into PostgreSQL
- Admin login protected with a HASHED password (not plain text),
  a login-attempt limiter, and secure session cookie settings
- Serves the banner images from static/slides as a JSON API for the
  frontend slideshow

CONFIGURATION (set these as environment variables before running -
see the "How to run" section at the bottom of this file):

    ADMIN_USERNAME       - admin login username        (default: admin)
    ADMIN_PASSWORD_HASH  - output of hash_password.py   (required in production)
    SECRET_KEY           - random string, keep it secret (required in production)
    FLASK_ENV            - set to "production" when deployed publicly

Run locally for testing:
    pip install flask
    python app.py

Run in production (see deployment guide provided separately):
    pip install flask gunicorn
    gunicorn -w 2 -b 0.0.0.0:8000 app:app
"""

import os
import secrets
import psycopg
from psycopg.rows import dict_row
import time
from datetime import datetime
from functools import wraps

from flask import (
    Flask, request, jsonify, render_template,
    redirect, url_for, session, g
)
from werkzeug.security import check_password_hash, generate_password_hash

# --------------------------------------------------------------------------
# Basic setup
# --------------------------------------------------------------------------

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATABASE_URL = os.environ.get("DATABASE_URL")
SLIDES_DIR = os.path.join(BASE_DIR, "static", "slides")

app = Flask(__name__)

# --------------------------------------------------------------------------
# Security configuration
# --------------------------------------------------------------------------

IS_PRODUCTION = os.environ.get("FLASK_ENV") == "production"

# Secret key: MUST be set via environment variable in production.
# For local testing only, we fall back to a random key generated at startup
# (this means sessions won't survive a server restart locally - that's fine
# for testing, but in production always set SECRET_KEY explicitly).
app.secret_key = os.environ.get("SECRET_KEY") or os.urandom(32).hex()

# Admin credentials.
# Username can just be an env var. Password is stored as a HASH, never
# as plain text, so even if someone reads your server files they can't
# see the real password.
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD_HASH = os.environ.get("ADMIN_PASSWORD_HASH")

if IS_PRODUCTION and ADMIN_USERNAME == "admin":
    print("WARNING: ADMIN_USERNAME is still the default 'admin'. Set a "
          "custom ADMIN_USERNAME environment variable in Render - 'admin' "
          "is the first username every attacker tries.")

if not ADMIN_PASSWORD_HASH:
    # Local-testing fallback ONLY: default password is "admin123".
    # In production you should always set ADMIN_PASSWORD_HASH yourself
    # (see hash_password.py in this folder).
    ADMIN_PASSWORD_HASH = generate_password_hash("admin123")
    if IS_PRODUCTION:
        print("WARNING: ADMIN_PASSWORD_HASH is not set! Using an insecure "
              "default. Set it via an environment variable before going live.")

# Secure session cookies (cookie can't be read by JS, only sent over HTTPS
# in production, and not sent along with cross-site requests).
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=IS_PRODUCTION,   # requires HTTPS in production
    PERMANENT_SESSION_LIFETIME=1800,        # auto-logout after 30 min idle
)

# --------------------------------------------------------------------------
# Very simple login rate-limiter (blocks brute-force password guessing)
# In-memory only - resets if the server restarts. Good enough for a small
# single-admin site; for a bigger deployment use Flask-Limiter + Redis.
# --------------------------------------------------------------------------

MAX_LOGIN_ATTEMPTS = 5
LOCKOUT_SECONDS = 300  # 5 minutes
_login_attempts = {}  # ip -> {"count": int, "locked_until": timestamp}


def is_locked_out(ip):
    entry = _login_attempts.get(ip)
    if not entry:
        return False
    if entry["count"] >= MAX_LOGIN_ATTEMPTS:
        if time.time() < entry["locked_until"]:
            return True
        # Lockout period has expired - reset this IP's attempt counter.
        _login_attempts.pop(ip, None)
    return False


def register_failed_attempt(ip):
    entry = _login_attempts.setdefault(ip, {"count": 0, "locked_until": 0})
    entry["count"] += 1
    if entry["count"] >= MAX_LOGIN_ATTEMPTS:
        entry["locked_until"] = time.time() + LOCKOUT_SECONDS


def clear_attempts(ip):
    _login_attempts.pop(ip, None)


# --------------------------------------------------------------------------
# CORS - restrict this to your real website domain in production instead
# of "*". Example: ALLOWED_ORIGIN = "https://www.trustcredit.com"
# --------------------------------------------------------------------------

ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


@app.after_request
def add_security_headers(response):
    # Stops the admin pages from being loaded inside an <iframe> on
    # another site (clickjacking protection).
    response.headers["X-Frame-Options"] = "DENY"
    # Stops the browser from guessing/re-interpreting file types, which
    # can be abused to run disguised scripts.
    response.headers["X-Content-Type-Options"] = "nosniff"
    # Don't leak the full referring URL (which may contain admin paths
    # or session-ish info) to third-party sites linked from your pages.
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


# --------------------------------------------------------------------------
# Database helpers
# --------------------------------------------------------------------------

def get_db():
    if "db" not in g:
        if not DATABASE_URL:
            raise RuntimeError(
                "DATABASE_URL environment variable is not set. "
                "Add your PostgreSQL connection string in Render."
            )
        g.db = psycopg.connect(DATABASE_URL, row_factory=dict_row)
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    if not DATABASE_URL:
        raise RuntimeError(
            "DATABASE_URL environment variable is not set. "
            "Add your PostgreSQL connection string in Render."
        )

    with psycopg.connect(DATABASE_URL) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS applications (
                id BIGSERIAL PRIMARY KEY,
                full_name TEXT NOT NULL,
                mobile TEXT NOT NULL,
                email TEXT,
                city TEXT,
                loan_type TEXT,
                message TEXT,
                created_at TIMESTAMP NOT NULL
            )
            """
        )
        # Safe to re-run: only adds these columns if they don't already exist,
        # so this won't touch your existing application rows.
        conn.execute("ALTER TABLE applications ADD COLUMN IF NOT EXISTS contacted BOOLEAN NOT NULL DEFAULT FALSE")
        conn.execute("ALTER TABLE applications ADD COLUMN IF NOT EXISTS disbursed BOOLEAN NOT NULL DEFAULT FALSE")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS reviews (
                id BIGSERIAL PRIMARY KEY,
                customer_name TEXT NOT NULL,
                rating INTEGER,
                review_text TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TIMESTAMP NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS partner_referrals (
                id BIGSERIAL PRIMARY KEY,
                referrer_name TEXT NOT NULL,
                referrer_mobile TEXT NOT NULL,
                referrer_payout TEXT,
                borrower_name TEXT NOT NULL,
                borrower_mobile TEXT NOT NULL,
                borrower_city TEXT,
                borrower_occupation TEXT,
                loan_amount TEXT,
                loan_type TEXT,
                contacted BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMP NOT NULL
            )
            """
        )
        conn.commit()


with app.app_context():
    init_db()


# --------------------------------------------------------------------------
# Admin login required decorator
# --------------------------------------------------------------------------

def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("admin_login"))
        return view(*args, **kwargs)
    return wrapped


def wants_json():
    # Our own JS sends this header on every fetch() call below. Regular
    # <form> submits (no-JS fallback) won't send it, so those still get
    # the normal redirect behavior.
    return request.headers.get("X-Requested-With") == "XMLHttpRequest"


# --------------------------------------------------------------------------
# CSRF protection for the admin login form.
# A malicious website could otherwise auto-submit a hidden form to your
# /admin/login endpoint from a visitor's browser. This one-time token
# (tied to their session) makes sure a submission only counts if it
# actually came from your own login page.
# --------------------------------------------------------------------------

def get_csrf_token():
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_hex(32)
    return session["csrf_token"]


def csrf_token_valid(submitted_token):
    real_token = session.get("csrf_token")
    return bool(real_token) and bool(submitted_token) and secrets.compare_digest(real_token, submitted_token)


app.jinja_env.globals["csrf_token"] = get_csrf_token


# --------------------------------------------------------------------------
# Public API - Loan application form
# --------------------------------------------------------------------------

@app.route("/api/apply", methods=["POST", "OPTIONS"])
def api_apply():
    if request.method == "OPTIONS":
        return ("", 204)

    data = request.get_json(silent=True) or request.form

    full_name = (data.get("fname") or data.get("full_name") or "").strip()
    mobile = (data.get("mobile") or "").strip()
    email = (data.get("email") or "").strip()
    city = (data.get("city") or "").strip()
    loan_type = (data.get("loanType") or data.get("loan_type") or "").strip()
    message = (data.get("message") or "").strip()

    if not full_name or not mobile:
        return jsonify({"success": False, "error": "Full name and mobile number are required."}), 400

    db = get_db()
    db.execute(
        """
        INSERT INTO applications (full_name, mobile, email, city, loan_type, message, created_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (full_name, mobile, email, city, loan_type, message, datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
    )
    db.commit()

    return jsonify({"success": True, "message": "Application submitted successfully."})


# --------------------------------------------------------------------------
# Public API - Partner referral form (Refer & Earn)
# --------------------------------------------------------------------------

@app.route("/api/partner-referral", methods=["POST", "OPTIONS"])
def api_partner_referral():
    if request.method == "OPTIONS":
        return ("", 204)

    data = request.get_json(silent=True) or request.form

    referrer_name = (data.get("referrer_name") or "").strip()
    referrer_mobile = (data.get("referrer_mobile") or "").strip()
    referrer_payout = (data.get("referrer_payout") or "").strip()
    borrower_name = (data.get("borrower_name") or "").strip()
    borrower_mobile = (data.get("borrower_mobile") or "").strip()
    borrower_city = (data.get("borrower_city") or "").strip()
    borrower_occupation = (data.get("borrower_occupation") or "").strip()
    loan_amount = (data.get("loan_amount") or "").strip()
    loan_type = (data.get("loan_type") or "").strip()

    if not referrer_name or not referrer_mobile or not borrower_name or not borrower_mobile:
        return jsonify({"success": False, "error": "Referrer and borrower name/mobile are required."}), 400

    db = get_db()
    db.execute(
        """
        INSERT INTO partner_referrals (
            referrer_name, referrer_mobile, referrer_payout,
            borrower_name, borrower_mobile, borrower_city, borrower_occupation,
            loan_amount, loan_type, created_at
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            referrer_name, referrer_mobile, referrer_payout,
            borrower_name, borrower_mobile, borrower_city, borrower_occupation,
            loan_amount, loan_type, datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        ),
    )
    db.commit()

    return jsonify({"success": True, "message": "Referral submitted successfully."})


# --------------------------------------------------------------------------
# Public API - Slideshow images
# --------------------------------------------------------------------------

@app.route("/api/slides", methods=["GET"])
def api_slides():
    if not os.path.isdir(SLIDES_DIR):
        return jsonify({"slides": []})

    allowed_ext = (".jpg", ".jpeg", ".png", ".webp", ".gif")
    files = sorted(
        f for f in os.listdir(SLIDES_DIR)
        if f.lower().endswith(allowed_ext)
    )
    slide_urls = [f"/static/slides/{f}" for f in files]
    return jsonify({"slides": slide_urls})


# --------------------------------------------------------------------------
# Public API - Reviews (submit + fetch approved)
# --------------------------------------------------------------------------

@app.route("/api/reviews", methods=["POST", "OPTIONS"])
def api_submit_review():
    if request.method == "OPTIONS":
        return ("", 204)

    data = request.get_json(silent=True) or request.form

    customer_name = (data.get("customer_name") or data.get("name") or "").strip()
    review_text = (data.get("review_text") or data.get("message") or "").strip()
    rating_raw = data.get("rating")

    rating = None
    if rating_raw not in (None, ""):
        try:
            rating = int(rating_raw)
            if rating < 1 or rating > 5:
                rating = None
        except (TypeError, ValueError):
            rating = None

    if not customer_name or not review_text:
        return jsonify({"success": False, "error": "Name and review text are required."}), 400

    if len(review_text) > 2000:
        return jsonify({"success": False, "error": "Review is too long."}), 400

    db = get_db()
    db.execute(
        """
        INSERT INTO reviews (customer_name, rating, review_text, status, created_at)
        VALUES (%s, %s, %s, 'pending', %s)
        """,
        (customer_name, rating, review_text, datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
    )
    db.commit()

    return jsonify({"success": True, "message": "Thank you! Your review will appear once approved."})


@app.route("/api/reviews", methods=["GET"])
def api_get_reviews():
    db = get_db()
    reviews = db.execute(
        """
        SELECT customer_name, rating, review_text, created_at
        FROM reviews
        WHERE status = 'approved'
        ORDER BY id DESC
        LIMIT 50
        """
    ).fetchall()
    for r in reviews:
        r["created_at"] = r["created_at"].strftime("%d %b %Y") if r.get("created_at") else ""
    return jsonify({"reviews": reviews})


# --------------------------------------------------------------------------
# Admin - Login / Logout
# --------------------------------------------------------------------------

@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    error = None
    ip = request.remote_addr or "unknown"

    if request.method == "POST":
        submitted_csrf = request.form.get("csrf_token", "")

        if not csrf_token_valid(submitted_csrf):
            error = "Your session expired. Please try logging in again."
        elif is_locked_out(ip):
            error = "Too many failed attempts. Please try again in a few minutes."
        else:
            username = request.form.get("username", "")
            password = request.form.get("password", "")

            valid_user = username == ADMIN_USERNAME
            valid_pass = check_password_hash(ADMIN_PASSWORD_HASH, password)

            if valid_user and valid_pass:
                clear_attempts(ip)
                session.clear()
                session["logged_in"] = True
                session.permanent = True
                return redirect(url_for("admin_dashboard"))
            else:
                register_failed_attempt(ip)
                print(f"[SECURITY] Failed admin login attempt from {ip} "
                      f"at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} "
                      f"(username tried: {username!r})")
                error = "Invalid username or password."

    return render_template("admin_login.html", error=error)


@app.route("/admin/logout")
def admin_logout():
    session.clear()
    return redirect(url_for("admin_login"))


# --------------------------------------------------------------------------
# Admin - Dashboard
# --------------------------------------------------------------------------

@app.route("/admin/dashboard")
@login_required
def admin_dashboard():
    db = get_db()

    active_applications = db.execute(
        "SELECT * FROM applications WHERE disbursed = FALSE ORDER BY id DESC"
    ).fetchall()
    disbursed_applications = db.execute(
        "SELECT * FROM applications WHERE disbursed = TRUE ORDER BY id DESC"
    ).fetchall()
    total = len(active_applications) + len(disbursed_applications)
    contacted_count = sum(1 for a in active_applications if a["contacted"])

    pending_reviews = db.execute(
        "SELECT * FROM reviews WHERE status = 'pending' ORDER BY id DESC"
    ).fetchall()
    approved_reviews = db.execute(
        "SELECT * FROM reviews WHERE status = 'approved' ORDER BY id DESC"
    ).fetchall()
    rejected_reviews = db.execute(
        "SELECT * FROM reviews WHERE status = 'rejected' ORDER BY id DESC"
    ).fetchall()

    partner_referrals = db.execute(
        "SELECT * FROM partner_referrals ORDER BY id DESC"
    ).fetchall()

    return render_template(
        "admin_dashboard.html",
        active_applications=active_applications,
        disbursed_applications=disbursed_applications,
        total=total,
        contacted_count=contacted_count,
        pending_reviews=pending_reviews,
        approved_reviews=approved_reviews,
        rejected_reviews=rejected_reviews,
        partner_referrals=partner_referrals,
    )


@app.route("/admin/view/<int:app_id>")
@login_required
def admin_view(app_id):
    db = get_db()
    application = db.execute(
        "SELECT * FROM applications WHERE id = %s", (app_id,)
    ).fetchone()
    if application is None:
        return redirect(url_for("admin_dashboard"))
    return render_template("admin_view.html", application=application)


@app.route("/admin/delete/<int:app_id>", methods=["POST"])
@login_required
def admin_delete(app_id):
    db = get_db()
    db.execute("DELETE FROM applications WHERE id = %s", (app_id,))
    db.commit()
    if wants_json():
        return jsonify({"success": True})
    return redirect(url_for("admin_dashboard"))


@app.route("/admin/applications/<int:app_id>/toggle-contacted", methods=["POST"])
@login_required
def admin_toggle_contacted(app_id):
    db = get_db()
    db.execute(
        "UPDATE applications SET contacted = NOT contacted WHERE id = %s", (app_id,)
    )
    db.commit()
    row = db.execute("SELECT contacted FROM applications WHERE id = %s", (app_id,)).fetchone()
    if wants_json():
        return jsonify({"success": True, "contacted": row["contacted"] if row else None})
    return redirect(url_for("admin_dashboard"))


@app.route("/admin/applications/<int:app_id>/toggle-disbursed", methods=["POST"])
@login_required
def admin_toggle_disbursed(app_id):
    db = get_db()
    db.execute(
        "UPDATE applications SET disbursed = NOT disbursed WHERE id = %s", (app_id,)
    )
    db.commit()
    row = db.execute("SELECT disbursed FROM applications WHERE id = %s", (app_id,)).fetchone()
    if wants_json():
        return jsonify({"success": True, "disbursed": row["disbursed"] if row else None})
    return redirect(url_for("admin_dashboard"))


# --------------------------------------------------------------------------
# Admin - Reviews (approve / reject customer-submitted reviews)
# Merged into the single admin_dashboard.html page - these routes just
# perform the action and report back, they no longer render their own page.
# --------------------------------------------------------------------------

@app.route("/admin/reviews/<int:review_id>/approve", methods=["POST"])
@login_required
def admin_approve_review(review_id):
    db = get_db()
    db.execute("UPDATE reviews SET status = 'approved' WHERE id = %s", (review_id,))
    db.commit()
    if wants_json():
        return jsonify({"success": True})
    return redirect(url_for("admin_dashboard"))


@app.route("/admin/reviews/<int:review_id>/reject", methods=["POST"])
@login_required
def admin_reject_review(review_id):
    db = get_db()
    db.execute("UPDATE reviews SET status = 'rejected' WHERE id = %s", (review_id,))
    db.commit()
    if wants_json():
        return jsonify({"success": True})
    return redirect(url_for("admin_dashboard"))


@app.route("/admin/reviews/<int:review_id>/delete", methods=["POST"])
@login_required
def admin_delete_review(review_id):
    db = get_db()
    db.execute("DELETE FROM reviews WHERE id = %s", (review_id,))
    db.commit()
    if wants_json():
        return jsonify({"success": True})
    return redirect(url_for("admin_dashboard"))


# --------------------------------------------------------------------------
# Admin - Partner referrals (Refer & Earn submissions)
# --------------------------------------------------------------------------

@app.route("/admin/referrals/<int:referral_id>/toggle-contacted", methods=["POST"])
@login_required
def admin_toggle_referral_contacted(referral_id):
    db = get_db()
    db.execute(
        "UPDATE partner_referrals SET contacted = NOT contacted WHERE id = %s", (referral_id,)
    )
    db.commit()
    row = db.execute("SELECT contacted FROM partner_referrals WHERE id = %s", (referral_id,)).fetchone()
    if wants_json():
        return jsonify({"success": True, "contacted": row["contacted"] if row else None})
    return redirect(url_for("admin_dashboard"))


@app.route("/admin/referrals/<int:referral_id>/delete", methods=["POST"])
@login_required
def admin_delete_referral(referral_id):
    db = get_db()
    db.execute("DELETE FROM partner_referrals WHERE id = %s", (referral_id,))
    db.commit()
    if wants_json():
        return jsonify({"success": True})
    return redirect(url_for("admin_dashboard"))


# --------------------------------------------------------------------------
# Root
# --------------------------------------------------------------------------

@app.route("/")
def index():
    return redirect(url_for("admin_login"))


# --------------------------------------------------------------------------
# Entry point (used for local testing only - see deployment guide for
# how to run this with gunicorn in production)
# --------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(debug=not IS_PRODUCTION, host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))

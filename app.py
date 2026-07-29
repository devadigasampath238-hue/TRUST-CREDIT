"""
Trust Credit - Flask Backend (hardened for production)
--------------------------------------------------------
- Saves loan applications submitted from the website into SQLite (loan.db)
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
import sqlite3
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
DB_PATH = os.path.join(BASE_DIR, "loan.db")
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


# --------------------------------------------------------------------------
# Database helpers
# --------------------------------------------------------------------------

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS applications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            full_name TEXT NOT NULL,
            mobile TEXT NOT NULL,
            email TEXT,
            city TEXT,
            loan_type TEXT,
            message TEXT,
            created_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()
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
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (full_name, mobile, email, city, loan_type, message, datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
    )
    db.commit()

    return jsonify({"success": True, "message": "Application submitted successfully."})


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
# Admin - Login / Logout
# --------------------------------------------------------------------------

@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    error = None
    ip = request.remote_addr or "unknown"

    if request.method == "POST":
        if is_locked_out(ip):
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
    applications = db.execute(
        "SELECT * FROM applications ORDER BY id DESC"
    ).fetchall()
    total = len(applications)
    return render_template("admin_dashboard.html", applications=applications, total=total)


@app.route("/admin/view/<int:app_id>")
@login_required
def admin_view(app_id):
    db = get_db()
    application = db.execute(
        "SELECT * FROM applications WHERE id = ?", (app_id,)
    ).fetchone()
    if application is None:
        return redirect(url_for("admin_dashboard"))
    return render_template("admin_view.html", application=application)


@app.route("/admin/delete/<int:app_id>", methods=["POST"])
@login_required
def admin_delete(app_id):
    db = get_db()
    db.execute("DELETE FROM applications WHERE id = ?", (app_id,))
    db.commit()
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
    init_db()
    app.run(debug=not IS_PRODUCTION, host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))

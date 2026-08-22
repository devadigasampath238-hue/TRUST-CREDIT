(function () {
  var API_BASE = "https://trust-credit.onrender.com"; // same backend as slideshow
  var CACHE_KEY = "tc3d_reviews_cache_v1";
  var FETCH_TIMEOUT_MS = 12000; // Render free tier can be slow to wake up
  var RETRY_ATTEMPTS = 2;
  var RETRY_DELAY_MS = 1500;

  // ------------------------------------------------------------------
  // Fetch approved reviews (same reliability pattern as slideshow.js:
  // timeout + retry, then fall back to last cached set on failure)
  // ------------------------------------------------------------------

  function fetchWithTimeout(url, ms) {
    if (typeof AbortController === "undefined") return fetch(url);
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ms);
    return fetch(url, { signal: controller.signal }).finally(function () {
      clearTimeout(timer);
    });
  }

  function fetchReviewsWithRetry(attemptsLeft) {
    return fetchWithTimeout(API_BASE + "/api/reviews", FETCH_TIMEOUT_MS)
      .then(function (res) {
        if (!res.ok) throw new Error("Bad response: " + res.status);
        return res.json();
      })
      .catch(function (err) {
        if (attemptsLeft > 0) {
          return new Promise(function (resolve) { setTimeout(resolve, RETRY_DELAY_MS); })
            .then(function () { return fetchReviewsWithRetry(attemptsLeft - 1); });
        }
        throw err;
      });
  }

  function getCachedReviews() {
    try {
      var raw = window.localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return (parsed && parsed.reviews) ? parsed.reviews : null;
    } catch (e) { return null; }
  }

  function setCachedReviews(reviews) {
    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify({ reviews: reviews, savedAt: Date.now() }));
    } catch (e) { /* non-fatal */ }
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  function initials(name) {
    var parts = String(name || "").trim().split(/\s+/);
    var first = parts[0] ? parts[0][0] : "";
    var second = parts[1] ? parts[1][0] : "";
    return (first + second).toUpperCase() || "?";
  }

  function starRow(rating) {
    var r = parseInt(rating, 10);
    if (!r || r < 1) r = 5; // no rating on record -> show as a full 5-star card
    if (r > 5) r = 5;
    return "★★★★★".slice(0, r) + "☆☆☆☆☆".slice(0, 5 - r);
  }

  // Builds a .testi-slide element identical in structure to the
  // hand-written ones already in the carousel, so it inherits all
  // existing styling without any new CSS.
  function buildSlideEl(review) {
    var wrap = document.createElement("div");
    wrap.className = "testi-slide";
    wrap.innerHTML =
      '<div class="testi-card">' +
        '<div class="testi-stars">' + starRow(review.rating) + '</div>' +
        '<p class="testi-quote">&ldquo;' + escapeHtml(review.review_text) + '&rdquo;</p>' +
        '<div class="testi-person">' +
          '<div class="testi-avatar">' + escapeHtml(initials(review.customer_name)) + '</div>' +
          '<div><b>' + escapeHtml(review.customer_name) + '</b><span>Verified Customer</span></div>' +
        '</div>' +
      '</div>';
    return wrap;
  }

  function loadReviews() {
    var slidesWrap = document.getElementById("testiSlides");
    if (!slidesWrap) return;

    fetchReviewsWithRetry(RETRY_ATTEMPTS)
      .then(function (data) {
        var reviews = data.reviews || [];
        setCachedReviews(reviews);
        insertSlides(reviews);
      })
      .catch(function (err) {
        console.error("Could not load fresh reviews, checking cache:", err);
        var cached = getCachedReviews();
        if (cached) insertSlides(cached);
      });
  }

  function insertSlides(reviews) {
    var slidesWrap = document.getElementById("testiSlides");
    if (!slidesWrap || !reviews || reviews.length === 0) return;

    // Newest approved review first, ahead of the hand-written slides.
    reviews.slice().reverse().forEach(function (r) {
      slidesWrap.insertBefore(buildSlideEl(r), slidesWrap.firstChild);
    });

    // The carousel's own script (in the page) builds nav dots once at
    // load time. Ask it to rebuild now that we've added slides.
    if (typeof window.refreshTestimonialSlider === "function") {
      window.refreshTestimonialSlider();
    }
  }

  // ------------------------------------------------------------------
  // Submission form (#reviewForm) with a 5-star click input
  // ------------------------------------------------------------------

  function initStarInput() {
    var starWrap = document.getElementById("reviewStarInput");
    if (!starWrap) return;
    var stars = starWrap.querySelectorAll("[data-star]");

    function paint(value) {
      stars.forEach(function (s) {
        s.classList.toggle("is-filled", parseInt(s.getAttribute("data-star"), 10) <= value);
      });
    }
    paint(parseInt(starWrap.getAttribute("data-value"), 10) || 5);

    stars.forEach(function (s) {
      s.addEventListener("click", function () {
        var value = parseInt(s.getAttribute("data-star"), 10);
        starWrap.setAttribute("data-value", value);
        paint(value);
      });
    });
  }

  function initForm() {
    var form = document.getElementById("reviewForm");
    if (!form) return;

    var successEl = document.getElementById("reviewFormSuccess");
    var starWrap = document.getElementById("reviewStarInput");
    var submitBtn = form.querySelector("button[type=submit]");

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!form.checkValidity()) { form.reportValidity(); return; }

      var customerName = form.querySelector("[name=customer_name]").value.trim();
      var reviewText = form.querySelector("[name=review_text]").value.trim();
      var rating = starWrap ? starWrap.getAttribute("data-value") : "5";

      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Submitting..."; }
      if (successEl) successEl.classList.remove("show");

      fetch(API_BASE + "/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_name: customerName, review_text: reviewText, rating: rating })
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.success) {
            if (successEl) {
              successEl.querySelector("span").textContent = data.message || "Thank you! Your review will appear once approved.";
              successEl.classList.add("show");
            }
            form.reset();
            if (starWrap) { starWrap.setAttribute("data-value", "5"); initStarInput(); }
          } else {
            alert(data.error || "Something went wrong. Please try again.");
          }
        })
        .catch(function () {
          alert("Could not submit right now. Please check your connection and try again.");
        })
        .finally(function () {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Submit Review"; }
        });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    loadReviews();
    initStarInput();
    initForm();
  });
})();

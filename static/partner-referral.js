/* ============================================================
   TRUST CREDIT — Partner Referral Program
   Handles: ripple buttons, animated stat counters, form
   validation + submission, success/error states, confetti burst.
   Depends on markup/classes from the "Refer & Earn" section in
   trust_credit.html (ids: referralForm, referralSubmitBtn,
   referralSuccess, referralError; class: .ripple, [data-count]).
============================================================= */
(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    initRipple();
    initCounters();
    initReferralForm();
  }

  /* ---------------------------------------------------------
     1. Ripple click effect for buttons marked with .ripple
  --------------------------------------------------------- */
  function initRipple() {
    document.querySelectorAll(".ripple").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        var rect = btn.getBoundingClientRect();
        var size = Math.max(rect.width, rect.height);
        var dot = document.createElement("span");
        dot.className = "ripple-dot";
        dot.style.width = dot.style.height = size + "px";
        dot.style.left = (e.clientX - rect.left - size / 2) + "px";
        dot.style.top = (e.clientY - rect.top - size / 2) + "px";
        btn.appendChild(dot);
        dot.addEventListener("animationend", function () {
          dot.remove();
        });
      });
    });
  }

  /* ---------------------------------------------------------
     2. Count-up animation for the referral stats strip
  --------------------------------------------------------- */
  function initCounters() {
    var counters = document.querySelectorAll("[data-count]");
    if (!counters.length) return;

    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          animateCount(entry.target);
          io.unobserve(entry.target);
        });
      },
      { threshold: 0.4 }
    );

    counters.forEach(function (el) {
      io.observe(el);
    });
  }

  function animateCount(el) {
    var target = parseInt(el.getAttribute("data-count"), 10) || 0;
    var suffix = el.getAttribute("data-suffix") || "";
    var duration = 1200;
    var start = null;

    function step(timestamp) {
      if (start === null) start = timestamp;
      var progress = Math.min((timestamp - start) / duration, 1);
      var eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      var current = Math.floor(eased * target);
      el.textContent = current.toLocaleString("en-IN") + suffix;
      if (progress < 1) {
        window.requestAnimationFrame(step);
      } else {
        el.textContent = target.toLocaleString("en-IN") + suffix;
        el.classList.add("count-pop");
      }
    }
    window.requestAnimationFrame(step);
  }

  /* ---------------------------------------------------------
     3. Referral form: validation, submission, success/error UI
  --------------------------------------------------------- */
  function initReferralForm() {
    var form = document.getElementById("referralForm");
    if (!form) return;

    var submitBtn = document.getElementById("referralSubmitBtn");
    var successBox = document.getElementById("referralSuccess");
    var errorBox = document.getElementById("referralError");
    var submitLabel = submitBtn ? submitBtn.textContent : "Submit Referral";

    form.addEventListener("submit", function (e) {
      e.preventDefault();

      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      hide(errorBox);
      hide(successBox);
      setLoading(true);

      var payload = {};
      new FormData(form).forEach(function (value, key) {
        payload[key] = value;
      });

      // POST to the partner referral endpoint. The site (trustcreditsolutions.in)
      // and the backend (trust-credit.onrender.com) are on different domains,
      // so this must be an absolute URL — a relative "/api/..." path would
      // resolve against trustcreditsolutions.in and 404. CORS is already
      // configured on the backend (see app.py) to allow this cross-origin call.
      fetch("https://trust-credit.onrender.com/api/partner-referral", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
        .then(function (res) {
          if (!res.ok) throw new Error("Request failed with " + res.status);
          return res.json().catch(function () {
            return {};
          });
        })
        .then(function () {
          setLoading(false);
          show(successBox);
          burstConfetti(submitBtn);
          form.reset();
          submitBtn.textContent = "Submitted ✓";
          window.setTimeout(function () {
            submitBtn.textContent = submitLabel;
          }, 3000);
        })
        .catch(function () {
          setLoading(false);
          show(errorBox);
        });
    });

    function setLoading(isLoading) {
      if (!submitBtn) return;
      submitBtn.disabled = isLoading;
      submitBtn.textContent = isLoading ? "Submitting…" : submitLabel;
    }
  }

  function show(el) {
    if (el) el.classList.add("show");
  }
  function hide(el) {
    if (el) el.classList.remove("show");
  }

  /* ---------------------------------------------------------
     4. Lightweight confetti burst on successful submission
  --------------------------------------------------------- */
  function burstConfetti(anchorEl) {
    if (!anchorEl || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    var rect = anchorEl.getBoundingClientRect();
    var originX = rect.left + rect.width / 2;
    var originY = rect.top;
    var colors = ["#2E9E3E", "#0B3B75", "#C98A1E", "#7FE092", "#124884"];
    var pieceCount = 22;

    for (var i = 0; i < pieceCount; i++) {
      var piece = document.createElement("span");
      piece.className = "confetti-piece";
      piece.style.background = colors[i % colors.length];
      piece.style.left = originX + "px";
      piece.style.top = originY + "px";
      document.body.appendChild(piece);

      var angle = (Math.random() * Math.PI) - Math.PI / 2 - Math.PI / 4;
      var distance = 90 + Math.random() * 110;
      var dx = Math.cos(angle) * distance;
      var dy = Math.sin(angle) * distance - 60;
      var rotate = (Math.random() * 720 - 360) + "deg";
      var duration = 700 + Math.random() * 500;

      var animation = piece.animate(
        [
          { transform: "translate(0, 0) rotate(0deg)", opacity: 1 },
          {
            transform: "translate(" + dx + "px, " + (dy + 140) + "px) rotate(" + rotate + ")",
            opacity: 0
          }
        ],
        { duration: duration, easing: "cubic-bezier(.2,.7,.3,1)" }
      );
      animation.onfinish = function (pieceEl) {
        return function () {
          pieceEl.remove();
        };
      }(piece);
    }
  }
})();

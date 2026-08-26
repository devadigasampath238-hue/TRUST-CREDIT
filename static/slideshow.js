/*
  slideshow.js
  --------------------------------------------------------------
  Fetches the banner images from the Flask backend
  ( GET /api/slides ) and displays them as a 3D "coverflow" style
  carousel — a large centered slide with smaller rotated slides
  fanning out on either side (similar to a movie-poster carousel).

  This file does NOT modify any existing HTML/CSS/JS. It builds
  its own section with JavaScript and inserts it into the middle
  of the page automatically (right before the "Founders" /
  advisors section, roughly the structural midpoint of the site).
  If that section isn't found, it falls back to inserting before
  the EMI Calculator section, then before Contact, then the end
  of <body>.

  It reuses the site's own ".section", ".container", ".section-head"
  and ".eyebrow" classes (and CSS variables like --navy, --green)
  so the typography and spacing match the rest of the page exactly.

  Sizing notes (v2):
  - Card width now scales per breakpoint instead of being a fixed
    230px box at every screen size, so it doesn't look tiny on a
    1440-1920px desktop.
  - Card height is driven by `aspect-ratio` and the image is shown
    with `object-fit:contain` (not `cover`), so no slide is ever
    cropped, regardless of the source image's own aspect ratio.
  - The coverflow's fan-out spacing (translateX/translateZ per
    side card) is computed in JS as a proportion of the CURRENT
    rendered card width, instead of hard-coded pixel values, so it
    stays visually consistent at every breakpoint and re-adapts on
    window resize / orientation change.

  Usage: add this one line near the end of trust_credit.html,
  just before </body> (alongside loan-form.js):

      <script src="http://127.0.0.1:5000/static/slideshow.js"></script>

  If your backend runs on a different host/port, update API_BASE below.
*/

(function () {
  var API_BASE = "https://trust-credit.vercel.app"; // change if backend runs elsewhere
  var AUTOPLAY_MS = 3200;
  var CACHE_KEY = "tc3d_slides_cache_v1";
  var FETCH_TIMEOUT_MS = 12000; // Render free-tier cold start can take 30-60s to
  // wake, but we don't want a visitor waiting that long staring at nothing.
  // Give it 12s, then fall back to the last known-good set of slides so the
  // section still appears instead of leaving a blank gap.
  var RETRY_ATTEMPTS = 2;
  var RETRY_DELAY_MS = 1500;

  // --------------------------------------------------------------
  // Reliability layer: the backend is a free-tier Render service
  // that spins down after ~15 min idle, so the first request after
  // a quiet period can be very slow or occasionally fail outright.
  // This wraps the plain fetch from before with:
  //   1. a timeout, so we don't hang indefinitely on a slow wake-up
  //   2. a couple of quick retries (cheap, since a retry after a
  //      cold-start failure often lands on an already-warm server)
  //   3. a localStorage cache of the last successful slide list, so
  //      if every attempt fails the visitor still sees the most
  //      recent real slides instead of an empty section
  // --------------------------------------------------------------

  function fetchWithTimeout(url, ms) {
    if (typeof AbortController === "undefined") return fetch(url);
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ms);
    return fetch(url, { signal: controller.signal }).finally(function () {
      clearTimeout(timer);
    });
  }

  function fetchSlidesWithRetry(attemptsLeft) {
    return fetchWithTimeout(API_BASE + "/api/slides", FETCH_TIMEOUT_MS)
      .then(function (res) {
        if (!res.ok) throw new Error("Bad response: " + res.status);
        return res.json();
      })
      .catch(function (err) {
        if (attemptsLeft > 0) {
          return new Promise(function (resolve) {
            setTimeout(resolve, RETRY_DELAY_MS);
          }).then(function () { return fetchSlidesWithRetry(attemptsLeft - 1); });
        }
        throw err;
      });
  }

  function getCachedSlides() {
    try {
      var raw = window.localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return (parsed && parsed.slides && parsed.slides.length) ? parsed.slides : null;
    } catch (e) {
      return null;
    }
  }

  function setCachedSlides(slides) {
    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify({ slides: slides, savedAt: Date.now() }));
    } catch (e) {
      // localStorage unavailable (private browsing, quota, etc.) — non-fatal,
      // it just means no fallback cache next time.
    }
  }

  function init() {
    fetchSlidesWithRetry(RETRY_ATTEMPTS)
      .then(function (data) {
        var slides = data.slides || [];
        if (slides.length === 0) throw new Error("Empty slides response");
        setCachedSlides(slides);
        buildCoverflow(slides.map(function (path) { return API_BASE + path; }));
      })
      .catch(function (err) {
        console.error("Could not load fresh slideshow images, checking cache:", err);
        var cached = getCachedSlides();
        if (cached) {
          console.warn("Showing last cached slideshow images instead.");
          buildCoverflow(cached.map(function (path) { return API_BASE + path; }));
        } else {
          console.error("No cached slideshow images available — section will not render.");
        }
      });
  }

  function injectStyles() {
    if (document.getElementById("tc3d-styles")) return;
    var css = "\n" +
      ".tc3d-section{background:var(--mist,#F5F8FC);overflow:hidden;}\n" +
      ".tc3d-stage{position:relative; width:100%; height:480px; margin:0 auto; max-width:1100px;" +
      " perspective:1800px; display:flex; align-items:center; justify-content:center; box-sizing:border-box;}\n" +
      ".tc3d-track{position:relative; width:100%; height:100%; transform-style:preserve-3d;}\n" +
      /* Card size now comes from `width` + `aspect-ratio` only — centering is
         handled entirely by the translate(-50%,-50%) applied in JS, so there
         is no separate pixel-margin to keep in sync with the width/height. */
      ".tc3d-card{position:absolute; top:50%; left:50%; width:300px; aspect-ratio:3/4;" +
      " border-radius:16px; overflow:hidden; cursor:pointer;" +
      " box-shadow:var(--shadow-lg,0 24px 60px rgba(7,37,72,0.18)); transition:transform 0.6s cubic-bezier(.4,.1,.2,1), opacity 0.6s ease;" +
      " will-change:transform; background:#0B3B75; box-sizing:border-box;}\n" +
      /* object-fit:contain (not cover) so a slide's own proportions are always
         fully visible inside the card — nothing gets cropped off the edges. */
      ".tc3d-card img{width:100%; height:100%; object-fit:contain; display:block; pointer-events:none; background:#0B3B75;}\n" +
      ".tc3d-card.is-center{cursor:default;}\n" +
      /* Per-slide download button, top-right corner of each card. Only shown
         (via hover/focus) on the centered card on pointer devices; always
         shown on touch devices since there's no hover state there. */
      ".tc3d-dl{position:absolute; top:8px; right:8px; z-index:5; width:34px; height:34px; min-width:34px;" +
      " border-radius:50%; border:none; background:rgba(7,37,72,0.55); backdrop-filter:blur(2px);" +
      " color:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer;" +
      " opacity:0; transform:translateY(-4px); transition:opacity 0.2s ease, transform 0.2s ease, background 0.2s ease;" +
      " pointer-events:none;}\n" +
      ".tc3d-dl svg{width:16px; height:16px;}\n" +
      ".tc3d-card.is-center .tc3d-dl{opacity:1; transform:translateY(0); pointer-events:auto;}\n" +
      ".tc3d-dl:hover{background:var(--green,#2E9E3E);}\n" +
      ".tc3d-dl.is-busy{pointer-events:none; opacity:0.7;}\n" +
      "@media(hover:none){.tc3d-dl{opacity:1; transform:none; pointer-events:auto; width:30px; height:30px; min-width:30px;}}\n" +
      ".tc3d-arrow{position:absolute; top:50%; transform:translateY(-50%); z-index:60;" +
      " width:46px; height:46px; min-width:46px; border-radius:50%; border:none; background:#fff;" +
      " color:var(--navy-deep,#072548); font-size:22px; line-height:1; cursor:pointer;" +
      " box-shadow:var(--shadow-md,0 8px 24px rgba(11,59,117,0.10)); display:flex;" +
      " align-items:center; justify-content:center; transition:background 0.2s;}\n" +
      ".tc3d-arrow:hover{background:var(--green,#2E9E3E); color:#fff;}\n" +
      ".tc3d-arrow.prev{left:6px;} .tc3d-arrow.next{right:6px;}\n" +
      ".tc3d-dots{display:flex; justify-content:center; gap:8px; margin-top:34px; flex-wrap:wrap; max-width:600px; margin-left:auto; margin-right:auto;}\n" +
      ".tc3d-dot{width:8px; height:8px; min-width:8px; border-radius:50%; background:var(--line,#E3E9F2); border:none; padding:0; cursor:pointer; transition:background 0.2s, transform 0.2s;}\n" +
      ".tc3d-dot.active{background:var(--green,#2E9E3E); transform:scale(1.3);}\n" +
      /* Tablet */
      "@media(max-width:980px){\n" +
      "  .tc3d-stage{height:400px;}\n" +
      "  .tc3d-card{width:230px;}\n" +
      "}\n" +
      "@media(max-width:820px){\n" +
      "  .tc3d-stage{height:360px;}\n" +
      "  .tc3d-card{width:200px;}\n" +
      "  .tc3d-arrow{width:38px; height:38px; min-width:38px; font-size:18px;}\n" +
      "  .tc3d-dl{width:30px; height:30px; min-width:30px;}\n" +
      "}\n" +
      /* Mobile */
      "@media(max-width:560px){\n" +
      "  .tc3d-stage{height:300px;}\n" +
      "  .tc3d-card{width:165px; border-radius:12px;}\n" +
      "  .tc3d-arrow{width:34px; height:34px; min-width:34px; font-size:16px; left:2px;}\n" +
      "  .tc3d-arrow.next{left:auto; right:2px;}\n" +
      "  .tc3d-dl{width:26px; height:26px; min-width:26px; top:6px; right:6px;}\n" +
      "  .tc3d-dl svg{width:13px; height:13px;}\n" +
      "}\n" +
      "@media(max-width:400px){\n" +
      "  .tc3d-stage{height:260px;}\n" +
      "  .tc3d-card{width:140px;}\n" +
      "}\n";
    var style = document.createElement("style");
    style.id = "tc3d-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildCoverflow(imageUrls) {
    injectStyles();

    var section = document.createElement("section");
    section.className = "section tc3d-section";
    section.id = "tc3dOffers";

    section.innerHTML =
      '<div class="container">' +
      '  <div class="section-head reveal">' +
      '    <span class="eyebrow">Latest Offers</span>' +
      '    <h2>Explore Our Loan Offers</h2>' +
      '    <p>A quick look at our latest loan offers and partner benefits — swipe or wait to see more.</p>' +
      '  </div>' +
      '  <div class="tc3d-stage" id="tc3dStage">' +
      '    <button class="tc3d-arrow prev" aria-label="Previous offer" type="button">&#8249;</button>' +
      '    <div class="tc3d-track" id="tc3dTrack"></div>' +
      '    <button class="tc3d-arrow next" aria-label="Next offer" type="button">&#8250;</button>' +
      '  </div>' +
      '  <div class="tc3d-dots" id="tc3dDots"></div>' +
      '</div>';

    insertInMiddle(section);
    observeReveal(section);

    var track = section.querySelector("#tc3dTrack");
    var dotsWrap = section.querySelector("#tc3dDots");
    var stage = section.querySelector("#tc3dStage");
    var prevBtn = section.querySelector(".tc3d-arrow.prev");
    var nextBtn = section.querySelector(".tc3d-arrow.next");

    var total = imageUrls.length;
    var current = 0;
    var cards = [];

    var DOWNLOAD_ICON =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 20h16"/></svg>';
    var CHECK_ICON =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

    imageUrls.forEach(function (url, i) {
      var card = document.createElement("div");
      card.className = "tc3d-card";
      card.innerHTML = '<img src="' + url + '" alt="Trust Credit offer ' + (i + 1) + '" loading="lazy">' +
        '<button class="tc3d-dl" type="button" aria-label="Download this offer image">' + DOWNLOAD_ICON + '</button>';
      card.addEventListener("click", function () { goTo(i); });

      var dlBtn = card.querySelector(".tc3d-dl");
      dlBtn.addEventListener("click", function (e) {
        e.stopPropagation(); // don't trigger the card's own goTo(i) click
        downloadSlide(url, i, dlBtn, DOWNLOAD_ICON, CHECK_ICON);
      });

      track.appendChild(card);
      cards.push(card);

      var dot = document.createElement("span");
      dot.className = "tc3d-dot";
      dot.addEventListener("click", function () { goTo(i); });
      dotsWrap.appendChild(dot);
    });
    var dots = dotsWrap.children;

    // Fan-out spacing expressed as a multiple of the card's own current
    // width, so the coverflow keeps its proportions at every breakpoint
    // instead of relying on pixel values tuned for one fixed card size.
    var RING_OFFSETS = [
      { x: 0.85, z: -0.70, rotate: -40, scale: 0.82, opacity: 0.9 },
      { x: 1.45, z: -1.40, rotate: -50, scale: 0.62, opacity: 0.55 },
      { x: 1.90, z: -1.90, rotate: -55, scale: 0.46, opacity: 0.22 },
      { x: 2.10, z: -2.30, rotate: -55, scale: 0.40, opacity: 0 }
    ];

    function render() {
      var half = Math.floor(total / 2);
      // Measure the card's true (untransformed) width so spacing matches
      // whatever the current breakpoint's CSS `width` resolves to.
      // IMPORTANT: use offsetWidth, not getBoundingClientRect() — the
      // latter reports the size AFTER the scale() transform is applied,
      // so it would report a different (shrinking/growing) width
      // depending on which ring position card[0] currently happens to
      // be in, throwing the whole layout's spacing off as slides advance.
      var cardW = cards[0].offsetWidth || 300;

      for (var i = 0; i < total; i++) {
        var delta = i - current;
        if (delta > half) delta -= total;
        if (delta < -half) delta += total;

        var card = cards[i];
        var abs = Math.abs(delta);
        var sign = delta === 0 ? 0 : (delta > 0 ? 1 : -1);
        var t;

        if (abs === 0) {
          t = "translateX(0px) translateZ(0px) rotateY(0deg) scale(1)";
          card.style.opacity = "1";
          card.style.zIndex = "50";
          card.classList.add("is-center");
        } else {
          var ring = RING_OFFSETS[Math.min(abs - 1, RING_OFFSETS.length - 1)];
          var tx = (sign * ring.x * cardW).toFixed(1);
          var tz = (ring.z * cardW).toFixed(1);
          t = "translateX(" + tx + "px) translateZ(" + tz + "px) rotateY(" + (sign * ring.rotate) + "deg) scale(" + ring.scale + ")";
          card.style.opacity = String(ring.opacity);
          card.style.zIndex = String(50 - abs * 10);
          card.classList.remove("is-center");
        }
        card.style.transform = "translate(-50%, -50%) " + t;
      }
      for (var d = 0; d < dots.length; d++) {
        dots[d].classList.toggle("active", d === current);
      }
    }

    function goTo(index) {
      current = ((index % total) + total) % total;
      render();
    }

    prevBtn.addEventListener("click", function () { goTo(current - 1); resetTimer(); });
    nextBtn.addEventListener("click", function () { goTo(current + 1); resetTimer(); });

    var timer = setInterval(function () { goTo(current + 1); }, AUTOPLAY_MS);
    function resetTimer() {
      clearInterval(timer);
      timer = setInterval(function () { goTo(current + 1); }, AUTOPLAY_MS);
    }
    stage.addEventListener("mouseenter", function () { clearInterval(timer); });
    stage.addEventListener("mouseleave", resetTimer);

    // Re-run the layout math when the viewport crosses a breakpoint
    // (resize, orientation change, devtools panel toggle, etc.) so the
    // fan-out spacing always matches the currently rendered card width.
    var resizeTimer;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(render, 120);
    });

    render();
  }

  // -----------------------------------------------------------------
  // Fix for the blank gap above the slideshow:
  // The site's own scroll-reveal script (inline at the bottom of
  // trust_credit.html) sets up ONE IntersectionObserver on page load
  // and only ever watches the `.reveal` / `.reveal-stagger` elements
  // that already exist in the DOM at that instant. Because this
  // section is injected by slideshow.js slightly later, its own
  // ".section-head.reveal" (eyebrow + heading + paragraph) never gets
  // observed, so it never receives the "in" class the site's CSS
  // needs to fade it to opacity:1. It stays invisible forever, but
  // still occupies its normal layout space (margin-bottom:56px, plus
  // the eyebrow/h2/p line-heights) — which is exactly the "huge gap"
  // above the coverflow. We give this section its own small observer
  // that replicates the same fade-in behavior.
  // -----------------------------------------------------------------
  function observeReveal(section) {
    var els = section.querySelectorAll(".reveal, .reveal-stagger");
    if (!els.length) return;
    if (!("IntersectionObserver" in window)) {
      // No IO support: just show the content immediately rather than
      // leaving it invisible.
      for (var i = 0; i < els.length; i++) els[i].classList.add("in");
      return;
    }
    var io = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });
    for (var j = 0; j < els.length; j++) io.observe(els[j]);
  }

  // -----------------------------------------------------------------
  // Per-slide download.
  // Tries to fetch the image as a blob and trigger a real file
  // download (works when the backend serves the image with permissive
  // CORS headers, same as it already must for the JSON API call).
  // If that's blocked (e.g. no CORS headers on the static image
  // route), falls back to opening the image in a new tab so the user
  // can still save it manually (long-press / right-click → Save Image).
  // -----------------------------------------------------------------
  function downloadSlide(url, index, btn, iconHtml, checkHtml) {
    btn.classList.add("is-busy");
    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error("Bad response");
        return res.blob();
      })
      .then(function (blob) {
        var ext = (blob.type && blob.type.split("/")[1]) || (url.split(".").pop().split("?")[0]) || "jpg";
        var a = document.createElement("a");
        var objectUrl = URL.createObjectURL(blob);
        a.href = objectUrl;
        a.download = "trust-credit-offer-" + (index + 1) + "." + ext;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 4000);
        showDownloadSuccess(btn, iconHtml, checkHtml);
      })
      .catch(function () {
        // CORS or network issue — fall back to a new tab so the user
        // can still save the image themselves.
        window.open(url, "_blank", "noopener");
        btn.classList.remove("is-busy");
      });
  }

  function showDownloadSuccess(btn, iconHtml, checkHtml) {
    btn.innerHTML = checkHtml;
    btn.classList.remove("is-busy");
    setTimeout(function () { btn.innerHTML = iconHtml; }, 1400);
  }

  function insertInMiddle(section) {
    // Preferred anchor points, roughly the structural middle of the page.
    var anchors = ["#advisors", "#process", "#calculator", "#testimonials", "#contact"];
    for (var i = 0; i < anchors.length; i++) {
      var el = document.querySelector(anchors[i]);
      if (el && el.parentNode) {
        el.parentNode.insertBefore(section, el);
        return;
      }
    }
    // Fallback: end of body
    document.body.appendChild(section);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

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

  Usage: add this one line near the end of trust_credit.html,
  just before </body> (alongside loan-form.js):

      <script src="http://127.0.0.1:5000/static/slideshow.js"></script>

  If your backend runs on a different host/port, update API_BASE below.
*/

(function () {
  var API_BASE = "https://trust-credit.onrender.com"; // change if backend runs elsewhere
  var AUTOPLAY_MS = 3200;

  function init() {
    fetch(API_BASE + "/api/slides")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var slides = data.slides || [];
        if (slides.length === 0) return;
        buildCoverflow(slides.map(function (path) { return API_BASE + path; }));
      })
      .catch(function (err) {
        console.error("Could not load slideshow images:", err);
      });
  }

  function injectStyles() {
    if (document.getElementById("tc3d-styles")) return;
    var css = "\n" +
      ".tc3d-section{background:var(--mist,#F5F8FC);overflow:hidden;}\n" +
      ".tc3d-stage{position:relative; height:440px; margin:0 auto; max-width:1100px;" +
      " perspective:1600px; display:flex; align-items:center; justify-content:center;}\n" +
      ".tc3d-track{position:relative; width:100%; height:100%; transform-style:preserve-3d;}\n" +
      ".tc3d-card{position:absolute; top:50%; left:50%; width:230px; height:340px;" +
      " margin:-170px 0 0 -115px; border-radius:16px; overflow:hidden; cursor:pointer;" +
      " box-shadow:var(--shadow-lg,0 24px 60px rgba(7,37,72,0.18)); transition:transform 0.6s cubic-bezier(.4,.1,.2,1), opacity 0.6s ease;" +
      " will-change:transform; background:#0B3B75;}\n" +
      ".tc3d-card img{width:100%; height:100%; object-fit:cover; display:block; pointer-events:none;}\n" +
      ".tc3d-card.is-center{cursor:default;}\n" +
      ".tc3d-arrow{position:absolute; top:50%; transform:translateY(-50%); z-index:60;" +
      " width:46px; height:46px; border-radius:50%; border:none; background:#fff;" +
      " color:var(--navy-deep,#072548); font-size:22px; line-height:1; cursor:pointer;" +
      " box-shadow:var(--shadow-md,0 8px 24px rgba(11,59,117,0.10)); display:flex;" +
      " align-items:center; justify-content:center; transition:background 0.2s;}\n" +
      ".tc3d-arrow:hover{background:var(--green,#2E9E3E); color:#fff;}\n" +
      ".tc3d-arrow.prev{left:6px;} .tc3d-arrow.next{right:6px;}\n" +
      ".tc3d-dots{display:flex; justify-content:center; gap:8px; margin-top:34px; flex-wrap:wrap; max-width:600px; margin-left:auto; margin-right:auto;}\n" +
      ".tc3d-dot{width:8px; height:8px; border-radius:50%; background:var(--line,#E3E9F2); cursor:pointer; transition:background 0.2s, transform 0.2s;}\n" +
      ".tc3d-dot.active{background:var(--green,#2E9E3E); transform:scale(1.3);}\n" +
      "@media(max-width:820px){\n" +
      "  .tc3d-stage{height:340px;}\n" +
      "  .tc3d-card{width:170px; height:250px; margin:-125px 0 0 -85px;}\n" +
      "  .tc3d-arrow{width:38px; height:38px; font-size:18px;}\n" +
      "}\n" +
      "@media(max-width:520px){\n" +
      "  .tc3d-stage{height:280px;}\n" +
      "  .tc3d-card{width:140px; height:205px; margin:-102px 0 0 -70px;}\n" +
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

    var track = section.querySelector("#tc3dTrack");
    var dotsWrap = section.querySelector("#tc3dDots");
    var stage = section.querySelector("#tc3dStage");
    var prevBtn = section.querySelector(".tc3d-arrow.prev");
    var nextBtn = section.querySelector(".tc3d-arrow.next");

    var total = imageUrls.length;
    var current = 0;
    var cards = [];

    imageUrls.forEach(function (url, i) {
      var card = document.createElement("div");
      card.className = "tc3d-card";
      card.innerHTML = '<img src="' + url + '" alt="Trust Credit offer ' + (i + 1) + '" loading="lazy">';
      card.addEventListener("click", function () { goTo(i); });
      track.appendChild(card);
      cards.push(card);

      var dot = document.createElement("span");
      dot.className = "tc3d-dot";
      dot.addEventListener("click", function () { goTo(i); });
      dotsWrap.appendChild(dot);
    });
    var dots = dotsWrap.children;

    function render() {
      var half = Math.floor(total / 2);
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
        } else if (abs === 1) {
          t = "translateX(" + (sign * 190) + "px) translateZ(-160px) rotateY(" + (sign * -40) + "deg) scale(0.82)";
          card.style.opacity = "0.9";
          card.style.zIndex = "40";
          card.classList.remove("is-center");
        } else if (abs === 2) {
          t = "translateX(" + (sign * 330) + "px) translateZ(-320px) rotateY(" + (sign * -50) + "deg) scale(0.62)";
          card.style.opacity = "0.55";
          card.style.zIndex = "30";
          card.classList.remove("is-center");
        } else if (abs === 3) {
          t = "translateX(" + (sign * 430) + "px) translateZ(-440px) rotateY(" + (sign * -55) + "deg) scale(0.46)";
          card.style.opacity = "0.22";
          card.style.zIndex = "20";
          card.classList.remove("is-center");
        } else {
          t = "translateX(" + (sign * 480) + "px) translateZ(-520px) rotateY(" + (sign * -55) + "deg) scale(0.4)";
          card.style.opacity = "0";
          card.style.zIndex = "10";
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

    render();
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

/*
  loan-form.js
  --------------------------------------------------------------
  Connects the EXISTING "leadForm" on the Trust Credit website to
  the Flask backend so submissions get saved into loan.db.

  This file does NOT change any existing HTML/CSS/JS. It only
  listens for the same form's "submit" event (in addition to the
  site's own demo handler) and sends the data to the backend API.

  Usage: add this one line near the end of trust_credit.html,
  just before </body>:

      <script src="http://127.0.0.1:5000/static/loan-form.js"></script>

  If your backend runs on a different host/port, update API_BASE below.
*/

(function () {
  var API_BASE = "https://trust-credit.onrender.com"; // change if backend runs elsewhere

  function init() {
    var form = document.getElementById("leadForm");
    if (!form) return; // form not found on this page, do nothing

    form.addEventListener("submit", function (e) {
      // NOTE: the site's own script already calls e.preventDefault()
      // for its demo "Submitted ✓" animation. We just also send the
      // data to our backend in the background.

      var payload = {
        fname: (document.getElementById("fname") || {}).value || "",
        mobile: (document.getElementById("mobile") || {}).value || "",
        email: (document.getElementById("email") || {}).value || "",
        city: (document.getElementById("city") || {}).value || "",
        loanType: (document.getElementById("loanType") || {}).value || "",
        message: (document.getElementById("message") || {}).value || ""
      };

      // Only send if the form is actually valid (mirrors the site's own check)
      if (!form.checkValidity) {
        sendToBackend(payload);
        return;
      }
      if (form.checkValidity()) {
        sendToBackend(payload);
      }
    });
  }

  function sendToBackend(payload) {
    fetch(API_BASE + "/api/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        console.log("Trust Credit backend:", data);
      })
      .catch(function (err) {
        console.error("Could not reach Trust Credit backend:", err);
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

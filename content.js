// ============================================================
// content.js — ByeClicker + AI  (final)
// Uses exact button IDs confirmed from real iClicker DOM:
//   #multiple-choice-a, #multiple-choice-b, etc.
// Handles "Extension context invalidated" gracefully.
// ============================================================

(function () {
  "use strict";

  const HOST            = "https://bye-clicker-api.vercel.app";
  const LETTER_TO_INDEX = { A:0, B:1, C:2, D:3, E:4 };

  // ── State ──────────────────────────────────────────────────
  let running          = false;
  let random           = false;
  let autoJoin         = false;
  let notify           = false;
  let useAI            = false;
  let fetchCalled      = false;
  let answerLock       = false;
  let lastFingerprint  = "";
  let mainInterval     = null;
  let urlInterval      = null;
  let access_token, courseId, activityId;

  // ── Extension context guard ────────────────────────────────
  // When extension is reloaded mid-session, chrome.* throws.
  // We detect this and shut down cleanly instead of spamming errors.
  function alive() {
    try { return !!chrome.runtime.id; }
    catch(e) { return false; }
  }

  function safeChrome(fn) {
    if (!alive()) { kill(); return; }
    try { fn(); }
    catch(e) {
      if (e.message && e.message.includes("Extension context")) { kill(); }
      else { log("chrome error:", e.message); }
    }
  }

  function kill() {
    // Extension was reloaded — stop everything silently
    running = false;
    clearInterval(mainInterval);
    clearInterval(urlInterval);
    mainInterval = null;
    log("Extension context lost — stopped. Please reload the page.");
  }

  // ── Boot ───────────────────────────────────────────────────
  safeChrome(() => {
    chrome.storage.local.get(["notify","random","autoJoin","useAI","status"], (r) => {
      notify   = !!r.notify;
      random   = !!r.random;
      autoJoin = !!r.autoJoin;
      useAI    = !!r.useAI;
      if (r.status === "started") {
        log("Auto-resuming");
        startRunning();
      }
    });
  });

  // ── Message listener ───────────────────────────────────────
  safeChrome(() => {
    chrome.runtime.onMessage.addListener((message) => {
      if (!alive()) { kill(); return; }

      if (message.type === "processAIResponse") {
        log("AI response:", message.response);
        clickAIAnswer(message.response);
        return;
      }
      if (message.type === "aiFallback") {
        log("AI fallback:", message.reason);
        clickByLetter(random ? randomLetter() : "A");
        return;
      }

      if (message.from !== "popup") return;

      switch (message.msg) {
        case "start":    startRunning();   break;
        case "stop":     stopRunning();    break;
        case "random":
          random = !random;
          safeChrome(() => chrome.storage.local.set({ random }));
          break;
        case "autoJoin":
          autoJoin = !autoJoin;
          safeChrome(() => chrome.storage.local.set({ autoJoin }));
          break;
        case "useAI":
          useAI = !useAI;
          safeChrome(() => chrome.storage.local.set({ useAI }));
          break;
        case "notify":
          notify = !notify;
          safeChrome(() => chrome.storage.local.set({ email: message.email, notify }));
          break;
      }
    });
  });

  // ── Start / Stop ───────────────────────────────────────────
  function startRunning() {
    if (running) return;
    running = true;
    safeChrome(() => chrome.storage.local.set({ status: "started" }));
    log("▶ Started");
    grabCredentials();
    mainLoop();
    mainInterval = setInterval(() => {
      if (!alive()) { kill(); return; }
      mainLoop();
    }, 1500);
  }

  function stopRunning() {
    running = false;
    clearInterval(mainInterval);
    mainInterval = null;
    safeChrome(() => chrome.storage.local.set({ status: "stopped" }));
    log("■ Stopped");
  }

  // ── Main loop (every 1.5s) ─────────────────────────────────
  function mainLoop() {
    if (!running || !alive()) return;
    const url = location.href;

    // Poll page — answer questions
    if (url.includes("/poll")) {
      safeChrome(() => chrome.storage.local.set({ prevPage: "poll" }));

      const btns = getButtons();
      if (!btns.length) {
        log("Waiting for buttons...");
        return;
      }

      // Fingerprint detects new questions
      const fp = btns.map(b => b.id + b.getAttribute("aria-pressed")).join("|");
      if (fp !== lastFingerprint) {
        lastFingerprint = fp;
        answerLock = false;
        log("New question! Buttons:", btns.map(b => b.id));
      }

      if (!answerLock) {
        answerLock = true;
        log("Will answer in 2.5s...");
        setTimeout(() => doAnswer(), 2500);
      }
    }

    // Overview page — auto-join
    if (url.includes("/overview") && autoJoin) {
      tryAutoJoin();
    }
  }

  // ── Get buttons using confirmed real iClicker IDs ──────────
  function getButtons() {
    // Method 1: exact IDs from real DOM (most reliable)
    const byId = ["a","b","c","d","e"]
      .map(l => document.getElementById(`multiple-choice-${l}`))
      .filter(el => el && !el.disabled && isVisible(el));
    if (byId.length >= 2) return byId;

    // Method 2: button.btn inside .btn-container (confirmed class from DOM)
    const byClass = Array.from(
      document.querySelectorAll(".btn-container button.btn")
    ).filter(el => !el.disabled && isVisible(el));
    if (byClass.length >= 2) return byClass;

    // Method 3: any button inside .answer-controls-container
    const byParent = Array.from(
      document.querySelectorAll(".answer-controls-container button")
    ).filter(el => !el.disabled && isVisible(el));
    if (byParent.length >= 2) return byParent;

    return [];
  }

  // ── Answer dispatch ────────────────────────────────────────
  function doAnswer() {
    if (!running || !alive()) return;
    const btns = getButtons();
    if (!btns.length) {
      log("doAnswer: no buttons, will retry next loop");
      answerLock = false;
      return;
    }
    if (useAI) {
      sendToAI(btns);
    } else {
      clickByLetter(random ? randomLetter(btns.length) : "A");
    }
  }

  // ── Click by letter A/B/C/D/E ─────────────────────────────
  function clickByLetter(letter, btns) {
    const L = letter.toUpperCase().charAt(0);

    // Try exact ID first
    const byId = document.getElementById(`multiple-choice-${L.toLowerCase()}`);
    if (byId && !byId.disabled && isVisible(byId)) {
      log(`Clicking #multiple-choice-${L.toLowerCase()}`);
      safeClick(byId);
      return;
    }

    // Fall back to index
    const buttons = btns || getButtons();
    const idx = LETTER_TO_INDEX[L] ?? 0;
    if (buttons[idx]) {
      log(`Clicking index ${idx}`);
      safeClick(buttons[idx]);
    }
  }

  // ── AI path ────────────────────────────────────────────────
  function sendToAI(buttons) {
    const qHeader = document.querySelector(".center-buttons h1");
    const qText   = qHeader ? qHeader.textContent.trim() : "Answer this poll question.";

    const payload = {
      type: "multiple_choice",
      question: qText,
      options: buttons.map((_, i) => Object.keys(LETTER_TO_INDEX)[i] || String(i+1)),
      previousCorrection: null,
    };

    log("Sending to AI:", payload);
    safeChrome(() => chrome.runtime.sendMessage({ type: "sendQuestionToAI", question: payload }));
  }

  function clickAIAnswer(responseText) {
    try {
      const cleaned = responseText.replace(/```json|```/g, "").trim();
      const parsed  = JSON.parse(cleaned);
      const raw     = Array.isArray(parsed.answer) ? parsed.answer[0] : parsed.answer;
      const letter  = String(raw).trim().toUpperCase().charAt(0);
      log("AI picked:", letter);
      clickByLetter(letter);
    } catch(e) {
      log("AI parse error:", e.message, "| raw:", responseText);
      clickByLetter(random ? randomLetter() : "A");
    }
  }

  // ── safeClick — fires all events Angular/React needs ──────
  function safeClick(el) {
    if (!el) return;
    log("Clicking:", el.id || el.className.slice(0,30), `"${el.textContent.trim()}"`);
    ["mouseenter","mouseover","mousedown","mouseup","click"].forEach(name => {
      el.dispatchEvent(new MouseEvent(name, { bubbles:true, cancelable:true, view:window }));
    });
    el.click();
  }

  // ── Auto-join ──────────────────────────────────────────────
  function tryAutoJoin() {
    const joinCard = document.querySelector(".course-join-container");
    if (!joinCard) return;

    const isExpanded =
      joinCard.classList.contains("expanded") ||
      joinCard.offsetHeight > 80;
    if (!isExpanded) return;

    const joinBtn =
      document.getElementById("btnJoin") ||
      document.querySelector("button#btnJoin") ||
      document.querySelector(".join-btn") ||
      document.querySelector("[class*='join'] button");

    if (!joinBtn || !isVisible(joinBtn)) return;

    log("Auto-joining!");
    if (notify && !fetchCalled) {
      fetchCalled = true;
      safeChrome(() => {
        chrome.storage.local.get(["email"], ({ email }) => {
          fetch(`${HOST}/notify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, type: "classStart" }),
          })
            .then(r => r.json())
            .finally(() => {
              fetchCalled = false;
              safeClick(joinBtn);
              setTimeout(grabCredentials, 1000);
            });
        });
      });
    } else {
      safeClick(joinBtn);
      setTimeout(grabCredentials, 1000);
    }
  }

  // ── Credentials ────────────────────────────────────────────
  function grabCredentials() {
    access_token = sessionStorage.getItem("access_token") ||
      document.cookie.split("; ").find(r => r.startsWith("access_token"))?.split("=")[1];
    courseId = sessionStorage.getItem("courseId");
    if (courseId && access_token) fetchActivityId();
  }

  function fetchActivityId() {
    if (!courseId || !access_token) return;
    fetch(
      `https://api.iclicker.com/v2/courses/${courseId}/class-sections` +
      `?recordsPerPage=1&pageNumber=1&expandChild=activities&expandChild=userActivities` +
      `&expandChild=attendances&expandChild=questions&expandChild=userQuestions&expandChild=questionGroups`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${access_token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          Origin: "https://student.iclicker.com",
        },
      }
    )
      .then(r => r.json())
      .then(data => {
        const act = data?.[0]?.activities?.[0];
        if (act) { activityId = act._id; log("activityId:", activityId); }
      })
      .catch(e => log("fetchActivityId error:", e.message));
  }

  // ── Helpers ────────────────────────────────────────────────
  function isVisible(el) {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0"
      && (el.offsetWidth > 0 || el.offsetHeight > 0);
  }

  function randomLetter(max) {
    return Object.keys(LETTER_TO_INDEX)[Math.floor(Math.random() * (max || 5))];
  }

  function log(...args) {
    console.log("[ByeClicker]", ...args);
  }

  // ── Stay alive after tab switch ────────────────────────────
  document.addEventListener("visibilitychange", () => {
    if (!alive()) { kill(); return; }
    if (document.visibilityState === "visible" && running) {
      log("Tab back — restarting interval");
      clearInterval(mainInterval);
      mainInterval = setInterval(() => {
        if (!alive()) { kill(); return; }
        mainLoop();
      }, 1500);
      mainLoop();
    }
  });

  // ── SPA URL watcher ────────────────────────────────────────
  let lastUrl = location.href;
  urlInterval = setInterval(() => {
    if (!alive()) { kill(); return; }
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastFingerprint = "";
      answerLock = false;
      log("URL changed:", lastUrl);
      grabCredentials();
    }
  }, 500);

  log("Loaded on:", location.href);
})();

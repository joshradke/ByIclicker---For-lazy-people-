// ============================================================
// content.js — ByeClicker + AI  (BEST COMBINED)
//
// Combines:
//  • MutationObserver (efficient DOM watching) from observer version
//  • alive() / safeChrome() / kill() extension-context guards from interval version
//  • getButtons() with 3 selector strategies + safeClick() from interval version
//  • Fingerprint-based new-question detection from interval version
//  • parseQuestion() with full text extraction from observer version
//  • clickAIAnswer() with text-matching AND letter fallback from observer version
//  • checkAnswer() popularity API from observer version
//  • Notify email flow + auto-join from observer version
//  • SPA URL watcher + visibilitychange restart from interval version
//  • observerActive guard to prevent double-observe
// ============================================================

(function () {
    "use strict";

    const HOST = "https://bye-clicker-api.vercel.app";
    const LETTER_TO_INDEX = { A: 0, B: 1, C: 2, D: 3, E: 4 };

    // ── State ──────────────────────────────────────────────────
    let random = false;
    let autoJoin = false;
    let notify = false;
    let useAI = false;
    let fetchCalled = false;
    let answerLock = false;
    let observerActive = false;
    let lastFingerprint = "";
    let intervalId = null;   // checkAnswer interval
    let urlInterval = null;   // SPA URL watcher
    let targetNode = null;
    let access_token, activity, courseId, activityId, requestOptions;

    // ── Extension context guard ────────────────────────────────
    function alive() {
        try { return !!chrome.runtime.id; }
        catch (e) { return false; }
    }

    function safeChrome(fn) {
        if (!alive()) { kill(); return; }
        try { fn(); }
        catch (e) {
            if (e.message && e.message.includes("Extension context")) { kill(); }
            else { log("chrome error:", e.message); }
        }
    }

    function kill() {
        observerActive = false;
        observer.disconnect();
        clearInterval(intervalId);
        clearInterval(urlInterval);
        intervalId = null;
        log("Extension context lost — stopped. Please reload the page.");
    }

    // ── Observer config ────────────────────────────────────────
    const observerConfig = { attributes: true, childList: true, subtree: true };

    const observer = new MutationObserver((mutationsList) => {
        if (!alive()) { kill(); return; }
        const url = window.location.href;

        for (let mutation of mutationsList) {

            // ── New DOM nodes — question detection ──────────────
            if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
                for (let node of mutation.addedNodes) {
                    if (!(node instanceof Element)) continue;

                    if (
                        url.includes("student.iclicker.com/#/class") &&
                        (url.includes("/poll") || url.includes("/question/"))
                    ) {
                        safeChrome(() => chrome.storage.local.set({ prevPage: "poll" }));

                        if (!activityId) setActivityId();

                        if (node.matches(".question-type-container")) {
                            setTimeout(() => setVariables(), 3000);

                            if (notify && !fetchCalled) {
                                fetchCalled = true;
                                let img = "https://institutional-web-assets-share.s3.amazonaws.com/iClicker/student/images/image_hidden_2.png";
                                const imgContainer = document.querySelector(".question-image-container");

                                setTimeout(() => {
                                    const src = imgContainer?.querySelector("img")?.src;
                                    if (src) img = src;

                                    safeChrome(() => {
                                        chrome.storage.local.get(["email"], ({ email }) => {
                                            fetch(`${HOST}/notify`, {
                                                method: "POST",
                                                headers: { "Content-Type": "application/json" },
                                                body: JSON.stringify({ email, type: "ques", img }),
                                            })
                                                .then(r => r.json())
                                                .finally(() => {
                                                    fetchCalled = false;
                                                    clearInterval(intervalId);
                                                    handleAnswer();
                                                });
                                        });
                                    });
                                }, 1000);
                            } else {
                                clearInterval(intervalId);
                                handleAnswer();
                            }
                        }
                    }
                }
            }

            // ── Attribute changes — aria-hidden for auto-join ───
            if (mutation.type === "attributes" && mutation.attributeName === "aria-hidden") {
                if (
                    url.includes("student.iclicker.com/#/course") &&
                    url.includes("/overview")
                ) {
                    safeChrome(() => {
                        chrome.storage.local.get(["prevPage"], ({ prevPage }) => {
                            if (prevPage === "poll") stopObserver("default");
                        });
                    });

                    if (autoJoin) {
                        const joinCard = document.querySelector(".course-join-container");
                        if (joinCard?.classList.contains("expanded")) {
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
                                                tryClickJoin();
                                                setActivityId();
                                            });
                                    });
                                });
                            } else {
                                tryClickJoin();
                                setActivityId();
                            }
                        }
                    }
                }
            }

            // ── Also detect new questions via fingerprint (belt+suspenders) ─
            if (url.includes("/poll") || url.includes("/question/")) {
                const btns = getButtons();
                if (btns.length >= 2) {
                    const fp = btns.map(b => b.id + (b.getAttribute("aria-pressed") || "")).join("|");
                    if (fp !== lastFingerprint) {
                        lastFingerprint = fp;
                        if (answerLock) {
                            log("Fingerprint changed — resetting lock for new question");
                            answerLock = false;
                        }
                    }
                    if (!answerLock) {
                        answerLock = true;
                        log("Fingerprint detected new question. Will answer in 2.5s...");
                        setTimeout(() => {
                            if (!alive()) return;
                            const currentBtns = getButtons();
                            if (currentBtns.length) handleAnswer();
                            else answerLock = false;
                        }, 2500);
                    }
                }
            }
        }
    });

    // ── Boot ───────────────────────────────────────────────────
    safeChrome(() => {
        chrome.storage.local.get(["notify", "random", "autoJoin", "useAI", "status"], (r) => {
            notify = !!r.notify;
            random = !!r.random;
            autoJoin = !!r.autoJoin;
            useAI = !!r.useAI;
            if (r.status === "started") {
                log("Auto-resuming after page load / tab switch");
                setTimeout(() => startObserver(), 500);
            }
        });
    });

    // ── Message listener ───────────────────────────────────────
    safeChrome(() => {
        chrome.runtime.onMessage.addListener((message) => {
            if (!alive()) { kill(); return; }

            // AI responses
            if (message.type === "processAIResponse") {
                log("AI response received:", message.response);
                clickAIAnswer(message.response);
                return;
            }
            if (message.type === "aiFallback") {
                log("AI fallback:", message.reason);
                selectAnswer();
                return;
            }

            // Popup messages
            if (message.from !== "popup") return;
            const url = window.location.href;

            if (message.msg === "start") {
                if (
                    url.includes("student.iclicker.com/#/class") &&
                    (url.includes("/poll") || url.includes("/question/"))
                ) {
                    setTimeout(() => setVariables(), 3000);
                    clearInterval(intervalId);
                    answerLock = false;
                    handleAnswer();
                } else if (
                    url.includes("student.iclicker.com/#/course") &&
                    url.includes("/overview") &&
                    autoJoin
                ) {
                    const joinCard = document.querySelector(".course-join-container");
                    if (joinCard?.classList.contains("expanded")) {
                        tryClickJoin();
                        setActivityId();
                    }
                }
                startObserver();

            } else if (message.msg === "stop") {
                stopObserver("manual");
            } else if (message.msg === "random") {
                random = !random;
                safeChrome(() => chrome.storage.local.set({ random }));
            } else if (message.msg === "autoJoin") {
                autoJoin = !autoJoin;
                safeChrome(() => chrome.storage.local.set({ autoJoin }));
            } else if (message.msg === "notify") {
                notify = !notify;
                safeChrome(() => chrome.storage.local.set({ email: message.email, notify }));
            } else if (message.msg === "useAI") {
                useAI = !useAI;
                safeChrome(() => chrome.storage.local.set({ useAI }));
            }
        });
    });

    // ── Answer dispatch ────────────────────────────────────────
    function handleAnswer() {
        if (useAI) {
            tryAIAnswer();
        } else {
            selectAnswer();
        }
    }

    // ── AI path ───────────────────────────────────────────────
    function tryAIAnswer() {
        const qData = parseQuestion();
        if (!qData) {
            log("Could not parse question — falling back to auto-click.");
            selectAnswer();
            return;
        }
        log("Sending to AI:", qData);
        safeChrome(() => chrome.runtime.sendMessage({ type: "sendQuestionToAI", question: qData }));
    }

    /**
     * Parse the visible question text and answer options.
     * Returns { type, question, options, previousCorrection } or null.
     */
    function parseQuestion() {
        // Try multiple selectors for question text
        const questionEl = document.querySelector(
            ".center-buttons h1, .question-text, .question-content, .poll-question, h2.question"
        );
        const questionText = questionEl ? questionEl.textContent.trim() : "";

        // Collect answer options — prefer btn-container text, fall back to button labels
        const btnContainers = document.querySelectorAll(".btn-container");
        const options = [];
        if (btnContainers.length) {
            btnContainers.forEach((c) => {
                const label = c.querySelector(".answer-text, .choice-text, span, p") || c;
                options.push(label.textContent.trim());
            });
        } else {
            // Fall back to getButtons() labels
            getButtons().forEach((b, i) => {
                options.push(b.textContent.trim() || Object.keys(LETTER_TO_INDEX)[i] || String(i + 1));
            });
        }

        if (!questionText && options.length === 0) return null;

        return {
            type: "multiple_choice",
            question: questionText || "Select the best answer.",
            options,
            previousCorrection: null,
        };
    }

    /**
     * Parse AI JSON response and click the matching button.
     * Tries text-match first, then letter index, then falls back to A.
     */
    function clickAIAnswer(responseText) {
        try {
            const cleaned = responseText.replace(/```json|```/g, "").trim();
            const parsed = JSON.parse(cleaned);
            const raw = Array.isArray(parsed.answer) ? parsed.answer[0] : parsed.answer;
            const answer = String(raw).trim();
            const letter = answer.toUpperCase().charAt(0);
            log("AI picked:", answer);

            // First try: match by button text content
            const containers = document.querySelectorAll(".btn-container");
            let clicked = false;
            containers.forEach((btn) => {
                const label = btn.querySelector(".answer-text, .choice-text, span, p") || btn;
                const text = label.textContent.trim();
                if (
                    text === answer ||
                    text.replace(/\.$/, "") === answer.replace(/\.$/, "") ||
                    text.startsWith(answer)
                ) {
                    setTimeout(() => safeClick(btn.children[0] || btn), 500);
                    clicked = true;
                }
            });
            if (clicked) return;

            // Second try: click by letter A/B/C/D/E using exact ID or index
            clickByLetter(letter);

        } catch (e) {
            log("AI parse error:", e.message, "| raw:", responseText);
            selectAnswer();
        }
    }

    // ── Get answer buttons — 3-strategy selector ──────────────
    function getButtons() {
        // Method 1: exact IDs from real iClicker DOM
        const byId = ["a", "b", "c", "d", "e"]
            .map(l => document.getElementById(`multiple-choice-${l}`))
            .filter(el => el && !el.disabled && isVisible(el));
        if (byId.length >= 2) return byId;

        // Method 2: button.btn inside .btn-container
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

    // ── Click by letter A/B/C/D/E ─────────────────────────────
    function clickByLetter(letter, btns) {
        const L = (letter || "A").toUpperCase().charAt(0);

        const byId = document.getElementById(`multiple-choice-${L.toLowerCase()}`);
        if (byId && !byId.disabled && isVisible(byId)) {
            log(`Clicking #multiple-choice-${L.toLowerCase()}`);
            safeClick(byId);
            return;
        }

        const buttons = btns || getButtons();
        const idx = LETTER_TO_INDEX[L] ?? 0;
        if (buttons[idx]) {
            log(`Clicking index ${idx} for letter ${L}`);
            safeClick(buttons[idx]);
        }
    }

    /**
     * Original ByeClicker fallback: click option A (or random).
     */
    function selectAnswer() {
        const btns = getButtons();
        if (!btns.length) {
            // Also try .btn-container children fallback
            const containers = document.querySelectorAll(".btn-container");
            if (!containers.length) return;
            const idx = random ? Math.floor(Math.random() * containers.length) : 0;
            setTimeout(() => safeClick(containers[idx]?.children[0] || containers[idx]), 5000);
            return;
        }
        const letter = random ? randomLetter(btns.length) : "A";
        setTimeout(() => clickByLetter(letter, btns), 5000);
    }

    // ── safeClick — fires all events Angular/React needs ──────
    function safeClick(el) {
        if (!el) return;
        log("Clicking:", el.id || el.className?.slice(0, 30), `"${el.textContent?.trim()}"`);
        ["mouseenter", "mouseover", "mousedown", "mouseup", "click"].forEach(name => {
            el.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true, view: window }));
        });
        el.click();
    }

    // ── Auto-join helper ───────────────────────────────────────
    function tryClickJoin() {
        const joinBtn =
            document.getElementById("btnJoin") ||
            document.querySelector("button#btnJoin") ||
            document.querySelector(".join-btn") ||
            document.querySelector("[class*='join'] button");
        if (joinBtn && isVisible(joinBtn)) {
            log("Clicking join button");
            safeClick(joinBtn);
        } else {
            log("Join button not found");
        }
    }

    // ── Credentials + activityId ───────────────────────────────
    function setVariables() {
        access_token = sessionStorage.getItem("access_token");
        if (!access_token) {
            access_token = document.cookie
                .split("; ")
                .find(r => r.startsWith("access_token"))
                ?.split("=")[1];
        }
        courseId = sessionStorage.getItem("courseId");
        if (!courseId || !access_token) return;
        requestOptions = {
            method: "GET",
            headers: {
                Authorization: `Bearer ${access_token}`,
                Accept: "application/json",
                "Content-Type": "application/json",
                Origin: "https://student.iclicker.com",
            },
        };
    }

    function setActivityId() {
        const cId = sessionStorage.getItem("courseId");
        const tok = sessionStorage.getItem("access_token") ||
            document.cookie.split("; ").find(r => r.startsWith("access_token"))?.split("=")[1];
        if (!cId || !tok) return;

        fetch(
            `https://api.iclicker.com/v2/courses/${cId}/class-sections` +
            `?recordsPerPage=1&pageNumber=1&expandChild=activities&expandChild=userActivities` +
            `&expandChild=attendances&expandChild=questions&expandChild=userQuestions&expandChild=questionGroups`,
            {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${tok}`,
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    Origin: "https://student.iclicker.com",
                },
            }
        )
            .then(r => r.json())
            .then(data => {
                activity = data?.[0]?.activities?.[0];
                if (activity) { activityId = activity._id; log("activityId:", activityId); }
            })
            .catch(e => log("setActivityId error:", e.message));
    }

    /**
     * Poll the iClicker API and click the most popular answer.
     * Only used when checkAnswer mode is invoked.
     */
    function checkAnswer(btns, optionIndex) {
        if (!requestOptions || !courseId || !activityId) {
            btns[optionIndex]?.children[0]?.click();
            return;
        }
        intervalId = setInterval(() => {
            fetch(
                `https://api.iclicker.com/v2/reporting/courses/${courseId}/activities/${activityId}/questions/view`,
                requestOptions
            )
                .then(r => r.json())
                .then(data => {
                    const answerOverview = data.questions[data.questions.length - 1].answerOverview;
                    if (answerOverview.length === 0) {
                        btns[optionIndex]?.children[0]?.click();
                        return;
                    }
                    const best = answerOverview.reduce((max, cur) =>
                        cur.percentageOfTotalResponses > max.percentageOfTotalResponses ? cur : max
                    );
                    btns[LETTER_TO_INDEX[best.answer]]?.children[0]?.click();
                })
                .catch(console.error);
        }, 5000);
    }

    // ── Start / Stop observer ──────────────────────────────────
    function startObserver() {
        targetNode = document.querySelector("#wrapper");
        if (!targetNode) { log("No #wrapper found — retrying in 1s"); setTimeout(startObserver, 1000); return; }

        if (observerActive) observer.disconnect();
        observer.observe(targetNode, observerConfig);
        observerActive = true;

        const url = window.location.href;
        safeChrome(() => {
            chrome.storage.local.set({ status: "started" });
            chrome.storage.local.set({ prevPage: url.includes("#/course") ? "courses" : "poll" });
        });
        log("▶ Observer started/resumed on:", url);
    }

    function stopObserver(status) {
        observer.disconnect();
        observerActive = false;
        clearInterval(intervalId);
        answerLock = false;
        lastFingerprint = "";
        log("■ Observer stopped, reason:", status);

        if (status === "default") {
            safeChrome(() => chrome.storage.local.remove("status"));
            if (notify && !fetchCalled) {
                fetchCalled = true;
                safeChrome(() => {
                    chrome.storage.local.get(["email"], ({ email }) => {
                        fetch(`${HOST}/notify`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ email, type: "classEnd" }),
                        })
                            .then(r => r.json())
                            .finally(() => {
                                fetchCalled = false;
                                window.location.reload();
                            });
                    });
                });
            }
        } else {
            safeChrome(() => chrome.storage.local.set({ status: "stopped" }));
        }
    }

    // ── Helpers ────────────────────────────────────────────────
    function isVisible(el) {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0"
            && (el.offsetWidth > 0 || el.offsetHeight > 0);
    }

    function randomLetter(max) {
        return Object.keys(LETTER_TO_INDEX)[Math.floor(Math.random() * (max || 4))];
    }

    function log(...args) { console.log("[ByeClicker]", ...args); }

    // ── Stay alive after tab switch ────────────────────────────
    document.addEventListener("visibilitychange", () => {
        if (!alive()) { kill(); return; }
        if (document.visibilityState === "visible") {
            safeChrome(() => {
                chrome.storage.local.get(["status"], ({ status }) => {
                    if (status === "started" && !observerActive) {
                        log("Tab visible again — resuming observer");
                        startObserver();
                    }
                });
            });
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
            setVariables();
            // Re-attach observer to new page's #wrapper
            if (observerActive) {
                const newWrapper = document.querySelector("#wrapper");
                if (newWrapper && newWrapper !== targetNode) {
                    targetNode = newWrapper;
                    observer.disconnect();
                    observer.observe(targetNode, observerConfig);
                    log("Re-attached observer to new #wrapper");
                }
            }
        }
    }, 500);

    log("Loaded on:", location.href);
})();
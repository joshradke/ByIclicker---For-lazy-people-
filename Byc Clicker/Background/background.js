// ============================================================
// background.js — ByeClicker v2.0
//
// Changes from original:
//  • keepalive ping handler — keeps service worker alive so
//    answers are never dropped when iClicker tab is in background
//  • Routes sendQuestionToAI (image + text questions) to AI tab
//  • Debug logging so you can see answers routing in DevTools
//  • Gemini + DeepSeek host_permissions added
// ============================================================

function updateActionForTab(tabId, url) {
    if (!url) return;
    const isSupported = url.includes("student.iclicker.com");
    const iconSuffix  = isSupported ? "" : "-disabled";
    const paths = ["16","32","48","128"].reduce((o, s) => {
        o[s] = `./assets/logo${iconSuffix}-${s}.png`;
        return o;
    }, {});
    if (isSupported) chrome.action.enable(tabId);
    else             chrome.action.disable(tabId);
    chrome.action.setIcon({ path: paths, tabId });
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return;
        updateActionForTab(tabId, tab.url);
    });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.active && changeInfo.status === "complete" && tab.url) {
        updateActionForTab(tabId, tab.url);
    }
});

function getAITabUrl(model) {
    return {
        chatgpt:  "https://chatgpt.com/*",
        gemini:   "https://gemini.google.com/*",
        deepseek: "https://chat.deepseek.com/*",
    }[model] || "https://chatgpt.com/*";
}

// ── Service worker keepalive + message router ──────────────
// Chrome kills the background service worker after ~30s idle.
// content.js pings every 20s to keep it awake so answers are
// never dropped while the iClicker tab is in the background.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // Keepalive ping from content.js
    if (message.type === "keepalive") {
        sendResponse({ alive: true });
        return true;
    }

    // Open settings page
    if (message.type === "openSettings") {
        chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
        return;
    }

    // iClicker → AI tab (handles both image and text questions)
    if (message.type === "sendQuestionToAI") {
        chrome.storage.sync.get("aiModel", ({ aiModel }) => {
            const model  = aiModel || "chatgpt";
            const tabUrl = getAITabUrl(model);
            chrome.tabs.query({ url: tabUrl }, (tabs) => {
                if (!tabs.length) {
                    console.warn(`[ByeClicker BG] No ${model} tab found`);
                    if (sender.tab) {
                        chrome.tabs.sendMessage(sender.tab.id, {
                            type: "aiFallback",
                            reason: `No ${model} tab open. Open ${model} in another tab first.`,
                        });
                    }
                    sendResponse({ success: false });
                    return;
                }
                console.log(`[ByeClicker BG] Sending question to ${model} tab`);
                chrome.tabs.sendMessage(
                    tabs[0].id,
                    { type: "receiveQuestion", question: message.question },
                    (resp) => sendResponse(resp || { success: true })
                );
            });
        });
        return true;
    }

    // McGraw Hill → AI tab (kept for compatibility)
    if (message.type === "sendQuestionToChatGPT") {
        chrome.storage.sync.get("aiModel", ({ aiModel }) => {
            const model  = aiModel || "chatgpt";
            const tabUrl = getAITabUrl(model);
            chrome.tabs.query({ url: tabUrl }, (tabs) => {
                if (!tabs.length) return;
                chrome.tabs.sendMessage(tabs[0].id, {
                    type: "receiveQuestion",
                    question: message.question,
                });
            });
        });
        return;
    }

    // AI tab → iClicker (answer comes back here from bridge)
    if (
        message.type === "chatGPTResponse"  ||
        message.type === "geminiResponse"   ||
        message.type === "deepseekResponse"
    ) {
        console.log("[ByeClicker BG] Answer received, routing to iClicker:", message.response);
        chrome.tabs.query({ url: "https://student.iclicker.com/*" }, (tabs) => {
            if (!tabs.length) {
                console.warn("[ByeClicker BG] No iClicker tab found to send answer to!");
                return;
            }
            tabs.forEach(t =>
                chrome.tabs.sendMessage(t.id, {
                    type: "processAIResponse",
                    response: message.response,
                })
            );
        });
        // Also route to McGraw Hill if open (kept for compatibility)
        chrome.tabs.query({ url: "https://*.mheducation.com/*" }, (tabs) => {
            tabs.forEach(t =>
                chrome.tabs.sendMessage(t.id, {
                    type: "processChatGPTResponse",
                    response: message.response,
                })
            );
        });
        return;
    }
});

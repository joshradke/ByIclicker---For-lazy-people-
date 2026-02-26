// ============================================================
// background.js — Merged ByeClicker + Auto-McGraw  (FINAL)
// Handles: tab icons, AI message routing for both sites,
//          settings page opener
// ============================================================

function updateActionForTab(tabId, url) {
  if (!url) return;
  const isSupported =
    url.includes("student.iclicker.com") ||
    url.includes("mheducation.com");

  const iconSuffix = isSupported ? "" : "-disabled";
  const paths = ["16","32","48","128"].reduce((o,s) => {
    o[s] = `./assets/logo${iconSuffix}-${s}.png`;
    return o;
  }, {});

  if (isSupported) {
    chrome.action.enable(tabId);
  } else {
    chrome.action.disable(tabId);
  }
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Open settings page
  if (message.type === "openSettings") {
    chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
    return;
  }

  // iClicker content.js -> AI tab
  if (message.type === "sendQuestionToAI") {
    chrome.storage.sync.get("aiModel", ({ aiModel }) => {
      const model  = aiModel || "chatgpt";
      const tabUrl = getAITabUrl(model);
      chrome.tabs.query({ url: tabUrl }, (tabs) => {
        if (!tabs.length) {
          if (sender.tab) {
            chrome.tabs.sendMessage(sender.tab.id, {
              type: "aiFallback",
              reason: `No ${model} tab found. Open it to use AI answering.`,
            });
          }
          sendResponse({ success: false });
          return;
        }
        chrome.tabs.sendMessage(
          tabs[0].id,
          { type: "receiveQuestion", question: message.question },
          (resp) => sendResponse(resp || { success: true })
        );
      });
    });
    return true;
  }

  // McGraw Hill mheducation.js -> AI tab
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

  // AI tab -> content pages (both iClicker and McGraw Hill)
  if (
    message.type === "chatGPTResponse"  ||
    message.type === "geminiResponse"   ||
    message.type === "deepseekResponse"
  ) {
    // Route to iClicker
    chrome.tabs.query({ url: "https://student.iclicker.com/*" }, (tabs) => {
      tabs.forEach((t) =>
        chrome.tabs.sendMessage(t.id, {
          type: "processAIResponse",
          response: message.response,
        })
      );
    });
    // Route to McGraw Hill
    chrome.tabs.query({ url: "https://*.mheducation.com/*" }, (tabs) => {
      tabs.forEach((t) =>
        chrome.tabs.sendMessage(t.id, {
          type: "processChatGPTResponse",
          response: message.response,
        })
      );
    });
    return;
  }
});

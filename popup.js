// ============================================================
// popup.js — Merged ByeClicker + AI
// ============================================================

const startBtn   = document.getElementById("start-btn");
const stopBtn    = document.getElementById("stop-btn");
const runStatus  = document.getElementById("runStatus");
const container  = document.getElementById("container");
const randomBtn  = document.getElementById("random");
const autoJoinBtn = document.getElementById("autoJoin");
const notifyBtn  = document.getElementById("notify");
const emailInput = document.getElementById("email");
const useAIBtn   = document.getElementById("useAI");
const aiModelGroup = document.getElementById("ai-model-group");
const aiStatus   = document.getElementById("ai-status");
const openSettingsLink = document.getElementById("open-settings");

const modelPills = document.querySelectorAll(".model-pill");

// ── Persist email ──────────────────────────────────────────
emailInput.addEventListener("input", () => {
  chrome.storage.local.set({ email: emailInput.value });
});

// ── Open settings page ─────────────────────────────────────
openSettingsLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.sendMessage({ type: "openSettings" });
});

// ── AI model pill selection ────────────────────────────────
modelPills.forEach((pill) => {
  pill.addEventListener("click", () => {
    const model = pill.dataset.model;
    chrome.storage.sync.set({ aiModel: model }, () => {
      updateActivePill(model);
      checkAITabStatus(model);
    });
  });
});

function updateActivePill(model) {
  modelPills.forEach((p) => {
    p.classList.toggle("active", p.dataset.model === model);
  });
}

function checkAITabStatus(model) {
  const urlMap = {
    chatgpt:  "https://chatgpt.com/*",
    gemini:   "https://gemini.google.com/*",
    deepseek: "https://chat.deepseek.com/*",
  };
  const nameMap = {
    chatgpt: "ChatGPT", gemini: "Gemini", deepseek: "DeepSeek",
  };
  chrome.tabs.query({ url: urlMap[model] }, (tabs) => {
    if (tabs.length > 0) {
      aiStatus.textContent = `✓ ${nameMap[model]} tab is open`;
      aiStatus.style.color = "#4caf50";
    } else {
      aiStatus.textContent = `✗ Open ${nameMap[model]} in another tab first`;
      aiStatus.style.color = "#f44336";
    }
  });
}

// ── Use AI toggle ──────────────────────────────────────────
useAIBtn.addEventListener("change", () => {
  const enabled = useAIBtn.checked;
  aiModelGroup.style.display = enabled ? "block" : "none";

  if (enabled) {
    chrome.storage.sync.get("aiModel", ({ aiModel }) => {
      const model = aiModel || "chatgpt";
      updateActivePill(model);
      checkAITabStatus(model);
    });
  }
});

// ── DOMContentLoaded — restore state ──────────────────────
document.addEventListener("DOMContentLoaded", () => {

  // Running status
  chrome.storage.local.get(["status"], ({ status }) => {
    if (status === "started") {
      startBtn.style.display = "none";
      runStatus.style.display = "block";
      stopBtn.style.display   = "block";
      runStatus.style.transform = "scale(0)";
      setTimeout(() => {
        runStatus.style.transition  = "0.5s";
        runStatus.style.transform   = "scale(1)";
        stopBtn.style.transition    = "0.5s";
        stopBtn.style.transform     = "scale(1)";
      }, 100);
    } else {
      runStatus.style.display = "none";
      document.getElementById("form").style.marginTop = "30px";
      startBtn.style.display = "block";
      startBtn.style.transition = "0.5s";
      startBtn.style.transform  = "scale(1)";
      stopBtn.style.display = "none";
    }
  });

  // Checkbox states
  chrome.storage.local.get(["random"],   ({ random })   => { randomBtn.checked   = !!random;   });
  chrome.storage.local.get(["autoJoin"], ({ autoJoin }) => { autoJoinBtn.checked  = !!autoJoin; });
  chrome.storage.local.get(["notify"],   ({ notify })   => { notifyBtn.checked    = !!notify;   });
  chrome.storage.local.get(["email"],    ({ email })    => { emailInput.value     = email || ""; });

  // AI state
  chrome.storage.local.get(["useAI"], ({ useAI }) => {
    useAIBtn.checked = !!useAI;
    if (useAI) {
      aiModelGroup.style.display = "block";
      chrome.storage.sync.get("aiModel", ({ aiModel }) => {
        const model = aiModel || "chatgpt";
        updateActivePill(model);
        checkAITabStatus(model);
      });
    }
  });
});

// ── Main tab logic ─────────────────────────────────────────
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];

  if (!tab.url || tab.url.startsWith("chrome")) {
    container.innerHTML = "<h1>ByeClicker can't access Chrome Pages</h1>";
    return;
  }
  if (tab.url.startsWith("file")) {
    container.innerHTML = "<h1>ByeClicker can't access local files</h1>";
    return;
  }
  if (!tab.url.includes("student.iclicker.com")) {
    container.innerHTML = "<h1>ByeClicker works only on iClicker pages</h1>";
    return;
  }

  // ── Start ─────────────────────────────────────────────────
  startBtn.addEventListener("click", () => {
    startBtn.style.transition = "0.5s";
    startBtn.style.transform  = "scale(0)";
    setTimeout(() => {
      startBtn.style.display  = "none";
      runStatus.style.display = "block";
      stopBtn.style.display   = "block";
      runStatus.style.transform = "scale(0)";
      setTimeout(() => {
        runStatus.style.transition = "0.5s";
        runStatus.style.transform  = "scale(1)";
        stopBtn.style.transition   = "0.5s";
        stopBtn.style.transform    = "scale(1)";
      }, 100);
    }, 500);
    chrome.tabs.sendMessage(tab.id, { from: "popup", msg: "start" });
  });

  // ── Stop ──────────────────────────────────────────────────
  stopBtn.addEventListener("click", () => {
    runStatus.style.transition = "0.5s";
    runStatus.style.transform  = "scale(0)";
    stopBtn.style.transition   = "0.5s";
    stopBtn.style.transform    = "scale(0)";
    setTimeout(() => {
      document.getElementById("form").style.marginTop = "30px";
      runStatus.style.display = "none";
      stopBtn.style.display   = "none";
      startBtn.style.display  = "block";
      startBtn.style.transform = "scale(0)";
      setTimeout(() => {
        startBtn.style.transition = "0.5s";
        startBtn.style.transform  = "scale(1)";
      }, 100);
    }, 500);
    chrome.tabs.sendMessage(tab.id, { from: "popup", msg: "stop" });
  });

  // ── Toggles ───────────────────────────────────────────────
  randomBtn.addEventListener("click", () => {
    chrome.tabs.sendMessage(tab.id, { from: "popup", msg: "random" });
  });
  autoJoinBtn.addEventListener("click", () => {
    chrome.tabs.sendMessage(tab.id, { from: "popup", msg: "autoJoin" });
  });
  notifyBtn.addEventListener("click", () => {
    chrome.tabs.sendMessage(tab.id, {
      from: "popup", msg: "notify", email: emailInput.value,
    });
  });
  useAIBtn.addEventListener("click", () => {
    chrome.tabs.sendMessage(tab.id, { from: "popup", msg: "useAI" });
  });
});

// ============================================================
// chatgpt-bridge.js — runs inside the ChatGPT tab
// Receives a question from background.js, types it into the
// ChatGPT input, waits for the response, and sends it back.
// ============================================================
(function () {
  "use strict";

  const MC_SYSTEM_PROMPT =
    'You are answering a multiple-choice poll question. ' +
    'Reply ONLY with valid JSON like {"answer":"B"} — ' +
    'no explanation, no markdown, just the JSON object. ' +
    'Pick the single best letter answer.';

  const NUMERIC_SYSTEM_PROMPT =
    'You are answering a numeric free-response question from a physics/science class. ' +
    'Solve the problem and reply ONLY with valid JSON like {"answer":"42.5"} — ' +
    'the value should be the numeric answer as a plain number string (digits and decimal point only, no units). ' +
    'No explanation, no markdown, just the JSON object.';

  function alive() {
    try { return !!chrome.runtime.id; } catch(e) { return false; }
  }

  // Build the full prompt string to type into ChatGPT
  function buildPrompt(qData) {
    const isNumeric = qData.type === 'numeric';

    if (isNumeric) {
      let text = NUMERIC_SYSTEM_PROMPT + '\n\n';
      text += 'Question:\n' + (qData.question || '') + '\n';
      if (qData.instruction) text += '\n' + qData.instruction;
      text += '\n\nRespond with JSON only: {"answer":"<number>"}';
      return text;
    }

    // Multiple choice
    let text = MC_SYSTEM_PROMPT + '\n\n';
    if (qData.question) text += 'Question: ' + qData.question + '\n';
    if (qData.options && qData.options.length) {
      const letters = ['A','B','C','D','E'];
      qData.options.forEach((opt, i) => {
        text += (letters[i] || String(i+1)) + ') ' + opt + '\n';
      });
    }
    text += '\nRespond with JSON only: {"answer":"<letter>"}';
    return text;
  }

  // Type text into the ChatGPT textarea using React's synthetic event system
  function typeIntoInput(el, text) {
    el.focus();
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'value')?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, text);
    } else {
      el.value = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Find the ChatGPT send button and click it
  function clickSend() {
    const btn =
      document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label="Send message"]') ||
      document.querySelector('button[aria-label="Send prompt"]') ||
      document.querySelector('form button[type="submit"]');
    if (btn && !btn.disabled) {
      btn.click();
      return true;
    }
    return false;
  }

  // Find the textarea / contenteditable input
  function getInput() {
    return (
      document.querySelector('#prompt-textarea') ||
      document.querySelector('textarea[placeholder]') ||
      document.querySelector('[contenteditable="true"][data-id]') ||
      document.querySelector('div[contenteditable="true"]')
    );
  }

  // Wait for the streaming response to finish (stop button disappears)
  function waitForResponse(cb, timeout = 60000) {
    const start = Date.now();
    const poll = setInterval(() => {
      const stopBtn =
        document.querySelector('button[aria-label="Stop generating"]') ||
        document.querySelector('button[data-testid="stop-button"]');
      const elapsed = Date.now() - start;
      if (!stopBtn && elapsed > 2000) {
        clearInterval(poll);
        cb();
      }
      if (elapsed > timeout) {
        clearInterval(poll);
        cb();
      }
    }, 800);
  }

  // Extract the last assistant message text
  function getLastResponse() {
    const messages = document.querySelectorAll(
      '[data-message-author-role="assistant"], ' +
      '.markdown, ' +
      '[class*="message"]:not([class*="user"])'
    );
    if (!messages.length) return '';
    const last = messages[messages.length - 1];
    return last.textContent.trim();
  }

  // Parse whatever the AI returned and extract an answer (letter or number)
  function extractAnswer(rawText) {
    // Try JSON with answer field first (handles both letters and numbers)
    const jsonMatch = rawText.match(/\{[^}]*"answer"\s*:\s*"([^"]+)"[^}]*\}/);
    if (jsonMatch) {
      return JSON.stringify({ answer: jsonMatch[1] });
    }
    // Numeric answer fallback (e.g. 968555.66)
    const numMatch = rawText.match(/\b(\d[\d.eE+\-]*)\b/);
    if (numMatch) {
      return JSON.stringify({ answer: numMatch[1] });
    }
    // Letter answer fallback
    const letterMatch = rawText.match(/\b([A-E])\b/);
    if (letterMatch) {
      return JSON.stringify({ answer: letterMatch[1].toUpperCase() });
    }
    return JSON.stringify({ answer: 'A' });
  }

  // Main handler: receive question → type → wait → extract → send back
  function handleQuestion(qData) {
    console.log('[ByeClicker-ChatGPT] Received question:', qData);
    const prompt = buildPrompt(qData);

    setTimeout(() => {
      const input = getInput();
      if (!input) {
        console.warn('[ByeClicker-ChatGPT] Could not find input box');
        return;
      }

      if (input.getAttribute('contenteditable') === 'true') {
        input.focus();
        input.textContent = prompt;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        typeIntoInput(input, prompt);
      }

      setTimeout(() => {
        const sent = clickSend();
        if (!sent) {
          console.warn('[ByeClicker-ChatGPT] Could not find/click send button');
          return;
        }

        waitForResponse(() => {
          const raw    = getLastResponse();
          const answer = extractAnswer(raw);
          console.log('[ByeClicker-ChatGPT] Sending answer back:', answer);
          if (alive()) {
            chrome.runtime.sendMessage({
              type: 'chatGPTResponse',
              response: answer,
            });
          }
        });
      }, 600);
    }, 500);
  }

  if (alive()) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'receiveQuestion') {
        handleQuestion(message.question);
      }
    });
    console.log('[ByeClicker-ChatGPT] Bridge ready on ChatGPT tab');
  }
})();

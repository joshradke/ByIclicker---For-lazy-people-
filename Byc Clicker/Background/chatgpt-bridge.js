// ============================================================
// chatgpt-bridge.js — ByeClicker v2.4
//
// KEY FIXES in v2.4:
//  • setInputText() now uses clipboard-based paste (most reliable
//    method for modern ChatGPT's ProseMirror/Lexical editor).
//    Falls back to execCommand, then direct assignment.
//  • clickSend() retries longer and targets the new ChatGPT
//    send button (data-testid="send-button" is still correct,
//    but also targets the new composer submit button).
//  • Image short-answer: if imageUrl fetch fails from ChatGPT
//    tab (CORS), falls back to text-only immediately instead of
//    hanging.
//  • Added console logs so you can confirm the bridge is firing.
// ============================================================
(function () {
    "use strict";

    const SENTINEL = "BYECLICKER_" + Date.now();

    // ── Prompts ────────────────────────────────────────────────
    const MC_PROMPT =
        'You are answering a multiple-choice poll question. ' +
        'Reply ONLY with valid JSON like {"answer":"B"} — ' +
        'no explanation, no markdown, just the JSON object. ' +
        'Pick the single best letter answer.';

    const NUMERIC_PROMPT =
        'You are answering a numeric free-response question from a physics/science class. ' +
        'Solve the problem and reply ONLY with valid JSON like {"answer":"42.5"} — ' +
        'digits and decimal only, no units, no explanation, no markdown.';

    const SHORT_ANSWER_PROMPT =
        'You are answering a short free-response question for a class poll. ' +
        'Give a concise answer (a word, phrase, or number). ' +
        'Reply ONLY with valid JSON like {"answer":"your answer here"} — ' +
        'no explanation, no markdown, just the JSON object.';

    const IMG_MC_PROMPT =
        'This image shows a multiple-choice poll question. ' +
        'Pick the single best answer letter (A, B, C, D, or E). ' +
        'Reply ONLY with valid JSON like {"answer":"B"} — no explanation, no markdown.';

    const IMG_SHORT_PROMPT =
        'This image shows a short free-response question. ' +
        'Give a concise answer (word, phrase, or number). ' +
        'Reply ONLY with valid JSON like {"answer":"your answer"} — no explanation, no markdown.';

    // ── Alive guard ────────────────────────────────────────────
    function alive() {
        try { return !!chrome.runtime.id; } catch (e) { return false; }
    }

    // ── Build text-only prompt ─────────────────────────────────
    function buildTextPrompt(qData) {
        const S = '\n' + SENTINEL;

        if (qData.type === 'numeric') {
            let t = NUMERIC_PROMPT + '\n\nQuestion:\n' + (qData.question || '');
            if (qData.instruction) t += '\n' + qData.instruction;
            return t + '\n\nRespond with JSON only: {"answer":"<number>"}' + S;
        }
        if (qData.type === 'short_answer') {
            let t = SHORT_ANSWER_PROMPT + '\n\nQuestion:\n' + (qData.question || '');
            if (qData.instruction) t += '\n' + qData.instruction;
            return t + '\n\nRespond with JSON only: {"answer":"<your answer>"}' + S;
        }
        // Multiple choice
        let t = MC_PROMPT + '\n\n';
        if (qData.question) t += 'Question: ' + qData.question + '\n';
        if (qData.options?.length) {
            ['A', 'B', 'C', 'D', 'E'].forEach((l, i) => {
                if (qData.options[i] != null) t += l + ') ' + qData.options[i] + '\n';
            });
        }
        return t + '\nRespond with JSON only: {"answer":"<letter>"}' + S;
    }

    // ── DOM helpers ────────────────────────────────────────────
    function getInput() {
        return (
            document.querySelector('#prompt-textarea') ||
            document.querySelector('div[contenteditable="true"][data-lexical-editor]') ||
            document.querySelector('div[contenteditable="true"][id*="prompt"]') ||
            document.querySelector('div[contenteditable="true"]') ||
            document.querySelector('textarea[placeholder]')
        );
    }

    // ── The key fix: use clipboard to inject text ──────────────
    // execCommand('insertText') is deprecated and blocked in Brave/Chrome 120+.
    // Writing to the clipboard and dispatching a paste event is the most
    // reliable way to inject text into a ProseMirror / Lexical editor.
    async function setInputText(text) {
        const el = getInput();
        if (!el) { console.warn('[ByeClicker] No input element found'); return false; }

        el.focus();

        // Strategy 1: clipboard write + paste event (most reliable for new ChatGPT)
        try {
            await navigator.clipboard.writeText(text);
            // Select all existing content first so we replace it
            document.execCommand('selectAll', false, null);
            // Dispatch paste — Lexical/ProseMirror listens to this
            document.execCommand('paste');
            await new Promise(r => setTimeout(r, 150));
            // Verify it worked
            const content = el.textContent || el.value || '';
            if (content.trim().length > 5) {
                console.log('[ByeClicker] Text set via clipboard paste ✓');
                return true;
            }
        } catch (e) {
            console.warn('[ByeClicker] Clipboard strategy failed:', e.message);
        }

        // Strategy 2: execCommand insertText (works in some contexts)
        try {
            el.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            const inserted = document.execCommand('insertText', false, text);
            await new Promise(r => setTimeout(r, 150));
            const content = el.textContent || el.value || '';
            if (inserted && content.trim().length > 5) {
                console.log('[ByeClicker] Text set via execCommand ✓');
                return true;
            }
        } catch (e) {
            console.warn('[ByeClicker] execCommand strategy failed:', e.message);
        }

        // Strategy 3: DataTransfer paste event (works for some editors)
        try {
            el.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            el.dispatchEvent(new ClipboardEvent('paste', {
                bubbles: true, cancelable: true, clipboardData: dt
            }));
            await new Promise(r => setTimeout(r, 200));
            const content = el.textContent || el.value || '';
            if (content.trim().length > 5) {
                console.log('[ByeClicker] Text set via DataTransfer paste ✓');
                return true;
            }
        } catch (e) {
            console.warn('[ByeClicker] DataTransfer strategy failed:', e.message);
        }

        // Strategy 4: Direct value assignment + React/Angular events
        try {
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                const setter = Object.getOwnPropertyDescriptor(
                    el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
                    'value'
                )?.set;
                if (setter) setter.call(el, text);
                else el.value = text;
            } else {
                // contenteditable — set innerHTML as plain text
                el.innerText = text;
            }
            ['input', 'change', 'keyup'].forEach(evt =>
                el.dispatchEvent(new Event(evt, { bubbles: true }))
            );
            await new Promise(r => setTimeout(r, 150));
            console.log('[ByeClicker] Text set via direct assignment ✓');
            return true;
        } catch (e) {
            console.warn('[ByeClicker] Direct assignment failed:', e.message);
        }

        console.error('[ByeClicker] All text-injection strategies failed!');
        return false;
    }

    // ── Click send button ──────────────────────────────────────
    function clickSend(attempts) {
        attempts = attempts || 0;
        const btn =
            document.querySelector('button[data-testid="send-button"]') ||
            document.querySelector('button[aria-label="Send message"]') ||
            document.querySelector('button[aria-label="Send prompt"]') ||
            document.querySelector('button[class*="send"]') ||
            document.querySelector('form button[type="submit"]') ||
            // New ChatGPT composer button
            document.querySelector('button[class*="composer"] svg')?.closest('button') ||
            document.querySelector('[data-testid="composer-submit-button"]');

        if (btn && !btn.disabled) {
            console.log('[ByeClicker] Clicking send button ✓');
            btn.click();
            return true;
        }
        if (attempts < 20) {
            setTimeout(() => clickSend(attempts + 1), 300);
        } else {
            // Last resort: Enter key
            console.warn('[ByeClicker] Send button not found — trying Enter key');
            const el = getInput();
            if (el) {
                el.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Enter', code: 'Enter', keyCode: 13,
                    bubbles: true, cancelable: true
                }));
            }
        }
        return false;
    }

    // ── Response detection via MutationObserver ────────────────
    function waitForResponse(cb, timeoutMs) {
        timeoutMs = timeoutMs || 120000;
        const deadline = Date.now() + timeoutMs;
        let settled = false;
        let idleTimer = null;

        function isGenerating() {
            return !!(
                document.querySelector('button[aria-label="Stop generating"]') ||
                document.querySelector('button[data-testid="stop-button"]') ||
                document.querySelector('button[aria-label="Stop streaming"]')
            );
        }

        function finish() {
            if (settled) return;
            settled = true;
            obs.disconnect();
            clearTimeout(idleTimer);
            clearTimeout(killTimer);
            cb();
        }

        function onMutation() {
            if (Date.now() > deadline) { finish(); return; }
            clearTimeout(idleTimer);
            if (!isGenerating()) {
                idleTimer = setTimeout(finish, 800);
            }
        }

        const obs = new MutationObserver(onMutation);
        obs.observe(document.body, { childList: true, subtree: true, characterData: true });
        const killTimer = setTimeout(finish, timeoutMs);
        onMutation();
    }

    function getLastResponse() {
        // ChatGPT — role attribute (most reliable)
        const byRole = document.querySelectorAll('[data-message-author-role="assistant"]');
        if (byRole.length) return byRole[byRole.length - 1].textContent.trim();

        // ChatGPT — markdown container
        const byMd = document.querySelectorAll('.markdown.prose, .markdown');
        if (byMd.length) return byMd[byMd.length - 1].textContent.trim();

        // Gemini
        const gemMsgs = document.querySelectorAll(
            'model-response, .model-response-text, .response-content, [class*="model-turn"]');
        if (gemMsgs.length) return gemMsgs[gemMsgs.length - 1].textContent.trim();

        // DeepSeek
        const dsMsgs = document.querySelectorAll('.ds-markdown, [class*="assistant-message"]');
        if (dsMsgs.length) return dsMsgs[dsMsgs.length - 1].textContent.trim();

        // Generic fallback
        const generic = document.querySelectorAll('[class*="message"]:not([class*="user"])');
        if (generic.length) return generic[generic.length - 1].textContent.trim();

        return '';
    }

    function extractAnswer(rawText) {
        const cleaned = (rawText || '').replace(SENTINEL, '').replace(/```json|```/g, '').trim();
        const j = cleaned.match(/\{[^}]*"answer"\s*:\s*"([^"]+)"[^}]*\}/);
        if (j) return JSON.stringify({ answer: j[1] });
        const n = cleaned.match(/\b(\d[\d.eE+\-]*)\b/);
        if (n) return JSON.stringify({ answer: n[1] });
        const l = cleaned.match(/\b([A-E])\b/);
        if (l) return JSON.stringify({ answer: l[1].toUpperCase() });
        return JSON.stringify({ answer: 'A' });
    }

    function sendAnswer(raw) {
        const answer = extractAnswer(raw);
        console.log('[ByeClicker] Sending answer back to iClicker:', answer);
        if (alive()) chrome.runtime.sendMessage({ type: 'chatGPTResponse', response: answer });
    }

    // ── Image attach helpers ───────────────────────────────────
    function imageAttached() {
        return !!(
            document.querySelector('[data-testid="file-thumbnail"]') ||
            document.querySelector('.upload-image-preview') ||
            document.querySelector('[class*="attachment"] img') ||
            document.querySelector('[class*="upload"] img') ||
            document.querySelector('img[alt="Uploaded image"]') ||
            document.querySelector('[class*="ImagePreview"]') ||
            document.querySelector('[class*="filePreview"]')
        );
    }

    async function attachViaDrop(blob, filename) {
        const file = new File([blob], filename, { type: blob.type });
        const dropTarget =
            document.querySelector('form') ||
            document.querySelector('main') ||
            document.body;
        const dt = new DataTransfer();
        dt.items.add(file);
        const evOpts = { bubbles: true, cancelable: true, dataTransfer: dt };
        dropTarget.dispatchEvent(new DragEvent('dragenter', evOpts));
        dropTarget.dispatchEvent(new DragEvent('dragover', evOpts));
        await new Promise(r => setTimeout(r, 200));
        dropTarget.dispatchEvent(new DragEvent('drop', evOpts));
        await new Promise(r => setTimeout(r, 1200));
        return imageAttached();
    }

    async function attachViaFileInput(blob, filename) {
        const file = new File([blob], filename, { type: blob.type });
        const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
        for (const fi of inputs) {
            try {
                const dt = new DataTransfer();
                dt.items.add(file);
                fi.files = dt.files;
                fi.dispatchEvent(new Event('change', { bubbles: true }));
                await new Promise(r => setTimeout(r, 1000));
                if (imageAttached()) return true;
            } catch (e) { /* try next */ }
        }
        return false;
    }

    async function attachViaClipboard(blob) {
        try {
            if (!window.ClipboardItem) return false;
            await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
            const input = getInput();
            if (!input) return false;
            input.focus();
            const dt = new DataTransfer();
            input.dispatchEvent(new ClipboardEvent('paste', {
                bubbles: true, cancelable: true, clipboardData: dt,
            }));
            document.execCommand('paste');
            await new Promise(r => setTimeout(r, 1200));
            return imageAttached();
        } catch (e) {
            console.warn('[ByeClicker] Clipboard attach failed:', e.message);
            return false;
        }
    }

    // ── Text question handler ──────────────────────────────────
    async function handleTextQuestion(qData) {
        const prompt = buildTextPrompt(qData);
        console.log('[ByeClicker] Injecting text prompt, length:', prompt.length);
        const ok = await setInputText(prompt);
        if (!ok) {
            console.error('[ByeClicker] Could not inject text — aborting');
            return;
        }
        await new Promise(r => setTimeout(r, 500));
        clickSend();
        waitForResponse(() => {
            const raw = getLastResponse();
            console.log('[ByeClicker] Raw response from AI:', raw.slice(0, 200));
            sendAnswer(raw);
        });
    }

    // ── Image question handler (URL fetch) ─────────────────────
    async function handleImageQuestion(qData) {
        const imageUrl = qData.imageUrl;
        const isShort = qData.type === 'short_answer';
        const imgPrompt = (isShort ? IMG_SHORT_PROMPT : IMG_MC_PROMPT) + '\n' + SENTINEL;

        console.log('[ByeClicker] Fetching image from URL:', imageUrl);

        let blob;
        try {
            const resp = await fetch(imageUrl, { mode: 'cors' });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            blob = await resp.blob();
        } catch (e) {
            console.warn('[ByeClicker] Image fetch failed (CORS likely):', e.message, '— using text-only fallback');
            await handleTextQuestion(qData);
            return;
        }

        const ext = blob.type.includes('png') ? 'png' : 'jpg';
        let attached = await attachViaDrop(blob, 'question.' + ext);
        if (!attached) attached = await attachViaFileInput(blob, 'question.' + ext);
        if (!attached) attached = await attachViaClipboard(blob);

        if (attached) {
            await new Promise(r => setTimeout(r, 400));
            await setInputText(imgPrompt);
            await new Promise(r => setTimeout(r, 600));
            clickSend();
            waitForResponse(() => sendAnswer(getLastResponse()));
        } else {
            console.warn('[ByeClicker] Image attach failed — text fallback');
            await handleTextQuestion(qData);
        }
    }

    // ── Data URL image handler ─────────────────────────────────
    async function handleDataUrlQuestion(qData) {
        const isShort = qData.type === 'short_answer';
        const imgPrompt = (isShort ? IMG_SHORT_PROMPT : IMG_MC_PROMPT) + '\n' + SENTINEL;

        let blob;
        try {
            const arr = qData.imageDataUrl.split(',');
            const mime = arr[0].match(/:(.*?);/)[1];
            const bstr = atob(arr[1]);
            const u8 = new Uint8Array(bstr.length);
            for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
            blob = new Blob([u8], { type: mime });
        } catch (e) {
            console.warn('[ByeClicker] Data URL decode failed:', e.message);
            await handleTextQuestion(qData);
            return;
        }

        let attached = await attachViaDrop(blob, 'question.png');
        if (!attached) attached = await attachViaFileInput(blob, 'question.png');
        if (!attached) attached = await attachViaClipboard(blob);

        if (attached) {
            await new Promise(r => setTimeout(r, 400));
            await setInputText(imgPrompt);
            await new Promise(r => setTimeout(r, 600));
            clickSend();
            waitForResponse(() => sendAnswer(getLastResponse()));
        } else {
            console.warn('[ByeClicker] Data URL image attach failed — text fallback');
            await handleTextQuestion(qData);
        }
    }

    // ── Entry point ────────────────────────────────────────────
    async function handleQuestion(qData) {
        console.log('[ByeClicker Bridge] Received question type:', qData.type,
            '| has imageDataUrl:', !!qData.imageDataUrl,
            '| has imageUrl:', !!qData.imageUrl);

        if (qData.imageDataUrl) {
            await handleDataUrlQuestion(qData);
        } else if (qData.imageUrl) {
            await handleImageQuestion(qData);
        } else {
            await handleTextQuestion(qData);
        }
    }

    if (alive()) {
        chrome.runtime.onMessage.addListener((message) => {
            if (message.type === 'receiveQuestion') {
                console.log('[ByeClicker Bridge] receiveQuestion event fired ✓');
                handleQuestion(message.question);
            }
        });
        console.log('[ByeClicker Bridge] v2.4 ready on:', location.hostname);
    } else {
        console.warn('[ByeClicker Bridge] Extension context not alive — bridge not registered');
    }
})();
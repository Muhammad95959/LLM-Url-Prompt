(() => {
  const LOG = '[LLM URL Prompt]';

  // ?prompt=<text> fills the composer only. Add &send (any value) to submit.
  const DEFAULT_COMPOSER = [
    'main textarea',
    'form textarea',
    'textarea',
    '[contenteditable="true"]',
    'div[role="textbox"]',
  ];

  // Per-site overrides. `gate` restricts to a path prefix when the manifest
  // match is broader than the actual chat page.
  const SITES = {
    'chatgpt.com': { composer: ['#prompt-textarea', 'main textarea', 'form textarea', 'textarea'] },
    'chat.openai.com': { composer: ['#prompt-textarea', 'main textarea', 'form textarea', 'textarea'] },
    'claude.ai': { composer: ['div[contenteditable="true"]', '.ProseMirror', 'textarea'] },
    'gemini.google.com': { composer: ['div[contenteditable="true"]', 'rich-textarea', 'textarea'] },
    'grok.com': {},
    'perplexity.ai': { composer: ['#ask-input', 'div[contenteditable="true"]', 'textarea'] },
    'www.perplexity.ai': { composer: ['#ask-input', 'div[contenteditable="true"]', 'textarea'] },
    'meta.ai': { composer: ['div[data-testid="composer-input"][contenteditable="true"]'] },
    'www.meta.ai': { composer: ['div[data-testid="composer-input"][contenteditable="true"]'] },
    'chat.deepseek.com': {},
    'chat.qwen.ai': {},
    'kimi.com': {},
    'www.kimi.com': {},
    'kimi.ai': {},
    'manus.im': {},
    'poe.com': {},
    'www.poe.com': {},
    'chat.z.ai': {},
    'pi.ai': {},
    'duck.ai': {},
    'venice.ai': {},
    'openrouter.ai': { gate: '/chat' },
    't3.chat': {},
    'genspark.ai': {},
    'www.genspark.ai': {},
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function isVisible(el) {
    return !!(el.offsetParent || el.getClientRects().length);
  }

  function siteConfig() {
    const cfg = SITES[location.hostname];
    if (!cfg) return { composer: DEFAULT_COMPOSER };
    if (cfg.gate && !location.pathname.startsWith(cfg.gate)) return null;
    return { composer: [...(cfg.composer || []), ...DEFAULT_COMPOSER] };
  }

  function findInput(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    return findComposerFallback();
  }

  // Used when none of the known per-site or default selectors match —
  // typically an SPA we don't have a confirmed selector for. Chat composers
  // are almost always docked near the bottom of the viewport (unlike search
  // bars, filters, or newsletter inputs higher up the page), so pick the
  // largest visible textarea/contenteditable box closest to the bottom.
  function findComposerFallback() {
    const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
      .filter(isVisible);
    if (!candidates.length) return null;
    const scored = candidates.map(el => {
      const r = el.getBoundingClientRect();
      const distanceFromBottom = window.innerHeight - r.bottom;
      const area = r.width * r.height;
      // Prefer elements nearer the bottom; use area as a tiebreaker so a
      // large empty page isn't beaten by a tiny hidden textarea.
      return { el, score: -distanceFromBottom + Math.log(area + 1) };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].el;
  }

  function currentValue(el) {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value;
    return el.textContent || '';
  }

  function fillInput(el, text) {
    el.focus();
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, text); else el.value = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, text);
    }
  }

  function placeCaretEnd(el) {
    try {
      el.focus();
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        const len = el.value.length;
        el.setSelectionRange(len, len);
      } else {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch (e) {}
  }

  function focusComposer(selectors) {
    const el = findInput(selectors);
    if (el) placeCaretEnd(el);
    return el;
  }

  function findSendButton(input) {
    const enabled = [...document.querySelectorAll('button:not([disabled])')]
      .filter(b => b.getAttribute('aria-disabled') !== 'true' && isVisible(b));
    const byLabel = enabled.find(b =>
      /send|submit/i.test(b.getAttribute('aria-label') || '') ||
      /send/i.test(b.dataset.testid || '')
    );
    if (byLabel) return byLabel;
    const form = input && input.closest('form');
    if (form) {
      const sub = form.querySelector('button[type="submit"]:not([disabled])');
      if (sub && isVisible(sub)) return sub;
    }
    return null;
  }

  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // Returns true once the prompt has been safely handed off to the page —
  // either filled and idle (manual mode) or filled and confirmed sent
  // (auto-send mode) — and false if we gave up. The caller uses this to
  // decide whether it's safe to strip the URL params.
  async function fillComposer(selectors, prompt, autoSend) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const el = findInput(selectors);
      if (el && currentValue(el) !== prompt) {
        fillInput(el, prompt);
        await sleep(200);
        if (currentValue(findInput(selectors) || el) !== prompt) {
          await sleep(400);
          continue;
        }
      }
      const ready = findInput(selectors);
      if (ready && currentValue(ready) === prompt) {
        if (!autoSend) {
          focusComposer(selectors);
          console.info(LOG, 'Prompt filled — press Enter when ready.');
          return true;
        }
        await sleep(400);
        for (let attempt = 0; attempt < 4; attempt++) {
          const cur = findInput(selectors);
          if (!cur || !currentValue(cur).trim()) {
            focusComposer(selectors);
            console.info(LOG, 'Prompt sent.');
            return true;
          }
          const btn = findSendButton(cur);
          if (btn) btn.click();
          else if (cur) pressEnter(cur);
          await sleep(600);
        }
        // Filled but couldn't confirm the send went through. Leave the URL
        // params intact so a reload (or later SPA route change) can retry
        // rather than silently discarding the prompt.
        focusComposer(selectors);
        console.warn(LOG, 'Filled the prompt, but could not confirm it was sent.');
        return false;
      }
      await sleep(400);
    }
    console.warn(LOG, 'Could not find the chat input in time. Are you logged in?');
    return false;
  }

  let handledUrl = null; // last href we successfully completed for
  let inFlight = false;  // prevents overlapping fillComposer runs

  function stripParams() {
    try {
      const u = new URL(location.href);
      for (const p of ['prompt', 'send']) u.searchParams.delete(p);
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    } catch (e) {}
  }

  function maybeRun() {
    const params = new URLSearchParams(location.search);
    const prompt = params.get('prompt');
    if (!prompt) return;

    const key = location.href;
    if (key === handledUrl) return; // already completed successfully for this exact URL
    if (inFlight) return;           // a run is already in progress, let it finish or time out

    // Check eligibility (e.g. gated path) BEFORE touching the URL at all —
    // if we're not going to act, the prompt param must survive so the user
    // can navigate to the right path and still have it picked up.
    const cfg = siteConfig();
    if (!cfg) return;

    const autoSend = params.has('send');
    console.info(LOG,
      `prompt="${prompt.slice(0, 60)}"` +
      ` | auto-send: ${autoSend ? 'ON' : 'OFF'}` +
      ` | site: ${location.hostname}`);

    inFlight = true;
    fillComposer(cfg.composer, prompt, autoSend).then(success => {
      inFlight = false;
      if (success) {
        handledUrl = key;
        // Only now, after the prompt has actually landed in the composer
        // (and been sent, if requested), is it safe to drop it from the URL.
        stripParams();
      }
      // On failure we deliberately leave the params in place so a page
      // reload or later route change can retry automatically.
    });
  }

  // SPAs (ChatGPT, Gemini, Grok, OpenRouter…) often swap pages without a
  // full reload, so re-check when history changes.
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    history[m] = function (...args) {
      const r = orig.apply(this, args);
      setTimeout(maybeRun, 0);
      return r;
    };
  }
  window.addEventListener('popstate', maybeRun);

  // Some sites mount the real composer late — behind a "Start chatting"
  // interstitial, after a lazy-loaded chunk, etc — with no history event at
  // all. A throttled MutationObserver catches those without polling forever.
  let mutationScheduled = false;
  const observer = new MutationObserver(() => {
    if (mutationScheduled) return;
    mutationScheduled = true;
    setTimeout(() => { mutationScheduled = false; maybeRun(); }, 500);
  });
  const startObserving = () => {
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    else setTimeout(startObserving, 50);
  };
  startObserving();

  maybeRun();
})();

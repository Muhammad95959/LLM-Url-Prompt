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
    'claude.ai': { composer: ['div[contenteditable="true"]', '.ProseMirror', 'textarea'] },
    'gemini.google.com': { composer: [
      'input-area-v2 div.single-line-format > div',
      'input-area-v2 div[class*="single-line-format"] > div',
      'input-area-v2 [contenteditable="true"]',
      'chat-window input-area-v2 [contenteditable="true"]',
      '#xap-skip-link-target chat-window input-area-v2 div.single-line-format > div',
      'div[contenteditable="true"]', 'rich-textarea', 'textarea'
    ] },
    'grok.com': {},
    'www.perplexity.ai': { composer: [
      '#ask-input',
      'div[contenteditable="true"][data-lexical-editor="true"]',
      '#root [contenteditable="true"]',
      '#root textarea',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea'
    ] },
    'meta.ai': { composer: ['div[data-testid="composer-input"][contenteditable="true"]'] },
    'chat.deepseek.com': {},
    'chat.qwen.ai': {},
    'www.kimi.ai': {},
    'manus.im': {},
    'poe.com': {},
    'chat.z.ai': {},
    'pi.ai': {},
    'duck.ai': {},
    'venice.ai': {},
    'openrouter.ai': { gate: '/chat' },
    't3.chat': {},
    'www.genspark.ai': { composer: [
      'div.textarea-wrapper textarea',
      '.search-input-and-toggle textarea',
      'div.textarea-wrapper [contenteditable="true"]',
      '#__nuxt textarea',
      'textarea'
    ] },
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const isGeminiHost = () => location.hostname === 'gemini.google.com';
  const isGensparkHost = () => /(^|\.)genspark\.ai$/.test(location.hostname);
  const isPerplexityHost = () => /(^|\.)perplexity\.ai$/.test(location.hostname);

  function isVisible(el) {
    return !!(el.offsetParent || el.getClientRects().length);
  }

  function siteConfig() {
    let cfg = SITES[location.hostname];
    // handle www. alias without duplicating logic everywhere
    if (!cfg && location.hostname.startsWith('www.')) cfg = SITES[location.hostname.slice(4)];
    if (!cfg) {
      // also check base host for subdomains
      const base = location.hostname.replace(/^www\./, '');
      cfg = SITES[base];
    }
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
  // Genspark & Perplexity home pages center the composer, so bias toward
  // center/large area for those hosts.
  function findComposerFallback() {
    const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
      .filter(isVisible);
    if (!candidates.length) return null;
    const isCenteredHost = isGensparkHost() || isPerplexityHost();
    const scored = candidates.map(el => {
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (isCenteredHost) {
        const centerY = window.innerHeight / 2;
        const elCenterY = r.top + r.height / 2;
        const distanceFromCenter = Math.abs(centerY - elCenterY);
        return { el, score: -distanceFromCenter * 0.5 + Math.log(area + 1) * 2 };
      }
      const distanceFromBottom = window.innerHeight - r.bottom;
      return { el, score: -distanceFromBottom + Math.log(area + 1) };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].el;
  }

  function currentValue(el) {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value;
    if (el.tagName && el.tagName.toLowerCase() === 'rich-textarea') {
      const inner = el.querySelector('[contenteditable="true"]');
      if (inner) return inner.textContent || '';
    }
    return el.textContent || '';
  }

  function clearComposer(el) {
    if (!el) return;
    el.focus();
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, ''); else el.value = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const target = (el.tagName && el.tagName.toLowerCase() === 'rich-textarea')
        ? (el.querySelector('[contenteditable="true"]') || el)
        : el;
      target.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      try {
        range.selectNodeContents(target);
        sel.removeAllRanges();
        sel.addRange(range);
        const did = document.execCommand('insertText', false, '');
        if (!did) {
          target.textContent = '';
          target.dispatchEvent(new InputEvent('input', { bubbles: true }));
        } else {
          target.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }
        if ((target.textContent || '').trim()) {
          target.textContent = '';
          target.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }
        if (target.innerHTML === '<p><br></p>' || target.innerHTML === '<br>') target.innerHTML = '';
      } catch (e) {
        try { target.textContent = ''; target.dispatchEvent(new InputEvent('input', { bubbles: true })); } catch (e2) {}
      }
    }
  }

  function hasUrlChanged(startHref) {
    try {
      if (location.href !== startHref) return true;
      const cur = new URL(location.href);
      const start = new URL(startHref);
      if (cur.pathname !== start.pathname) return true;
      if (start.searchParams.has('prompt') && !cur.searchParams.has('prompt')) return true;
    } catch (e) {}
    return false;
  }

  function isComposerEmpty(el) {
    if (!el) return true;
    return !currentValue(el).trim();
  }

  function isGeminiMessageSent(prompt) {
    const norm = prompt.trim();
    if (!norm) return false;
    const el = document.querySelector('[id^="user-query-content-"] > span')
            || document.querySelector('#user-query-content-0 > span')
            || document.querySelector('[id^="user-query-content-"]');
    if (!el) return false;
    const txt = (el.textContent || '').trim();
    return txt === norm || txt.includes(norm);
  }

  function isGensparkMessageSent(prompt) {
    const norm = prompt.trim();
    if (!norm) return false;
    // Provided by user: #__nuxt ... div.conversation-statement.user.plain-text > div.conversation-item-desc.user > div
    const candidates = [
      ...document.querySelectorAll('div.conversation-statement.user.plain-text'),
      ...document.querySelectorAll('div.conversation-item-desc.user'),
      ...document.querySelectorAll('[data-testid="user-message"]'),
    ];
    for (const el of candidates) {
      const txt = (el.textContent || '').trim();
      if (txt && (txt === norm || txt.includes(norm))) return true;
    }
    return false;
  }

  function isPerplexityMessageSent(prompt) {
    const norm = prompt.trim();
    if (!norm) return false;
    // Perplexity thread: #root ... .group/thread-content ... inline-flex containing user query
    // Use broad selectors - user bubble is the only inline-flex ending with query text
    const candidates = [
      ...document.querySelectorAll('#root .group\\/thread-content span'),
      ...document.querySelectorAll('#root [data-testid="user-message"]'),
      ...document.querySelectorAll('#root .conversation-statement.user'),
      ...document.querySelectorAll('#root div.inline-flex span span'),
    ];
    for (const el of candidates) {
      const txt = (el.textContent || '').trim();
      if (txt && (txt === norm || txt.includes(norm))) return true;
    }
    // Fallback: any span in thread that matches prompt
    const allSpans = [...document.querySelectorAll('#root span')].filter(isVisible);
    for (const el of allSpans) {
      const txt = (el.textContent || '').trim();
      if (txt === norm) return true;
    }
    return false;
  }

  function isPromptSent(prompt) {
    if (isGeminiHost() && isGeminiMessageSent(prompt)) return true;
    if (isGensparkHost() && isGensparkMessageSent(prompt)) return true;
    if (isPerplexityHost() && isPerplexityMessageSent(prompt)) return true;
    return false;
  }

  function isSentinelSent(sentinel, selectors, startHref, prompt) {
    if (hasUrlChanged(startHref)) return true;
    if (!sentinel) return true;
    if (isComposerEmpty(sentinel)) return true;
    if (prompt && isPromptSent(prompt)) return true;
    if (!document.contains(sentinel)) {
      const cur = findInput(selectors);
      if (!cur || isComposerEmpty(cur)) return true;
    }
    return false;
  }

  function schedulePostSendCleanup(prompt, selectors, startHref, sentinel, durationMs = 10000) {
    const norm = prompt.trim();
    if (!norm) return;
    const start = Date.now();
    let sentObserved = false;
    const tick = () => {
      if (Date.now() - start > durationMs) return;
      const el = findInput(selectors);
      if (!sentObserved) {
        if (isSentinelSent(sentinel, selectors, startHref, prompt)) sentObserved = true;
      }
      if (sentObserved && el) {
        const val = currentValue(el);
        if (val.trim() === norm) {
          console.info(LOG, 'Composer refilled with prompt — clearing.');
          clearComposer(el);
        }
      }
      if (Date.now() - start < durationMs) setTimeout(tick, 400);
    };
    setTimeout(tick, 300);
  }

  function fillInput(el, text) {
    el.focus();
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, text); else el.value = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      // Frameworks (Vue/Nuxt - Genspark, React - Perplexity) sometimes need
      // native setter + input + additional events
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    } else {
      const target = el;
      target.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      try {
        range.selectNodeContents(target);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) {}
      // Lexical (Perplexity) and generic contenteditable
      let did = false;
      try { did = document.execCommand('insertText', false, text); } catch (e) {}
      if (!did) {
        target.textContent = text;
      }
      target.dispatchEvent(new InputEvent('input', { bubbles: true }));
      target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true }));
      // ensure framework sees change
      if ((target.textContent || '').trim() !== text.trim()) {
        target.textContent = text;
        target.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
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
    // Scope to composer vicinity first for Genspark/Perplexity where many buttons exist
    if (input) {
      const scope = input.closest('form') || input.closest('div.textarea-wrapper') || input.closest('.search-input-and-toggle') || input.parentElement;
      if (scope) {
        const scoped = [...scope.querySelectorAll('button:not([disabled])')].filter(isVisible);
        const scopedByLabel = scoped.find(b =>
          /send|submit|ask/i.test(b.getAttribute('aria-label') || '') ||
          /send|submit/i.test(b.dataset.testid || '') ||
          /send|submit/i.test(b.getAttribute('data-testid') || '')
        );
        if (scopedByLabel) return scopedByLabel;
        // Genspark has button near textarea with send icon; Perplexity has submit button
        if (scoped.length === 1) return scoped[0];
        const withSvg = scoped.find(b => b.querySelector('svg'));
        if (withSvg) return withSvg;
      }
    }
    const byLabel = enabled.find(b =>
      /send|submit/i.test(b.getAttribute('aria-label') || '') ||
      /send/i.test(b.dataset.testid || '') ||
      /send/i.test(b.getAttribute('data-testid') || '')
    );
    if (byLabel) return byLabel;
    const form = input && input.closest('form');
    if (form) {
      const sub = form.querySelector('button[type="submit"]:not([disabled])');
      if (sub && isVisible(sub)) return sub;
    }
    // Last resort: button with send icon near input
    if (input) {
      const near = enabled.filter(b => {
        const r = b.getBoundingClientRect();
        const ir = input.getBoundingClientRect();
        return Math.abs(r.top - ir.top) < 200 && Math.abs(r.left - ir.left) < 600;
      });
      if (near.length) return near[0];
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
    const startHref = location.href;
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
        const sentinel = ready;
        if (!autoSend) {
          focusComposer(selectors);
          console.info(LOG, 'Prompt filled — press Enter when ready.');
          return true;
        }
        await sleep(400);
        // watch for refilled composer and use sentinel/URL/message checks
        schedulePostSendCleanup(prompt, selectors, startHref, sentinel);
        for (let attempt = 0; attempt < 4; attempt++) {
          if (isSentinelSent(sentinel, selectors, startHref, prompt)) {
            focusComposer(selectors);
            console.info(LOG, 'Prompt sent.');
            return true;
          }
          const cur = findInput(selectors);
          const btn = findSendButton(cur);
          if (btn) btn.click();
          else if (cur) {
            cur.focus();
            // Genspark/Perplexity may need Enter with modifier or just Enter
            pressEnter(cur);
            // Fallback: dispatch Enter on document as well
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          }
          await sleep(600);
          if (isSentinelSent(sentinel, selectors, startHref, prompt)) {
            focusComposer(selectors);
            console.info(LOG, 'Prompt sent.');
            return true;
          }
        }
        for (let i = 0; i < 10; i++) {
          if (isSentinelSent(sentinel, selectors, startHref, prompt)) {
            focusComposer(selectors);
            console.info(LOG, 'Prompt sent (late confirmation).');
            return true;
          }
          await sleep(500);
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
  let handledPrompt = null; // Gemini-only: last prompt stripped
  let handledAt = 0;
  let inFlight = false;  // prevents overlapping fillComposer runs

  function stripParams() {
    try {
      const u = new URL(location.href);
      if (!u.searchParams.has('prompt') && !u.searchParams.has('send')) return false;
      for (const p of ['prompt', 'send']) u.searchParams.delete(p);
      history.replaceState(null, '', u.pathname + u.search + u.hash);
      if (isGeminiHost()) console.info(LOG, 'Stripped prompt params.');
      return true;
    } catch (e) {}
    return false;
  }

  function maybeRun() {
    const params = new URLSearchParams(location.search);
    const prompt = params.get('prompt');
    if (!prompt) return;

    // Gemini-only: params reappear in new /app/<id>?prompt after send — strip without refill
    if (isGeminiHost() && handledPrompt !== null && prompt === handledPrompt) {
      const age = Date.now() - handledAt;
      if (age < 60000) {
        const didStrip = stripParams();
        if (didStrip) {
          try {
            const cfg = siteConfig();
            if (cfg) {
              const el = findInput(cfg.composer);
              if (el && currentValue(el).trim() === prompt.trim()) {
                console.info(LOG, 'Clearing refilled prompt after param reappearance.');
                clearComposer(el);
              }
            }
          } catch (e) {}
          handledUrl = location.href;
          return;
        }
      }
      if (age >= 60000) handledPrompt = null;
    }

    const key = location.href;
    if (key === handledUrl) return; // already completed successfully for this exact URL
    if (inFlight) {
      if (isGeminiHost()) {
        setTimeout(maybeRun, 600);
      }
      return;
    }

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
        if (isGeminiHost()) {
          handledPrompt = prompt;
          handledAt = Date.now();
          stripParams();
          handledUrl = location.href;
          setTimeout(maybeRun, 300);
        } else {
          // Non-Gemini: original simple strip
          stripParams();
        }
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

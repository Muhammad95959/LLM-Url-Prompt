'use strict';

/* Shared DOM helpers + per-site adapters.
   Loaded before content.js; exposes `LLM` on the content-script global. */

var LLM = (function () {
  /* ---------------- selectors ---------------- */

  function fastQueryAll(selector, root) {
    try {
      return Array.prototype.slice.call((root || document).querySelectorAll(selector));
    } catch (_) {
      return [];
    }
  }

  // Walks open shadow roots. Throttled by the caller; Gemini's <rich-textarea>
  // is the main reason this exists.
  function deepQueryAll(selector) {
    const out = fastQueryAll(selector);
    const walk = (root) => {
      const hosts = fastQueryAll('*', root);
      for (const el of hosts) {
        if (!el.shadowRoot) continue;
        for (const found of fastQueryAll(selector, el.shadowRoot)) out.push(found);
        walk(el.shadowRoot);
      }
    };
    walk(document);
    return out;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  // Every site marks "cannot send yet" differently: real [disabled],
  // aria-disabled, a rotating `disabled` class, or data-visually-disabled.
  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled === true) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    if (el.hasAttribute('data-visually-disabled')) return true;
    if (typeof el.className === 'string' && /(^|\s|-)disabled(\s|-|$)/.test(el.className)) return true;
    return !isVisible(el);
  }

  function waitFor(fn, timeout, interval) {
    interval = interval || 200;
    return new Promise((resolve) => {
      let hit;
      try {
        hit = fn();
      } catch (_) {
        hit = null;
      }
      if (hit) return resolve(hit);
      const deadline = Date.now() + timeout;
      const id = setInterval(() => {
        let v;
        try {
          v = fn();
        } catch (_) {
          v = null;
        }
        if (v) {
          clearInterval(id);
          resolve(v);
        } else if (Date.now() > deadline) {
          clearInterval(id);
          resolve(null);
        }
      }, interval);
    });
  }

  /* ---------------- text input ---------------- */

  function elText(el) {
    if (!el) return '';
    const raw = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.innerText;
    return String(raw || '')
      .replace(/\u200b/g, '')
      .trim();
  }

  function selectAll(el) {
    const sel = getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function execInsert(el, text) {
    el.focus();
    selectAll(el);
    try {
      return document.execCommand('insertText', false, text);
    } catch (_) {
      return false;
    }
  }

  // ProseMirror / Lexical style editors: one <p> per line, then an InputEvent.
  function buildParagraphs(el, text) {
    el.focus();
    el.textContent = '';
    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
      const p = document.createElement('p');
      if (line) p.appendChild(document.createTextNode(line));
      else p.appendChild(document.createElement('br'));
      el.appendChild(p);
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // React-controlled <textarea>: bypass React's value tracker.
  function nativeValue(el, text) {
    el.focus();
    const proto = Object.getPrototypeOf(el);
    const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
    if (el._valueTracker) el._valueTracker.setValue(el.value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function matches(el, text, ratio) {
    const got = elText(el);
    const want = text.trim();
    if (!want) return got === '';
    const needed = Math.max(1, Math.floor(want.length * (ratio || 0.9)));
    return got.length >= Math.min(want.length, needed);
  }

  // Ordered fill strategies; the first one that lands wins.
  function fillStrategies(text) {
    return [
      // Quill / Lexical listen to paste; also handles multi-line correctly.
      function pasteInto(el) {
        el.focus();
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
          if (!ev.clipboardData) Object.defineProperty(ev, 'clipboardData', { value: dt });
          el.dispatchEvent(ev);
          return true;
        } catch (_) {
          return false;
        }
      },
      function insertViaExec(el) {
        return !!execInsert(el, text);
      },
      function paragraphs(el) {
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
          nativeValue(el, text);
          return true;
        }
        buildParagraphs(el, text);
        return true;
      },
    ];
  }

  function fill(el, text) {
    for (const strategy of fillStrategies(text)) {
      try {
        strategy(el);
      } catch (_) {
        /* try the next one */
      }
      if (matches(el, text)) return true;
    }
    return matches(el, text, 0.5);
  }

  /* ---------------- submitting ---------------- */

  function collect(selectors) {
    const out = [];
    for (const sel of selectors) for (const el of fastQueryAll(sel)) out.push(el);
    return out;
  }

  // Prefers the send button nearest the composer; DeepSeek's is a generic
  // div[role=button] and needs geometry to disambiguate.
  function pickSend(selectors, input) {
    const enabled = collect(selectors).filter((el) => !isDisabled(el));
    if (!enabled.length) return null;
    if (!input) return enabled[0];

    const anchor = input.getBoundingClientRect();
    const ay = anchor.top + anchor.height / 2;
    const axRight = anchor.right;
    let best = null;
    let bestScore = Infinity;

    for (const el of enabled) {
      const r = el.getBoundingClientRect();
      const dy = Math.abs(r.top + r.height / 2 - ay);
      const dx = Math.max(0, r.left - axRight);
      const score = dy + dx * 0.5;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function clickSend(btn) {
    if (!btn) return false;
    if (btn.tagName === 'BUTTON' && btn.type === 'submit' && btn.form) {
      try {
        btn.form.requestSubmit(btn);
        return true;
      } catch (_) {
        /* fall through to .click() */
      }
    }
    try {
      btn.click();
      return true;
    } catch (_) {
      return false;
    }
  }

  function pressEnter(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 13 };
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  /* ---------------- adapters ---------------- */

  const sites = [
    {
      id: 'chatgpt',
      label: 'ChatGPT',
      conversationPath: /^\/(c|g)\/[^/]+/,
      inputs: [
        '#prompt-textarea[contenteditable="true"]',
        'div#prompt-textarea.ProseMirror',
        '#composer [contenteditable="true"][role="textbox"]',
        '[contenteditable="true"][class*="ProseMirror"]',
        // signed-out SSR composer (real textarea)
        'textarea#mobile-composer-prompt',
        'textarea[name="prompt-textarea"]',
        '[data-composer-editor-host] [contenteditable="true"]',
      ],
      // NOTE: the hidden textarea.wcDTda_fallbackTextarea is a11y-only and
      // React does not observe it — writing there never enables send.
      sends: [
        'button[data-testid="send-button"]',
        'button#composer-submit-button',
        'button[data-composer-submit]',
        'button[aria-label="Send prompt"]',
        'button[aria-label="Send message"]',
      ],
      isEmpty: (el) => !elText(el),
      postFillDelay: 60,
    },
    {
      id: 'gemini',
      label: 'Gemini',
      conversationPath: /^\/app\/[^/]+/,
      inputs: [
        'rich-textarea .ql-editor[contenteditable="true"]',
        'input-area-v2 rich-textarea > div',
        '.ql-editor[contenteditable="true"]',
        'rich-textarea > .ql-editor',
        'div[contenteditable="true"][role="textbox"][aria-label*="Ask Gemini" i]',
        '.text-input-field_textarea .ql-editor',
        // simplified home composer
        'initial-input-area-container textarea',
        '.initial-input-area-container textarea',
        'textarea[aria-label*="Ask" i]',
      ],
      // Google uses data-test-id, not data-testid.
      sends: [
        'button[data-test-id="send-button"]',
        'button.send-button',
        '.send-button-container.visible button',
        'mat-icon[data-mat-icon-name="send"]',
        'button[aria-label*="Send" i]',
        'button[aria-label*="送信"]',
        'button[aria-label*="发送"]',
        'button[aria-label*="發送"]',
      ],
      isEmpty: (el) => el.classList.contains('ql-blank') || !elText(el),
      postFillDelay: 800,
      shadowHint: true,
    },
    {
      id: 'claude',
      label: 'Claude',
      conversationPath: /^\/chat\/[^/]+/,
      inputs: [
        'div.ProseMirror[contenteditable="true"][data-testid="chat-input"]',
        '[data-composer-editor] .ProseMirror[contenteditable="true"]',
        '.ProseMirror[contenteditable="true"][aria-label="Write your prompt to Claude"]',
        '[data-chat-input-container] [contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"][aria-label*="Claude" i]',
        // pre-hydration static composer
        'textarea#static-composer-input',
      ],
      sends: [
        'button[data-testid="chat-input-send"]',
        'button[data-testid="code-prompt-send"]',
        'button[aria-label="Send message"]',
        'button[aria-label*="Send" i]',
      ],
      isEmpty: (el) => el.getAttribute('data-doc-empty') === 'true' || !elText(el),
      postFillDelay: 60,
    },
    {
      id: 'deepseek',
      label: 'DeepSeek',
      conversationPath: /^\/a\/chat\/s\/[^/]+/,
      inputs: [
        'textarea[name="search"]',
        'textarea#chat-input',
        'textarea[data-testid="chat-input"]',
        'textarea[placeholder*="Send a message" i]',
        'textarea[contenteditable="true"]',
      ],
      sends: [
        '.ds-icon-button',
        'div[role="button"].ds-icon-button',
        'div[role="button"][aria-label*="send" i]',
        'button[type="submit"]',
        '.ds-button.ds-button--primary',
      ],
      isEmpty: (el) => !elText(el),
      postFillDelay: 800,
    },
  ];

  function matchSite(hostname) {
    return (
      sites.find((s) => s.id === 'chatgpt' && /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(hostname)) ||
      sites.find((s) => s.id === 'gemini' && /(^|\.)gemini\.google\.com$/.test(hostname)) ||
      sites.find((s) => s.id === 'claude' && /(^|\.)claude\.ai$/.test(hostname)) ||
      sites.find((s) => s.id === 'deepseek' && /(^|\.)deepseek\.com$/.test(hostname))
    );
  }

  return {
    sites,
    matchSite,
    fastQueryAll,
    deepQueryAll,
    waitFor,
    isVisible,
    isDisabled,
    elText,
    fill,
    pickSend,
    collect,
    clickSend,
    pressEnter,
    nativeValue,
  };
})();
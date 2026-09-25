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

  // Provider table lives in sites.js so composer.html can offer the same list
  // without a second copy drifting out of sync. Falls back to the generic
  // selectors if it somehow failed to load.
  const SITES = globalThis.LLM_SITES || {};

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const isGeminiHost = () => location.hostname === 'gemini.google.com';
  const isGensparkHost = () => /(^|\.)genspark\.ai$/.test(location.hostname);
  const isPerplexityHost = () => /(^|\.)perplexity\.ai$/.test(location.hostname);
  const isChatGPTHost = () => /(^|\.)(chatgpt|openai)\.com$/.test(location.hostname);
  const isClaudeHost = () => /(^|\.)claude\.ai$/.test(location.hostname);

  // Editor libraries render one block element per line, and textContent
  // concatenates them with no separator. Compare through this instead of raw
  // textContent so multi-line prompts verify correctly.
  const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'PRE', 'BLOCKQUOTE',
    'SECTION', 'ARTICLE', 'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'TABLE', 'TR', 'TD', 'TH', 'HR', 'BR']);

  function readEditable(el) {
    if (!el) return '';
    let out = '';
    const nl = () => { if (out && !out.endsWith('\n')) out += '\n'; };
    const walk = node => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { out += child.nodeValue; continue; }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName.toUpperCase();
        if (tag === 'BR' || tag === 'HR') { nl(); continue; }
        const block = BLOCK_TAGS.has(tag);
        if (block) nl();
        walk(child);
        if (block) nl();
      }
    };
    walk(el);
    return out;
  }

  // Applied to both sides of every comparison so cosmetic differences between
  // the URL text and what the editor rendered never look like a fill failure.
  // Inner whitespace is deliberately preserved: code blocks and indentation
  // are part of the prompt, and collapsing them would mask a partial fill.
  function normalize(s) {
    return (s || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u00a0\u200b\u200c\u200d]/g, ' ')
      .split('\n')
      .map(l => l.trim())
      .join('\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  function sameText(a, b) {
    return normalize(a) === normalize(b);
  }

  // Strict comparison for the composer. Leading indentation must match exactly,
  // because in code it is syntax rather than formatting — accepting a reflowed
  // block would silently ship wrong prompts. Only trailing whitespace and blank
  // lines are forgiven, since neither survives HTML rendering anyway.
  function codeLines(s) {
    return (s || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u00a0\u200b\u200c\u200d]/g, ' ')
      .split('\n')
      .map(l => l.replace(/[ \t]+$/, ''))
      .filter(l => l !== '');
  }

  function sameCode(a, b) {
    const A = codeLines(a);
    const B = codeLines(b);
    return A.length === B.length && A.every((l, i) => l === B[i]);
  }

  // Markdown list markers are consumed by the renderer, so a prompt line
  // "- alpha" comes back out of the transcript as "alpha". Strip them on both
  // sides so a bulleted prompt is still recognisable as delivered.
  const LIST_MARKER = /^(?:[-*+•‣▪]|\d{1,3}[.)])\s+/;

  function transcriptLines(s) {
    return normalize(s).split('\n').map(l => l.replace(LIST_MARKER, '')).filter(Boolean);
  }

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

  // Editor libraries nest the real contenteditable inside wrapper divs; typing
  // and key events must target the innermost one or the editor never sees them.
  function editableRoot(el) {
    if (!el || !el.isContentEditable) return el;
    const inner = el.querySelector('[contenteditable="true"]');
    return inner ? editableRoot(inner) : el;
  }

  function findInput(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return editableRoot(el);
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
    return editableRoot(scored[0].el);
  }

  // Gemini wraps its composer in a <rich-textarea> custom element that also
  // holds a placeholder node. Everything below has to address the inner
  // contenteditable or the placeholder pollutes the comparison.
  function editableTarget(el) {
    if (el && el.tagName && el.tagName.toLowerCase() === 'rich-textarea') {
      return el.querySelector('[contenteditable="true"]') || el;
    }
    return el;
  }

  function currentValue(el) {
    if (!el) return '';
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value || '';
    const t = editableTarget(el);
    if (t.isContentEditable) return readEditable(t);
    return t.textContent || '';
  }

  // ProseMirror, Lexical, Slate and Quill all keep their own document model
  // and reconcile the DOM on every transaction. Writing textContent/innerHTML
  // directly desyncs the two, and the editor erases our text on its next
  // update — which is how the prompt used to vanish without being sent.
  function isRichEditor(el) {
    if (!el || !el.isContentEditable) return false;
    if (el.closest('rich-textarea')) return true;
    try {
      if (el.matches('.ProseMirror, [data-lexical-editor="true"], [data-slate-editor], [data-testid="editor"]')) return true;
    } catch (e) {}
    const cls = typeof el.className === 'string' ? el.className : '';
    return /(^|\s|\b)(ProseMirror|slate-|lexical-|cm-)/.test(cls);
  }

  function selectAllContents(el) {
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}
  }

  // ProseMirror and Lexical split *pasted* newlines into real block elements.
  // Chrome accepts a ClipboardEvent constructor but can drop the clipboardData
  // member, which leaves the editor with an empty paste and no error — so the
  // event is only trusted once the data is confirmed to have arrived.
  function pasteText(el, text) {
    const build = () => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      dt.setData('text/html', escapeHtml(text));
      return dt;
    };
    try {
      const ev = new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: build(),
      });
      if (ev.clipboardData && typeof ev.clipboardData.getData === 'function'
          && ev.clipboardData.getData('text/plain') === text) {
        el.dispatchEvent(ev);
        return true;
      }
    } catch (e) {}
    try {
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: build() });
      el.dispatchEvent(ev);
      return true;
    } catch (e) {}
    return false;
  }

  // Editors prefer text/html when present, so offer a faithful rendering with
  // real <pre> blocks. This is what preserves indentation on paste.
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .split('\n')
      .map(l => `<div>${l === '' ? '<br>' : l}</div>`)
      .join('');
  }

  const ENTER_OPTS = {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
  };

  // Types the prompt one line at a time. The line break travels *inside* the
  // inserted text rather than as a dispatched Enter: on ChatGPT and Claude a
  // real Enter keypress submits the message, which would send the prompt one
  // line at a time. Chrome turns a trailing \n in insertText into a line break.
  function typeLines(el, text) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const payload = i < lines.length - 1 ? lines[i] + '\n' : lines[i];
      if (!payload) continue;
      let did = false;
      try { did = document.execCommand('insertText', false, payload); } catch (e) {}
      if (!did) return false;
    }
    return true;
  }

  // Set by setEditableText when the text landed but not byte-for-byte, so
  // fillComposer can report it once instead of on every retry.
  let fillDrift = null;
  let fillStrategy = null;

  function setEditableText(el, text) {
    const target = editableTarget(el);
    target.focus();
    const strict = () => sameCode(readEditable(target), text);
    const lenient = () => sameText(readEditable(target), text);

    // Ordered most-faithful first. Each is only attempted if the previous one
    // did not land the text exactly, so a framework that ignores one path
    // still gets served.
    const strategies = [
      ['paste', () => { selectAllContents(target); return pasteText(target, text); }],
      ['bulk insertText', () => {
        selectAllContents(target);
        let did = false;
        try { did = document.execCommand('insertText', false, text); } catch (e) {}
        return did;
      }],
      ['per-line insertText', () => { selectAllContents(target); return typeLines(target, text); }],
      ['beforeinput', () => {
        selectAllContents(target);
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          target.dispatchEvent(new InputEvent('beforeinput', {
            bubbles: true, cancelable: true, inputType: 'insertText', data: text, dataTransfer: dt,
          }));
        } catch (e) {}
        return false;
      }],
    ];

    for (const [name, strategy] of strategies) {
      if (strict()) return true;
      strategy();
      if (strict()) { fillStrategy = name; fillDrift = null; return true; }
    }

    if (lenient()) {
      fillStrategy = 'none exact';
      const want = codeLines(text);
      const got = codeLines(readEditable(target));
      // The rendered HTML is the only way to tell "site folded the newlines"
      // apart from "editor stored them but displays them as spaces".
      fillDrift = `Text not delivered as typed (strategy: ${name}). `
        + (got.length < want.length
          ? `Site collapsed ${want.length} lines into ${got.length}. `
          : 'Indentation was altered. ')
        + `Rendered: ${truncate(target.innerHTML, 220)}`;
      return true;
    }

    // Raw DOM writes desync the editor's document model, so they are a last
    // resort and never allowed on a rich editor.
    if (isRichEditor(target)) return false;
    try { target.textContent = text; } catch (e) { return false; }
    target.dispatchEvent(new InputEvent('input', { bubbles: true }));
    fillStrategy = 'textContent';
    fillDrift = null;
    return true;
  }

  function truncate(s, n) {
    const str = String(s == null ? '' : s).replace(/\s+/g, ' ');
    return str.length > n ? `${str.slice(0, n)}…` : str;
  }

  function clearEditable(el) {
    const target = editableTarget(el);
    target.focus();
    let ok = false;
    try {
      selectAllContents(target);
      ok = document.execCommand('delete', false);
    } catch (e) {}
    if (!ok || normalize(readEditable(target))) {
      if (isRichEditor(target)) return;
      try { target.textContent = ''; } catch (e) { return; }
    }
    target.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }

  function clearComposer(el) {
    if (!el) return;
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, ''); else el.value = '';
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (el.isContentEditable || editableTarget(el) !== el) { clearEditable(el); return; }
    el.focus();
    try { el.textContent = ''; } catch (e) {}
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }

  function hasUrlChanged(startHref) {
    try {
      // Deliberately ignores same-path query churn: every one of these SPAs
      // calls replaceState on load for cosmetic reasons, and treating that as
      // a successful send is what made the prompt disappear unreported.
      const cur = new URL(location.href);
      const start = new URL(startHref);
      if (cur.pathname !== start.pathname) return true;
      if (start.searchParams.has('prompt') && !cur.searchParams.has('prompt')) return true;
    } catch (e) {}
    return false;
  }

  // Rendered user messages are read with readEditable for the same reason the
  // composer is: a multi-line prompt arrives as one block per line, and plain
  // textContent would glue them into a single unmatchable run.
  function matchTranscript(prompt, nodes) {
    const want = transcriptLines(prompt);
    if (!want.length) return false;
    // The first few lines are the stable part of the message; matching those in
    // order is a strong delivery signal without being brittle about the tail.
    const probe = want.slice(0, 3);
    for (const el of nodes) {
      const got = transcriptLines(readEditable(el));
      if (!got.length) continue;
      let i = 0;
      let ok = true;
      for (const line of probe) {
        const at = got.findIndex((g, idx) => idx >= i
          && (g === line || (line.length > 8 && g.includes(line))));
        if (at === -1) { ok = false; break; }
        i = at + 1;
      }
      if (ok) return true;
    }
    return false;
  }

  function isGeminiMessageSent(prompt) {
    return matchTranscript(prompt, document.querySelectorAll(
      '[id^="user-query-content-"], #user-query-content-0'
    ));
  }

  function isChatGPTMessageSent(prompt) {
    return matchTranscript(prompt, document.querySelectorAll(
      '[data-message-author-role="user"], [data-testid="user-message"]'
    ));
  }

  function isClaudeMessageSent(prompt) {
    return matchTranscript(prompt, document.querySelectorAll(
      '[data-testid="user-message"], [class*="font-user-message"], .font-user-message'
    ));
  }

  function isGensparkMessageSent(prompt) {
    return matchTranscript(prompt, document.querySelectorAll(
      'div.conversation-statement.user.plain-text, div.conversation-item-desc.user, [data-testid="user-message"]'
    ));
  }

  function isPerplexityMessageSent(prompt) {
    const want = transcriptLines(prompt);
    if (!want.length) return false;
    if (matchTranscript(prompt, document.querySelectorAll(
      '#root [data-testid="user-message"], #root .conversation-statement.user'
    ))) return true;
    for (const el of document.querySelectorAll('#root .group\\/thread-content span')) {
      const txt = normalize(readEditable(el));
      if (txt && want.some(line => line.length > 8 && txt.includes(line))) return true;
    }
    return false;
  }

  // Shared by every host that renders a recognisable user bubble. Costs one
  // selector sweep and keeps the "sent but unconfirmed" failure — which leaves
  // the prompt in the URL and duplicates it on reload — off the other providers.
  function isGenericMessageSent(prompt) {
    return matchTranscript(prompt, document.querySelectorAll(
      '[data-message-author-role="user"], [data-testid="user-message"],'
      + ' [data-testid*="user-message" i], [class*="user-message"],'
      + ' [class*="font-user-message"], [data-role="user"], [data-author="user"]'
    ));
  }

  function isPromptSent(prompt) {
    if (!normalize(prompt)) return false;
    if (isGeminiHost()) return isGeminiMessageSent(prompt);
    if (isGensparkHost()) return isGensparkMessageSent(prompt);
    if (isPerplexityHost()) return isPerplexityMessageSent(prompt);
    if (isChatGPTHost()) return isChatGPTMessageSent(prompt);
    if (isClaudeHost()) return isClaudeMessageSent(prompt);
    return isGenericMessageSent(prompt);
  }

  // Three-state verdict on whether the prompt reached the thread.
  //   'sent'    - positive evidence it landed
  //   'pending' - still in the composer, or not enough time has passed yet
  //   'lost'    - the composer was replaced and the text went with it, with
  //               nothing showing the message was ever submitted
  function sendStatus(sentinel, selectors, startHref, prompt, elapsedMs) {
    const norm = normalize(prompt);
    const live = findInput(selectors);
    if (live && sameText(currentValue(live), norm)) return 'pending';
    if (norm && isPromptSent(prompt)) return 'sent';
    if (hasUrlChanged(startHref)) return 'sent';
    // A replaced node plus an empty composer means the framework tore the text
    // out, not that it submitted it. Give the transcript a moment to render.
    if (sentinel && !document.contains(sentinel)) return elapsedMs < 2000 ? 'pending' : 'lost';
    if (sentinel && !normalize(currentValue(sentinel))) return 'sent';
    return 'pending';
  }

  function schedulePostSendCleanup(prompt, selectors, startHref, sentinel, durationMs = 8000) {
    const norm = normalize(prompt);
    if (!norm) return;
    const start = Date.now();
    let done = false;
    const tick = () => {
      if (done) return;
      const elapsed = Date.now() - start;
      if (elapsed > durationMs) return;
      // Only ever clear on confirmed delivery. Clearing on a guess is what
      // deleted the prompt out of the composer when the send had not happened.
      if (sendStatus(sentinel, selectors, startHref, prompt, elapsed) === 'sent') {
        done = true;
        const el = findInput(selectors);
        if (el && sameText(currentValue(el), norm)) {
          console.info(LOG, 'Composer refilled with prompt after send — clearing.');
          clearComposer(el);
        }
        return;
      }
      setTimeout(tick, 500);
    };
    setTimeout(tick, 500);
  }

  function fillInput(el, text) {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, text); else el.value = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return setEditableText(el, text);
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

  const SEND_NEG = /voice|dictate|attach|upload|stop|new[-_]?chat|share|rename|delete|artifact|download|copy|edit|tools|plus|add[-_]?file|microphone|camera|picker|search|upgrade|subscribe/i;
  const SEND_POS = /send|submit|ask/i;

  function findSendButton(input) {
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter(b => !b.disabled && b.getAttribute('aria-disabled') !== 'true' && isVisible(b));
    const meta = b => [b.getAttribute('aria-label') || '', b.getAttribute('title') || '',
      b.getAttribute('data-testid') || '', (b.dataset && b.dataset.testid) || '', b.id || ''].join(' ');
    const positive = b => {
      const m = meta(b);
      if (SEND_NEG.test(m)) return false;
      return SEND_POS.test(m) || /\bsend\b/i.test(typeof b.className === 'string' ? b.className : '');
    };
    const isNear = b => {
      if (!input) return true;
      const r = b.getBoundingClientRect();
      const ir = input.getBoundingClientRect();
      return Math.abs(r.top - ir.top) < 200 && Math.abs(r.left - ir.left) < 600;
    };
    // Only reachable by scoping to the composer: the surrounding page is full
    // of buttons that match /send|submit/ loosely enough to be dangerous.
    const scope = input && (input.closest('form') || input.closest('rich-textarea')
      || input.closest('input-area-v2') || input.closest('div.textarea-wrapper')
      || input.closest('.search-input-and-toggle') || input.parentElement);
    const pool = scope ? buttons.filter(b => scope.contains(b)) : buttons;
    const near = pool.filter(isNear);
    return near.find(positive)
      || pool.find(positive)
      || buttons.filter(isNear).find(positive)
      || buttons.find(positive)
      // Textarea composers usually submit via a form button with no useful label.
      || (input && input.closest('form')
        && [...input.closest('form').querySelectorAll('button[type="submit"]:not([disabled])')].find(isVisible))
      || null;
  }

  function pressEnter(el) {
    el.focus();
    placeCaretEnd(el);
    el.dispatchEvent(new KeyboardEvent('keydown', ENTER_OPTS));
    el.dispatchEvent(new KeyboardEvent('keypress', ENTER_OPTS));
    el.dispatchEvent(new KeyboardEvent('keyup', ENTER_OPTS));
  }

  // Returns true once the prompt has been safely handed off to the page —
  // either filled and idle (manual mode) or filled and confirmed delivered
  // (auto-send mode) — and false if we gave up. The caller uses this to
  // decide whether it's safe to strip the URL params.
  async function fillComposer(selectors, prompt, autoSend, debug) {
    const norm = normalize(prompt);
    const startHref = location.href;
    const fillDeadline = Date.now() + 20000;
    let sentinel = null;
    fillDrift = null;
    fillStrategy = null;

    // Deliberately lenient: a site that always reindents would otherwise spin
    // here for the full deadline. The exact-match check lives in setEditableText
    // and drives the retry strategy; the drift it records is reported below.
    let refused = 0;
    while (Date.now() < fillDeadline) {
      const el = findInput(selectors);
      if (!el) { await sleep(400); continue; }
      if (!sameText(currentValue(el), norm)) {
        // A rich editor that keeps refusing means it is rewriting the text, not
        // that we are too early. Bailing out promptly with the rendered HTML
        // beats a 20s hang that ends in a misleading "could not find the input".
        if (fillInput(el, prompt) === false && isRichEditor(editableTarget(el))) refused++;
        else if (sameText(currentValue(el), norm)) refused = 0;
        if (refused >= 4) {
          const got = readEditable(el);
          console.warn(LOG,
            `The editor rewrote the prompt and would not accept it verbatim `
            + `(${refused} attempts).\n`
            + `lines wanted: ${codeLines(prompt).length} | got: ${codeLines(got).length}\n`
            + `Rendered: ${truncate(el.innerHTML, 220)}\n`
            + 'Your prompt is still in the URL — nothing was sent. Reopen with '
            + '&debug=1 for the full dump.');
          return false;
        }
        await sleep(250);
        continue;
      }
      sentinel = el;
      break;
    }

    if (!sentinel) {
      if (!refused) console.warn(LOG, 'Could not find the chat input in time. Are you logged in?');
      return false;
    }

    if (debug) {
      // Report exactly what the site received, so a mismatch is diagnosable
      // without guessing at which layer dropped the line breaks.
      const el = findInput(selectors);
      const got = el ? readEditable(el) : '';
      console.info(LOG,
        `DEBUG strategy: ${fillStrategy || 'n/a'}\n`
        + `DEBUG lines wanted: ${codeLines(prompt).length} | got: ${codeLines(got).length}\n`
        + `DEBUG exact: ${el ? sameCode(got, prompt) : false}`
        + ` | lenient: ${el ? sameText(got, prompt) : false}\n`
        + `DEBUG composer tag: ${el ? el.tagName : 'none'}`
        + `${el ? ` class="${el.className}"` : ''}\n`
        + `DEBUG raw textContent: ${JSON.stringify(el ? el.textContent : '')}\n`
        + `DEBUG innerHTML: ${el ? el.innerHTML : 'n/a'}`);
    }

    if (fillDrift) {
      console.warn(LOG, `${fillDrift}\nIf this persists, reopen the link with `
        + '&debug=1 and share the logged HTML — it shows whether the site or the '
        + 'editor is folding the line breaks.');
    }

    if (!autoSend) {
      focusComposer(selectors);
      console.info(LOG, 'Prompt filled — press Enter when ready.');
      return true;
    }

    const t0 = Date.now();
    schedulePostSendCleanup(prompt, selectors, startHref, sentinel);
    const stillHas = () => {
      const cur = findInput(selectors);
      return cur && sameText(currentValue(cur), norm);
    };
    const sent = msg => { focusComposer(selectors); console.info(LOG, msg); return true; };
    const lost = () => {
      console.warn(LOG, 'Composer was cleared but the message never appeared — '
        + 'keeping the URL params so a reload can retry.');
      return false;
    };

    // Submit, but only while the prompt is actually still sitting in the
    // composer. Clicking blind here is what fired unrelated buttons.
    const submitDeadline = Date.now() + 6000;
    while (Date.now() < submitDeadline) {
      const st = sendStatus(sentinel, selectors, startHref, prompt, Date.now() - t0);
      if (st === 'sent') return sent('Prompt sent.');
      if (st === 'lost') return lost();
      if (stillHas()) {
        const cur = findInput(selectors);
        const btn = findSendButton(cur);
        if (btn) btn.click();
        else if (cur) pressEnter(cur);
      }
      await sleep(700);
    }

    for (let i = 0; i < 12; i++) {
      const st = sendStatus(sentinel, selectors, startHref, prompt, Date.now() - t0);
      if (st === 'sent') return sent('Prompt sent (late confirmation).');
      if (st === 'lost') return lost();
      await sleep(500);
    }

    // Filled but couldn't confirm delivery. Leave the URL params intact so a
    // reload (or later SPA route change) can retry rather than silently
    // discarding the prompt.
    focusComposer(selectors);
    console.warn(LOG, 'Filled the prompt, but could not confirm it was sent.');
    return false;
  }

  let handledUrl = null; // last href we successfully completed for
  let handledPrompt = null; // Gemini-only: last prompt stripped
  let handledAt = 0;
  let inFlight = false;  // prevents overlapping fillComposer runs
  let attempts = 0;      // consecutive failures for the current href

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
              if (el && sameText(currentValue(el), prompt)) {
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
      if (isGeminiHost()) setTimeout(maybeRun, 600);
      return;
    }

    // Check eligibility (e.g. gated path) BEFORE touching the URL at all —
    // if we're not going to act, the prompt param must survive so the user
    // can navigate to the right path and still have it picked up.
    const cfg = siteConfig();
    if (!cfg) return;

    // The mutation observer fires constantly while the editor works, so cap
    // retries instead of re-filling every half second forever.
    if (attempts >= 3) return;
    attempts++;

    const autoSend = params.has('send');
    console.info(LOG,
      `prompt="${prompt.slice(0, 60)}"` +
      ` | auto-send: ${autoSend ? 'ON' : 'OFF'}` +
      ` | site: ${location.hostname}`);

    inFlight = true;
    fillComposer(cfg.composer, prompt, autoSend, params.has('debug')).then(success => {
      inFlight = false;
      if (!success) return;
      attempts = 0;
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

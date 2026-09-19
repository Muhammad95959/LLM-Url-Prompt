(() => {
  const LOG = '[Z.ai URL Prompt]';
  const params = new URLSearchParams(location.search);
  const prompt = params.get('q');
  if (!prompt) return;

  // ?q=<prompt> fills only. Add &s (any value) to auto-submit.
  const autoSend = params.has('s');

  console.info(LOG,
    `prompt="${prompt.slice(0, 60)}"` +
    ` | auto-send: ${autoSend ? 'ON' : 'OFF'}`);

  // Strip params so a refresh/back doesn't re-fill or re-send.
  try {
    const u = new URL(location.href);
    for (const p of ['q', 's']) u.searchParams.delete(p);
    history.replaceState(null, '', u.pathname + u.search + u.hash);
  } catch (e) {}

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function isVisible(el) {
    return !!(el.offsetParent || el.getClientRects().length);
  }

  function findInput() {
    return (
      document.querySelector('main textarea, form textarea, textarea') ||
      document.querySelector('[contenteditable="true"]')
    );
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

  function focusComposer() {
    const el = findInput();
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

  async function fillComposer() {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const el = findInput();
      if (el && currentValue(el) !== prompt) {
        fillInput(el, prompt);
        await sleep(200);
        // If fill didn't take (framework overwrote it), retry on next loop.
        if (currentValue(el) !== prompt) {
          await sleep(400);
          continue;
        }
      }
      if (el && currentValue(el) === prompt) {
        if (!autoSend) {
          focusComposer();
          console.info(LOG, 'Prompt filled — press Enter when ready.');
          return;
        }

        await sleep(400);
        for (let attempt = 0; attempt < 4; attempt++) {
          const cur = findInput();
          if (!cur || !currentValue(cur).trim()) {
            focusComposer();
            console.info(LOG, 'Prompt sent.');
            return;
          }
          const btn = findSendButton(cur);
          if (btn) btn.click();
          else if (cur) pressEnter(cur);
          await sleep(600);
        }
        focusComposer();
        console.warn(LOG, 'Filled the prompt, but could not confirm it was sent.');
        return;
      }
      await sleep(400);
    }
    console.warn(LOG, 'Could not find the chat input in time. Are you logged in?');
  }

  fillComposer();
})();

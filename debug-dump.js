/* Page-console DOM dump for debugging the send path.
   Run it on a provider page AFTER the prompt is in the composer but BEFORE
   sending: the point is to capture the send control while the extension still
   considers it disabled/unmatched.

   Content-script globals (LLM) are NOT visible here — this script is
   deliberately standalone. Paste the whole file into DevTools' console, then
   run:  dumpSend()
*/
function dumpSend() {
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const visible = (el) => {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return !!r.width && !!r.height && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  };
  const desc = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    name: el.getAttribute('name') || null,
    testid: el.getAttribute('data-testid'),
    testId: el.getAttribute('data-test-id'),
    ariaLabel: el.getAttribute('aria-label'),
    title: el.getAttribute('title'),
    type: el.getAttribute('type'),
    role: el.getAttribute('role'),
    cls: (typeof el.className === 'string' ? el.className : '').slice(0, 70) || null,
    disabled: el.disabled === true,
    ariaDisabled: el.getAttribute('aria-disabled'),
    visuallyDisabled: el.hasAttribute('data-visually-disabled'),
    disabledClass: /(^|\s|-)disabled(\s|-|$)/.test(typeof el.className === 'string' ? el.className : ''),
    rect: rect(el),
  });
  const text = (el) =>
    (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.innerText || '').replace(/\u200b/g, '').trim();

  const editors = [...document.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"]')].filter(visible);
  const composers = editors.map((el) => ({
    ...desc(el),
    placeholder: el.getAttribute('placeholder'),
    textLength: text(el).length,
    // controls sharing this editor's bottom edge = the footer controls
    footer: [...document.querySelectorAll('button, [role="button"], [role="menuitem"]')]
      .filter(visible)
      .filter((c) => Math.abs(c.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom) < 60)
      .map(desc),
  }));

  const out = {
    url: location.href,
    contentScriptVisible: typeof LLM !== 'undefined',
    composers,
  };
  const json = JSON.stringify(out, null, 1);
  try {
    copy(json);
    console.log('%ccopied to clipboard — paste this back', 'color:#0a0;font-weight:700');
  } catch (_) {
    console.log(json);
  }
  console.table(
    composers.flatMap((c) => c.footer.map((f) => ({ editor: c.tag + (c.name ? `[name=${c.name}]` : ''), text: f.textLength, control: f.tag, testid: f.testid || f.testId, aria: f.ariaLabel, cls: f.cls, disabled: f.disabled || f.ariaDisabled || f.disabledClass }))),
  );
  return out;
}
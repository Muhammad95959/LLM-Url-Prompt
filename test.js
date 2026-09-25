// End-to-end tests: run the real content.js against a minimal DOM with a
// simulated rich-text editor, then assert on what the site actually received.
//
//   node test.js
//
// Covers the regressions behind "fills then throws the text away" and
// "multiple lines are converted to a single line".
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = __dirname;
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---------------------------------------------------------------- tiny DOM

let nodeSeq = 0;

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.childNodes = [];
    this.attrs = {};
    this.listeners = {};
    this.uid = ++nodeSeq;
    this.isContentEditable = this.attrs.contenteditable === 'true';
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'contenteditable') this.isContentEditable = String(v) === 'true';
  }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  get id() { return this.attrs.id || ''; }
  set id(v) { this.attrs.id = v; }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = v; }
  get dataset() {
    const out = {};
    for (const k of Object.keys(this.attrs)) {
      if (!k.startsWith('data-')) continue;
      const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[camel] = this.attrs[k];
    }
    return out;
  }
  get disabled() { return this.hasAttribute('disabled'); }
  get parentElement() { return this.parent || null; }

  get textContent() {
    let out = '';
    for (const c of this.childNodes) out += c.nodeType === 3 ? c.nodeValue : c.textContent;
    return out;
  }
  set textContent(v) {
    this.childNodes = String(v) === '' ? [] : [{ nodeType: 3, nodeValue: String(v), parent: this }];
  }
  get innerHTML() {
    return this.childNodes.map(c => c.nodeType === 3 ? c.nodeValue : c.innerHTML).join('');
  }

  appendChild(node) {
    node.parent = this;
    this.childNodes.push(node);
    return node;
  }
  contains(node) {
    if (node === this) return true;
    return this.childNodes.some(c => c.nodeType === 1 && c.contains(node));
  }
  remove() {
    if (!this.parent) return;
    const i = this.parent.childNodes.indexOf(this);
    if (i >= 0) this.parent.childNodes.splice(i, 1);
    this.parent = null;
  }

  descendants(out = []) {
    for (const c of this.childNodes) {
      if (c.nodeType !== 1) continue;
      out.push(c);
      c.descendants(out);
    }
    return out;
  }
  querySelectorAll(sel) {
    const groups = String(sel).split(',').map(s => s.trim()).filter(Boolean);
    return this.descendants().filter(n => groups.some(g => matches(n, g)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  matches(sel) {
    return String(sel).split(',').some(g => matches(this, g.trim()));
  }
  closest(sel) {
    let n = this;
    while (n) {
      if (n.nodeType === 1 && matches(n, sel)) return n;
      n = n.parentElement;
    }
    return null;
  }

  focus() { (this._doc || doc).activeElement = this; }
  click() { this.dispatchEvent(new FakeEvent('click', { bubbles: true })); }
  getClientRects() { return [{}]; }
  get offsetParent() { return null; }
  getBoundingClientRect() {
    return { top: 0, left: 0, bottom: 40, right: 600, width: 600, height: 40 };
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    for (const fn of this.listeners[ev.type] || []) fn(ev);
    return true;
  }
}

// Selector engine: comma groups, descendant/child combinators, and one compound
// of tag/#id/.class/[attr]/[attr="v"]/[attr*="v" i]/:not().
function matches(el, sel) {
  return String(sel).split(',').map(s => s.trim()).filter(Boolean)
    .some(g => matchesChain(el, g));
}

function matchesChain(el, sel) {
  const steps = [];
  let comb = null;
  for (const tk of String(sel).split(/\s+/).filter(Boolean)) {
    if (tk === '>') { comb = '>'; continue; }
    steps.push({ sel: tk, comb });
    comb = null;
  }
  if (!steps.length) return false;
  let i = steps.length - 1;
  let node = el;
  if (!compound(node, steps[i].sel)) return false;
  while (--i >= 0) {
    if (steps[i + 1].comb === '>') {
      node = node.parentElement;
      if (!node || !compound(node, steps[i].sel)) return false;
    } else {
      let anc = node.parentElement;
      let ok = false;
      while (anc) {
        if (compound(anc, steps[i].sel)) { ok = true; node = anc; break; }
        anc = anc.parentElement;
      }
      if (!ok) return false;
    }
  }
  return true;
}

function compound(el, sel) {
  const parts = sel.match(/(^[a-zA-Z][\w-]*)|(#[\w-]+)|(\.[\w-]+)|(\[[^\]]+\])|(:not\([^)]*\))/g) || [];
  if (!parts.length) return false;
  for (const p of parts) {
    if (p.startsWith(':not(')) {
      if (matchesChain(el, p.slice(5, -1))) return false;
    } else if (p.startsWith('#')) {
      if (el.id !== p.slice(1)) return false;
    } else if (p.startsWith('.')) {
      if (!String(el.className).split(/\s+/).includes(p.slice(1))) return false;
    } else if (p.startsWith('[')) {
      const m = /^\[\s*([\w-]+)\s*(?:([~^$*|]?=)\s*"([^"]*)"\s*)?(([iIsS]))?\s*\]$/.exec(p);
      if (!m) return false;
      const [, name, op, val] = m;
      const have = el.getAttribute(name);
      if (have == null) return false;
      if (op === '=' && have !== val) return false;
      if (op === '*=' && !have.toLowerCase().includes(val.toLowerCase())) return false;
    } else if (el.tagName !== p.toUpperCase()) return false;
  }
  return true;
}

// A fresh document per test: content.js keeps a 20s retry loop alive, and a
// shared document would let a finished test corrupt the next one.
let doc = null;
function createDoc() {
  const d = {
    activeElement: null,
    body: null,
    documentElement: new El('html'),
    createElement(t) { return bind(new El(t), d); },
    createRange() { return { el: null, selectNodeContents(el) { this.el = el; } }; },
    querySelector(sel) { return this.body.querySelector(sel); },
    querySelectorAll(sel) { return this.body.querySelectorAll(sel); },
    contains: n => d.body.contains(n),
    addEventListener() {},
    dispatchEvent() { return true; },
    // Route editing commands at this document's focused editor.
    execCommand(cmd, _ui, value) {
      const el = d.activeElement;
      if (!el || !el._editor) return false;
      if (cmd === 'insertText') return el._editor.insertText(String(value));
      if (cmd === 'delete') return el._editor.clear();
      return false;
    },
  };
  d.body = bind(new El('body'), d);
  return d;
}
function bind(el, d) { el._doc = d; return el; }

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
    this.defaultPrevented = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() {}
}
class FakeKeyboardEvent extends FakeEvent {}
class FakeInputEvent extends FakeEvent {}

class FakeDataTransfer {
  constructor() { this.data = {}; }
  setData(t, v) { this.data[t] = v; }
  getData(t) { return this.data[t] || ''; }
}
class FakeClipboardEvent extends FakeEvent {}

const selection = {
  ranges: [],
  removeAllRanges() { this.ranges = []; },
  addRange(r) { this.ranges = [r]; },
};
const win = {
  innerHeight: 900,
  getSelection: () => selection,
  addEventListener() {},
  getComputedStyle: () => ({}),
};

// ------------------------------------------------- simulated rich-text editor

/**
 * A contenteditable that behaves like ProseMirror/Lexical:
 *  - one block element per line
 *  - insertText folds embedded \n into a space
 *  - Enter splits the current block
 *  - paste splits on \n into blocks (unless the site ignores synthetic paste)
 */
function makeEditor(d, { id, className = 'ProseMirror', ignorePaste = false,
                        foldBulk = false, foldNewlines = false,
                        ignoreSelectAll = false, manglePaste = false } = {}) {
  const el = bind(new El('div'), d);
  el.setAttribute('contenteditable', 'true');
  if (id) el.id = id;
  if (className) el.className = className;

  let lines = [''];
  let li = 0;
  let col = 0;

  const render = () => {
    el.childNodes = [];
    for (const line of lines) {
      const p = new El('p');
      p._doc = d;
      p.setAttribute('contenteditable', 'false');
      p.textContent = line;
      p.parent = el;
      el.childNodes.push(p);
    }
  };
  render();

  const insertAt = (s, fold) => {
    if (el._selAll) {
      lines = [s];
      li = 0;
      col = s.length;
      el._selAll = false;
      return;
    }
    lines[li] = lines[li].slice(0, col) + s + lines[li].slice(col);
    col += s.length;
  };
  // Insert text, honouring newlines the way Chrome's contenteditable does.
  const typeText = (text, fold) => {
    const parts = fold ? [text.replace(/\r\n?|\n/g, ' ')] : text.split(/\r\n?|\n/);
    parts.forEach((part, i) => {
      if (i > 0) {
        // A newline behaves like a block split at the caret.
        const cur = lines[li];
        const before = cur.slice(0, col);
        const after = cur.slice(col);
        lines.splice(li, 1, before, after);
        li += 1;
        col = 0;
      }
      if (part) insertAt(part, fold);
    });
  };

  el._editor = {
    insertText(text) {
      const isBulk = text.split(/\r\n?|\n/).length > 2;
      const fold = foldNewlines || (foldBulk && isBulk);
      typeText(text, fold);
      render();
      el.dispatchEvent(new FakeInputEvent('input', { bubbles: true }));
      return true;
    },
    clear() {
      lines = [''];
      li = 0;
      col = 0;
      el._selAll = false;
      render();
      el.dispatchEvent(new FakeInputEvent('input', { bubbles: true }));
      return true;
    },
    enter() {
      const cur = lines[li];
      const before = cur.slice(0, col);
      const after = cur.slice(col);
      lines.splice(li, 1, before, after);
      li += 1;
      col = 0;
      el._selAll = false;
      render();
      return true;
    },
    get lines() { return lines; },
    ignoreSelectAll,
  };

  // ChatGPT and Claude submit on Enter, so a real keydown here must never be
  // treated as a line break by the extension.
  el.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); el.dispatchEvent(new FakeEvent('llm-submit')); }
  });
  el.addEventListener('paste', ev => {
    if (ignorePaste) return;
    const text = (ev.clipboardData && ev.clipboardData.getData('text/plain')) || '';
    const parts = (manglePaste ? text.replace(/^(    )+/gm, '  ') : text).split('\n');
    lines = parts;
    li = lines.length - 1;
    col = lines[li].length;
    el._selAll = false;
    render();
    ev.preventDefault();
  });

  return el;
}

// --------------------------------------------------------- site scaffolding

function buildSite(d, { hostname, search, editor, onSend }) {
  const body = bind(new El('body'), d);
  d.body = body;
  doc.activeElement = null;

  const form = bind(new El('form'), d);
  body.appendChild(form);
  if (editor) form.appendChild(editor);

  const loc = {
    hostname,
    pathname: '/',
    search,
    set href(v) { const u = new URL(v); loc.search = u.search; loc.pathname = u.pathname; },
    get href() { return `https://${hostname}${loc.pathname}${loc.search}`; },
  };

  // Selecting the editor's contents must mark it "replace on next insert",
  // which is what selectNodeContents does in a real browser.
  selection.addRange = r => {
    selection.ranges = [r];
    const el = r && r.el;
    // ignoreSelectAll models an editor that discards synthetic ranges and
    // keeps its own caret, so a later insert appends instead of replacing.
    if (el && el._editor && !el._editor.ignoreSelectAll) el._selAll = true;
  };

  const sendBtn = bind(new El('button'), d);
  sendBtn.setAttribute('aria-label', 'Send prompt');
  sendBtn.setAttribute('data-testid', 'send-button');
  sendBtn.addEventListener('click', () => { if (onSend) onSend(d); });
  if (editor) form.appendChild(sendBtn);

  return { doc: d, body, loc, editor };
}

// ------------------------------------------------------------- run the code

function runContent(opts = {}) {
  const d = createDoc();
  doc = d;
  const editor = opts.makeEditor ? opts.makeEditor(d) : null;
  const log = { info: [], warn: [] };
  const sink = {
    info: (...a) => log.info.push(a.join(' ')),
    warn: (...a) => log.warn.push(a.join(' ')),
    error: (...a) => log.warn.push(a.join(' ')),
  };
  const site = buildSite(d, { hostname: opts.hostname, search: opts.search, editor, onSend: opts.onSend });
  site.log = sink;
  site.warnings = log.warn;
  site.infos = log.info;
  const loc = site.loc;
  const history = {
    pushState(_s, _t, url) { if (url) loc.href = url; },
    // Real stripParams() relies on this to actually change location.search.
    replaceState(_s, _t, url) { if (url) loc.href = new URL(url, loc.href).href; },
  };

  const context = vm.createContext({
    document: d,
    window: win,
    location: site.loc,
    history,
    console: site.log,
    setTimeout,
    clearTimeout,
    Promise,
    URL,
    URLSearchParams,
    MutationObserver: class { observe() {} disconnect() {} },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    InputEvent: FakeInputEvent,
    KeyboardEvent: FakeKeyboardEvent,
    Event: FakeEvent,
    DataTransfer: FakeDataTransfer,
    ClipboardEvent: FakeClipboardEvent,
  });
  context.globalThis = context;
  vm.runInContext(read('sites.js'), context, { filename: 'sites.js' });
  vm.runInContext(read('content.js'), context, { filename: 'content.js' });
  site.context = context;
  return site;
}

const settle = (ms = 1400) => new Promise(r => setTimeout(r, ms));

// Simulate the site accepting the message: move the composer into the thread.
function sentTo(threadSel) {
  return (d) => {
    const composer = d.querySelector('[contenteditable="true"]');
    if (!composer) return;
    const thread = d.createElement('div');
    thread.setAttribute('data-message-author-role', 'user');
    if (!thread.matches(threadSel)) return;
    // Move the composer's blocks so the editor can be cleared afterwards.
    while (composer.childNodes.length) {
      const node = composer.childNodes.shift();
      node.parent = null;
      thread.appendChild(node);
    }
    d.body.appendChild(thread);
    composer._editor.clear();
  };
}

// ------------------------------------------------------------------- runner

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  ok ? pass++ : fail++;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail) results.push(`      ${detail}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  // ---- 1. multi-line code on a site that ignores synthetic paste, so the
  //         ladder must fall through to insertText and still keep every line.
  {
    const code = [
      'Review this:',
      '',
      'def parse(raw):',
      '    total = 0',
      '    for line in raw:',
      '        total += int(line)',
      '    return total',
    ].join('\n');
    const run = runContent({
      hostname: 'chatgpt.com',
      search: `?prompt=${encodeURIComponent(code)}`,
      makeEditor: d => makeEditor(d, { id: 'prompt-textarea', ignorePaste: true }),
    });
    await settle();
    const got = run.editor._editor.lines;
    check('multi-line code keeps every line', same(got, code.split('\n')),
      `got ${JSON.stringify(got)}`);
    check('indentation is byte-exact', got[3] === '    total = 0',
      `line 4 = ${JSON.stringify(got[3])}`);
  }

  // ---- 2. the same prompt where paste works
  {
    const code = 'alpha\n    beta\n        gamma';
    const run = runContent({
      hostname: 'claude.ai',
      search: `?prompt=${encodeURIComponent(code)}`,
      makeEditor: d => makeEditor(d, { id: 'prompt-textarea' }),
    });
    await settle();
    check('paste path preserves indentation too',
      same(run.editor._editor.lines, code.split('\n')),
      `got ${JSON.stringify(run.editor._editor.lines)}`);
  }

  // ---- 3. an editor that folds a bulk multi-line insert but not single-line
  //         ones: the per-line strategy must recover the exact formatting.
  {
    const code = 'def f():\n    if x:\n        return 1\n    return 0';
    const run = runContent({
      hostname: 'chatgpt.com',
      search: `?prompt=${encodeURIComponent(code)}`,
      makeEditor: d => makeEditor(d, { id: 'prompt-textarea', ignorePaste: true, foldBulk: true }),
    });
    await settle();
    check('per-line strategy recovers a folded bulk insert',
      same(run.editor._editor.lines, code.split('\n')),
      `got ${JSON.stringify(run.editor._editor.lines)}`);
  }

  // ---- 4. a site that folds every newline: the extension must not claim
  //         success, and must report what the composer actually contains.
  {
    const code = 'one\ntwo\nthree';
    const run = runContent({
      hostname: 'chatgpt.com',
      search: `?prompt=${encodeURIComponent(code)}`,
      makeEditor: d => makeEditor(d, { id: 'prompt-textarea', ignorePaste: true, foldNewlines: true }),
    });
    await settle();
    const warned = run.warnings.join('\n');
    check('a folding site produces a warning, not silence',
      /rewrote the prompt/i.test(warned), `warnings = ${JSON.stringify(run.warnings)}`);
    check('the warning reports the rendered HTML',
      /Rendered:/.test(warned), `warnings = ${JSON.stringify(run.warnings)}`);
    check('the warning reports the line-count mismatch',
      /lines wanted: 3 \| got: 1/.test(warned), `warnings = ${JSON.stringify(run.warnings)}`);
    check('a folding site gives up promptly rather than hanging',
      run.warnings.length > 0 && /attempts/.test(warned), `warnings = ${JSON.stringify(run.warnings)}`);
    check('a folding site does not claim the prompt was sent',
      !run.infos.join('\n').includes('Prompt sent'), `infos = ${JSON.stringify(run.infos)}`);
    check('a folding site keeps the prompt in the URL',
      !!run.loc.search.includes('prompt='), `search = ${run.loc.search}`);
  }

  // ---- 4b. Claude's failure mode: the editor discards the synthetic range,
  //           so a retry used to append and the prompt arrived duplicated.
  {
    const code = 'def f():\n    if x:\n        return 1\n    return 0';
    const run = runContent({
      hostname: 'claude.ai',
      search: `?prompt=${encodeURIComponent(code)}`,
      makeEditor: d => makeEditor(d, {
        id: 'composer', className: 'ProseMirror', ignoreSelectAll: true, manglePaste: true,
      }),
    });
    await settle(2500);
    const got = run.editor._editor.lines;
    check('no duplicated lines when selection is ignored', same(got, code.split('\n')),
      `got ${JSON.stringify(got)}`);
    check('the prompt is not sent twice over',
      got.join('\n').split('def f():').length - 1 === 1,
      `occurrences of "def f():" = ${got.join('\n').split('def f():').length - 1}`);
  }

  // ---- 4c. the same, on a site where the paste path is ignored outright
  {
    const code = 'alpha\n    beta\n        gamma';
    const run = runContent({
      hostname: 'claude.ai',
      search: `?prompt=${encodeURIComponent(code)}`,
      makeEditor: d => makeEditor(d, { id: 'composer', ignoreSelectAll: true, ignorePaste: true }),
    });
    await settle(2500);
    check('no duplication on a single-line prompt either',
      same(run.editor._editor.lines, code.split('\n')),
      `got ${JSON.stringify(run.editor._editor.lines)}`);
  }

  // ---- 5. single-line prompt unchanged (no regression)
  {
    const run = runContent({
      hostname: 'chatgpt.com',
      search: '?prompt=hello',
      makeEditor: d => makeEditor(d, { id: 'prompt-textarea' }),
    });
    await settle();
    check('single-line prompt still fills',
      same(run.editor._editor.lines, ['hello']), `got ${JSON.stringify(run.editor._editor.lines)}`);
  }

  // ---- 6. auto-send actually reaches the thread and clears the composer
  {
    const prompt = 'Explain this:\n\nconst x = 1;\nWhy?';
    const run = runContent({
      hostname: 'chatgpt.com',
      search: `?prompt=${encodeURIComponent(prompt)}&send=1`,
      makeEditor: d => makeEditor(d, { id: 'prompt-textarea' }),
      onSend: sentTo('[data-message-author-role="user"]'),
    });
    await settle(2500);
    const thread = run.body.querySelector('[data-message-author-role="user"]');
    check('auto-send put the prompt in the thread', !!thread, 'no user message rendered');
    check('thread text matches the prompt line-for-line',
      !!thread && same(thread.textContent, prompt.replace(/\n/g, '')),
      `thread = ${JSON.stringify(thread && thread.textContent)}`);
    check('composer emptied after send',
      same(run.editor._editor.lines, ['']), `composer = ${JSON.stringify(run.editor._editor.lines)}`);
    check('URL params stripped after a confirmed send', !run.loc.search,
      `search = ${run.loc.search}`);
  }

  // ---- 7. auto-send the site refuses: prompt kept, not lost
  {
    const prompt = 'a\nb';
    const run = runContent({
      hostname: 'chatgpt.com',
      search: `?prompt=${encodeURIComponent(prompt)}&send=1`,
      makeEditor: d => makeEditor(d, { id: 'prompt-textarea' }),
      onSend: () => { /* site ignores the click */ },
    });
    await settle(2500);
    check('unsent prompt stays in the URL for a retry', !!run.loc.search.includes('prompt='),
      `search = ${run.loc.search}`);
    check('unsent prompt is still in the composer',
      same(run.editor._editor.lines, prompt.split('\n')),
      `composer = ${JSON.stringify(run.editor._editor.lines)}`);
  }

  // ---- 8. a site with no known selectors still finds its composer
  {
    const run = runContent({
      hostname: 'grok.com',
      search: '?prompt=fallback%20test',
      makeEditor: d => makeEditor(d, { className: 'plain-editor' }),
    });
    await settle();
    check('unknown site falls back to the composer',
      same(run.editor._editor.lines, ['fallback test']),
      `got ${JSON.stringify(run.editor._editor.lines)}`);
  }

  // ---- 9. the send path may use Enter, but the fill path must not
  {
    const run = runContent({
      hostname: 'chatgpt.com',
      search: '?prompt=line1%0Aline2',
      makeEditor: d => makeEditor(d, { id: 'prompt-textarea' }),
    });
    await settle();
    let submitted = 0;
    run.editor.addEventListener('llm-submit', () => { submitted++; });
    // Re-filling must not submit anything.
    run.context.globalThis.__noop = 0;
    void submitted;
    check('filling a multi-line prompt never submits it', submitted === 0,
      `submit events during fill = ${submitted}`);
  }

  // ---- 7. strict comparison rejects a reflowed code block
  {
    const { codeLines, sameCode } = extract(['codeLines', 'sameCode']);
    const want = 'def f():\n    return 1';
    check('sameCode accepts identical indentation', sameCode(want, want));
    check('sameCode rejects reindented code',
      !sameCode(want, 'def f():\n  return 1'), 'reindented block was accepted');
    check('sameCode ignores trailing whitespace', sameCode('a  \nb\t', 'a\nb'));
    check('sameCode ignores blank-line count', sameCode('a\n\n\nb', 'a\nb'));
    check('sameCode normalises CRLF', sameCode('a\r\nb', 'a\nb'));
    check('sameCode still rejects different text', !sameCode('a\nb', 'a\nc'));
    check('codeLines keeps leading indentation', same(codeLines('  x'), ['  x']));
  }

  // ---- 8. per-line typing: newline inside the payload, never an Enter keypress
  {
    const events = [];
    const inserts = [];
    const fakeEl = {
      dispatchEvent(ev) { events.push(ev.type === 'keydown' ? `key:${ev.key}` : ev.type); return true; },
    };
    const { typeLines } = extract(['typeLines'], {
      document: {
        execCommand(cmd, _ui, val) { if (cmd === 'insertText') { inserts.push(String(val)); return true; } return false; },
      },
      KeyboardEvent: FakeKeyboardEvent,
      window: win,
      console,
    });
    typeLines(fakeEl, 'one\n    two\n\nthree');
    check('typing splits the prompt into lines',
      same(inserts, ['one\n', '    two\n', '\n', 'three']), `insertText calls = ${JSON.stringify(inserts)}`);
    check('typing dispatches NO Enter keypress',
      !events.some(e => e.startsWith('key:')), `events = ${JSON.stringify(events)}`);
    check('typing carries line breaks inside the payload',
      inserts.filter(s => s.endsWith('\n')).length === 3, `inserts = ${JSON.stringify(inserts)}`);
    check('typing preserves leading indentation',
      inserts.includes('    two\n'), `inserts = ${JSON.stringify(inserts)}`);
  }

  // ---- 8b. a real Enter would submit on ChatGPT/Claude, so nothing in the
  //          fill path may dispatch one.
  {
    const src = read('content.js');
    const fill = body('fillComposer') + body('setEditableText')
      + body('typeLines') + body('pasteText') + body('fillInput');
    check('fill path never dispatches a keydown',
      !/new KeyboardEvent\(\s*'keydown'/.test(fill),
      'a keydown in the fill path risks submitting on ChatGPT/Claude');
    check('pressEnter (the send path) still exists',
      /new KeyboardEvent\('keydown', ENTER_OPTS\)/.test(body('pressEnter')));
    check('ENTER_OPTS is used by pressEnter only', src.includes('ENTER_OPTS'));
  }

  // ---- 8c. paste must not be trusted unless clipboardData actually arrived
  {
    const mk = ClipboardEventImpl => extract(['pasteText', 'escapeHtml'], {
      DataTransfer: FakeDataTransfer,
      ClipboardEvent: ClipboardEventImpl,
      Event: FakeEvent,
      console,
    });

    // Happy path: a browser that honours the clipboardData constructor member.
    const good = mk(FakeClipboardEvent);
    const seenGood = [];
    good.pasteText({ dispatchEvent(ev) { seenGood.push(ev.clipboardData); return true; } }, 'a\n    b');
    check('paste carries text/plain through to the editor',
      seenGood[0] && seenGood[0].getData('text/plain') === 'a\n    b',
      `seen = ${JSON.stringify(seenGood.map(s => s && s.getData('text/plain')))}`);
    check('paste also supplies text/html',
      seenGood[0] && seenGood[0].getData('text/html').includes('<div>    b</div>'));

    // Broken path: a browser whose constructor silently drops clipboardData.
    // The event must still reach the editor via the defineProperty fallback.
    class DropsClipboardData extends FakeEvent {
      constructor(type, init) { super(type, {}); void init; }
    }
    const broken = mk(DropsClipboardData);
    const seenBroken = [];
    const r = broken.pasteText(
      { dispatchEvent(ev) { seenBroken.push(ev.clipboardData); return true; } }, 'x\ny');
    check('paste falls back when the constructor drops clipboardData',
      r === true && seenBroken[0] && seenBroken[0].getData('text/plain') === 'x\ny',
      `r = ${r}, seen = ${JSON.stringify(seenBroken.map(s => s && s.getData('text/plain')))}`);

    const { escapeHtml: esc } = extract(['escapeHtml'], { console });
    check('text/html payload keeps one element per line',
      esc('a\nb') === '<div>a</div><div>b</div>', esc('a\nb'));
    check('text/html payload preserves indentation',
      esc('a\n    b').includes('<div>    b</div>'));
    check('text/html payload keeps blank lines',
      esc('a\n\nb') === '<div>a</div><div><br></div><div>b</div>');
    check('text/html payload escapes markup',
      esc('<b>') === '<div>&lt;b&gt;</div>', esc('<b>'));
  }

  // ---- 8d. drift is reported with the rendered HTML so it is diagnosable
  {
    const src = read('content.js');
    const setEditable = body('setEditableText');
    check('drift report includes the rendered HTML',
      /target\.innerHTML/.test(setEditable), 'no innerHTML in the drift report');
    check('drift report names the strategy that ran',
      /strategy: \$\{last\}/.test(setEditable));
    check('&debug=1 dumps composer state', /DEBUG innerHTML/.test(body('fillComposer')));
    check('debug flag is parsed from the URL',
      /params\.has\('debug'\)/.test(body('maybeRun')));
  }

  // ---- 9. invariants and manifest/site consistency
  {
    const src = read('content.js');
    const setEditable = body('setEditableText');
    check('no raw textContent write on a rich editor',
      /if \(isRichEditor\(target\)\) return false;/.test(setEditable));
    check('paste still gets raw text', /pasteText\(target, text\)/.test(setEditable));
    check('fill inserts the raw prompt', /fillInput\(el, prompt\)/.test(body('fillComposer')));
    check('every insert waits for a verified-empty composer',
      /if \(!emptyComposer\(target\) && !clearVerified\(target\)\) return false;/.test(setEditable),
      'an insert can run against a non-empty composer, which duplicates text');
    check('a failed attempt clears what it left behind',
      /if \(!emptyComposer\(target\)\) clearVerified\(target\);/.test(setEditable));
    check('fillInput never relies on selection alone to replace',
      !/selectAllContents\(el\)/.test(body('fillInput')));
    check('params stripped only on success', /if \(!success\) return;/.test(body('maybeRun')));

    const sites = JSON.parse(JSON.stringify(vm.runInNewContext(
      `${read('sites.js')}; globalThis.LLM_SITES`, { })));
    const manifest = JSON.parse(read('manifest.json'));
    const matches = manifest.content_scripts[0].matches;
    for (const [host, cfg] of Object.entries(sites)) {
      const covered = matches.some(m => m.includes(host.replace(/^www\./, '')));
      check(`manifest covers ${host}`, covered);
      check(`${host} has a launch URL`, /^https:\/\//.test(cfg.base || ''));
    }
    check('manifest loads sites.js first',
      manifest.content_scripts[0].js[0] === 'sites.js');
    check('content.js has no duplicated site table',
      !/^\s{2}const SITES = \{/m.test(src));
    check('every provider in sites.js is reachable from composer.html',
      read('composer.html').includes('sites.js'));
  }

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.on('unhandledRejection', e => { console.log('FAIL  unhandled rejection:', e && e.message); process.exit(1); });
  process.exit(fail ? 1 : 0);
}

// Pull named functions out of the IIFE for direct unit testing. They are
// concatenated into one scope because some call each other. `decls` pulls in
// module-level constants those functions close over.
function extract(names, globals = {}, decls = []) {
  const ctx = vm.createContext({ console, ...globals });
  const code = [...decls.map(decl), ...names.map(body)].join('\n');
  vm.runInContext(`${code}\nglobalThis.__out = {${names.join(',')}};`, ctx);
  return ctx.__out;
}
function decl(name) {
  const src = read('content.js');
  const s = src.indexOf(`const ${name} = {`);
  const e = src.indexOf('};', s);
  if (s < 0 || e < 0) throw new Error(`no const ${name}`);
  return src.slice(s, e + 2);
}
function body(name) {
  const src = read('content.js');
  const s = src.indexOf(`function ${name}(`);
  if (s < 0) throw new Error(`no function ${name}`);
  let i = src.indexOf('{', s), d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; }
  return src.slice(s, j + 1);
}

main();

'use strict';

/* LLM URL Prompt — content script.

   URL contract
     ?prompt=<text>          fill the composer, do not send
     ?prompt=<text>&send=1   fill and send
     ?q=<text>               alias of ?prompt

   Guard
     Nothing derived from the prompt text is ever stored. The only durable
     record is the conversation path the app navigated to after a send, saved
     under a key of the chat id itself (`<conversationPath> -> ts`).

     Repeat-fire protection is therefore two-layered:
       1. in-memory, per document: the params are stripped immediately, and a
          prompt handled in this page load is never handled again.
       2. durable, chat-id only: if prompt params reappear while sitting on a
          conversation we already sent into, the run is skipped.

     A fill-only run records nothing. A send that never navigates records
     nothing, so it is retried on the next visit. Chat records expire after
     STORE_TTL_MS. */

const TAG = '[llm-url-prompt]';
const PROMPT_PARAMS = ['prompt', 'q'];
const SEND_PARAMS = ['send', 'autosubmit', 'submit'];
const STORE_KEY = 'llm-url-prompt/sent-chats/v1';
const STORE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INPUT_TIMEOUT_MS = 25000;
const SEND_TIMEOUT_MS = 8000;
const CHAT_ID_TIMEOUT_MS = 120000;
// How long one handled prompt stays blocked inside this page load.
const HANDLED_TTL_MS = 10 * 60 * 1000;
const TRUTHY = /^(1|true|yes|on|send|submit)$/i;

const site = LLM.matchSite(location.hostname);

/* ---------------- storage ---------------- */

// Deliberately in memory only — keyed by nothing, never persisted, gone on
// reload. Its only job is to stop the 250ms poll loop and a second
// history.replaceState from running the same prompt twice in one page load.
const handled = new Map();

function readChats() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeChats(chats) {
  try {
    const now = Date.now();
    const kept = {};
    for (const [path, ts] of Object.entries(chats)) {
      if (now - (ts || 0) < STORE_TTL_MS) kept[path] = ts;
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(kept));
  } catch (_) {
    /* private mode / storage blocked */
  }
}

function knownChat(path) {
  const chats = readChats();
  const ts = chats[path];
  return ts ? Date.now() - ts < STORE_TTL_MS : false;
}

function rememberChat(path) {
  const chats = readChats();
  chats[path] = Date.now();
  writeChats(chats);
}

function alreadyHandled(prompt, send) {
  const key = `${prompt}|${send ? 1 : 0}`;
  const at = handled.get(key);
  return at != null && Date.now() - at < HANDLED_TTL_MS;
}

function markHandled(prompt, send) {
  handled.set(`${prompt}|${send ? 1 : 0}`, Date.now());
  if (handled.size > 20) handled.delete(handled.keys().next().value);
}

function releaseHandled(prompt, send) {
  handled.delete(`${prompt}|${send ? 1 : 0}`);
}

/* ---------------- url ---------------- */

function readParams() {
  const params = new URLSearchParams(location.search);
  let prompt = null;
  for (const name of PROMPT_PARAMS) {
    const value = params.get(name);
    if (value != null && value.trim()) {
      prompt = value;
      break;
    }
  }
  if (prompt == null) return null;

  let send = false;
  for (const name of SEND_PARAMS) {
    if (!params.has(name)) continue;
    const value = params.get(name);
    send = value === null || value === '' || TRUTHY.test(value.trim());
    if (send) break;
  }

  return { prompt: prompt.trim(), send };
}

function stripParams() {
  try {
    const url = new URL(location.href);
    let changed = false;
    for (const name of [...PROMPT_PARAMS, ...SEND_PARAMS]) {
      if (url.searchParams.has(name)) {
        url.searchParams.delete(name);
        changed = true;
      }
    }
    if (changed) history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  } catch (_) {
    /* nothing to do */
  }
}

/* ---------------- toast ---------------- */

function toast(message, kind) {
  try {
    const host = document.body || document.documentElement;
    if (!host) return;
    const el = document.createElement('div');
    el.textContent = message;
    el.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483647',
      'max-width:340px',
      'padding:10px 14px',
      'border-radius:10px',
      'font:500 13px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif',
      'color:#fff',
      'background:' + (kind === 'error' ? '#b42318' : kind === 'warn' ? '#b54708' : '#101828'),
      'opacity:.96',
      'box-shadow:0 8px 24px rgba(0,0,0,.24)',
    ].join(';');
    host.appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
  } catch (_) {
    /* toast is cosmetic */
  }
}

/* ---------------- dom resolution ---------------- */

let lastShadowSweep = 0;

// Fast path first; the shadow sweep is a throttled fallback for
// <rich-textarea>-style custom elements.
function findInput() {
  for (const sel of site.inputs) {
    const hit = LLM.fastQueryAll(sel).find((el) => LLM.isVisible(el));
    if (hit) return hit;
  }
  if (site.shadowHint && Date.now() - lastShadowSweep > 1500) {
    lastShadowSweep = Date.now();
    for (const sel of site.inputs) {
      const hit = LLM.deepQueryAll(sel).find((el) => LLM.isVisible(el));
      if (hit) return hit;
    }
  }
  return null;
}

function findSend(input) {
  return LLM.pickSend(site.sends, input);
}

/* ---------------- main flow ---------------- */

const POST_FILL_ATTEMPTS = 3;
const POST_FILL_BACKOFF_MS = [150, 400];

// These apps remount the composer on navigation and right after a send, and
// DeepSeek's /a/chat landing URL redirects under us, which silently discards
// whatever we filled. So re-resolve and re-fill until the text survives
// instead of trusting one postFillDelay sleep.
async function ensureFilled(prompt) {
  for (let attempt = 0; attempt < POST_FILL_ATTEMPTS; attempt++) {
    await sleep(attempt === 0 ? site.postFillDelay : POST_FILL_BACKOFF_MS[attempt - 1]);
    const live = findInput();
    if (!live) continue;
    if (!LLM.elText(live)) LLM.fill(live, prompt);
    if (LLM.elText(live)) return live;
    console.warn(TAG, 'composer was empty again after fill, attempt', attempt + 1);
  }
  return null;
}

// A composer can hold the text visually while the app's own state never saw it
// — a ProseMirror paste React ignores leaves the send control disabled forever.
// So a dead send path is treated as a fill failure: re-fill with the next
// strategy and look again before falling back to Enter.
const SEND_ROUNDS = 2;

async function clickSend(input, prompt) {
  let live = input;
  for (let round = 0; round < SEND_ROUNDS; round++) {
    const timeout = round === 0 ? SEND_TIMEOUT_MS : 3000;
    const btn = await LLM.waitFor(() => findSend(live), timeout, 200);
    if (btn) {
      LLM.clickSend(btn);
      console.log(TAG, 'clicked send', site.id, accessible(btn));
      return true;
    }
    live = findInput() || live;
    if (!LLM.elText(live)) {
      console.warn(TAG, 'composer is empty again — giving up on send');
      return false;
    }
    console.log(TAG, 'no enabled send control after fill — re-filling with strategy', round + 2);
    LLM.fill(live, prompt, { start: round + 1 });
  }
  return false;
}

async function run({ prompt, send }) {
  const input = await LLM.waitFor(findInput, INPUT_TIMEOUT_MS, 250);
  if (!input) {
    releaseHandled(prompt, send);
    toast(`Could not find the ${site.label} prompt box — parameter ignored.`, 'error');
    console.warn(TAG, `no input found within ${INPUT_TIMEOUT_MS}ms`);
    return;
  }

  if (!site.isEmpty(input)) console.log(TAG, `${site.label} composer already has text — overwriting`);

  const landed = LLM.fill(input, prompt);
  if (!landed) {
    releaseHandled(prompt, send);
    toast(`Could not fill the ${site.label} prompt box — parameter ignored.`, 'error');
    console.warn(TAG, 'fill failed', input);
    return;
  }

  console.log(TAG, 'filled', site.id, { send, length: prompt.length });
  toast(send ? `Prompt filled — sending to ${site.label}…` : `Prompt filled in ${site.label}. Not sent.`, send ? undefined : 'warn');

  if (!send) {
    // Nothing was sent, so there is nothing to remember: release the claim and
    // let a later visit with the same URL fill again.
    releaseHandled(prompt, send);
    return;
  }

  const live = await ensureFilled(prompt);
  if (!live) {
    releaseHandled(prompt, send);
    toast(`The ${site.label} prompt box kept losing the text — nothing sent.`, 'error');
    console.log(TAG, 'composer controls nearby:', LLM.describeComposerControls(input));
    return;
  }

  if (!(await clickSend(live, prompt))) {
    releaseHandled(prompt, send);
    toast(`No enabled ${site.label} send button — prompt left in the box, not sent.`, 'error');
    console.warn(TAG, `no enabled send control after ${SEND_ROUNDS} rounds — not sending. Nearby controls → ${LLM.describeComposerControls(live)}`);
    return;
  }

  recordChatId(prompt, send);
}

function accessible(el) {
  return el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('aria-label') || el.className || el.tagName;
}

// The send is only "recorded" once the app has actually created the
// conversation, and the only thing stored is that path. Two shapes are both
// recorded: a send that happens while *already on* a conversation URL (the
// path is identical to origin), and a send from a new-chat URL that navigates
// into /c/<id>, /app/<id>, etc.
function recordChatId(prompt, send) {
  const tryRecord = () => {
    const path = location.pathname;
    if (!site.conversationPath.test(path)) return false;
    rememberChat(path);
    releaseHandled(prompt, send);
    console.log(TAG, 'sent, chat id saved', path);
    return true;
  };

  if (tryRecord()) return;

  const deadline = Date.now() + CHAT_ID_TIMEOUT_MS;
  const id = setInterval(() => {
    if (tryRecord()) {
      clearInterval(id);
      return;
    }
    if (Date.now() > deadline) {
      releaseHandled(prompt, send);
      clearInterval(id);
      console.log(TAG, 'no conversation id appeared — nothing saved, a revisit will retry');
    }
  }, 400);
}

function handle() {
  const params = readParams();
  if (!params) return;
  stripParams();

  const { prompt, send } = params;

  if (alreadyHandled(prompt, send)) {
    toast(`This ${site.label} prompt was already handled on this page — parameters cleared.`, 'warn');
    console.log(TAG, 'already handled in this page load, ignoring');
    return;
  }

  // Durable guard, keyed by chat id alone: prompt params showing up inside a
  // conversation we already sent into means this would duplicate a send.
  if (knownChat(location.pathname)) {
    toast(`This ${site.label} conversation (${location.pathname}) already has a sent prompt — parameters cleared.`, 'warn');
    console.log(TAG, 'current chat was already sent into, ignoring', location.pathname);
    return;
  }

  markHandled(prompt, send);
  run(params).catch((err) => {
    releaseHandled(prompt, send);
    console.error(TAG, err);
  });
}

/* ---------------- bootstrap ---------------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function boot() {
  if (!site) return;
  console.log(TAG, 'active on', location.hostname, '->', site.id);

  handle();
  const id = setInterval(handle, 250);
  // The SPAs rewrite location via pushState, which content scripts cannot
  // patch from the isolated world — polling is the portable route.
  window.addEventListener('pagehide', () => clearInterval(id), { once: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
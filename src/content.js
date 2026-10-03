'use strict';

/* LLM URL Prompt — content script.

   URL contract
     ?prompt=<text>          fill the composer, do not send
     ?prompt=<text>&send=1   fill and send
     ?q=<text>               alias of ?prompt

   Guard
     The prompt is recorded in localStorage under a hash of
     `<text>|<send>`. A prompt counts as used only once the app created a
     conversation for it: the entry is stamped with that chat id, and only a
     stamped entry blocks later visits. Until then the claim is provisional —
     it only stops the 250ms poll loop and an immediate second open from firing
     a duplicate, and lapses on its own. Fill-only runs release their claim
     outright. Entries expire after STORE_TTL_MS. */

const TAG = '[llm-url-prompt]';
const PROMPT_PARAMS = ['prompt', 'q'];
const SEND_PARAMS = ['send', 'autosubmit', 'submit'];
const STORE_KEY = 'llm-url-prompt/consumed/v1';
const STORE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INPUT_TIMEOUT_MS = 25000;
const SEND_TIMEOUT_MS = 8000;
const CHAT_ID_TIMEOUT_MS = 120000;
// Provisional claims block re-entry for as long as a chat id could still
// arrive, plus a grace window for slow navigations.
const CLAIM_TTL_MS = CHAT_ID_TIMEOUT_MS + 30000;
const TRUTHY = /^(1|true|yes|on|send|submit)$/i;

const site = LLM.matchSite(location.hostname);

/* ---------------- storage ---------------- */

function hashKey(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function readStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeStore(store) {
  try {
    const now = Date.now();
    const kept = {};
    for (const [k, v] of Object.entries(store)) {
      if (now - (v && v.ts ? v.ts : 0) < STORE_TTL_MS) kept[k] = v;
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(kept));
  } catch (_) {
    /* private mode / storage blocked — the in-memory guard still holds */
  }
}

function markConsumed(key, patch) {
  const store = readStore();
  store[key] = Object.assign({ ts: Date.now() }, store[key], patch);
  writeStore(store);
  return store[key];
}

function forget(key) {
  const store = readStore();
  if (store[key]) {
    delete store[key];
    writeStore(store);
  }
}

/* Only a chat id makes a prompt "used". An unstamped claim is provisional: it
   exists to stop the poll loop and an immediate re-open from double-firing,
   and stops counting as a block once CLAIM_TTL_MS has passed. */
function claimState(key) {
  const entry = readStore()[key];
  if (!entry) return null;
  const age = Date.now() - (entry.ts || 0);
  if (age >= STORE_TTL_MS) return null;
  if (entry.chatId) return 'done';
  if (entry.inflight && age < CLAIM_TTL_MS) return 'inflight';
  return null;
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

async function run({ prompt, send }, key, originPath) {
  const input = await LLM.waitFor(findInput, INPUT_TIMEOUT_MS, 250);
  if (!input) {
    forget(key);
    toast(`Could not find the ${site.label} prompt box — parameter ignored.`, 'error');
    console.warn(TAG, `no input found within ${INPUT_TIMEOUT_MS}ms`);
    return;
  }

  if (!site.isEmpty(input)) console.log(TAG, `${site.label} composer already has text — overwriting`);

  const landed = LLM.fill(input, prompt);
  if (!landed) {
    forget(key);
    toast(`Could not fill the ${site.label} prompt box — parameter ignored.`, 'error');
    console.warn(TAG, 'fill failed', input);
    return;
  }

  console.log(TAG, 'filled', site.id, { send, length: prompt.length });
  toast(send ? `Prompt filled — sending to ${site.label}…` : `Prompt filled in ${site.label}. Not sent.`, send ? undefined : 'warn');

  if (!send) {
    // Nothing was sent, so there is nothing to remember: drop the claim and
    // let a later visit with the same URL fill again.
    forget(key);
    return;
  }

  await sleep(site.postFillDelay);
  // Re-resolve: every one of these apps remounts the composer.
  const live = findInput() || input;
  if (!LLM.elText(live)) LLM.fill(live, prompt);

  const btn = await LLM.waitFor(() => findSend(live), SEND_TIMEOUT_MS, 200);
  if (btn) {
    LLM.clickSend(btn);
    console.log(TAG, 'clicked send', site.id, btn.getAttribute('data-testid') || btn.className || btn.tagName);
  } else {
    console.warn(TAG, 'no enabled send button — falling back to Enter');
    LLM.pressEnter(live);
  }

  watchForChatId(key, originPath);
}

function watchForChatId(key, originPath) {
  const deadline = Date.now() + CHAT_ID_TIMEOUT_MS;
  const id = setInterval(() => {
    const path = location.pathname;
    if (site.conversationPath.test(path) && path !== originPath) {
      markConsumed(key, { chatId: path, inflight: false });
      clearInterval(id);
      console.log(TAG, 'recorded chat id', path);
    } else if (Date.now() > deadline) {
      clearInterval(id);
    }
  }, 400);
}

function handle() {
  const params = readParams();
  if (!params) return;
  stripParams();

  const key = hashKey(params.prompt + '|' + (params.send ? 1 : 0));
  const originPath = location.pathname;

  const state = claimState(key);
  if (state) {
    const entry = readStore()[key] || {};
    toast(
      state === 'done'
        ? `This ${site.label} prompt is already a chat (${entry.chatId}) — parameters cleared.`
        : `This ${site.label} prompt is already being handled — parameters cleared.`,
      'warn',
    );
    console.log(TAG, 'already handled, ignoring', state, key, entry);
    return;
  }

  // Claim before acting so neither the poll loop nor an immediate second open
  // can start a duplicate run. Provisional until a chat id is stamped.
  markConsumed(key, { inflight: true, chatId: null, from: originPath });
  run(params, key, originPath).catch((err) => {
    forget(key);
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
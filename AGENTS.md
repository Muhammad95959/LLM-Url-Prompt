# AGENTS.md

MV3 browser extension. Loads a prompt into ChatGPT / Gemini / Claude / DeepSeek from URL params.

## Layout

- `manifest.json` — no build step, no bundler, plain files.
- `src/sites.js` — shared DOM helpers + per-site adapter array. Defines `var LLM` (top-level `var`, so it lands on the content-script global shared with `content.js`). Must load **before** `content.js`.
- `src/content.js` — URL parsing, localStorage guard, orchestration.
- `src/content.js` runs at `document_start` and polls `location.href` every 250ms. This is deliberate: these are SPAs that use `pushState`, and a content script in the isolated world **cannot** patch the page's `history.pushState`.
- `test-all.sh` — manual smoke test: opens every provider with `?prompt=…&send=1`. The provider table is `id|label|url` strings; keep it in sync when adding a site. It appends a per-run `[test …]` tag so the guard can't swallow a retest (`--exact` sends verbatim).

## Adapter contract

Each entry in `LLM.sites` needs: `inputs[]` (ordered), `sends[]` (ordered), `isEmpty(el)`, `conversationPath` (regex on `pathname`), `postFillDelay`, and optionally `shadowHint`.

Adding a site = add an adapter + a `matchSite()` branch + `matches`/`host_permissions` entries in `manifest.json`.

## Editor gotchas (verified against live markup + vendor bundles — don't "simplify" these away)

- **Gemini** uses `data-test-id`, hyphenated. Every other site uses `data-testid`.
- **Claude** has no `data-testid="send-button"`; it is `chat-input-send`. Community scripts that claim otherwise are wrong.
- **ChatGPT**'s hidden `textarea.wcDTda_fallbackTextarea` is an a11y fallback React does not observe — writing to it launches voice mode instead of enabling send.
- **DeepSeek**'s send control is a `div[role="button"].ds-icon-button`, not a `<button>`, and its class names rotate per build — pick it by geometry relative to the textarea, not by class.
- Disabled-state detection must check all of: `.disabled`, `aria-disabled="true"`, a `disabled` class, and `data-visually-disabled`. Different sites use different ones.
- Three different editor architectures: Quill (Gemini) → synthetic `paste`; ProseMirror/Tiptap (ChatGPT, Claude) → `execCommand('insertText')`; React `<textarea>` (DeepSeek) → native `value` setter via the prototype descriptor + `input`/`change`.
- All four remount the composer on navigation and after each send. **Never cache the node across a send** — re-resolve it.
- Synthetic `Enter` is unreliable on ChatGPT (clears the composer without sending). Click the real send button; use `form.requestSubmit()` for `type="submit"` composers.

## The already-used guard

`localStorage` key `llm-url-prompt/consumed/v1`, keyed by `hash(prompt + "|" + sendFlag)`, 7-day TTL. Contract:

- Params are stripped from the URL **immediately** via `history.replaceState`, before acting.
- The entry is claimed **before** acting, so the 250ms poll loop can't double-fire. That claim is **provisional** (`inflight: true`, no `chatId`): it only blocks an immediate second open, and stops blocking after `CLAIM_TTL_MS` (chat-id watch window + 30s).
- **Only a stamped chat id blocks a prompt permanently.** When the app navigates to a matching `conversationPath`, the entry is stamped `{chatId, inflight: false}` and later visits are no-ops.
- Fill-only runs call `forget()` — nothing was sent, so there is nothing to dedupe and a revisit re-fills.
- A send that never navigates is *not* remembered; the claim lapses and a revisit retries.
- On fill/resolve failure the claim is **rolled back** (`forget`) so a revisit retries.

`claimState(key)` → `'done'` (chat id) | `'inflight'` (provisional) | `null` (act). Do not replace it with a plain `wasConsumed()` timestamp check — that reintroduces the old bug where a fill-only visit permanently blocked its own retest.

Ordering is the point: strip → claim → act → stamp. Changing it breaks the idempotency guarantee.
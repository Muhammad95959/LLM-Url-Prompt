# AGENTS.md

MV3 browser extension. Loads a prompt into ChatGPT / Gemini / Claude / DeepSeek from URL params.

## Layout

- `manifest.json` — no build step, no bundler, plain files.
- `src/sites.js` — shared DOM helpers + per-site adapter array. Defines `var LLM` (top-level `var`, so it lands on the content-script global shared with `content.js`). Must load **before** `content.js`.
- `src/content.js` — URL parsing, localStorage guard, orchestration.
- `src/content.js` runs at `document_start` and polls `location.href` every 250ms. This is deliberate: these are SPAs that use `pushState`, and a content script in the isolated world **cannot** patch the page's `history.pushState`.
- `test-all.sh` — manual smoke test: opens every provider with `?prompt=…&send=1`. The provider table is `id|label|url` strings; keep it in sync when adding a site. It appends a per-run `[test …]` tag so you can tell repeat runs apart in the chat (`--exact` sends verbatim).

## Adapter contract

Each entry in `LLM.sites` needs: `inputs[]` (ordered), `sends[]` (ordered), `isEmpty(el)`, `conversationPath` (regex on `pathname`), `postFillDelay`, and optionally `shadowHint`.

Adding a site = add an adapter + a `matchSite()` branch + `matches`/`host_permissions` entries in `manifest.json`.

## Editor gotchas (verified against live markup + vendor bundles — don't "simplify" these away)

- **Gemini** uses `data-test-id`, hyphenated. Every other site uses `data-testid`.
- **Claude** has no `data-testid="send-button"`; it is `chat-input-send`. Community scripts that claim otherwise are wrong.
- **ChatGPT**'s hidden `textarea.wcDTda_fallbackTextarea` is an a11y fallback React does not observe — writing to it launches voice mode instead of enabling send.
- **DeepSeek**'s send control is a `div[role="button"].ds-icon-button`, not a `<button>`, and its class names rotate per build — pick it by geometry relative to the textarea, not by class.
- Disabled-state detection must check all of: `el.disabled === true`, `aria-disabled="true"`, `data-visually-disabled`, and a `disabled` class. **But the class check applies only to elements with no native disabled state** (`div[role=button]` such as DeepSeek's). Claude's *enabled* send button carries a class with `disabled` in it (verified: `testid=chat-input-send disabled=false disabledClass=true`), so trusting the class on a real `<button>` vetoes a control that is ready to send — that is what made Claude fill and never send.
- Three different editor architectures: Quill (Gemini) → synthetic `paste`; ProseMirror/Tiptap (ChatGPT, Claude) → `execCommand('insertText')`; React `<textarea>` (DeepSeek) → native `value` setter via the prototype descriptor + `input`/`change`.
- All four remount the composer on navigation and after each send. **Never cache the node across a send** — re-resolve it.
- The synthetic-`Enter` fallback is **deleted**. On ChatGPT it clears the composer without sending. If no enabled send control is found, leave the prompt in the box and toast an error. `clickSend()` retries twice with the next `fill()` strategy (`{start: n}`), because a `paste` React ignores renders the text while the app's state stays empty, leaving the control disabled forever.
- When no `sends` selector matches an *enabled* control, `nearbySend()` scans the composer's footer by geometry: accessible name must match `/send|submit|发送|送信|發送/` and must not hit the `NOT_SEND` blocklist (mic/attach/model-picker/…). An unlabelled control is accepted only if nothing else qualifies. It refuses rather than risk clicking the mic.
- Never trust a single post-fill sleep: `ensureFilled()` re-resolves and re-fills with a short backoff before the send click, because a remount or redirect (DeepSeek's `/a/chat` → `/a/chat/s/<id>`) silently discards the text.
- To debug the send path, paste `debug-dump.js` into the **page** console (content-script `LLM` is not visible there) with the prompt filled but not sent, then call `dumpSend()`.

## The already-used guard

**Never persist anything derived from the prompt text** — not the text, not a hash of it. The only durable record is the conversation path from the URL, saved under `llm-url-prompt/sent-chats/v1` as `{path: ts}` (7-day TTL). Keyed by chat id alone.

- Params are stripped from the URL **immediately** via `history.replaceState`, before acting.
- In-memory `handled` Map (never persisted, gone on reload, `HANDLED_TTL_MS` = 10 min, capped at 20 entries) is what stops the 250ms poll loop from double-firing. `markHandled` / `releaseHandled(prompt, send)` — release on every early return.
- `rememberChat(path)` fires only after the send actually produced a conversation, via `recordChatId` — both shapes covered: a send inside an existing conversation URL (path already a conversation) and a send from a new-chat URL that navigates into one. Note the old `path !== originPath` check silently dropped the first case; don't re-add it.
- **A send that never navigates records nothing**, and fill-only records nothing, so both retry on the next visit. Do not add a "seen this prompt" entry to fix that — it is the exact bug this design avoids.
- Skip the run when `knownChat(location.pathname)` is true: params reappearing inside a conversation we already sent into would duplicate a send.
- Cost of this design: two tabs opening the *same* params URL simultaneously both fire, and re-opening a params URL later re-sends. Accepted — the alternative is storing prompt-derived keys.
- Manual reset in the site console: `localStorage.removeItem('llm-url-prompt/sent-chats/v1')`.

Ordering is the point: strip → guard → act → remember chat path. Changing it breaks the idempotency guarantee.
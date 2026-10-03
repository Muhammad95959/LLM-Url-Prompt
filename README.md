# LLM URL Prompt

Manifest V3 extension that fills — and optionally sends — prompts in **ChatGPT**, **Gemini**, **Claude** and **DeepSeek** straight from URL parameters.

## Install

```bash
# chrome://extensions → Developer mode → "Load unpacked" → pick this folder
```

Firefox: `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → `manifest.json`.

## Usage

| URL | Behaviour |
| --- | --- |
| `https://chatgpt.com/?prompt=hello%20world` | fills the composer, does **not** send |
| `https://chatgpt.com/?prompt=hello%20world&send=true` | fills **and** sends |
| `https://gemini.google.com/app?prompt=...&send=1` | same |
| `https://claude.ai/new?prompt=...` | fills only |
| `https://chat.deepseek.com/a/chat?prompt=...` | fills only |

- `prompt` (or the alias `q`) — the prompt text.
- `send` (aliases `autosubmit`, `submit`) — truthy values: `1`, `true`, `yes`, `on`, `send`, or the bare flag `?send`. Anything else means fill-only.

### Already-used guard

- The parameters are stripped from the address bar immediately (via `history.replaceState`), so the prompt is never left sitting in the URL, history, or a shared link.
- **Nothing derived from the prompt text is ever written to storage.** Not the text, not a hash of it.
- Repeat-fire protection is two-layered. In memory, per page load: a prompt handled once in this document is not handled again (10-minute window), which covers the 250ms poll loop. Durably: after a send, the conversation path the app navigated to (`/c/<id>`, `/app/<id>`, `/chat/<id>`, `/a/chat/s/<id>`) is saved under `llm-url-prompt/sent-chats/v1`, keyed by the path itself. If prompt parameters reappear while you are sitting on a conversation that already carries a sent prompt, the run is skipped and the parameters cleared.
- A fill-only run records nothing, and a send that never navigates records nothing — so both are retried on the next visit.
- Records expire after 7 days.

To reset manually, run in the site console:

```js
localStorage.removeItem('llm-url-prompt/sent-chats/v1')
```

## How it works

```
manifest.json
src/sites.js     shared DOM helpers + per-site adapters (selectors, fill strategy, timings)
src/content.js   URL parsing, storage guard, fill/send orchestration, toast
```

Each site is an adapter with:

- `inputs` — ordered selector list for the composer
- `sends` — ordered selector list for the send button
- `isEmpty` — how the app signals an empty composer
- `conversationPath` — regex identifying a created chat URL
- `postFillDelay` — settle time before clicking send

Because all four are SPAs with three different editor architectures, filling uses ordered strategies until one lands:

1. synthesized `ClipboardEvent('paste')` (Quill on Gemini)
2. `document.execCommand('insertText')` (ProseMirror / Tiptap on ChatGPT and Claude)
3. rebuild as one `<p>` per line + `InputEvent`, or the native `value` setter + `input`/`change` for React `<textarea>` (DeepSeek)

Everything is re-resolved on every attempt — these apps unmount and remount the composer on navigation and after each send.

### Per-site notes

| Site | Composer | Send button | Gotcha |
| --- | --- | --- | --- |
| ChatGPT | `div#prompt-textarea.ProseMirror` (signed-in) / `textarea#mobile-composer-prompt` (signed-out) | `button[data-testid="send-button"]`, `button[data-composer-submit]` | ignores the hidden `textarea.wcDTda_fallbackTextarea`; Octane uses `aria-disabled`, not `disabled` |
| Gemini | `rich-textarea .ql-editor` (Quill) | `button[data-test-id="send-button"]` | Google uses `data-test-id`; fully client-rendered so it needs the longest wait |
| Claude | `div.ProseMirror[data-testid="chat-input"]` (Tiptap) / `textarea#static-composer-input` pre-hydration | `button[data-testid="chat-input-send"]` | there is no `data-testid="send-button"`; `data-doc-empty="true"` is the app's own empty flag; the enabled button's className contains `disabled`, so class-based disabled checks must be skipped for native buttons |
| DeepSeek | `textarea[name="search"]` | `.ds-icon-button` / `div[role="button"]` | the send control is a `div`, not a `<button>`, and sits next to the textarea |

Submitting clicks the real send control (or `form.requestSubmit()` for `type="submit"` composers). There is no synthetic-`Enter` fallback any more: on ChatGPT it cleared the composer without sending, which is worse than leaving the text visible. If no enabled control is found the prompt stays in the box and an error toast says so.

A dead send path is treated as a fill failure, not a dead end. A composer can hold the text visually while the app's state never saw it — a `paste` event React ignores leaves the send button disabled forever — so `clickSend()` re-fills with the next fill strategy and looks again, up to two rounds.

## Testing

```bash
./test-all.sh "what is a monad"                 # all four providers, fill + send
./test-all.sh "what is a monad" -p gemini,claude  # subset (comma/space ok)
./test-all.sh "what is a monad" --exact         # send the text verbatim
./test-all.sh "what is a monad" --no-open       # just print the URLs
```

Each run appends a `[test <time>-<pid>]` tag to the prompt so repeats are distinguishable in the chat (`--exact` opts out). Re-running the same wording on a fresh-chat URL always fires, because blocking is keyed to the chat path, not the wording. Launcher order: `--browser`, then `brave-browser`, `brave`, `$BROWSER`, `xdg-open`.

## Debugging

All logging is prefixed `[llm-url-prompt]`. Open the site console to see which adapter matched, whether the fill landed, and which button was clicked.

Firefox's Error Console (Ctrl+Shift+J) shows `no enabled send button…` as a *warning* with a stack trace — that is not a crash. It means the fill landed but nothing that looked like an enabled send control was found in 8s; the prompt was left in the box rather than sent.

To see the real markup, paste `debug-dump.js` into the page console on a provider page with the prompt in the composer but **not yet sent**, then call `dumpSend()`. It copies a JSON dump of every composer plus its footer controls (test ids, aria-labels, all four disabled signals, geometry) to the clipboard. Note that `LLM` and other content-script globals are invisible in the page console, so the script is standalone.
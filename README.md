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
- Before acting, the entry `hash(prompt | send)` is claimed in `localStorage` under `llm-url-prompt/consumed/v1`. Re-opening the same URL is a no-op — the extension just shows a toast and clears the parameters.
- Once the app navigates to a conversation URL (`/c/<id>`, `/app/<id>`, `/chat/<id>`, `/a/chat/s/<id>`), the entry is stamped with that chat id.
- Entries expire after 7 days. If the composer could not be found or filled, the claim is rolled back so a revisit retries.

To reset manually, run in the site console:

```js
localStorage.removeItem('llm-url-prompt/consumed/v1')
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
| Claude | `div.ProseMirror[data-testid="chat-input"]` (Tiptap) / `textarea#static-composer-input` pre-hydration | `button[data-testid="chat-input-send"]` | there is no `data-testid="send-button"`; `data-doc-empty="true"` is the app's own empty flag |
| DeepSeek | `textarea[name="search"]` | `.ds-icon-button` / `div[role="button"]` | the send control is a `div`, not a `<button>`, and sits next to the textarea |

Submitting always prefers clicking the real send button (or `form.requestSubmit()` for `type="submit"` composers) and only falls back to a synthetic `Enter` keypress.

## Debugging

All logging is prefixed `[llm-url-prompt]`. Open the site console to see which adapter matched, whether the fill landed, and which button was clicked.
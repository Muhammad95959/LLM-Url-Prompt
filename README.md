# LLM URL Prompt

MV3 extension that fills — and optionally sends — prompts in **ChatGPT**, **Gemini**, **Claude** and **DeepSeek** from URL parameters.

## Install

- Chrome: `chrome://extensions` → Developer mode → "Load unpacked" → this folder.
- Firefox: `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → `manifest.json`.

## Usage

| URL | Behaviour |
| --- | --- |
| `https://chatgpt.com/?prompt=hello%20world` | fills, does **not** send |
| `https://chatgpt.com/?prompt=hello%20world&send=true` | fills **and** sends |
| `https://gemini.google.com/app?prompt=…&send=1` | same |
| `https://claude.ai/new?prompt=…` | fills only |
| `https://chat.deepseek.com/a/chat?prompt=…` | fills only |

- `prompt` (alias `q`) — the prompt text.
- `send` (aliases `autosubmit`, `submit`) — truthy: `1`, `true`, `yes`, `on`, `send`, or the bare `?send`. Anything else means fill-only.

### Already-used guard

Params are stripped from the address bar immediately (`history.replaceState`), so a prompt never sits in the URL or history.

**Nothing derived from the prompt text is ever stored** — not the text, not a hash of it. The only durable record is the conversation path a send produced (`/c/<id>`, `/app/<id>`, `/chat/<id>`, `/a/chat/s/<id>`), saved in `llm-url-prompt/sent-chats/v1` as `{path: timestamp}` for 7 days. Prompt params reappearing inside an already-sent conversation are skipped. A fill-only run records nothing, so a revisit refills.

To reset, in the site console:

```js
localStorage.removeItem('llm-url-prompt/sent-chats/v1')
```

## How it works

```
src/sites.js     DOM helpers + one adapter per site (selectors, timings)
src/content.js   URL parsing, guard, fill/send orchestration, toast
```

Each adapter declares `inputs[]`, `sends[]`, `isEmpty()`, `conversationPath` and `postFillDelay`. Adding a site = adapter + a `matchSite()` branch + `manifest.json` entries.

Three editor architectures, so filling walks ordered strategies until one lands:

1. synthesized `ClipboardEvent('paste')` — Quill (Gemini)
2. `document.execCommand('insertText')` — ProseMirror/Tiptap (ChatGPT, Claude)
3. one `<p>` per line + `InputEvent`, or the native `value` setter + `input`/`change` — React `<textarea>` (DeepSeek)

The composer is re-resolved on every attempt; these apps remount it on navigation and after each send.

| Site | Composer | Send | Gotcha |
| --- | --- | --- | --- |
| ChatGPT | `div#prompt-textarea.ProseMirror` / `textarea#mobile-composer-prompt` when signed out | `button[data-testid="send-button"]` | ignores the hidden a11y `textarea.wcDTda_fallbackTextarea`; uses `aria-disabled` |
| Gemini | `rich-textarea .ql-editor` (Quill) | `button[data-test-id="send-button"]` | Google hyphenates: `data-test-id`; slowest to render |
| Claude | `div.ProseMirror[data-testid="chat-input"]` | `button[data-testid="chat-input-send"]` | no `send-button` testid; `data-doc-empty` is its empty flag; the **enabled** button's className contains `disabled` |
| DeepSeek | `textarea[name="search"]` | `.ds-icon-button` (`div[role=button]`) | the control is a `div`, not a `<button>`; class names rotate per build |

Send is a real click (or `form.requestSubmit()`). There is no synthetic-`Enter` fallback — it cleared ChatGPT's composer without sending. If no enabled control turns up the prompt stays in the box and an error toast says so. A composer can also show the text while the app's state never saw it, so a dead send retries the fill with the next strategy before giving up.

## Testing

```bash
./test-all.sh "what is a monad"                    # all four providers
./test-all.sh "what is a monad" -p gemini,claude   # subset (comma or space)
./test-all.sh "what is a monad" --exact            # no run tag
./test-all.sh "what is a monad" --no-open          # print URLs only
```

Launcher order: `--browser`, `brave-browser`, `brave`, `$BROWSER`, `xdg-open`. Each run appends a `[test <time>-<pid>]` tag so repeats are tellable apart; `--exact` omits it.

## Debugging

Log lines are prefixed `[llm-url-prompt]` — which adapter matched, whether the fill landed, which control was clicked.

`no enabled send control after 2 rounds — not sending` is a **warning**, not a crash (Firefox's Error Console shows it with a stack trace): the fill worked, but no enabled send control was found in 8s + 3s. The same message lists every nearby control with its test id, aria-label, all four disabled signals and position — that line is usually enough to fix an adapter.

For the full markup, paste `debug-dump.js` into the page console with a prompt filled but **not yet sent** and call `dumpSend()`; it copies JSON to the clipboard. It is standalone because content-script globals such as `LLM` are invisible in the page console.
# LLM URL Prompt

Fill any AI chat box straight from a link. No copy-paste needed.

## How to install

1. Download or save this folder on your computer.
2. Open your browser's extensions page:
   - Chrome: type `chrome://extensions` in the address bar and press Enter
   - Brave: type `brave://extensions`
   - Edge: type `edge://extensions`
3. Turn on **Developer mode** (switch in the top-right corner).
4. Click **Load unpacked**.
5. Select this folder (`LLM-Url-Prompt`) and click Open.

Then pin the extension: click the puzzle-piece icon in the toolbar, then pin
**LLM URL Prompt**.

## Sending a prompt (recommended)

Click the extension's toolbar icon. A prompt composer opens where you can:

- paste your prompt **exactly as typed**, line breaks and indentation intact
- pick the provider
- tick **Send automatically** to submit instead of just fill
- copy the generated link to bookmark or share it

<kbd>Ctrl</kbd>+<kbd>Enter</kbd> (<kbd>⌘</kbd>+<kbd>Enter</kbd> on macOS) opens
the chat straight away.

This is the reliable way to send **multi-line prompts, especially code**.

## Sending a prompt by hand

1. Open one of the supported sites below.
2. Add `?prompt=` followed by your question to the end of the address.
3. To send it automatically, also add `&send` at the end.

```
https://chatgpt.com/?prompt=Explain%20black%20holes%20simply
https://chatgpt.com/?prompt=Explain%20black%20holes%20simply&send
```

- Without `&send`: your text appears in the chat box, ready for you to press Enter.
- With `&send`: your text is filled in and sent for you.

### Encoding

A URL cannot legally contain a line break, so browsers replace one you type or
paste into the address bar with a space **before the page loads** — the line
breaks are gone before the extension ever runs. Building links by hand
therefore means encoding:

| Character | Encode as |
|-----------|-----------|
| Space | `%20` (or `+`) |
| Line break | `%0A` |
| A literal `+` | `%2B` |

Longer prompts also give a site's editor more time to become interactive, so
prefer **Send automatically** for them.

## Troubleshooting

**A prompt arrives as one line, or the formatting is off.** Tick **Debug** in
the composer page (or add `&debug=1` to any link). The console then logs what
the site actually received:

```
DEBUG strategy: paste
DEBUG lines wanted: 7 | got: 7
DEBUG exact: true | lenient: true
DEBUG composer tag: DIV class="ProseMirror"
DEBUG raw textContent: "Review this:def parse(raw):    total = 0…"
DEBUG innerHTML: <p>Review this:</p><p>def parse(raw):</p><p>    total = 0</p>…
```

- `lines wanted` ≠ `got` means the **site or its editor** folded the breaks.
- `exact: false` but `lenient: true` means it arrived intact but the editor
  reindented it.
- If the composer shows the right text but the **URL** had no `%0A`, the break
  was lost before the page loaded — use the composer page.

The extension warns and keeps your prompt in the URL rather than sending
something mangled, so nothing is lost.

## Supported sites

| Site | Start link |
|------|------------|
| ChatGPT | https://chatgpt.com/ |
| Claude | https://claude.ai/new |
| Gemini | https://gemini.google.com/app |
| Grok | https://grok.com/ |
| Perplexity | https://perplexity.ai/ |
| Meta AI | https://meta.ai/ |
| DeepSeek | https://chat.deepseek.com/ |
| Qwen | https://chat.qwen.ai/ |
| Kimi | https://www.kimi.ai/ |
| Manus | https://manus.im/ |
| Poe | https://poe.com/ |
| Z.AI | https://chat.z.ai/ |
| Pi | https://pi.ai/ |
| DuckDuckGo AI | https://duck.ai/ |
| Venice | https://venice.ai/ |
| OpenRouter | https://openrouter.ai/chat |
| T3 Chat | https://t3.chat/ |
| Genspark | https://genspark.ai/ |

Just add `?prompt=hello` to any of the links above to try it out.

## Development

Provider list lives in `sites.js` — shared by the content script and the
composer page. To add a provider, add an entry there and its host to the
`matches` list in `manifest.json`.

```sh
node test.js          # 93 tests, no dependencies
./test-providers.sh   # open each provider in your default browser
```

`test.js` runs the real `content.js` against a simulated rich-text editor, so
it covers the regressions behind prompts being filled then discarded, and
multi-line prompts being collapsed to one line.

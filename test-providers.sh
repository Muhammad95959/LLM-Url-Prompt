#!/usr/bin/env bash
# Opens the system default browser at each provider URL supported by the LLM
# URL Prompt extension, with ?prompt=hello.
#
# Uses xdg-open (Linux), open (macOS), or cmd.exe start (Windows) to respect
# the OS default browser. Falls back to sensible-browser / python3 webbrowser.
#
# Usage:
#   ./test-providers.sh              # menu: pick one site to test
#   ./test-providers.sh all          # open every site, one browser window each,
#                                     # a few seconds apart
#   ./test-providers.sh chatgpt      # open just the named site
#   ./test-providers.sh --send all   # append &send=1 to auto-submit instead of
#                                     # just filling the composer
#
# BROWSER can be overridden, e.g.: BROWSER=brave ./test-providers.sh

DELAY_BETWEEN="${DELAY_BETWEEN:-0.25}"

open_url() {
  local url="$1"
  # Explicit BROWSER override still honored (keeps --test-type for Brave/Chromium).
  if [[ -n "${BROWSER:-}" ]]; then
    "$BROWSER" --test-type "$url" &
    return
  fi
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" &
  elif command -v open >/dev/null 2>&1; then
    open "$url" &
  elif command -v cmd.exe >/dev/null 2>&1; then
    cmd.exe /c start "" "$url" &
  elif command -v sensible-browser >/dev/null 2>&1; then
    sensible-browser "$url" &
  else
    python3 -m webbrowser "$url" &
  fi
}

# name -> URL (gated sites point straight at the path the extension requires)
declare -A SITES=(
  [chatgpt]="https://chatgpt.com/"
  [claude]="https://claude.ai/new"
  [gemini]="https://gemini.google.com/app"
  [grok]="https://grok.com/"
  [perplexity]="https://perplexity.ai/"
  [meta]="https://meta.ai/"
  [deepseek]="https://chat.deepseek.com/"
  [qwen]="https://chat.qwen.ai/"
  [kimi]="https://www.kimi.ai/"
  [manus]="https://manus.im/"
  [poe]="https://poe.com/"
  [zai]="https://chat.z.ai/"
  [pi]="https://pi.ai/"
  [duck]="https://duck.ai/"
  [venice]="https://venice.ai/"
  [openrouter]="https://openrouter.ai/chat"
  [t3chat]="https://t3.chat/"
  [genspark]="https://genspark.ai/"
)

SEND=""
if [[ "$1" == "--send" ]]; then
  SEND="&send=1"
  shift
fi

launch() {
  local name="$1"
  local base="${SITES[$name]}"
  local url="${base}?prompt=hello${SEND}"
  echo "-> [$name] $url"
  open_url "$url"
}

case "$1" in
  all)
    for name in "${!SITES[@]}"; do
      launch "$name"
      sleep "$DELAY_BETWEEN"
    done
    ;;
  "" )
    site_list="${!SITES[*]}"
    echo "Sites: $site_list"
    read -rp "Site to test: " pick
    if [[ -n "${SITES[$pick]:-}" ]]; then
      launch "$pick"
    else
      echo "Unknown site: $pick" >&2
      exit 1
    fi
    ;;
  *)
    if [[ -n "${SITES[$1]:-}" ]]; then
      launch "$1"
    else
      site_list="${!SITES[*]}"
      echo "Unknown site: $1" >&2
      echo "Sites: $site_list" >&2
      exit 1
    fi
    ;;
esac

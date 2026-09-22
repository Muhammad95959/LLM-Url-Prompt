#!/usr/bin/env bash
# Launches Brave (via --test-type, matching the reference command) at each
# provider URL supported by the LLM URL Prompt extension, with ?prompt=hello.
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

BROWSER="${BROWSER:-brave-origin}"
DELAY_BETWEEN="${DELAY_BETWEEN:-0.25}"

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
  [kimi]="https://kimi.com/"
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
  "$BROWSER" --test-type "$url" &
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

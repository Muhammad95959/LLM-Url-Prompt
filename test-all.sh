#!/usr/bin/env bash
# Opens every provider with ?prompt=<text>&send=1 so the extension fills AND sends.
#
#   ./test-all.sh "hello world"
#   ./test-all.sh "hello world" gemini claude
#   ./test-all.sh "hello world" --exact
#   ./test-all.sh "hello world" --no-open
set -euo pipefail

STORE_KEY='llm-url-prompt/consumed/v1'
CLAIM_TTL_NOTE='~2.5 min'

# id|label|landing page (must stay in sync with manifest.json + src/sites.js)
PROVIDERS=(
  'chatgpt|ChatGPT|https://chatgpt.com/'
  'gemini|Gemini|https://gemini.google.com/app'
  'claude|Claude|https://claude.ai/new'
  'deepseek|DeepSeek|https://chat.deepseek.com/a/chat'
)

OPEN_CMD=''
EXACT=0
PRINT_ONLY=0
DELAY=1

ids() {
  local row
  for row in "${PROVIDERS[@]}"; do
    printf '%s ' "${row%%|*}"
  done
}

usage() {
  cat <<EOF
usage: ${0##*/} [options] <prompt> [provider...]

Opens <provider> with ?prompt=<prompt>&send=1 — the extension fills the
composer and clicks send. Providers: $(ids)(default: all)

options:
  -b, --browser CMD   launcher to use (default: brave-browser, then brave,
                      then \$BROWSER, then xdg-open)
  -e, --exact         send <prompt> verbatim instead of appending a run tag
  -n, --no-open       only print the URLs, do not launch a browser
  -d, --delay SECS    pause between launches (default: ${DELAY})
  -h, --help          this text
EOF
}

die() {
  printf '%s: %s\n' "${0##*/}" "$*" >&2
  exit 1
}

urlencode() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,urllib.parse;print(urllib.parse.quote_plus(sys.stdin.read()))'
  elif command -v jq >/dev/null 2>&1; then
    jq -sRr @uri | sed 's/%20/+/g'
  else
    cat
    printf '\n%s: no python3/jq — prompt NOT encoded, special characters may break the URL\n' "${0##*/}" >&2
  fi
}

pick_browser() {
  [ -n "$OPEN_CMD" ] && return
  local candidate
  for candidate in brave-browser brave "${BROWSER:-}"; do
    if [ -n "$candidate" ] && command -v "$candidate" >/dev/null 2>&1; then
      OPEN_CMD="$candidate"
      return
    fi
  done
  OPEN_CMD='xdg-open'
}

while [ $# -gt 0 ]; do
  case "$1" in
    -b|--browser)
      [ $# -ge 2 ] || die "$1 needs a command"
      OPEN_CMD="$2"
      shift 2
      ;;
    -d|--delay)
      [ $# -ge 2 ] || die "$1 needs seconds"
      DELAY="$2"
      shift 2
      ;;
    -e|--exact) EXACT=1; shift ;;
    -n|--no-open) PRINT_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option $1 (try --help)" ;;
    *) break ;;
  esac
done

[ $# -ge 1 ] || {
  usage >&2
  exit 1
}

PROMPT="$1"
shift

case "$DELAY" in
  '' | *[!0-9.]*) die "--delay wants a number, got '$DELAY'" ;;
esac

SELECTED=()
if [ $# -gt 0 ]; then
  SELECTED=("$@")
  for want in "${SELECTED[@]}"; do
    found=0
    for row in "${PROVIDERS[@]}"; do
      [ "${row%%|*}" = "$want" ] && found=1
    done
    [ "$found" -eq 1 ] || die "unknown provider '$want' (pick from: $(ids))"
  done
else
  for row in "${PROVIDERS[@]}"; do
    SELECTED+=("${row%%|*}")
  done
fi

# A unique tag per run keeps the consumed-guard from swallowing a retest of the
# same wording; --exact opts out.
STAMP="[test $(date +%H%M%S)-$$]"
PAYLOAD="$PROMPT $STAMP"
[ "$EXACT" -eq 1 ] && PAYLOAD="$PROMPT"

ENCODED=$(printf '%s' "$PAYLOAD" | urlencode)

pick_browser

[ "$PRINT_ONLY" -eq 0 ] &&
  printf 'launcher: %s\ndelay:    %ss\nprompt:   %s\n\n' "$OPEN_CMD" "$DELAY" "$PAYLOAD"

total=${#SELECTED[@]}
i=0
for id in "${SELECTED[@]}"; do
  i=$((i + 1))
  for row in "${PROVIDERS[@]}"; do
    [ "${row%%|*}" = "$id" ] || continue
    label=$(printf '%s' "$row" | cut -d'|' -f2)
    base=${row##*|}
  done
  url="${base}?prompt=${ENCODED}&send=1"
  printf '%s [%d/%d] %s\n' "$label" "$i" "$total" "$url"
  if [ "$PRINT_ONLY" -eq 0 ]; then
    if ! "$OPEN_CMD" "$url" >/dev/null 2>&1; then
      printf '  ! launcher failed for %s\n' "$label" >&2
    fi
    [ "$i" -lt "$total" ] && sleep "$DELAY"
  fi
done

cat <<EOF

Expect a toast "Prompt filled — sending to <site>…" and a new chat URL on each
tab. A tab that says "already handled" still holds an unstamped claim: wait
${CLAIM_TTL_NOTE} or clear it in that site's console:
    localStorage.removeItem('$STORE_KEY')
EOF

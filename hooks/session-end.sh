#!/bin/sh
# SessionEnd: archive the transcript, detached, so the hook returns at once. Never loads the model.
# Always exits 0.
ROOT="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)" || exit 0
INPUT="$(cat 2>/dev/null)"
# Tiny parse: prints session_id and transcript_path on two lines.
FIELDS="$(printf '%s' "$INPUT" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
try{const o=JSON.parse(s);
if(typeof o.session_id==="string"&&/^[A-Za-z0-9_-]+$/.test(o.session_id)){
console.log(o.session_id);
console.log(typeof o.transcript_path==="string"?o.transcript_path:"");}}catch{}})' 2>/dev/null)" || exit 0
SESSION="$(printf '%s\n' "$FIELDS" | sed -n 1p)"
TRANSCRIPT="$(printf '%s\n' "$FIELDS" | sed -n 2p)"
[ -n "$SESSION" ] || exit 0

HOME_DIR="${TOTAL_RECALL_HOME:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/memory}"
LOG_DIR="$HOME_DIR/logs"
mkdir -p "$LOG_DIR" 2>/dev/null || exit 0
LOG="$LOG_DIR/archive.log"

if [ -n "$TRANSCRIPT" ]; then
  nohup node "$ROOT/bin/total-recall.js" archive --session "$SESSION" --transcript "$TRANSCRIPT" \
    </dev/null >>"$LOG" 2>&1 &
else
  nohup node "$ROOT/bin/total-recall.js" archive --session "$SESSION" \
    </dev/null >>"$LOG" 2>&1 &
fi
exit 0

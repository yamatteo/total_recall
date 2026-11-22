#!/bin/sh
# SessionStart: pure shell setup check. Silent when fine; stdout is added to the session context.
ROOT="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)" || exit 0
HOME_DIR="${TOTAL_RECALL_HOME:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/memory}"
RT="$HOME_DIR/runtime"
MODEL_REL="Xenova/bge-small-en-v1.5/onnx/model_quantized.onnx"
MODEL_ID="Xenova/bge-small-en-v1.5:q8"
TF_REL="node_modules/@huggingface/transformers"
need=0

# library: runtime first, then the repo (development fallback)
[ -d "$RT/$TF_REL" ] || [ -d "$ROOT/$TF_REL" ] || need=1

# model: TOTAL_RECALL_MODEL_CACHE, else runtime/models, else the repo's .cache
if [ -n "$TOTAL_RECALL_MODEL_CACHE" ]; then
  [ -f "$TOTAL_RECALL_MODEL_CACHE/$MODEL_REL" ] || need=1
else
  [ -f "$RT/models/$MODEL_REL" ] || [ -f "$ROOT/.cache/transformers/$MODEL_REL" ] || need=1
fi

# installed.json must match what this plugin version requires
if [ -f "$RT/installed.json" ]; then
  want_tf="$(sed -n 's/.*"@huggingface\/transformers" *: *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)"
  got_tf="$(sed -n 's/.*"transformers" *: *"\([^"]*\)".*/\1/p' "$RT/installed.json" | head -n 1)"
  got_model="$(sed -n 's/.*"model" *: *"\([^"]*\)".*/\1/p' "$RT/installed.json" | head -n 1)"
  [ "$got_tf" = "$want_tf" ] && [ "$got_model" = "$MODEL_ID" ] || need=1
fi

if [ "$need" = 1 ]; then
  echo "total-recall: setup needed — run: node $ROOT/bin/total-recall.js setup"
fi
exit 0

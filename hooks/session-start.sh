#!/bin/sh
# SessionStart: pure shell setup check. Silent when fine; stdout is added to the session context.
ROOT="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)" || exit 0
CACHE="${TOTAL_RECALL_MODEL_CACHE:-$ROOT/.cache/transformers}"
if [ ! -d "$ROOT/node_modules/@huggingface/transformers" ] ||
   [ ! -f "$CACHE/Xenova/bge-small-en-v1.5/onnx/model_quantized.onnx" ]; then
  echo "total-recall: setup incomplete — run: node $ROOT/bin/total-recall.js doctor"
fi
exit 0

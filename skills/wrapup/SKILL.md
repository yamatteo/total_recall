---
name: wrapup
description: Write long-term memory items for this session (overview, findings, mistakes, decisions) and ingest them into total_recall.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/total-recall.js *)
---

Session report (the session transcript has just been archived):

!`node "${CLAUDE_PLUGIN_ROOT}/bin/total-recall.js" prepare --session "${CLAUDE_SESSION_ID}" 2>&1 || true`

Wrap up this session into memory items.

1. Read the whole report above. If it shows an error instead of a report, tell the user and stop.
2. If the report lists compact boundaries, or your own context begins with a compaction summary, first read the compact summaries at the listed lines (Read with offset/limit; each summarises everything before it), then use targeted Read/Grep of the earlier ranges for details and exact quotes, so the items cover the whole session, not only what is still in your context.
3. Write the items:
   - exactly one `overview`;
   - `finding`, `mistake` and `decision` items as self-contained sentences that make sense without the session;
   - scope `global` only for knowledge useful outside this project, otherwise `project`;
   - 1 to 3 short verbatim quotes per non-overview item, copied exactly from message text in `transcript.md`, never from structural `#` lines.
4. Write the JSON to a temp file at the `--items` path given in the report, then run the `ingest` command from the report.
5. If ingest reports unmatched quotes, fix only those quotes (copy them exactly from `transcript.md`) and run ingest again.
6. End with a one-line summary per item.

$ARGUMENTS

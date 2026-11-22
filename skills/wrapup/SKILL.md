---
name: wrapup
description: Write long-term memory items for this session, or for an earlier one given by session id (overview, findings, mistakes, decisions), and ingest them into total_recall.
argument-hint: [session-id]
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/total-recall.js *) Read(~/.claude/memory/**)
---

Wrap up a session into memory items. Target session: the id in `$ARGUMENTS` if one is given, otherwise the current session `${CLAUDE_SESSION_ID}`.

1. Run `node ${CLAUDE_PLUGIN_ROOT}/bin/total-recall.js prepare --session <id>`, with `<id>` the target session id (`prepare` validates it). It archives the session (from total_recall's stored copy if Claude Code has deleted the original) and prints a report. Read the whole report. If it prints an error instead of a report, tell the user and stop.
2. If the report lists compact boundaries, or your own context begins with a compaction summary, first read the compact summaries at the listed lines (Read with offset/limit; each summarises everything before it), then use targeted Read/Grep of the earlier ranges for details and exact quotes, so the items cover the whole session, not only what is still in your context.
3. Write the items:
   - exactly one `overview`;
   - `finding`, `mistake` and `decision` items as self-contained sentences that make sense without the session;
   - scope `global` only for knowledge useful outside this project, otherwise `project`;
   - 1 to 3 short verbatim quotes per non-overview item, copied exactly from message text in `transcript.md`, never from structural `#` lines.
4. Write the JSON to a temp file at the `--items` path given in the report, then run the `ingest` command from the report.
5. If ingest reports unmatched quotes, fix only those quotes (copy them exactly from `transcript.md`) and run ingest again.
6. End with a one-line summary per item.

Wrapping up a session other than the current one: you were not in it, so your context says nothing about it. Build your picture only from that session's `transcript.md` (path in the report): read the compact summaries at the listed lines first, then Read in chunks (offset/limit) and Grep through the whole transcript, including an uncompacted one. Never write items from your own context; every item must rest on text you read in `transcript.md`. For the current session, proceed as described above.

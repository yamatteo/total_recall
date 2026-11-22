# total_recall

Long-term memory for Claude Code sessions. This is the ingest core: it archives a
session transcript, writes a cleaned and redacted greppable copy, validates the
memory items the session's model wrote, anchors each item's verbatim quotes to
transcript entry uuids, embeds the items and stores them in one SQLite index.
Skills and hooks are not part of this step.

Plain JavaScript (ESM, JSDoc types checked by `tsc`), no build step. Needs Node >= 22.5
(`node:sqlite`; its ExperimentalWarning is suppressed by the CLI).

## Usage

    node bin/total-recall.js ingest --session <id> --items items.json [--transcript <path>]
    node bin/total-recall.js search "<query>" [--scope project|global|all] [--project <project_id>] [--limit N] [--json]

Items file: `{"items":[{"kind":"overview|finding|mistake|decision","scope":"project|global","text":"...","quotes":["..."]}]}`.
Exactly one `overview`; every other item needs at least one quote; quotes are at least 15
characters and must appear verbatim (whitespace and case insensitive) in the cleaned transcript,
including compaction summaries and subagents. If any quote is unmatched, ingest changes nothing.
Re-ingesting a session replaces its rows and files atomically.

`--project` with scope `all` returns that project's items plus global ones.

## Storage

Root: `TOTAL_RECALL_HOME` (default `~/.claude/memory/`), dirs 0700, files 0600.

    index.sqlite
    sessions/<session_id>/raw.jsonl.gz            unredacted archive
    sessions/<session_id>/subagents/agent-<id>.jsonl.gz (+ .meta.json)
    sessions/<session_id>/transcript.md           cleaned, redacted, greppable
    sessions/<session_id>/items.json              validated, redacted items

The raw archive is NOT redacted. Redaction of `transcript.md` and item text is best-effort
pattern matching (API keys, GitHub/AWS/Slack tokens, JWTs, PEM private keys, `NAME=value`
for secret-looking names, `.env` file reads) and will miss secrets. A `NAME=value` / `NAME: value` pair is redacted only when the value looks
like a secret (at least 8 characters after stripping quotes, not purely numeric, not
`true|false|null|none|undefined`).

`transcript.md` grammar: the only lines starting with `#` are structural: `## <uuid> <role> <timestamp>`
(role is `user`, `assistant` or `compact-summary`), `# compact boundary …` and `# subagent …`. Content
lines that begin with `#` are written with one leading space. Long tool results are truncated there
(first 20 and last 10 lines), but quotes in items are matched against the full, untruncated text.

## Embeddings

`Xenova/bge-small-en-v1.5` (q8), run offline from `TOTAL_RECALL_MODEL_CACHE`
(default `<repo>/.cache/transformers`; the model must already be cached). The model is recorded
in the index; opening an index built with a different model fails with a "re-index needed" error.
Search is a brute-force dot product over Float32 blobs.

## Development

    npm test            # unit tests, fake embedder
    npm run test:model  # real model, offline
    npm run typecheck

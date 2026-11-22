# total_recall

Long-term memory for Claude Code sessions. This is the ingest core: it archives a
session transcript, writes a cleaned and redacted greppable copy, validates the
memory items the session's model wrote, anchors each item's verbatim quotes to
transcript entry uuids, embeds the items and stores them in one SQLite index.
It is also a Claude Code plugin (`.claude-plugin/plugin.json`): a `/wrapup` skill, a `/recall` skill and a setup-check hook.

**Storage policy: only what the user wraps up.** Nothing is archived automatically (there is no SessionEnd hook,
so no unredacted `raw.jsonl.gz` is written for sessions you did not choose). A session enters memory only through
`/wrapup`. A session you forgot to wrap up can still be wrapped up later with `/wrapup <session-id>`, but only while
Claude Code still keeps its transcript (default retention 30 days, set by `cleanupPeriodDays`). A wrapped-up session
stays re-processable after Claude Code deletes the original, because `archive`/`prepare`/`ingest` fall back to the
stored `raw.jsonl.gz` (and subagent files). `forget` removes a session from memory.

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
    node bin/total-recall.js archive --session <id> [--transcript <path>]
    node bin/total-recall.js prepare --session <id> [--transcript <path>]
    node bin/total-recall.js forget --session <id>
    node bin/total-recall.js doctor
    node bin/total-recall.js recall "<query>" [--cwd <dir>] [--everywhere] [--limit N] [--json]
    node bin/total-recall.js sessions [--cwd <dir>] [--everywhere] [--json]

`recall` is the model-facing read side: it searches memory, groups hits by session and prints each session's
transcript path, overview and items with `transcript.md:LINE` anchors (resolved at query time by scanning the
transcript for `## <uuid> ` headers; `?` when unresolved or the file is missing). Scope: the project of `--cwd`
(default: the current directory, via `project_id`) plus global items; `--everywhere` searches all projects.
`sessions` lists archived sessions (including any archived without items, e.g. a wrap-up abandoned after `prepare`) newest first, with transcript
paths to grep. Both only read the index; `sessions` loads no model.

`forget --session <id>` deletes the session's anchors, items and session row in one transaction, then (after the commit)
removes `sessions/<id>/`; it prints what it removed, exits 1 for an unknown id (or if the files cannot be removed), asks
no confirmation and loads no model. Use it for sessions the old SessionEnd hook archived or an abandoned wrap-up.

`archive` refreshes `raw.jsonl.gz`, `transcript.md`, subagent files and the session row, and never touches
items or anchors (a transcript only grows, so anchors stay valid). It loads no model. Source: `--transcript`, else Claude
Code's own file under `<config>/projects/*/<id>.jsonl`, else total_recall's stored copy (the result is identical). `prepare` archives, then
prints a report: paths, the line numbers of every `# compact boundary` and of the `compact-summary` header after each in `transcript.md`, the items rules and
the exact `ingest` command. `doctor` checks Node, `node_modules`, the cached q8 model, a writable
`TOTAL_RECALL_HOME` and the index, and prints the fix for each failure (exit 1 if any fails).

## Plugin

- `/wrapup [session-id]` (user-invoked only): runs `prepare` (for the given id, default the current session), then the model writes the items and runs
  `ingest`. If the session was compacted, the model's context holds only a summary, so the skill tells it to read
  the compact summaries at the listed lines first, then use targeted Read/Grep for details. For another session the model
  was not in it, so it builds items only from that session's `transcript.md`. No external API is called.
- `/recall <question>` (model-invocable): runs `recall`, reads about 40 lines around anchors, falls back to
  grepping transcripts found via `recall`/`sessions`, and answers with `transcript.md:LINE` sources. Its
  `allowed-tools` has `Read(~/.claude/memory/**)` (Read rules also cover Grep and Glob; `Grep(path)` rules do not
  match). If `TOTAL_RECALL_HOME` points elsewhere, add a matching `Read(...)` allow rule yourself.
- SessionStart hook (`startup`): a shell-only check; prints one line pointing at `doctor` if setup is incomplete.

Setup is never automatic. Install dependencies with
`ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install` in the plugin directory, then run `doctor` for the model
warm-up command.

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

import fs from 'node:fs';
import path from 'node:path';
import { commitSession, loadSession } from './archive.js';
import { normalizeText } from './clean.js';
import { counts, openDb, replaceSession, searchItems } from './db.js';
import { resolveQuotes, validateItems } from './items.js';
import { assertSessionId, memoryHome } from './paths.js';
import { projectId } from './project.js';

/** @typedef {import('./embed.js').Embedder} Embedder */

export class UnmatchedQuotesError extends Error {
  /** @param {Array<{item: number, quote: string}>} unmatched */
  constructor(unmatched) {
    super(
      `${unmatched.length} quote(s) not found in the transcript; nothing was changed:\n` +
        unmatched.map((u) => `  - item ${u.item}: ${JSON.stringify(u.quote)}`).join('\n'),
    );
    this.name = 'UnmatchedQuotesError';
    this.unmatched = unmatched;
  }
}

/**
 * Ingest one session. All-or-nothing: on any failure the previous state is intact.
 * @param {{sessionId: string, itemsFile: string, transcript?: string, home?: string, embedder: Embedder}} o
 */
export async function ingest(o) {
  const { sessionId, embedder } = o;
  assertSessionId(sessionId);
  const home = o.home ?? memoryHome();

  const items = validateItems(JSON.parse(fs.readFileSync(o.itemsFile, 'utf8')));

  const data = loadSession(sessionId, o.transcript, home);
  const { main, subs } = data;

  /** @type {Array<{uuid: string, norm: string}>} */
  const index = [];
  for (const blocks of [main, ...subs.map((s) => s.blocks)]) {
    for (const b of blocks) if (b.kind === 'message') index.push({ uuid: b.uuid, norm: normalizeText(b.full) });
  }
  const { anchors, unmatched } = resolveQuotes(items, index, normalizeText);
  if (unmatched.length) throw new UnmatchedQuotesError(unmatched);

  const embeddings = await embedder.embedPassages(items.map((i) => i.text));

  const db = await openDb(home, embedder);
  try {
    commitSession({
      db,
      home,
      data,
      itemsJson: `${JSON.stringify({ items }, null, 2)}\n`,
      dbWork: (finalDir) =>
        replaceSession(
          db,
          {
            session_id: sessionId,
            project_id: projectId(data.cwd),
            project_path: data.cwd,
            started_at: data.stamps[0] ?? null,
            ended_at: data.stamps[data.stamps.length - 1] ?? null,
            ingested_at: new Date().toISOString(),
            transcript_path: path.join(finalDir, 'transcript.md'),
            raw_path: path.join(finalDir, 'raw.jsonl.gz'),
          },
          items.map((it, i) => ({
            kind: it.kind,
            scope: it.scope,
            text: it.text,
            embedding: /** @type {Float32Array} */ (embeddings[i]),
            anchors: /** @type {Array<{uuid: string, quote: string}>} */ (anchors[i]),
          })),
        ),
    });
  } finally {
    db.close();
  }
  return { sessionId, items: items.length, anchors: anchors.reduce((n, a) => n + a.length, 0), subagents: subs.length };
}

/**
 * Embed the query and search the index.
 * @param {{query: string, scope?: 'project'|'global'|'all', project?: string, limit?: number, home?: string, embedder: Embedder}} o
 */
export async function search(o) {
  const db = await openDb(o.home ?? memoryHome(), o.embedder);
  try {
    const q = await o.embedder.embedQuery(o.query);
    return searchItems(db, q, o);
  } finally {
    db.close();
  }
}

export { counts };

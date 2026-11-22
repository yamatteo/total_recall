import fs from 'node:fs';
import { openDb, searchItems } from './db.js';
import { memoryHome } from './paths.js';
import { projectId } from './project.js';

/** @typedef {import('./embed.js').Embedder} Embedder */

/**
 * Map message uuids to the 1-based line of their `## <uuid> ` header in a transcript.md.
 * Returns null when the file cannot be read.
 * @param {string} file
 * @param {Set<string>} wanted
 * @returns {Map<string, number> | null}
 */
export function resolveLines(file, wanted) {
  /** @type {string} */
  let md;
  try {
    md = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  /** @type {Map<string, number>} */
  const found = new Map();
  let line = 0;
  let pos = 0;
  while (pos <= md.length && found.size < wanted.size) {
    line++;
    let end = md.indexOf('\n', pos);
    if (end === -1) end = md.length;
    if (md.startsWith('## ', pos)) {
      const sp = md.indexOf(' ', pos + 3);
      const uuid = md.slice(pos + 3, sp === -1 || sp > end ? end : sp);
      if (wanted.has(uuid) && !found.has(uuid)) found.set(uuid, line);
    }
    pos = end + 1;
  }
  return found;
}

/**
 * Model-facing search: scope from a directory, results grouped by session, anchors resolved to transcript lines.
 * Read-only.
 * @param {{query: string, cwd?: string, everywhere?: boolean, limit?: number, embedder: Embedder, home?: string}} o
 */
export async function recall(o) {
  const project = o.everywhere ? undefined : projectId(o.cwd ?? process.cwd());
  const db = await openDb(o.home ?? memoryHome(), o.embedder);
  try {
    const q = await o.embedder.embedQuery(o.query);
    const hits = searchItems(db, q, { scope: 'all', project, limit: o.limit ?? 8 });
    const sessionQ = db.prepare('SELECT * FROM sessions WHERE session_id = ?');
    const overviewQ = db.prepare("SELECT text FROM items WHERE session_id = ? AND kind = 'overview' ORDER BY id LIMIT 1");
    /** @type {Map<string, typeof hits>} */
    const bySession = new Map();
    for (const h of hits) bySession.set(h.session_id, [...(bySession.get(h.session_id) ?? []), h]);
    const sessions = [...bySession.entries()].map(([id, items]) => {
      const row = /** @type {any} */ (sessionQ.get(id)) ?? {};
      const ov = /** @type {{text: string} | undefined} */ (overviewQ.get(id));
      const transcript = String(row.transcript_path ?? '');
      const wanted = new Set(items.flatMap((i) => i.anchors));
      const lines = transcript ? resolveLines(transcript, wanted) : null;
      return {
        session_id: id,
        started_at: /** @type {string | null} */ (row.started_at ?? null),
        ended_at: /** @type {string | null} */ (row.ended_at ?? null),
        project_path: /** @type {string | null} */ (row.project_path ?? null),
        transcript,
        transcript_exists: lines !== null,
        best: Math.max(...items.map((i) => i.score)),
        overview: ov?.text ?? null,
        items: items
          .filter((i) => i.kind !== 'overview')
          .map((i) => ({
            score: i.score,
            kind: i.kind,
            scope: i.scope,
            text: i.text,
            anchors: i.anchors.map((uuid) => ({ uuid, line: lines?.get(uuid) ?? null })),
          })),
      };
    });
    sessions.sort((a, b) => b.best - a.best);
    return { query: o.query, everywhere: Boolean(o.everywhere), project: project ?? null, sessions };
  } finally {
    db.close();
  }
}

/** @param {Awaited<ReturnType<typeof recall>>} data */
export function formatRecall(data) {
  if (!data.sessions.length) {
    return `memory has nothing for this scope${data.everywhere ? '' : ' (try --everywhere to search all projects)'}`;
  }
  /** @type {string[]} */
  const out = [];
  for (const s of data.sessions) {
    out.push(
      `session ${s.session_id}  ${s.started_at ?? '?'}..${s.ended_at ?? '?'}  ${s.project_path ?? '?'}  best ${s.best.toFixed(3)}`,
    );
    out.push(`transcript: ${s.transcript || '?'}${s.transcript_exists ? '' : ' (missing)'}`);
    if (s.overview) out.push(`overview: ${s.overview}`);
    for (const it of s.items) {
      out.push(`- [${it.score.toFixed(3)}] ${it.kind} (${it.scope}): ${it.text}`);
      if (it.anchors.length) out.push(`    at transcript.md:${it.anchors.map((a) => a.line ?? '?').join(', ')}`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}

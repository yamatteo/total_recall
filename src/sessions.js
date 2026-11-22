import { openDb } from './db.js';
import { memoryHome } from './paths.js';
import { projectId } from './project.js';

const OVERVIEW_MAX = 160;

/**
 * List archived sessions (wrapped up or not), newest first. Needs no embedding model. Read-only.
 * @param {{cwd?: string, everywhere?: boolean, home?: string}} o
 */
export async function listSessions(o) {
  const db = await openDb(o.home ?? memoryHome());
  try {
    const rows = /** @type {any[]} */ (
      db
        .prepare(
          `SELECT s.session_id, s.started_at, s.ended_at, s.project_path, s.transcript_path,
             (SELECT count(*) FROM items i WHERE i.session_id = s.session_id) AS n_items,
             (SELECT i.text FROM items i WHERE i.session_id = s.session_id AND i.kind = 'overview' ORDER BY i.id LIMIT 1) AS overview
           FROM sessions s ${o.everywhere ? '' : 'WHERE s.project_id = ?'}
           ORDER BY s.ended_at IS NULL, s.ended_at DESC, s.session_id`,
        )
        .all(...(o.everywhere ? [] : [projectId(o.cwd ?? process.cwd())]))
    );
    return rows.map((r) => {
      const first = String(r.overview ?? '').split('\n')[0] ?? '';
      return {
        session_id: String(r.session_id),
        started_at: /** @type {string | null} */ (r.started_at ?? null),
        ended_at: /** @type {string | null} */ (r.ended_at ?? null),
        project_path: /** @type {string | null} */ (r.project_path ?? null),
        items: Number(r.n_items),
        overview: first.length > OVERVIEW_MAX ? `${first.slice(0, OVERVIEW_MAX - 3)}...` : first,
        transcript: String(r.transcript_path ?? ''),
      };
    });
  } finally {
    db.close();
  }
}

/** @param {Awaited<ReturnType<typeof listSessions>>} rows @param {boolean} [everywhere] */
export function formatSessions(rows, everywhere) {
  if (!rows.length) return `no archived sessions for this scope${everywhere ? '' : ' (try --everywhere)'}`;
  return rows
    .map((r) =>
      [
        `session ${r.session_id}  ${r.started_at ?? '?'}..${r.ended_at ?? '?'}  ${r.project_path ?? '?'}  items ${r.items}`,
        `  transcript: ${r.transcript}`,
        `  overview: ${r.overview || '(not wrapped up)'}`,
      ].join('\n'),
    )
    .join('\n');
}

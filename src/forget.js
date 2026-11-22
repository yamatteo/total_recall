import fs from 'node:fs';
import { openDb } from './db.js';
import { assertSessionId, memoryHome, sessionDir } from './paths.js';

/**
 * Remove a session from memory: its anchors, items and session row in one transaction, then (only after
 * COMMIT) `sessions/<id>/`. The foreign keys do not cascade, so rows are deleted explicitly. Needs no model.
 * Throws if the session is unknown; if the files cannot be removed the rows are already gone, and the error says so.
 * @param {{sessionId: string, home?: string}} o
 */
export async function forget(o) {
  assertSessionId(o.sessionId);
  const home = o.home ?? memoryHome();
  const dir = sessionDir(home, o.sessionId);
  const db = await openDb(home);
  let items = 0;
  let anchors = 0;
  let hadRow = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      hadRow = db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(o.sessionId) !== undefined;
      const n = (/** @type {string} */ sql) => Number(/** @type {{n: number}} */ (db.prepare(sql).get(o.sessionId)).n);
      items = n('SELECT count(*) n FROM items WHERE session_id = ?');
      anchors = n('SELECT count(*) n FROM anchors WHERE item_id IN (SELECT id FROM items WHERE session_id = ?)');
      db.prepare('DELETE FROM anchors WHERE item_id IN (SELECT id FROM items WHERE session_id = ?)').run(o.sessionId);
      db.prepare('DELETE FROM items WHERE session_id = ?').run(o.sessionId);
      db.prepare('DELETE FROM sessions WHERE session_id = ?').run(o.sessionId);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // no open transaction
      }
      throw err;
    }
  } finally {
    db.close();
  }
  const hadDir = fs.existsSync(dir);
  if (!hadRow && !hadDir) throw new Error(`session ${o.sessionId} is not in memory`);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    throw new Error(
      `forgot session ${o.sessionId} from the index (${items} items, ${anchors} anchors) but could not remove ${dir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return { sessionId: o.sessionId, items, anchors, dir, removedDir: hadDir };
}

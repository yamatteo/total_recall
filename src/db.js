import fs from 'node:fs';
import { suppressSqliteWarning } from './warnings.js';
import { dot, fromBlob, toBlob } from './embed.js';
import { indexPath } from './paths.js';

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {import('./embed.js').Embedder} Embedder */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY, project_id TEXT, project_path TEXT,
  started_at TEXT, ended_at TEXT, ingested_at TEXT, transcript_path TEXT, raw_path TEXT);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id),
  kind TEXT NOT NULL, scope TEXT NOT NULL, text TEXT NOT NULL, embedding BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS anchors (
  item_id INTEGER NOT NULL REFERENCES items(id), message_uuid TEXT NOT NULL, quote TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS items_session ON items(session_id);
CREATE INDEX IF NOT EXISTS anchors_item ON anchors(item_id);
`;

/**
 * Open (creating if needed) the index. Fails if it was built with a different embedding model.
 * @param {string} home
 * @param {Embedder} embedder
 * @returns {Promise<Database>}
 */
export async function openDb(home, embedder) {
  suppressSqliteWarning();
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = indexPath(home);
  const isNew = !fs.existsSync(file);
  const db = new DatabaseSync(file);
  if (isNew) fs.chmodSync(file, 0o600);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  const get = db.prepare('SELECT value FROM meta WHERE key = ?');
  const model = /** @type {{value: string} | undefined} */ (get.get('embedding_model'));
  if (!model) {
    const put = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)');
    put.run('embedding_model', embedder.model);
    put.run('embedding_dim', String(embedder.dim));
  } else if (model.value !== embedder.model) {
    db.close();
    throw new Error(
      `index was built with embedding model "${model.value}" but "${embedder.model}" is configured: re-index needed`,
    );
  }
  return db;
}

/**
 * @typedef {{session_id: string, project_id: string, project_path: string | null, started_at: string | null,
 *   ended_at: string | null, ingested_at: string, transcript_path: string, raw_path: string}} SessionRow
 * @typedef {{kind: string, scope: string, text: string, embedding: Float32Array,
 *   anchors: Array<{uuid: string, quote: string}>}} ItemRow
 */

/**
 * Replace all rows of a session. Caller owns the surrounding transaction.
 * @param {Database} db @param {SessionRow} s @param {ItemRow[]} items
 */
export function replaceSession(db, s, items) {
  db.prepare('DELETE FROM anchors WHERE item_id IN (SELECT id FROM items WHERE session_id = ?)').run(s.session_id);
  db.prepare('DELETE FROM items WHERE session_id = ?').run(s.session_id);
  db.prepare('DELETE FROM sessions WHERE session_id = ?').run(s.session_id);
  db.prepare(
    `INSERT INTO sessions(session_id, project_id, project_path, started_at, ended_at, ingested_at, transcript_path, raw_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(s.session_id, s.project_id, s.project_path, s.started_at, s.ended_at, s.ingested_at, s.transcript_path, s.raw_path);
  const insItem = db.prepare('INSERT INTO items(session_id, kind, scope, text, embedding) VALUES (?, ?, ?, ?, ?)');
  const insAnchor = db.prepare('INSERT INTO anchors(item_id, message_uuid, quote) VALUES (?, ?, ?)');
  for (const it of items) {
    const r = insItem.run(s.session_id, it.kind, it.scope, it.text, toBlob(it.embedding));
    for (const a of it.anchors) insAnchor.run(r.lastInsertRowid, a.uuid, a.quote);
  }
}

/** @param {Database} db */
export function counts(db) {
  const n = (/** @type {string} */ t) =>
    Number(/** @type {{n: number}} */ (db.prepare(`SELECT count(*) n FROM ${t}`).get()).n);
  return { sessions: n('sessions'), items: n('items'), anchors: n('anchors') };
}

/**
 * Brute-force vector search. scope "all" with a project returns that project's items plus global ones.
 * @param {Database} db
 * @param {Float32Array} query
 * @param {{scope?: 'project'|'global'|'all', project?: string, limit?: number}} opts
 */
export function searchItems(db, query, opts = {}) {
  const scope = opts.scope ?? 'all';
  /** @type {string[]} */ const where = [];
  /** @type {string[]} */ const params = [];
  if (scope === 'project' || scope === 'global') {
    where.push('i.scope = ?');
    params.push(scope);
    if (opts.project && scope === 'project') {
      where.push('s.project_id = ?');
      params.push(opts.project);
    }
  } else if (opts.project) {
    where.push("(i.scope = 'global' OR s.project_id = ?)");
    params.push(opts.project);
  }
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        `SELECT i.id, i.session_id, i.kind, i.scope, i.text, i.embedding, s.project_id
         FROM items i JOIN sessions s ON s.session_id = i.session_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
      )
      .all(...params)
  );
  const scored = rows
    .map((r) => ({ r, score: dot(query, fromBlob(r.embedding)) }))
    .sort((a, b) => b.score - a.score || a.r.id - b.r.id)
    .slice(0, opts.limit ?? 10);
  const anchorQ = db.prepare('SELECT DISTINCT message_uuid FROM anchors WHERE item_id = ? ORDER BY rowid');
  return scored.map(({ r, score }, idx) => ({
    rank: idx + 1,
    score,
    id: Number(r.id),
    kind: String(r.kind),
    scope: String(r.scope),
    session_id: String(r.session_id),
    project_id: String(r.project_id),
    text: String(r.text),
    anchors: /** @type {any[]} */ (anchorQ.all(r.id)).map((a) => String(a.message_uuid)),
  }));
}

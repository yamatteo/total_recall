import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { cleanEntries, normalizeText, renderTranscript } from './clean.js';
import { counts, openDb, replaceSession, searchItems } from './db.js';
import { resolveQuotes, validateItems } from './items.js';
import { assertSessionId, findTranscript, memoryHome, sessionDir } from './paths.js';
import { listSubagents, parseJsonl } from './parse.js';
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

/** @param {string} p */
const write = (p, /** @type {string | Uint8Array} */ data) => fs.writeFileSync(p, data, { mode: 0o600 });

/**
 * Ingest one session. All-or-nothing: on any failure the previous state is intact.
 * @param {{sessionId: string, itemsFile: string, transcript?: string, home?: string, embedder: Embedder}} o
 */
export async function ingest(o) {
  const { sessionId, embedder } = o;
  assertSessionId(sessionId);
  const home = o.home ?? memoryHome();

  const items = validateItems(JSON.parse(fs.readFileSync(o.itemsFile, 'utf8')));

  const transcript = o.transcript ?? findTranscript(sessionId);
  if (!transcript || !fs.existsSync(transcript)) {
    throw new Error(`transcript for session ${sessionId} not found${transcript ? `: ${transcript}` : ''}`);
  }
  const rawMain = fs.readFileSync(transcript);
  const mainEntries = parseJsonl(rawMain.toString('utf8'));
  const main = cleanEntries(mainEntries);
  const subs = listSubagents(transcript, sessionId).map((s) => ({
    ...s,
    raw: fs.readFileSync(s.file),
    blocks: cleanEntries(parseJsonl(fs.readFileSync(s.file, 'utf8'))),
  }));

  /** @type {Array<{uuid: string, norm: string}>} */
  const index = [];
  for (const blocks of [main, ...subs.map((s) => s.blocks)]) {
    for (const b of blocks) if (b.kind === 'message') index.push({ uuid: b.uuid, norm: normalizeText(b.full) });
  }
  const { anchors, unmatched } = resolveQuotes(items, index, normalizeText);
  if (unmatched.length) throw new UnmatchedQuotesError(unmatched);

  const embeddings = await embedder.embedPassages(items.map((i) => i.text));

  const stamps = mainEntries.map((e) => e.timestamp).filter((t) => typeof t === 'string').sort();
  const cwd = mainEntries.find((e) => typeof e.cwd === 'string')?.cwd ?? null;

  const db = await openDb(home, embedder);
  const sessionsRoot = path.join(home, 'sessions');
  const finalDir = sessionDir(home, sessionId);
  const tag = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const tmpDir = path.join(sessionsRoot, `.tmp-${sessionId}-${tag}`);
  const oldDir = path.join(sessionsRoot, `.old-${sessionId}-${tag}`);
  let swapped = false;
  let hadOld = false;
  try {
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(sessionsRoot, 0o700);
    write(path.join(tmpDir, 'raw.jsonl.gz'), zlib.gzipSync(rawMain));
    if (subs.length) {
      fs.mkdirSync(path.join(tmpDir, 'subagents'), { mode: 0o700 });
      for (const s of subs) {
        write(path.join(tmpDir, 'subagents', `${s.id}.jsonl.gz`), zlib.gzipSync(s.raw));
        if (s.metaFile) write(path.join(tmpDir, 'subagents', `${s.id}.meta.json`), fs.readFileSync(s.metaFile));
      }
    }
    write(
      path.join(tmpDir, 'transcript.md'),
      renderTranscript(main, subs.map((s) => ({ id: s.id, description: s.description, blocks: s.blocks }))),
    );
    write(path.join(tmpDir, 'items.json'), `${JSON.stringify({ items }, null, 2)}\n`);

    db.exec('BEGIN IMMEDIATE');
    replaceSession(
      db,
      {
        session_id: sessionId,
        project_id: projectId(cwd),
        project_path: cwd,
        started_at: stamps[0] ?? null,
        ended_at: stamps[stamps.length - 1] ?? null,
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
    );
    hadOld = fs.existsSync(finalDir);
    if (hadOld) fs.renameSync(finalDir, oldDir);
    fs.renameSync(tmpDir, finalDir);
    swapped = true;
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // no open transaction
    }
    if (swapped) fs.renameSync(finalDir, tmpDir);
    if (hadOld && fs.existsSync(oldDir)) fs.renameSync(oldDir, finalDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  } finally {
    db.close();
  }
  fs.rmSync(oldDir, { recursive: true, force: true });
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

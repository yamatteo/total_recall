import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { cleanEntries, renderTranscript } from './clean.js';
import { openDb, upsertSessionRow } from './db.js';
import { assertSessionId, findTranscript, memoryHome, sessionDir } from './paths.js';
import { listSubagents, parseJsonl } from './parse.js';
import { projectId } from './project.js';

/** @typedef {import('./db.js').Database} Database */

/** @param {string} p */
const write = (p, /** @type {string | Uint8Array} */ data) => fs.writeFileSync(p, data, { mode: 0o600 });

/**
 * Read and clean the main transcript and its subagents.
 * @param {string} sessionId
 * @param {string} [transcriptPath]
 */
export function loadSession(sessionId, transcriptPath) {
  assertSessionId(sessionId);
  const transcript = transcriptPath ?? findTranscript(sessionId);
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
  const stamps = mainEntries.map((e) => e.timestamp).filter((t) => typeof t === 'string').sort();
  const cwd = mainEntries.find((e) => typeof e.cwd === 'string')?.cwd ?? null;
  return { sessionId, rawMain, mainEntries, main, subs, stamps, cwd };
}

/** @typedef {ReturnType<typeof loadSession>} LoadedSession */

/**
 * Write the session dir in a temp location, then run `dbWork` inside BEGIN IMMEDIATE and swap the
 * dirs before COMMIT. All-or-nothing: on any failure the previous state is intact.
 * @param {{db: Database, home: string, data: LoadedSession, itemsJson?: string, keepItems?: boolean,
 *   dbWork: (finalDir: string) => void}} o
 */
export function commitSession({ db, home, data, itemsJson, keepItems, dbWork }) {
  const { sessionId, rawMain, main, subs } = data;
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
    if (itemsJson !== undefined) write(path.join(tmpDir, 'items.json'), itemsJson);

    db.exec('BEGIN IMMEDIATE');
    if (keepItems) {
      // read under the write lock so a concurrent ingest cannot slip in between
      const existing = path.join(finalDir, 'items.json');
      if (fs.existsSync(existing)) write(path.join(tmpDir, 'items.json'), fs.readFileSync(existing));
    }
    dbWork(finalDir);
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
  }
  fs.rmSync(oldDir, { recursive: true, force: true });
}

/**
 * Archive a session: refresh its transcript files and session row. Items and anchors are never touched.
 * Needs no embedding model.
 * @param {{sessionId: string, transcript?: string, home?: string}} o
 */
export async function archive(o) {
  const home = o.home ?? memoryHome();
  const data = loadSession(o.sessionId, o.transcript);
  const db = await openDb(home);
  try {
    commitSession({
      db,
      home,
      data,
      keepItems: true,
      dbWork: (finalDir) =>
        upsertSessionRow(db, {
          session_id: data.sessionId,
          project_id: projectId(data.cwd),
          project_path: data.cwd,
          started_at: data.stamps[0] ?? null,
          ended_at: data.stamps[data.stamps.length - 1] ?? null,
          ingested_at: null,
          transcript_path: path.join(finalDir, 'transcript.md'),
          raw_path: path.join(finalDir, 'raw.jsonl.gz'),
        }),
    });
  } finally {
    db.close();
  }
  const sessionPath = sessionDir(home, data.sessionId);
  const transcriptMd = path.join(sessionPath, 'transcript.md');
  const md = fs.readFileSync(transcriptMd, 'utf8');
  /** @type {number[]} */
  const boundaryLines = [];
  md.split('\n').forEach((l, i) => {
    if (l.startsWith('# compact boundary')) boundaryLines.push(i + 1);
  });
  return {
    sessionId: data.sessionId,
    projectId: projectId(data.cwd),
    cwd: data.cwd,
    entries: data.mainEntries.length,
    boundaries: data.main.filter((b) => b.kind === 'boundary').length,
    subagents: data.subs.length,
    transcriptMd,
    lines: md.endsWith('\n') ? md.split('\n').length - 1 : md.split('\n').length,
    boundaryLines,
  };
}

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { cleanEntries, renderTranscript } from './clean.js';
import { openDb, upsertSessionRow } from './db.js';
import { assertSessionId, findTranscript, memoryHome, sessionDir } from './paths.js';
import { listSubagents, parseJsonl, parseSubagentMeta } from './parse.js';
import { projectId } from './project.js';

/** @typedef {import('./db.js').Database} Database */

/** @param {string} p */
const write = (p, /** @type {string | Uint8Array} */ data) => fs.writeFileSync(p, data, { mode: 0o600 });

/**
 * Read and clean the main transcript and its subagents. Source, in order: an explicit `transcriptPath`
 * (must exist), Claude Code's own file, then total_recall's archive (`sessions/<id>/raw.jsonl.gz` and
 * `subagents/*.jsonl.gz`), which outlives the original.
 * @param {string} sessionId
 * @param {string} [transcriptPath]
 * @param {string} [home]
 */
export function loadSession(sessionId, transcriptPath, home = memoryHome()) {
  assertSessionId(sessionId);
  const transcript = transcriptPath ?? findTranscript(sessionId);
  /** @type {Buffer} */
  let rawMain;
  /** @type {Array<{id: string, description: string | null, agentType: string | null, raw: Buffer, metaRaw: Buffer | null}>} */
  let rawSubs;
  if (transcript && fs.existsSync(transcript)) {
    rawMain = fs.readFileSync(transcript);
    rawSubs = listSubagents(transcript, sessionId).map((s) => ({
      id: s.id,
      description: s.description,
      agentType: s.agentType,
      raw: fs.readFileSync(s.file),
      metaRaw: s.metaFile ? fs.readFileSync(s.metaFile) : null,
    }));
  } else {
    const stored = sessionDir(home, sessionId);
    const storedMain = path.join(stored, 'raw.jsonl.gz');
    if (transcriptPath || !fs.existsSync(storedMain)) {
      throw new Error(
        `transcript for session ${sessionId} not found${transcript ? `: ${transcript}` : ''}` +
          (transcriptPath ? '' : ` (no Claude Code transcript and no archive at ${storedMain})`),
      );
    }
    rawMain = zlib.gunzipSync(fs.readFileSync(storedMain));
    const subDir = path.join(stored, 'subagents');
    /** @type {string[]} */
    let names = [];
    try {
      names = fs.readdirSync(subDir);
    } catch {
      // no subagents archived
    }
    rawSubs = names
      .filter((n) => /^agent-.+\.jsonl\.gz$/.test(n))
      .sort()
      .map((n) => {
        const id = n.replace(/\.jsonl\.gz$/, '');
        const metaFile = path.join(subDir, `${id}.meta.json`);
        const metaRaw = fs.existsSync(metaFile) ? fs.readFileSync(metaFile) : null;
        return {
          id,
          ...parseSubagentMeta(metaRaw),
          raw: zlib.gunzipSync(fs.readFileSync(path.join(subDir, n))),
          metaRaw,
        };
      });
  }
  const mainEntries = parseJsonl(rawMain.toString('utf8'));
  const main = cleanEntries(mainEntries);
  const subs = rawSubs.map((s) => ({ ...s, blocks: cleanEntries(parseJsonl(s.raw.toString('utf8'))) }));
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
        if (s.metaRaw) write(path.join(tmpDir, 'subagents', `${s.id}.meta.json`), s.metaRaw);
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
  const data = loadSession(o.sessionId, o.transcript, home);
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
  /** line of the first compact-summary header after each boundary (null when none follows) @type {Array<number | null>} */
  const summaryLines = [];
  /** @type {number | null | undefined} */
  let pending;
  md.split('\n').forEach((l, i) => {
    if (l.startsWith('# compact boundary')) {
      if (pending === null) summaryLines.push(null);
      boundaryLines.push(i + 1);
      pending = null;
    } else if (pending === null && /^## \S+ compact-summary /.test(l)) {
      summaryLines.push(i + 1);
      pending = undefined;
    }
  });
  if (pending === null) summaryLines.push(null);
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
    summaryLines,
  };
}

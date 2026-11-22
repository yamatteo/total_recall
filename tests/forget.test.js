import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { archive } from '../src/archive.js';
import { forget } from '../src/forget.js';
import { counts, openDb } from '../src/db.js';
import { ingest, search } from '../src/ingest.js';
import { recall } from '../src/recall.js';
import { fakeEmbedder, FIXTURES, ITEMS, SESSION, TRANSCRIPT, tmp } from './helpers.js';

const embedder = fakeEmbedder();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'total-recall.js');
const OLD_CONFIG = process.env.CLAUDE_CONFIG_DIR;
afterEach(() => {
  if (OLD_CONFIG === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = OLD_CONFIG;
});

/** Fixture session copied under <config>/projects/p/; sets CLAUDE_CONFIG_DIR. */
function configWithFixture() {
  const cfg = tmp();
  const dir = path.join(cfg, 'projects', 'p');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(TRANSCRIPT, path.join(dir, `${SESSION}.jsonl`));
  fs.cpSync(path.join(FIXTURES, SESSION), path.join(dir, SESSION), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = cfg;
  return path.join(dir, `${SESSION}.jsonl`);
}

/** @param {string} home */
async function stats(home) {
  const db = await openDb(home);
  try {
    return counts(db);
  } finally {
    db.close();
  }
}

const tree = (/** @type {string} */ d) =>
  fs.readdirSync(d, { recursive: true }).map(String).sort();

describe('archive from the stored copy', () => {
  it('rebuilds a byte-identical transcript.md and keeps items when the original is gone', async () => {
    const original = configWithFixture();
    const home = tmp();
    await ingest({ sessionId: SESSION, itemsFile: ITEMS, home, embedder });
    const dir = path.join(home, 'sessions', SESSION);
    const mdBefore = fs.readFileSync(path.join(dir, 'transcript.md'));
    const filesBefore = tree(dir);
    const before = await stats(home);
    expect(before.items).toBeGreaterThan(0);

    fs.rmSync(original);
    fs.rmSync(path.join(path.dirname(original), SESSION), { recursive: true });
    const r = await archive({ sessionId: SESSION, home });
    expect(r.subagents).toBe(2);
    expect(Buffer.compare(fs.readFileSync(path.join(dir, 'transcript.md')), mdBefore)).toBe(0);
    expect(tree(dir)).toEqual(filesBefore);
    expect(fs.existsSync(path.join(dir, 'items.json'))).toBe(true);
    expect(await stats(home)).toEqual(before);
    expect(fs.readFileSync(path.join(dir, 'subagents', 'agent-a1.meta.json'), 'utf8')).toContain('investigate cache');
  });

  it('prepare works from the archive via the CLI', async () => {
    const original = configWithFixture();
    const home = tmp();
    await archive({ sessionId: SESSION, home });
    const md = fs.readFileSync(path.join(home, 'sessions', SESSION, 'transcript.md'));
    fs.rmSync(original);
    const r = spawnSync('node', [BIN, 'prepare', '--session', SESSION], {
      encoding: 'utf8',
      env: { ...process.env, TOTAL_RECALL_HOME: home },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`session: ${SESSION}`);
    expect(Buffer.compare(fs.readFileSync(path.join(home, 'sessions', SESSION, 'transcript.md')), md)).toBe(0);
  });

  it('gives a clear error with neither an original nor an archive', async () => {
    configWithFixture();
    await expect(archive({ sessionId: 'sess-none', home: tmp() })).rejects.toThrow(
      /transcript for session sess-none not found.*no Claude Code transcript and no archive/,
    );
    await expect(archive({ sessionId: SESSION, transcript: '/nope/x.jsonl', home: tmp() })).rejects.toThrow(/not found: \/nope/);
  });
});

describe('forget', () => {
  it('removes rows and directory, leaves other sessions alone, and drops it from search and recall', async () => {
    const t = configWithFixture();
    const home = tmp();
    await ingest({ sessionId: SESSION, itemsFile: ITEMS, home, embedder });
    // a second session: the same transcript under another id
    const other = path.join(path.dirname(t), 'sess-0002.jsonl');
    fs.copyFileSync(TRANSCRIPT, other);
    fs.cpSync(path.join(path.dirname(t), SESSION), path.join(path.dirname(t), 'sess-0002'), { recursive: true });
    await ingest({ sessionId: 'sess-0002', itemsFile: ITEMS, transcript: other, home, embedder });
    const both = await stats(home);
    expect(both.sessions).toBe(2);
    const perSession = both.items / 2;

    const r = await forget({ sessionId: SESSION, home });
    expect(r).toMatchObject({ sessionId: SESSION, items: perSession, removedDir: true });
    expect(fs.existsSync(path.join(home, 'sessions', SESSION))).toBe(false);
    expect(fs.existsSync(path.join(home, 'sessions', 'sess-0002', 'transcript.md'))).toBe(true);
    const after = await stats(home);
    expect(after).toEqual({ sessions: 1, items: perSession, anchors: both.anchors / 2 });

    const hits = await search({ query: 'cache', scope: 'all', limit: 50, home, embedder });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.session_id === 'sess-0002')).toBe(true);
    const rec = await recall({ query: 'cache', everywhere: true, limit: 50, home, embedder });
    expect(JSON.stringify(rec)).not.toContain(`"${SESSION}"`);
  });

  it('forgets an archive-only session and errors on an unknown id', async () => {
    const home = tmp();
    await archive({ sessionId: SESSION, transcript: TRANSCRIPT, home });
    const r = await forget({ sessionId: SESSION, home });
    expect(r).toMatchObject({ items: 0, removedDir: true });
    expect(await stats(home)).toEqual({ sessions: 0, items: 0, anchors: 0 });
    await expect(forget({ sessionId: SESSION, home })).rejects.toThrow(/not in memory/);
    await expect(forget({ sessionId: '../evil', home })).rejects.toThrow(/invalid session id/);
  });

  it('CLI prints what it removed; unknown id exits 1', async () => {
    const home = tmp();
    await ingest({ sessionId: SESSION, itemsFile: ITEMS, transcript: TRANSCRIPT, home, embedder });
    const env = { ...process.env, TOTAL_RECALL_HOME: home };
    const ok = spawnSync('node', [BIN, 'forget', '--session', SESSION], { encoding: 'utf8', env });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(new RegExp(`^forgot session ${SESSION}: removed [1-9]\\d* items, \\d+ anchors, directory `));
    const bad = spawnSync('node', [BIN, 'forget', '--session', SESSION], { encoding: 'utf8', env });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('not in memory');
    expect(spawnSync('node', [BIN, 'forget'], { encoding: 'utf8', env }).status).toBe(2);
  });
});

describe('hooks', () => {
  it('has no SessionEnd entry and no session-end script', () => {
    const h = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
    expect(Object.keys(h.hooks)).toEqual(['SessionStart']);
    expect(fs.existsSync(path.join(ROOT, 'hooks', 'session-end.sh'))).toBe(false);
  });
});

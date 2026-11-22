import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { archive } from '../src/archive.js';
import { renderTranscript } from '../src/clean.js';
import { counts, openDb } from '../src/db.js';
import { ingest } from '../src/ingest.js';
import { fakeEmbedder, FIXTURES, ITEMS, SESSION, TRANSCRIPT, tmp } from './helpers.js';

const embedder = fakeEmbedder();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'total-recall.js');

/** @param {string} home */
async function stats(home) {
  const db = await openDb(home);
  try {
    return counts(db);
  } finally {
    db.close();
  }
}

/** Copy the fixture session (main + subagents) to a temp dir. */
function copyFixture() {
  const dir = tmp();
  fs.copyFileSync(TRANSCRIPT, path.join(dir, `${SESSION}.jsonl`));
  fs.cpSync(path.join(FIXTURES, SESSION), path.join(dir, SESSION), { recursive: true });
  return path.join(dir, `${SESSION}.jsonl`);
}

describe('archive', () => {
  it('creates transcript files and a session row, with no items', async () => {
    const home = tmp();
    const r = await archive({ sessionId: SESSION, transcript: TRANSCRIPT, home });
    expect(r).toMatchObject({ subagents: 2, boundaries: 1, projectId: 'path:/work/demo-project' });
    const dir = path.join(home, 'sessions', SESSION);
    expect(fs.existsSync(path.join(dir, 'raw.jsonl.gz'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'transcript.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'subagents', 'agent-a1.jsonl.gz'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'items.json'))).toBe(false);
    expect(await stats(home)).toEqual({ sessions: 1, items: 0, anchors: 0 });
  });

  it('keeps items and anchors and refreshes the transcript after growth', async () => {
    const home = tmp();
    const t = copyFixture();
    await ingest({ sessionId: SESSION, itemsFile: ITEMS, transcript: t, home, embedder });
    const before = await stats(home);
    expect(before.items).toBeGreaterThan(0);
    const db0 = await openDb(home);
    const ingestedAt = /** @type {any} */ (db0.prepare('SELECT ingested_at FROM sessions').get()).ingested_at;
    db0.close();

    fs.appendFileSync(
      t,
      `${JSON.stringify({ type: 'user', uuid: 'u-new', timestamp: '2026-01-02T00:00:00.000Z', cwd: '/work/demo-project', message: { role: 'user', content: 'a brand new message after ingest' } })}\n`,
    );
    await archive({ sessionId: SESSION, transcript: t, home });
    expect(await stats(home)).toEqual(before);
    const dir = path.join(home, 'sessions', SESSION);
    expect(fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8')).toContain('a brand new message after ingest');
    expect(fs.existsSync(path.join(dir, 'items.json'))).toBe(true);
    const db = await openDb(home);
    const s = /** @type {any} */ (db.prepare('SELECT * FROM sessions').get());
    db.close();
    expect(s.ingested_at).toBe(ingestedAt);
    expect(s.ended_at).toBe('2026-01-02T00:00:00.000Z');
    expect(fs.readdirSync(path.join(home, 'sessions'))).toEqual([SESSION]);
  });
});

describe('cli', () => {
  /** @param {string} home @param {string[]} args */
  const cli = (home, args) =>
    spawnSync('node', [BIN, ...args], { encoding: 'utf8', env: { ...process.env, TOTAL_RECALL_HOME: home } });

  it('archive prints one line and never loads transformers', () => {
    const home = tmp();
    const hook = path.join(tmp(), 'trace.mjs');
    // preload that fails the process if the embedding library is imported
    fs.writeFileSync(
      hook,
      `import { registerHooks } from 'node:module';
registerHooks({ resolve(s, c, n) { if (s.includes('transformers') || s.endsWith('embed.js')) throw new Error('forbidden import: ' + s); return n(s, c); } });\n`,
    );
    const r = spawnSync('node', ['--import', hook, BIN, 'archive', '--session', SESSION, '--transcript', TRANSCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, TOTAL_RECALL_HOME: home },
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^archived session ${SESSION}: \\d+ entries, 1 compact boundaries, 2 subagents\\n$`));
  });

  it('forget never loads transformers', () => {
    const home = tmp();
    const hook = path.join(tmp(), 'trace.mjs');
    fs.writeFileSync(
      hook,
      `import { registerHooks } from 'node:module';
registerHooks({ resolve(s, c, n) { if (s.includes('transformers') || s.endsWith('embed.js')) throw new Error('forbidden import: ' + s); return n(s, c); } });\n`,
    );
    const env = { ...process.env, TOTAL_RECALL_HOME: home };
    spawnSync('node', [BIN, 'archive', '--session', SESSION, '--transcript', TRANSCRIPT], { env });
    const r = spawnSync('node', ['--import', hook, BIN, 'forget', '--session', SESSION], { encoding: 'utf8', env });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`forgot session ${SESSION}: removed 0 items`);
  });

  it('prepare reports boundary line numbers that match transcript.md', () => {
    const home = tmp();
    const r = cli(home, ['prepare', '--session', SESSION, '--transcript', TRANSCRIPT]);
    expect(r.status).toBe(0);
    const md = fs.readFileSync(path.join(home, 'sessions', SESSION, 'transcript.md'), 'utf8').split('\n');
    const lines = md.flatMap((l, i) => (l.startsWith('# compact boundary') ? [i + 1] : []));
    expect(lines.length).toBe(1);
    expect(r.stdout).toContain(`# compact boundary" in transcript.md): ${lines.join(', ')}\n`);
    expect(r.stdout).toContain(`ingest --session ${SESSION}`);
    expect(r.stdout).toContain(path.join(home, 'sessions', SESSION, 'transcript.md'));
  });

  it('doctor runs and reports each check', () => {
    const r = cli(tmp(), ['doctor']);
    expect(r.stdout).toMatch(/node version/);
    expect(r.stdout).toMatch(/embedding model/);
    expect(r.stdout).toMatch(/index opens/);
    const bad = spawnSync('node', [BIN, 'doctor'], {
      encoding: 'utf8',
      env: { ...process.env, TOTAL_RECALL_HOME: tmp(), TOTAL_RECALL_MODEL_CACHE: tmp() },
    });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/fail embedding model/);
    expect(bad.stdout).toMatch(/fixes:/);
  });
});

describe('session-start hook', () => {
  const hook = path.join(ROOT, 'hooks', 'session-start.sh');
  const run = (/** @type {string} */ cache) =>
    execFileSync('sh', [hook], { encoding: 'utf8', env: { ...process.env, TOTAL_RECALL_MODEL_CACHE: cache } });
  it('is silent when set up and prints one line otherwise', () => {
    expect(run(path.join(ROOT, '.cache', 'transformers'))).toBe('');
    const out = run(tmp());
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(out).toContain('total-recall: setup needed');
    expect(out).toContain('bin/total-recall.js setup');
  });
});

describe('subagent header', () => {
  it('collapses whitespace in descriptions to one line', () => {
    const md = renderTranscript([], [{ id: 'agent-x', description: '  find\nthe   bug\r\n here ', blocks: [] }]);
    expect(md.split('\n').filter((l) => l.startsWith('# subagent'))).toEqual(['# subagent agent-x: find the bug here']);
  });
});

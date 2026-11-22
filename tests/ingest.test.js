import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { validateItems, ItemsError } from '../src/items.js';
import { counts, openDb } from '../src/db.js';
import { ingest, search, UnmatchedQuotesError } from '../src/ingest.js';
import { projectId } from '../src/project.js';
import { fakeEmbedder, ITEMS, SESSION, TRANSCRIPT, tmp, writeJson } from './helpers.js';

const embedder = fakeEmbedder();
const run = (/** @type {string} */ home, itemsFile = ITEMS) =>
  ingest({ sessionId: SESSION, itemsFile, transcript: TRANSCRIPT, home, embedder });

/** @param {string} home */
async function stats(home) {
  const db = await openDb(home, embedder);
  try {
    return counts(db);
  } finally {
    db.close();
  }
}

/** @param {string} dir @returns {string[]} */
const tree = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? tree(path.join(dir, d.name)).map((f) => `${d.name}/${f}`) : [d.name]))
    .sort();

const valid = () => ({
  items: [
    { kind: 'overview', scope: 'project', text: 'ov', quotes: [] },
    { kind: 'finding', scope: 'global', text: 'f', quotes: ['a quote that is long enough'] },
  ],
});

describe('validateItems', () => {
  it('accepts a valid file', () => {
    expect(validateItems(valid())).toHaveLength(2);
  });

  /** @param {(o: any) => void} mutate @param {RegExp} re */
  const bad = (mutate, re) => {
    const o = valid();
    mutate(o);
    expect(() => validateItems(o)).toThrow(ItemsError);
    try {
      validateItems(o);
    } catch (e) {
      expect(/** @type {Error} */ (e).message).toMatch(re);
    }
  };

  it('rejects problems and names the item index', () => {
    bad((o) => o.items.push({ kind: 'overview', scope: 'project', text: 'x', quotes: [] }), /exactly one overview item is required, found 2/);
    bad((o) => o.items.shift(), /exactly one overview item is required, found 0/);
    bad((o) => (o.items[1].quotes = []), /item 1: finding needs at least 1 quote/);
    bad((o) => (o.items[1].quotes = ['too short']), /item 1: quote 0 is shorter than 15/);
    bad((o) => (o.items[1].text = ''), /item 1: text must be a non-empty/);
    bad((o) => (o.items[1].text = 'x'.repeat(1001)), /item 1: text is 1001 chars/);
    bad((o) => (o.items[1].kind = 'nope'), /item 1: kind must be/);
    bad((o) => (o.items[1].scope = 'nope'), /item 1: scope must be/);
    bad((o) => (o.items[1].extra = 1), /item 1: unknown field "extra"/);
    bad((o) => (o.extra = 1), /unknown top-level field "extra"/);
  });

  it('redacts item text and quotes', () => {
    const o = valid();
    o.items[1].text = 'key is sk-abcdefghijklmnopqrstuv';
    const items = validateItems(o);
    expect(items[1]?.text).toBe('key is [REDACTED:api-key]');
  });
});

describe('ingest', () => {
  it('stores files, rows, and anchors with the right modes', async () => {
    const home = tmp();
    const r = await run(home);
    expect(r).toMatchObject({ items: 4, anchors: 4, subagents: 2 });
    const dir = path.join(home, 'sessions', SESSION);
    expect(tree(dir)).toEqual([
      'items.json',
      'raw.jsonl.gz',
      'subagents/agent-a1.jsonl.gz',
      'subagents/agent-a1.meta.json',
      'subagents/agent-a2.jsonl.gz',
      'transcript.md',
    ]);
    expect(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'raw.jsonl.gz'))).toString()).toBe(
      fs.readFileSync(TRANSCRIPT, 'utf8'),
    );
    expect(fs.statSync(path.join(dir, 'raw.jsonl.gz')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.join(home, 'sessions'))).toEqual([SESSION]); // no temp leftovers
    const db = await openDb(home, embedder);
    const s = /** @type {any} */ (db.prepare('SELECT * FROM sessions').get());
    expect(s).toMatchObject({
      session_id: SESSION,
      project_id: 'path:/work/demo-project',
      project_path: '/work/demo-project',
      started_at: '2026-01-01T10:00:00.000Z',
    });
    db.close();
  });

  it('resolves quotes: single, normalised, multi-entry, subagent, compact summary', async () => {
    const home = tmp();
    await run(home);
    const hits = await search({ query: 'mutex', home, embedder, limit: 10 });
    const by = (/** @type {string} */ k) => /** @type {any} */ (hits.find((h) => h.kind === k));
    expect(by('finding').anchors).toEqual(['a-0005']);
    expect(by('decision').anchors).toEqual(['cs-0001', 'sa-0001']); // compact summary + subagent
    expect(by('overview').anchors).toEqual([]);
  });

  it('records multiple matching uuids for one quote', async () => {
    const home = tmp();
    const f = writeJson(tmp(), 'i.json', {
      items: [
        { kind: 'overview', scope: 'project', text: 'o', quotes: [] },
        { kind: 'finding', scope: 'project', text: 'f', quotes: ['the session cache'] },
      ],
    });
    await run(home, f);
    const hits = await search({ query: 'f', home, embedder });
    const anchors = /** @type {any} */ (hits.find((h) => h.kind === 'finding')).anchors;
    expect(anchors).toEqual(['a-0005', 'cs-0001']);
  });

  it('is idempotent', async () => {
    const home = tmp();
    await run(home);
    const first = await stats(home);
    await run(home);
    expect(await stats(home)).toEqual(first);
    expect(first).toEqual({ sessions: 1, items: 4, anchors: 4 });
  });

  it('fails as a whole on unmatched quotes, leaving previous state intact', async () => {
    const home = tmp();
    await run(home);
    const before = { counts: await stats(home), files: tree(home), md: fs.readFileSync(path.join(home, 'sessions', SESSION, 'items.json'), 'utf8') };
    const f = writeJson(tmp(), 'i.json', {
      items: [
        { kind: 'overview', scope: 'project', text: 'new overview', quotes: [] },
        { kind: 'finding', scope: 'project', text: 'f', quotes: ['race condition in the session cache', 'this quote is nowhere at all', 'neither is this other quote'] },
      ],
    });
    const err = await run(home, f).catch((e) => e);
    expect(err).toBeInstanceOf(UnmatchedQuotesError);
    expect(err.message).toContain('this quote is nowhere at all');
    expect(err.message).toContain('neither is this other quote');
    expect(err.unmatched).toHaveLength(2);
    expect(await stats(home)).toEqual(before.counts);
    expect(tree(home)).toEqual(before.files);
    expect(fs.readFileSync(path.join(home, 'sessions', SESSION, 'items.json'), 'utf8')).toBe(before.md);
  });

  it('unmatched quotes on a fresh home change nothing', async () => {
    const home = tmp();
    const f = writeJson(tmp(), 'i.json', {
      items: [
        { kind: 'overview', scope: 'project', text: 'o', quotes: [] },
        { kind: 'finding', scope: 'project', text: 'f', quotes: ['this quote is nowhere at all'] },
      ],
    });
    await expect(run(home, f)).rejects.toThrow(/not found/);
    expect(fs.existsSync(path.join(home, 'index.sqlite'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'sessions'))).toBe(false);
  });

  it('rolls back a failure after files are written (previous state intact)', async () => {
    const home = tmp();
    await run(home);
    const before = { counts: await stats(home), files: tree(home) };
    const broken = { ...embedder, embedPassages: async () => [new Float32Array(384)] }; // wrong count -> throws in insert
    await expect(
      ingest({ sessionId: SESSION, itemsFile: ITEMS, transcript: TRANSCRIPT, home, embedder: broken }),
    ).rejects.toThrow();
    expect(await stats(home)).toEqual(before.counts);
    expect(tree(home)).toEqual(before.files);
  });

  it('rejects an index built with another embedding model', async () => {
    const home = tmp();
    await run(home);
    await expect(
      ingest({ sessionId: SESSION, itemsFile: ITEMS, transcript: TRANSCRIPT, home, embedder: fakeEmbedder('other:model') }),
    ).rejects.toThrow(/re-index needed/);
  });

  it('rejects a missing transcript and bad session ids', async () => {
    const home = tmp();
    await expect(ingest({ sessionId: 'x', itemsFile: ITEMS, transcript: '/nope.jsonl', home, embedder })).rejects.toThrow(/not found/);
    await expect(ingest({ sessionId: '../x', itemsFile: ITEMS, transcript: TRANSCRIPT, home, embedder })).rejects.toThrow(/invalid session id/);
  });
});

describe('search filters', () => {
  /** @param {string} home @param {string} id @param {string} cwd */
  async function seed(home, id, cwd) {
    const dir = tmp();
    const t = path.join(dir, `${id}.jsonl`);
    const e = (/** @type {string} */ uuid, /** @type {string} */ type, /** @type {string} */ text) =>
      JSON.stringify({ uuid, type, timestamp: '2026-02-01T00:00:00Z', cwd, message: { role: type, content: text } });
    fs.writeFileSync(t, [e(`${id}-1`, 'user', 'hello there, this is a long enough line')].join('\n') + '\n');
    const items = writeJson(dir, 'items.json', {
      items: [
        { kind: 'overview', scope: 'project', text: `project overview ${id}`, quotes: [] },
        { kind: 'finding', scope: 'global', text: `global finding ${id}`, quotes: ['this is a long enough line'] },
      ],
    });
    await ingest({ sessionId: id, itemsFile: items, transcript: t, home, embedder });
  }

  it('filters by scope and project', async () => {
    const home = tmp();
    await seed(home, 's1', '/proj/one');
    await seed(home, 's2', '/proj/two');
    const q = (/** @type {any} */ o) => search({ query: 'overview finding', home, embedder, ...o });
    expect((await q({})).length).toBe(4);
    expect((await q({ scope: 'global' })).map((r) => r.scope)).toEqual(['global', 'global']);
    expect((await q({ scope: 'project' })).length).toBe(2);
    const p1 = await q({ scope: 'project', project: 'path:/proj/one' });
    expect(p1.map((r) => r.session_id)).toEqual(['s1']);
    const all1 = await q({ project: 'path:/proj/one' });
    expect(all1.length).toBe(3); // s1 overview + 2 global
    expect((await q({ limit: 1 })).length).toBe(1);
  });
});

describe('projectId', () => {
  it('uses path: for non-git directories and missing cwd', () => {
    const d = tmp();
    expect(projectId(d)).toBe(`path:${d}`);
    expect(projectId('/does/not/exist')).toBe('path:/does/not/exist');
    expect(projectId(undefined)).toBe('path:unknown');
  });

  it('uses git:<root commit> in a repo with commits, path: without commits', () => {
    const d = tmp();
    const git = (/** @type {string[]} */ ...a) =>
      execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
        encoding: 'utf8',
      });
    git('init', '-q');
    expect(projectId(d)).toBe(`path:${d}`);
    git('commit', '--allow-empty', '-q', '-m', 'one');
    git('commit', '--allow-empty', '-q', '-m', 'two');
    const root = git('rev-list', '--max-parents=0', 'HEAD').trim();
    expect(projectId(d)).toBe(`git:${root}`);
    fs.mkdirSync(path.join(d, 'sub'));
    expect(projectId(path.join(d, 'sub'))).toBe(`git:${root}`);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { archive } from '../src/archive.js';
import { ingest } from '../src/ingest.js';
import { formatRecall, recall } from '../src/recall.js';
import { formatSessions, listSessions } from '../src/sessions.js';
import { formatReport } from '../src/prepare.js';
import { fakeEmbedder, ITEMS, SESSION, TRANSCRIPT, tmp, writeJson } from './helpers.js';

const embedder = fakeEmbedder();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'total-recall.js');
const DEMO = '/work/demo-project';
const OTHER = '/work/other-project';
const OTHER_SESSION = 'sess-0002';
const ARCHIVED_ONLY = 'sess-0003';

/** @param {string} home @param {string} id */
const transcriptLines = (home, id) =>
  fs.readFileSync(path.join(home, 'sessions', id, 'transcript.md'), 'utf8').split('\n');

/** Build the second session (other cwd) and its items; ingest everything into a fresh home. */
async function build() {
  const home = tmp();
  const dir = tmp();
  const msg = (/** @type {string} */ type, /** @type {string} */ uuid, /** @type {string} */ ts, /** @type {string} */ text) =>
    JSON.stringify({
      type,
      uuid,
      timestamp: ts,
      cwd: OTHER,
      sessionId: OTHER_SESSION,
      message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] },
    });
  const t = path.join(dir, `${OTHER_SESSION}.jsonl`);
  fs.writeFileSync(
    t,
    [
      msg('user', 'o-1', '2026-02-01T10:00:00.000Z', 'The widget cache evicts entries too early.'),
      msg('assistant', 'o-2', '2026-02-01T10:01:00.000Z', 'Found the widget cache eviction bug: the TTL was in seconds, not milliseconds.'),
      msg('assistant', 'o-3', '2026-02-01T10:02:00.000Z', 'Lesson learned: always pin the lockfile library version before upgrading.'),
    ].join('\n') + '\n',
  );
  const items = writeJson(dir, 'items.json', {
    items: [
      { kind: 'overview', scope: 'project', text: 'Fixed the widget cache eviction in the other project.', quotes: [] },
      {
        kind: 'finding',
        scope: 'project',
        text: 'The widget cache eviction bug came from a TTL unit mismatch.',
        quotes: ['the TTL was in seconds, not milliseconds'],
      },
      {
        kind: 'decision',
        scope: 'global',
        text: 'Always pin the lockfile library version before upgrading.',
        quotes: ['always pin the lockfile library version'],
      },
    ],
  });
  await ingest({ sessionId: SESSION, itemsFile: ITEMS, transcript: TRANSCRIPT, home, embedder });
  await ingest({ sessionId: OTHER_SESSION, itemsFile: items, transcript: t, home, embedder });
  await archive({ sessionId: ARCHIVED_ONLY, transcript: TRANSCRIPT, home });
  return home;
}

/** @type {string} */ let home;
beforeAll(async () => {
  home = await build();
});

describe('recall', () => {
  it('reports anchor lines equal to grep -n of the uuid header', async () => {
    const data = await recall({ query: 'mutex around session cache refresh', cwd: DEMO, embedder, home });
    let checked = 0;
    for (const s of data.sessions) {
      const md = transcriptLines(home, s.session_id);
      for (const it of s.items) {
        for (const a of it.anchors) {
          const expected = md.findIndex((l) => l.startsWith(`## ${a.uuid} `)) + 1;
          expect(expected).toBeGreaterThan(0);
          expect(a.line).toBe(expected);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    const text = formatRecall(data);
    expect(text).toMatch(/at transcript\.md:\d+/);
    expect(text).toContain(`transcript: ${path.join(home, 'sessions', SESSION, 'transcript.md')}`);
  });

  it('default scope: this project plus global items, not other projects project-scoped items', async () => {
    const data = await recall({ query: 'widget cache eviction ttl lockfile mutex cache', cwd: DEMO, embedder, home, limit: 20 });
    const texts = data.sessions.flatMap((s) => s.items.map((i) => i.text));
    expect(texts).toContain('Always pin the lockfile library version before upgrading.'); // global, other project
    expect(texts).toContain('Use a mutex around cache refresh rather than retries.');
    expect(texts.join('\n')).not.toContain('TTL unit mismatch');
    const every = await recall({ query: 'widget cache eviction ttl lockfile mutex cache', cwd: DEMO, everywhere: true, embedder, home, limit: 20 });
    expect(every.sessions.flatMap((s) => s.items.map((i) => i.text))).toContain('The widget cache eviction bug came from a TTL unit mismatch.');
  });

  it('groups by session and prints each overview once', async () => {
    const data = await recall({ query: 'cache session mutex login race', cwd: DEMO, embedder, home, limit: 20 });
    const ids = data.sessions.map((s) => s.session_id);
    expect(new Set(ids).size).toBe(ids.length);
    const text = formatRecall(data);
    expect(text.match(/^overview: /gm)?.length).toBe(data.sessions.length);
    expect(text.match(/Fixed the flaky login test/g)?.length).toBe(1);
    expect(text.match(/^session /gm)?.length).toBe(data.sessions.length);
    const scores = data.sessions.map((s) => s.best);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('shows ? for a missing transcript instead of crashing', async () => {
    const h = await build();
    fs.rmSync(path.join(h, 'sessions', SESSION, 'transcript.md'));
    const data = await recall({ query: 'mutex around session cache refresh', cwd: DEMO, embedder, home: h });
    const text = formatRecall(data);
    expect(text).toMatch(/at transcript\.md:\?/);
    expect(text).toContain('(missing)');
  });

  it('says so when nothing is found', async () => {
    const h = tmp();
    const data = await recall({ query: 'anything', cwd: DEMO, embedder, home: h });
    expect(formatRecall(data)).toMatch(/nothing.*--everywhere/);
  });
});

describe('sessions', () => {
  it('lists an archived-only session with 0 items, newest first', async () => {
    const rows = await listSessions({ cwd: DEMO, home });
    const only = rows.find((r) => r.session_id === ARCHIVED_ONLY);
    expect(only).toMatchObject({ items: 0, overview: '' });
    expect(rows.map((r) => r.session_id)).not.toContain(OTHER_SESSION);
    expect(formatSessions(rows)).toContain('(not wrapped up)');
    const all = await listSessions({ everywhere: true, home });
    expect(all.map((r) => r.session_id)[0]).toBe(OTHER_SESSION); // ended 2026-02
    expect(all).toHaveLength(3);
    expect(all.find((r) => r.session_id === SESSION)?.overview).toMatch(/^Fixed the flaky login test/);
  });

  it('loads no transformers', () => {
    const hook = path.join(tmp(), 'trace.mjs');
    fs.writeFileSync(
      hook,
      `import { registerHooks } from 'node:module';
registerHooks({ resolve(s, c, n) { if (s.includes('transformers') || s.endsWith('embed.js')) throw new Error('forbidden import: ' + s); return n(s, c); } });\n`,
    );
    const r = spawnSync('node', ['--import', hook, BIN, 'sessions', '--everywhere'], {
      encoding: 'utf8',
      env: { ...process.env, TOTAL_RECALL_HOME: home },
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`session ${ARCHIVED_ONLY}`);
  });
});

describe('prepare report', () => {
  it('lists compact summary lines and the new wording', async () => {
    const info = await archive({ sessionId: SESSION, transcript: TRANSCRIPT, home });
    const md = transcriptLines(home, SESSION);
    const expected = md.flatMap((l, i) => (/^## \S+ compact-summary /.test(l) ? [i + 1] : []));
    expect(info.summaryLines).toEqual(expected);
    expect(expected.length).toBe(1);
    expect(md[info.boundaryLines[0] - 1]).toMatch(/^# compact boundary/);
    expect(expected[0]).toBeGreaterThan(info.boundaryLines[0]);
    const report = formatReport({ info, binPath: BIN });
    expect(report).toContain(`"## <uuid> compact-summary" in transcript.md): ${expected.join(', ')}`);
    expect(report).toContain('first read the compact summaries at the listed lines');
    expect(report).not.toMatch(/lines 1-\d+/);
  });
});

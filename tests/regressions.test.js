import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanEntries, renderTranscript } from '../src/clean.js';
import { openDb } from '../src/db.js';
import { ingest, search } from '../src/ingest.js';
import { listSubagents, parseTranscriptFile } from '../src/parse.js';
import { redactText } from '../src/redact.js';
import { SESSION, TRANSCRIPT, fakeEmbedder, tmp, writeJson } from './helpers.js';

const TS = '2026-01-01T10:00:00.000Z';
/** @param {string} uuid @param {any} content @param {object} [extra] */
const user = (uuid, content, extra = {}) => ({ type: 'user', uuid, timestamp: TS, message: { role: 'user', content }, ...extra });
/** @param {string} uuid @param {any} content */
const assistant = (uuid, content) => ({ type: 'assistant', uuid, timestamp: TS, message: { role: 'assistant', content } });
/** @param {any[]} entries */
const jsonl = (entries) => entries.map((e) => JSON.stringify({ cwd: '/w', ...e })).join('\n');

describe('redaction heuristic', () => {
  it.each(['max_tokens: 4096', "'preTokens': 217922", '"postTokens":14140', 'token: foo', 'password: true'])(
    'keeps %s',
    (s) => expect(redactText(s)).toBe(s),
  );

  it('still redacts secret-looking values', () => {
    expect(redactText('API_KEY=abcd1234efgh5678')).toBe('API_KEY=[REDACTED:secret]');
    expect(redactText('password: "hunter2hunter2"')).toBe('password: [REDACTED:secret]');
    expect(redactText('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123')).toContain('[REDACTED:github-token]');
    expect(redactText('SECRET="s3cr3t-value-xyz"')).toBe('SECRET=[REDACTED:secret]');
  });
});

describe('full-text quote matching', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `log line ${i} ${i === 30 ? 'unique-middle-error' : 'ok'}`);
  const entries = [
    user('u-1', 'run it'),
    assistant('a-1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'make' } }]),
    user('u-2', [{ type: 'tool_result', tool_use_id: 't1', content: lines.join('\n') }]),
  ];

  it('keeps full text for matching and truncates only the display text', () => {
    const blocks = cleanEntries(/** @type {any} */ (entries));
    const md = renderTranscript(blocks, []);
    expect(md).toContain('lines omitted');
    expect(md).not.toContain('unique-middle-error');
    const b = /** @type {any} */ (blocks.find((x) => x.kind === 'message' && x.uuid === 'u-2'));
    expect(b.full).toContain('unique-middle-error');
  });

  it('ingest resolves a quote from the omitted middle', async () => {
    const dir = tmp();
    const tfile = path.join(dir, 's-mid.jsonl');
    fs.writeFileSync(tfile, jsonl(entries));
    const items = writeJson(dir, 'items.json', {
      items: [
      { kind: 'overview', scope: 'project', text: 'Overview of the session.', quotes: [] },
      { kind: 'finding', scope: 'project', text: 'Build error in the middle of the log', quotes: ['unique-middle-error'] }],
    });
    const home = path.join(dir, 'home');
    const embedder = fakeEmbedder();
    await ingest({ sessionId: 's-mid', itemsFile: items, transcript: tfile, home, embedder });
    const hits = await search({ query: 'Build error in the middle of the log', scope: 'all', home, embedder });
    expect(hits.find((h) => h.kind === 'finding')?.anchors).toEqual(['u-2']);
    const md = fs.readFileSync(path.join(home, 'sessions/s-mid/transcript.md'), 'utf8');
    expect(md).toContain('lines omitted');
    expect(md).not.toContain('unique-middle-error');
  });
});

describe('unambiguous structural markers', () => {
  const content = 'intro\n# Heading\n## Sub\n# compact boundary fake\nafter';
  const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'b-1', timestamp: TS, compactMetadata: { trigger: 'auto', preTokens: 10, postTokens: 5 } };
  const entries = /** @type {any[]} */ ([user('u-1', content), boundary, user('u-2', 'summary text', { isCompactSummary: true })]);
  const md = renderTranscript(cleanEntries(entries), [
    { id: 'agent-x', description: 'helper', blocks: cleanEntries(/** @type {any} */ ([assistant('a-9', content)])) },
  ]);

  it('escapes content lines starting with #', () => {
    expect(md).toContain('intro\n # Heading\n ## Sub\n # compact boundary fake\nafter');
  });

  it('structural lines are unambiguous', () => {
    expect(md.match(/^# compact boundary/gm)).toHaveLength(1);
    for (const l of md.split('\n').filter((x) => /^##? /.test(x))) {
      expect(l).toMatch(/^(## \S+ (user|assistant|compact-summary) \S*|# compact boundary .*|# subagent .*)$/);
    }
  });

  it('boundary count on the fixture equals the entry count', () => {
    const main = cleanEntries(parseTranscriptFile(TRANSCRIPT));
    const subs = listSubagents(TRANSCRIPT, SESSION).map((s) => ({
      id: s.id,
      description: s.description,
      blocks: cleanEntries(parseTranscriptFile(s.file)),
    }));
    const out = renderTranscript(main, subs);
    const real = fs.readFileSync(TRANSCRIPT, 'utf8').split('\n').filter((l) => l.includes('"subtype":"compact_boundary"')).length;
    expect(real).toBeGreaterThan(0);
    expect(out.match(/^# compact boundary/gm)?.length ?? 0).toBe(real);
  });

  it('a quote spanning a heading line still resolves', async () => {
    const dir = tmp();
    const tfile = path.join(dir, 's-head.jsonl');
    fs.writeFileSync(tfile, jsonl(entries));
    const items = writeJson(dir, 'items.json', {
      items: [
      { kind: 'overview', scope: 'project', text: 'Overview of the session.', quotes: [] },
      { kind: 'finding', scope: 'project', text: 'Heading in content', quotes: ['intro\n# Heading\n## Sub'] }],
    });
    const home = path.join(dir, 'home');
    const embedder = fakeEmbedder();
    await ingest({ sessionId: 's-head', itemsFile: items, transcript: tfile, home, embedder });
    const hits = await search({ query: 'Heading in content', scope: 'all', home, embedder });
    expect(hits.find((h) => h.kind === 'finding')?.anchors).toEqual(['u-1']);
  });
});

describe('database', () => {
  it('sets a busy timeout', async () => {
    const db = await openDb(path.join(tmp(), 'home'), fakeEmbedder());
    try {
      expect(db.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 });
    } finally {
      db.close();
    }
  });
});

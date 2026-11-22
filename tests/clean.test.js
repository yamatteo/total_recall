import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanEntries, normalizeText, renderTranscript, truncateLines } from '../src/clean.js';
import { listSubagents, parseTranscriptFile } from '../src/parse.js';
import { redactText, readsEnvFile } from '../src/redact.js';
import { SESSION, TRANSCRIPT } from './helpers.js';

const render = () => {
  const main = cleanEntries(parseTranscriptFile(TRANSCRIPT));
  const subs = listSubagents(TRANSCRIPT, SESSION).map((s) => ({
    id: s.id,
    description: s.description,
    blocks: cleanEntries(parseTranscriptFile(s.file)),
  }));
  return renderTranscript(main, subs);
};

describe('parse and clean', () => {
  it('skips bookkeeping lines and malformed lines', () => {
    const entries = parseTranscriptFile(TRANSCRIPT);
    expect(entries.every((e) => typeof e.uuid === 'string')).toBe(true);
    expect(entries.find((e) => e.type === 'queue-operation')).toBeUndefined();
  });

  it('renders one block per entry with header, drops thinking and empty entries', () => {
    const md = render();
    expect(md).toContain('## u-0001 user 2026-01-01T10:00:00.000Z\n\nPlease fix the flaky login test');
    expect(md).toContain('## a-0002 assistant ');
    expect(md).not.toContain('secret musings');
    expect(md).not.toContain('SIGDATA');
    expect(md).not.toContain('## a-0001 ');
    expect(md).not.toContain('## a-0007 ');
    expect(md).not.toContain('## u-0004 '); // only image + tool_reference
    expect(md).not.toContain('AAAA');
    expect(md).not.toContain('dropped system note');
  });

  it('formats tool calls and truncates long inputs', () => {
    const md = render();
    expect(md).toContain('tool: Read {"file_path":"/work/demo-project/login.test.js"}');
    const taskLine = md.split('\n').find((l) => l.startsWith('tool: Task'));
    expect(taskLine).toBeDefined();
    expect(/** @type {string} */ (taskLine).length).toBeLessThan(330);
    expect(taskLine).toMatch(/…$/);
  });

  it('truncates tool results to first 20 and last 10 lines', () => {
    const md = render();
    expect(md).toContain('line 20 of login test\n[… 10 lines omitted …]\nline 31 of login test');
    expect(md).not.toContain('line 21 of login test');
    expect(truncateLines('a\nb')).toBe('a\nb');
  });

  it('renders compaction boundary and compact-summary role', () => {
    const md = render();
    expect(md).toContain('\n# compact boundary 2026-01-01T10:11:00.000Z auto 150000→12000\n');
    expect(md).toContain('## cs-0001 compact-summary ');
    expect(md).not.toMatch(/cs-0001 user/);
  });

  it('appends subagents with headings', () => {
    const md = render();
    expect(md).toContain('# subagent agent-a1: investigate cache\n\n## sa-0001 assistant');
    expect(md).toContain('# subagent agent-a2\n\n## sa-0002');
    expect(md.indexOf('# subagent agent-a1')).toBeGreaterThan(md.indexOf('## a-0008'));
  });

  it('is deterministic', () => {
    expect(render()).toBe(render());
  });

  it('normalises whitespace and case', () => {
    expect(normalizeText('  Foo \n BAR\tbaz ')).toBe('foo bar baz');
  });

  it('redacts in the cleaned transcript and replaces .env reads', () => {
    const md = render();
    expect(md).toContain('[REDACTED:api-key]');
    expect(md).toContain('API_KEY=[REDACTED:secret]');
    expect(md).toContain('result: [REDACTED:env-file]');
    expect(md).not.toContain('hunter2');
    expect(fs.readFileSync(TRANSCRIPT, 'utf8')).toContain('hunter2'); // fixture untouched
  });
});

describe('redactText', () => {
  const cases = /** @type {Array<[string, string, string]>} */ ([
    ['anthropic key', 'key sk-ant-api03-abcdefghijklmnop1234 end', '[REDACTED:api-key]'],
    ['sk key', 'sk-abcdefghijklmnopqrstuv', '[REDACTED:api-key]'],
    ['ghp', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', '[REDACTED:github-token]'],
    ['gho', 'gho_abcdefghijklmnopqrstuvwxyz0123456789', '[REDACTED:github-token]'],
    ['ghs', 'ghs_abcdefghijklmnopqrstuvwxyz0123456789', '[REDACTED:github-token]'],
    ['pat', 'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuv', '[REDACTED:github-token]'],
    ['aws', 'AKIAIOSFODNN7EXAMPLE', '[REDACTED:aws-key]'],
    ['slack', 'xoxb-1234567890-abcdefghij', '[REDACTED:slack-token]'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc_DEF-123', '[REDACTED:jwt]'],
    [
      'pem',
      'x\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY-----\ny',
      '[REDACTED:private-key]',
    ],
    ['assign =', 'MY_SECRET=abc123', 'MY_SECRET=[REDACTED:secret]'],
    ['assign :', 'db_password: hunter2', 'db_password: [REDACTED:secret]'],
    ['assign json', '"apiKey": "abc 123"', '"apiKey": [REDACTED:secret]'],
    ['assign quoted', "GITHUB_TOKEN='abc def'", 'GITHUB_TOKEN=[REDACTED:secret]'],
  ]);
  for (const [name, input, expected] of cases) {
    it(name, () => {
      const out = redactText(input);
      expect(out).toContain(expected);
    });
  }

  it('leaves ordinary text alone', () => {
    const t = 'We discussed the task-runner and sk8 boards. username: bob';
    expect(redactText(t)).toBe(t);
  });

  it('detects .env reads', () => {
    expect(readsEnvFile('Read', { file_path: '/a/.env' })).toBe(true);
    expect(readsEnvFile('Read', { file_path: '/a/.env.production' })).toBe(true);
    expect(readsEnvFile('Read', { file_path: '/a/env.js' })).toBe(false);
    expect(readsEnvFile('Bash', { command: 'cat .env' })).toBe(true);
    expect(readsEnvFile('Bash', { command: 'ls' })).toBe(false);
  });
});

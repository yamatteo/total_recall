#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const USAGE = `usage:
  total-recall ingest --session <id> --items <file> [--transcript <path>]
  total-recall archive --session <id> [--transcript <path>]
  total-recall prepare --session <id> [--transcript <path>]
  total-recall forget --session <id>
  total-recall doctor
  total-recall setup [--dry-run]
  total-recall search <query> [--scope project|global|all] [--project <project_id>] [--limit N] [--json]
  total-recall recall <query> [--cwd <dir>] [--everywhere] [--limit N] [--json]
  total-recall sessions [--cwd <dir>] [--everywhere] [--json]
`;

/** @param {string[]} argv */
async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!['ingest', 'search', 'recall', 'sessions', 'archive', 'prepare', 'forget', 'doctor', 'setup'].includes(String(cmd))) {
    process.stderr.write(USAGE);
    return cmd === undefined || cmd === '--help' || cmd === 'help' ? 0 : 2;
  }

  if (cmd === 'doctor') {
    const { doctor } = await import('../src/doctor.js');
    const results = await doctor();
    for (const r of results) console.log(`${r.ok ? 'ok  ' : 'fail'} ${r.name}: ${r.detail}`);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      console.log('\nfixes:');
      for (const r of failed) console.log(`  ${r.name}: ${r.fix}`);
    }
    return failed.length ? 1 : 0;
  }

  if (cmd === 'setup') {
    const { values } = parseArgs({ args: rest, options: { 'dry-run': { type: 'boolean', default: false } } });
    const { setup } = await import('../src/setup.js');
    await setup({ dryRun: values['dry-run'] });
    return 0;
  }

  if (cmd === 'forget') {
    const { values } = parseArgs({ args: rest, options: { session: { type: 'string' } } });
    if (!values.session) {
      process.stderr.write(USAGE);
      return 2;
    }
    const { forget } = await import('../src/forget.js');
    const r = await forget({ sessionId: values.session });
    console.log(
      `forgot session ${r.sessionId}: removed ${r.items} items, ${r.anchors} anchors${r.removedDir ? `, directory ${r.dir}` : ''}`,
    );
    return 0;
  }

  if (cmd === 'archive' || cmd === 'prepare') {
    const { values } = parseArgs({ args: rest, options: { session: { type: 'string' }, transcript: { type: 'string' } } });
    if (!values.session) {
      process.stderr.write(USAGE);
      return 2;
    }
    const { archive } = await import('../src/archive.js');
    const info = await archive({ sessionId: values.session, transcript: values.transcript });
    if (cmd === 'archive') {
      console.log(
        `archived session ${info.sessionId}: ${info.entries} entries, ${info.boundaries} compact boundaries, ${info.subagents} subagents`,
      );
    } else {
      const { formatReport } = await import('../src/prepare.js');
      console.log(
        formatReport({ info, binPath: fileURLToPath(import.meta.url), transcript: values.transcript }),
      );
    }
    return 0;
  }

  if (cmd === 'sessions') {
    const { values } = parseArgs({
      args: rest,
      options: { cwd: { type: 'string' }, everywhere: { type: 'boolean', default: false }, json: { type: 'boolean', default: false } },
    });
    const { listSessions, formatSessions } = await import('../src/sessions.js');
    const rows = await listSessions({ cwd: values.cwd, everywhere: values.everywhere });
    console.log(values.json ? JSON.stringify(rows, null, 2) : formatSessions(rows, values.everywhere));
    return 0;
  }

  const { createBgeEmbedder } = await import('../src/embed.js');
  const embedder = createBgeEmbedder();

  if (cmd === 'ingest') {
    const { values } = parseArgs({
      args: rest,
      options: { session: { type: 'string' }, items: { type: 'string' }, transcript: { type: 'string' } },
    });
    if (!values.session || !values.items) {
      process.stderr.write(USAGE);
      return 2;
    }
    const { ingest } = await import('../src/ingest.js');
    const r = await ingest({
      sessionId: values.session,
      itemsFile: values.items,
      transcript: values.transcript,
      embedder,
    });
    console.log(`ingested session ${r.sessionId}: ${r.items} items, ${r.anchors} anchors, ${r.subagents} subagents`);
    return 0;
  }

  if (cmd === 'recall') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        cwd: { type: 'string' },
        everywhere: { type: 'boolean', default: false },
        limit: { type: 'string', default: '8' },
        json: { type: 'boolean', default: false },
      },
    });
    const query = positionals.join(' ').trim();
    const limit = Number(values.limit);
    if (!query || !Number.isInteger(limit) || limit < 1) {
      process.stderr.write(USAGE);
      return 2;
    }
    const { recall, formatRecall } = await import('../src/recall.js');
    const data = await recall({ query, cwd: values.cwd, everywhere: values.everywhere, limit, embedder });
    console.log(values.json ? JSON.stringify(data, null, 2) : formatRecall(data));
    return 0;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      scope: { type: 'string', default: 'all' },
      project: { type: 'string' },
      limit: { type: 'string', default: '10' },
      json: { type: 'boolean', default: false },
    },
  });
  const query = positionals.join(' ').trim();
  const limit = Number(values.limit);
  if (!query || !['project', 'global', 'all'].includes(String(values.scope)) || !Number.isInteger(limit) || limit < 1) {
    process.stderr.write(USAGE);
    return 2;
  }
  const { search } = await import('../src/ingest.js');
  const results = await search({
    query,
    scope: /** @type {'project'|'global'|'all'} */ (values.scope),
    project: values.project,
    limit,
    embedder,
  });
  if (values.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      console.log(`${r.rank}. [${r.score.toFixed(3)}] ${r.kind} (${r.scope}) session ${r.session_id}`);
      console.log(`   ${r.text}`);
      if (r.anchors.length) console.log(`   anchors: ${r.anchors.join(' ')}`);
    }
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);

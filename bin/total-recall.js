#!/usr/bin/env node
import { parseArgs } from 'node:util';

const USAGE = `usage:
  total-recall ingest --session <id> --items <file> [--transcript <path>]
  total-recall search <query> [--scope project|global|all] [--project <project_id>] [--limit N] [--json]
`;

/** @param {string[]} argv */
async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'ingest' && cmd !== 'search') {
    process.stderr.write(USAGE);
    return cmd === undefined || cmd === '--help' || cmd === 'help' ? 0 : 2;
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

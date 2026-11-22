import os from 'node:os';
import path from 'node:path';

/** Quote only when the path needs it, so the command matches simple allow rules. @param {string} p */
const q = (p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : JSON.stringify(p));

/**
 * Plain-text report for the /wrapup skill.
 * @param {{info: Awaited<ReturnType<typeof import('./archive.js').archive>>, binPath: string, transcript?: string}} o
 */
export function formatReport({ info, binPath, transcript }) {
  const itemsFile = path.join(os.tmpdir(), `total-recall-${info.sessionId}.items.json`);
  const ingestCmd =
    `node ${q(binPath)} ingest --session ${info.sessionId} --items ${q(itemsFile)}` +
    (transcript ? ` --transcript ${q(path.resolve(transcript))}` : '');
  return [
    `session: ${info.sessionId}`,
    `project_id: ${info.projectId}`,
    `cwd: ${info.cwd ?? 'unknown'}`,
    `transcript.md: ${info.transcriptMd} (${info.lines} lines)`,
    `compact boundaries (line numbers of "# compact boundary" in transcript.md): ${
      info.boundaryLines.length ? info.boundaryLines.join(', ') : 'none'
    }`,
    ...(info.boundaryLines.length
      ? [
          `compact summaries (line numbers of "## <uuid> compact-summary" in transcript.md): ${
            info.summaryLines.map((l) => l ?? '?').join(', ')
          }`,
          '  the session was compacted: first read the compact summaries at the listed lines (they summarise everything before them), then use targeted Read/Grep of the earlier ranges for details and exact quotes',
        ]
      : []),
    `subagents: ${info.subagents}`,
    '',
    'items file: {"items":[{"kind":"overview|finding|mistake|decision","scope":"project|global","text":"...","quotes":["..."]}]}',
    '- exactly one overview; every other item needs 1-3 quotes of at least 15 characters',
    '- text: a self-contained sentence (max 1000 chars) that makes sense without the session',
    '- scope "global" only for knowledge useful outside this project',
    '- quotes: verbatim from message text in transcript.md (case and whitespace insensitive), never from "#" structural lines',
    '',
    'write the items file, then run:',
    ingestCmd,
  ].join('\n');
}

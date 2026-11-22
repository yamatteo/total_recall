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
  const last = info.boundaryLines[info.boundaryLines.length - 1];
  return [
    `session: ${info.sessionId}`,
    `project_id: ${info.projectId}`,
    `cwd: ${info.cwd ?? 'unknown'}`,
    `transcript.md: ${info.transcriptMd} (${info.lines} lines)`,
    `compact boundaries (line numbers of "# compact boundary" in transcript.md): ${
      info.boundaryLines.length ? info.boundaryLines.join(', ') : 'none'
    }`,
    ...(last
      ? [`  the session was compacted: read transcript.md lines 1-${last - 1} too, they are no longer in your context`]
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

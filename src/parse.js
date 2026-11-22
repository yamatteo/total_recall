import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Record<string, any> & {uuid: string, type: string}} Entry
 * @typedef {{id: string, file: string, metaFile: string | null, description: string | null, agentType: string | null}} SubagentFile
 */

/**
 * Parse JSONL text into entries that carry a uuid (bookkeeping lines have none).
 * Malformed lines are skipped.
 * @param {string} text
 * @returns {Entry[]}
 */
export function parseJsonl(text) {
  /** @type {Entry[]} */
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object' && typeof o.uuid === 'string' && typeof o.type === 'string') out.push(o);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/** @param {string} file */
export function parseTranscriptFile(file) {
  return parseJsonl(fs.readFileSync(file, 'utf8'));
}

/**
 * List subagent transcripts at <dir of transcript>/<sessionId>/subagents/.
 * @param {string} transcriptPath
 * @param {string} sessionId
 * @returns {SubagentFile[]}
 */
export function listSubagents(transcriptPath, sessionId) {
  const dir = path.join(path.dirname(transcriptPath), sessionId, 'subagents');
  /** @type {string[]} */
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^agent-.+\.jsonl$/.test(n))
    .sort()
    .map((n) => {
      const id = n.replace(/\.jsonl$/, '');
      const metaName = `${id}.meta.json`;
      const metaFile = names.includes(metaName) ? path.join(dir, metaName) : null;
      let description = null;
      let agentType = null;
      if (metaFile) {
        try {
          const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
          if (typeof m.description === 'string') description = m.description;
          if (typeof m.agentType === 'string') agentType = m.agentType;
        } catch {
          // ignore bad meta
        }
      }
      return { id, file: path.join(dir, n), metaFile, description, agentType };
    });
}

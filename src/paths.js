import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/** @param {string} id */
export function assertSessionId(id) {
  if (!SESSION_ID_RE.test(id)) throw new Error(`invalid session id: ${JSON.stringify(id)}`);
}

/** Claude Code config dir (CLAUDE_CONFIG_DIR or ~/.claude). */
export function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Storage root (TOTAL_RECALL_HOME or ~/.claude/memory). */
export function memoryHome() {
  return process.env.TOTAL_RECALL_HOME || path.join(claudeConfigDir(), 'memory');
}

/** @param {string} home */
export const indexPath = (home) => path.join(home, 'index.sqlite');
/** @param {string} home @param {string} sessionId */
export const sessionDir = (home, sessionId) => path.join(home, 'sessions', sessionId);

/** Model cache dir (TOTAL_RECALL_MODEL_CACHE or <repo>/.cache/transformers). */
export function modelCacheDir() {
  if (process.env.TOTAL_RECALL_MODEL_CACHE) return process.env.TOTAL_RECALL_MODEL_CACHE;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '.cache', 'transformers');
}

/**
 * Find <config>/projects/<slug>/<sessionId>.jsonl.
 * @param {string} sessionId
 * @returns {string | null}
 */
export function findTranscript(sessionId) {
  assertSessionId(sessionId);
  const projects = path.join(claudeConfigDir(), 'projects');
  /** @type {string[]} */
  let slugs;
  try {
    slugs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const slug of slugs.sort()) {
    const p = path.join(projects, slug, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

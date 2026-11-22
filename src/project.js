import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * project_id from a working directory: git:<root commit> when in a repo with commits, else path:<cwd>.
 * @param {string | null | undefined} cwd
 */
export function projectId(cwd) {
  if (!cwd) return 'path:unknown';
  try {
    if (fs.statSync(cwd).isDirectory()) {
      const out = execFileSync('git', ['-C', cwd, 'rev-list', '--max-parents=0', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const roots = out.split('\n').map((s) => s.trim()).filter(Boolean).sort();
      if (roots[0]) return `git:${roots[0]}`;
    }
  } catch {
    // not a git repo, no commits, or git missing
  }
  return `path:${cwd}`;
}

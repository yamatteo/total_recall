import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryHome } from './paths.js';
import { openDb } from './db.js';
import { installedStatus, repoRoot, resolveModelCache, resolveTransformers } from './runtime.js';

const root = repoRoot();
const SETUP_FIX = `node ${path.join(root, 'bin', 'total-recall.js')} setup`;

/** Path of the q8 model file inside the resolved cache. */
export const modelFile = () => resolveModelCache().file;

/**
 * Run every setup check.
 * @returns {Promise<Array<{name: string, ok: boolean, detail: string, fix?: string}>>}
 */
export async function doctor() {
  /** @type {Array<{name: string, ok: boolean, detail: string, fix?: string}>} */
  const out = [];

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const want = String(pkg.engines?.node ?? '>=22.5');
  const [wMaj = 0, wMin = 0] = (want.match(/\d+/g) ?? []).map(Number);
  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number);
  out.push({
    name: 'node version',
    ok: maj > wMaj || (maj === wMaj && min >= wMin),
    detail: `${process.versions.node} (needs ${want})`,
    fix: 'install Node 22.5 or newer',
  });

  const tf = resolveTransformers();
  out.push({
    name: 'dependencies',
    ok: tf.source !== 'missing',
    detail: tf.source === 'missing' ? `not found (looked in ${tf.dir} and the repo's node_modules)` : `${tf.source}: ${tf.dir}`,
    fix: SETUP_FIX,
  });

  const model = resolveModelCache();
  out.push({
    name: 'embedding model',
    ok: model.found,
    detail: model.found ? `${model.source}: ${model.file}` : `missing: ${model.file}`,
    fix: SETUP_FIX,
  });

  const inst = installedStatus();
  out.push({
    name: 'runtime version',
    ok: inst.state !== 'mismatch',
    detail: inst.state === 'absent' ? `${inst.detail} (nothing to compare)` : inst.detail,
    fix: SETUP_FIX,
  });

  const home = memoryHome();
  let writable = true;
  let why = home;
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const probe = path.join(home, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
  } catch (e) {
    writable = false;
    why = `${home}: ${e instanceof Error ? e.message : String(e)}`;
  }
  out.push({
    name: 'memory home writable',
    ok: writable,
    detail: why,
    fix: `make ${home} writable, or set TOTAL_RECALL_HOME to a writable directory`,
  });

  try {
    (await openDb(home)).close();
    out.push({ name: 'index opens', ok: true, detail: path.join(home, 'index.sqlite') });
  } catch (e) {
    out.push({
      name: 'index opens',
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      fix: `check ${home}/index.sqlite (move it aside to start a fresh index)`,
    });
  }
  return out;
}


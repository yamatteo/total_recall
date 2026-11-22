// Where the embedding library and the model live. Model-free: resolving paths is fine,
// importing @huggingface/transformers is not (see embed.js and setup.js for that).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_ID, MODEL_NAME } from './model-id.js';
import { memoryHome } from './paths.js';

const TF = ['@huggingface', 'transformers'];

/** Repository (plugin) root. */
export const repoRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Runtime folder, outside the plugin so it survives plugin updates: <memoryHome>/runtime. */
export const runtimeDir = () => path.join(memoryHome(), 'runtime');
/** Transformers cache dir inside the runtime folder. */
export const runtimeModelsDir = () => path.join(runtimeDir(), 'models');
/** Written by setup when both npm install and the model download succeeded. */
export const installedPath = () => path.join(runtimeDir(), 'installed.json');

/** @param {string} cache Path of the q8 model file inside a transformers cache dir. */
export const modelFileIn = (cache) => path.join(cache, ...MODEL_NAME.split('/'), 'onnx', 'model_quantized.onnx');

/** Dev fallback cache: <repo>/.cache/transformers. */
const repoModelCache = () => path.join(repoRoot(), '.cache', 'transformers');

/**
 * Model cache order: TOTAL_RECALL_MODEL_CACHE, runtime/models if it has the model,
 * the repo's .cache/transformers if it has the model, else runtime/models (where setup puts it).
 * @returns {{ source: 'env' | 'runtime' | 'repo' | 'missing', cache: string, file: string, found: boolean }}
 */
export function resolveModelCache() {
  const env = process.env.TOTAL_RECALL_MODEL_CACHE;
  if (env) return { source: 'env', cache: env, file: modelFileIn(env), found: fs.existsSync(modelFileIn(env)) };
  const rt = runtimeModelsDir();
  if (fs.existsSync(modelFileIn(rt))) return { source: 'runtime', cache: rt, file: modelFileIn(rt), found: true };
  const repo = repoModelCache();
  if (fs.existsSync(modelFileIn(repo))) return { source: 'repo', cache: repo, file: modelFileIn(repo), found: true };
  return { source: 'missing', cache: rt, file: modelFileIn(rt), found: false };
}

/** Cache dir the embedder uses. */
export const modelCacheDir = () => resolveModelCache().cache;

/**
 * ESM entry file of the transformers package installed under a node_modules folder, or null.
 * Resolved by hand because createRequire().resolve picks the CommonJS entry.
 * @param {string} nodeModules
 * @returns {string | null}
 */
function esmEntry(nodeModules) {
  const dir = path.join(nodeModules, ...TF);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const ex = pkg.exports;
    /** @type {unknown[]} */
    const cands = [
      ex?.node?.import?.default,
      ex?.node?.import,
      ex?.import?.default,
      ex?.import,
      ex?.default?.default,
      typeof ex === 'string' ? ex : undefined,
      pkg.module,
      pkg.main,
    ];
    for (const c of cands) {
      if (typeof c !== 'string') continue;
      const f = path.resolve(dir, c);
      if (fs.existsSync(f)) return f;
    }
  } catch {
    /* not installed */
  }
  return null;
}

/**
 * Where @huggingface/transformers loads from: the runtime's node_modules, else the repo's own
 * (development fallback), else missing. `entry` is the ESM entry file for 'runtime'; for 'repo'
 * the plain import specifier resolves it.
 * @returns {{ source: 'runtime' | 'repo' | 'missing', entry: string | null, dir: string }}
 */
export function resolveTransformers() {
  const rtNm = path.join(runtimeDir(), 'node_modules');
  const rt = esmEntry(rtNm);
  if (rt) return { source: 'runtime', entry: rt, dir: path.join(rtNm, ...TF) };
  const repoNm = path.join(repoRoot(), 'node_modules');
  const repo = esmEntry(repoNm);
  if (repo) return { source: 'repo', entry: repo, dir: path.join(repoNm, ...TF) };
  return { source: 'missing', entry: null, dir: path.join(rtNm, ...TF) };
}

/** Exact transformers version the plugin requires (its package.json dependency). */
export function requiredTransformersVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8'));
  return String(pkg.dependencies?.[TF.join('/')] ?? '');
}

/**
 * Compare runtime/installed.json with what this plugin version requires.
 * 'absent' when there is none (nothing to compare).
 * @returns {{ state: 'absent' | 'ok' | 'mismatch', detail: string }}
 */
export function installedStatus() {
  const p = installedPath();
  if (!fs.existsSync(p)) return { state: 'absent', detail: `${p} not present` };
  const want = { transformers: requiredTransformersVersion(), model: MODEL_ID };
  /** @type {any} */
  let got = {};
  try {
    got = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { state: 'mismatch', detail: `${p} is not valid JSON` };
  }
  const bad = [];
  if (got.transformers !== want.transformers) bad.push(`transformers ${got.transformers ?? '?'} installed, ${want.transformers} required`);
  if (got.model !== want.model) bad.push(`model ${got.model ?? '?'} installed, ${want.model} required`);
  return bad.length ? { state: 'mismatch', detail: bad.join('; ') } : { state: 'ok', detail: `${p}: transformers ${want.transformers}, model ${want.model}` };
}

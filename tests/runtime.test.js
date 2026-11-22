import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MODEL_ID } from '../src/model-id.js';
import { installedStatus, modelFileIn, requiredTransformersVersion, resolveModelCache, resolveTransformers } from '../src/runtime.js';
import { tmp } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'total-recall.js');
const HOOK = path.join(ROOT, 'hooks', 'session-start.sh');
const REPO_HAS_MODEL = fs.existsSync(modelFileIn(path.join(ROOT, '.cache', 'transformers')));
const REPO_HAS_LIB = fs.existsSync(path.join(ROOT, 'node_modules', '@huggingface', 'transformers'));

/** Fake package: package.json with the real exports shape, plus an ESM entry that fakes env/pipeline. */
function fakePackage(/** @type {string} */ nodeModules) {
  const dir = path.join(nodeModules, '@huggingface', 'transformers');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: '@huggingface/transformers',
      version: '4.3.2',
      type: 'module',
      exports: { node: { import: { default: './dist/transformers.node.mjs' }, require: { default: './dist/transformers.node.cjs' } } },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'dist', 'transformers.node.mjs'),
    `export const env = {};
export async function pipeline(task, name, opts) {
  globalThis.__fake = { task, name, opts, cacheDir: env.cacheDir, remote: env.allowRemoteModels };
  return async (texts) => ({ data: new Float32Array(384 * texts.length).fill(0.5) });
}\n`,
  );
  fs.writeFileSync(path.join(dir, 'dist', 'transformers.node.cjs'), 'throw new Error("cjs entry must not be used");\n');
}

/** @param {string} cache */
function fakeModel(cache) {
  const f = modelFileIn(cache);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'x');
}

/** A temp memory home whose runtime/ is complete (fake library, fake model, matching installed.json). */
function completeHome() {
  const home = tmp();
  const rt = path.join(home, 'runtime');
  fakePackage(path.join(rt, 'node_modules'));
  fakeModel(path.join(rt, 'models'));
  fs.writeFileSync(path.join(rt, 'installed.json'), JSON.stringify({ transformers: requiredTransformersVersion(), model: MODEL_ID }));
  return home;
}

/** @type {Record<string, string | undefined>} */
let saved;
beforeEach(() => {
  saved = { h: process.env.TOTAL_RECALL_HOME, c: process.env.TOTAL_RECALL_MODEL_CACHE };
  delete process.env.TOTAL_RECALL_MODEL_CACHE;
});
afterEach(() => {
  for (const [k, v] of [['TOTAL_RECALL_HOME', saved.h], ['TOTAL_RECALL_MODEL_CACHE', saved.c]]) {
    if (v === undefined) delete process.env[/** @type {string} */ (k)];
    else process.env[/** @type {string} */ (k)] = v;
  }
});

describe('model cache order', () => {
  it('prefers TOTAL_RECALL_MODEL_CACHE, then runtime/models, then repo, then runtime/models', () => {
    const home = tmp();
    process.env.TOTAL_RECALL_HOME = home;
    const rtModels = path.join(home, 'runtime', 'models');

    const env = tmp();
    process.env.TOTAL_RECALL_MODEL_CACHE = env;
    expect(resolveModelCache()).toMatchObject({ source: 'env', cache: env, found: false });
    fakeModel(env);
    fakeModel(rtModels);
    expect(resolveModelCache()).toMatchObject({ source: 'env', cache: env, found: true });
    delete process.env.TOTAL_RECALL_MODEL_CACHE;

    expect(resolveModelCache()).toMatchObject({ source: 'runtime', cache: rtModels, found: true });

    fs.rmSync(rtModels, { recursive: true });
    const r = resolveModelCache();
    if (REPO_HAS_MODEL) expect(r).toMatchObject({ source: 'repo', cache: path.join(ROOT, '.cache', 'transformers'), found: true });
    else expect(r).toMatchObject({ source: 'missing', cache: rtModels, found: false });
  });
});

describe('library resolution', () => {
  it('uses the runtime copy (ESM entry) when installed there', () => {
    const home = tmp();
    process.env.TOTAL_RECALL_HOME = home;
    fakePackage(path.join(home, 'runtime', 'node_modules'));
    const r = resolveTransformers();
    expect(r.source).toBe('runtime');
    expect(r.entry).toBe(path.join(home, 'runtime', 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs'));
  });

  it('falls back to the repo node_modules, else reports missing', () => {
    process.env.TOTAL_RECALL_HOME = tmp();
    expect(resolveTransformers().source).toBe(REPO_HAS_LIB ? 'repo' : 'missing');
  });

  it('the embedder loads the runtime copy and caches models under runtime/models', () => {
    const home = completeHome();
    const script = `import { createBgeEmbedder } from ${JSON.stringify(path.join(ROOT, 'src', 'embed.js'))};
const e = createBgeEmbedder();
const v = await e.embedPassages(['a', 'b']);
console.log(JSON.stringify({ n: v.length, dim: v[0].length, fake: globalThis.__fake }));\n`;
    const out = JSON.parse(
      execFileSync('node', ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        env: { ...process.env, TOTAL_RECALL_HOME: home, TOTAL_RECALL_MODEL_CACHE: '' },
      }),
    );
    expect(out.n).toBe(2);
    expect(out.dim).toBe(384);
    expect(out.fake).toMatchObject({ name: 'Xenova/bge-small-en-v1.5', opts: { dtype: 'q8' }, cacheDir: path.join(home, 'runtime', 'models'), remote: false });
  });
});

describe('installed.json', () => {
  it('reports absent, ok and mismatch', () => {
    const home = completeHome();
    process.env.TOTAL_RECALL_HOME = home;
    expect(installedStatus().state).toBe('ok');
    const p = path.join(home, 'runtime', 'installed.json');
    fs.writeFileSync(p, JSON.stringify({ transformers: '0.0.1', model: MODEL_ID }));
    expect(installedStatus()).toMatchObject({ state: 'mismatch' });
    fs.writeFileSync(p, JSON.stringify({ transformers: requiredTransformersVersion(), model: 'other:q4' }));
    expect(installedStatus().detail).toContain('other:q4');
    fs.rmSync(p);
    expect(installedStatus().state).toBe('absent');
  });
});

describe('setup --dry-run', () => {
  it('prints the plan, changes nothing and loads no model code', () => {
    const home = tmp();
    const hook = path.join(tmp(), 'trace.mjs');
    fs.writeFileSync(
      hook,
      `import { registerHooks } from 'node:module';
registerHooks({ resolve(s, c, n) { if (s.includes('transformers') || s.endsWith('embed.js')) throw new Error('forbidden import: ' + s); return n(s, c); } });\n`,
    );
    const r = spawnSync('node', ['--import', hook, BIN, 'setup', '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, TOTAL_RECALL_HOME: home },
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const rt = path.join(home, 'runtime');
    expect(r.stdout).toContain(`runtime folder: ${rt}`);
    expect(r.stdout).toContain(`cd ${rt} && ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install --no-audit --no-fund --omit=dev`);
    expect(r.stdout).toContain(path.join(rt, 'models'));
    expect(r.stdout).toContain(path.join(rt, 'installed.json'));
    expect(fs.readdirSync(home)).toEqual([]);
  });
});

describe('doctor with a runtime', () => {
  /** @param {string} home */
  const doctor = (home) =>
    spawnSync('node', [BIN, 'doctor'], { encoding: 'utf8', env: { ...process.env, TOTAL_RECALL_HOME: home, TOTAL_RECALL_MODEL_CACHE: '' } });

  it('is all ok, resolved from the runtime', () => {
    const home = completeHome();
    const r = doctor(home);
    expect(r.stdout).toContain(`ok   dependencies: runtime: ${path.join(home, 'runtime', 'node_modules')}`);
    expect(r.stdout).toContain(`ok   embedding model: runtime: ${modelFileIn(path.join(home, 'runtime', 'models'))}`);
    expect(r.stdout).not.toContain('fail');
    expect(r.status).toBe(0);
  });

  it('exits 1 on an installed.json mismatch, with the setup fix', () => {
    const home = completeHome();
    fs.writeFileSync(path.join(home, 'runtime', 'installed.json'), JSON.stringify({ transformers: '0.0.1', model: MODEL_ID }));
    const r = doctor(home);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/fail runtime version: .*transformers 0\.0\.1 installed/);
    expect(r.stdout).toContain(`node ${BIN} setup`);
  });
});

describe('session-start hook with a runtime', () => {
  /** A copy of the plugin without node_modules or .cache: hooks/ and package.json only. */
  function installedCopy() {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'hooks'));
    fs.copyFileSync(HOOK, path.join(root, 'hooks', 'session-start.sh'));
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
    return path.join(root, 'hooks', 'session-start.sh');
  }
  /** @param {string} hook @param {string} home */
  const run = (hook, home) =>
    execFileSync('sh', [hook], { encoding: 'utf8', env: { ...process.env, TOTAL_RECALL_HOME: home, TOTAL_RECALL_MODEL_CACHE: '' } });

  it('is silent when the runtime is complete and the repo has no node_modules', () => {
    expect(run(installedCopy(), completeHome())).toBe('');
  });

  it('prints one setup line when installed.json does not match', () => {
    const hook = installedCopy();
    const home = completeHome();
    const p = path.join(home, 'runtime', 'installed.json');
    fs.writeFileSync(p, JSON.stringify({ transformers: '0.0.1', model: MODEL_ID }));
    const out = run(hook, home);
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(out).toContain('total-recall: setup needed — run: node ');
    expect(out).toContain('bin/total-recall.js setup');
    fs.writeFileSync(p, JSON.stringify({ transformers: requiredTransformersVersion(), model: 'other:q4' }));
    expect(run(hook, home)).toContain('setup needed');
  });

  it('prints the line when the runtime is empty and the repo is not a fallback', () => {
    expect(run(installedCopy(), tmp())).toContain('setup needed');
  });

  it('hard-coded model id matches MODEL_ID', () => {
    expect(fs.readFileSync(HOOK, 'utf8')).toContain(`MODEL_ID="${MODEL_ID}"`);
  });
});

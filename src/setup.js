import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { MODEL_DTYPE, MODEL_ID, MODEL_NAME } from './model-id.js';
import {
  installedPath,
  modelFileIn,
  requiredTransformersVersion,
  resolveTransformers,
  runtimeDir,
  runtimeModelsDir,
} from './runtime.js';

const TF = '@huggingface/transformers';
export const NPM_ARGS = ['install', '--no-audit', '--no-fund', '--omit=dev'];
export const NPM_ENV = { ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip' };

/** @param {string} dir installed version of transformers in <dir>/node_modules, or null */
function installedVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', '@huggingface', 'transformers', 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Fill the runtime folder: npm dependencies, then the model. Safe to re-run.
 * Never imports transformers at module top level.
 * @param {{ dryRun?: boolean, log?: (line: string) => void }} [opts]
 */
export async function setup({ dryRun = false, log = console.log } = {}) {
  const dir = runtimeDir();
  const version = requiredTransformersVersion();
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`package.json must pin ${TF} exactly, found ${JSON.stringify(version)}`);
  const models = runtimeModelsDir();
  const envText = Object.entries(NPM_ENV).map(([k, v]) => `${k}=${v}`).join(' ');
  const npmText = `cd ${dir} && ${envText} npm ${NPM_ARGS.join(' ')}`;

  if (dryRun) {
    log('dry run: nothing will be changed');
    log(`runtime folder: ${dir}`);
    log(`1. write ${path.join(dir, 'package.json')} (private, dependency ${TF} ${version})`);
    log(`2. run: ${npmText}`);
    log(`3. download ${MODEL_NAME} (${MODEL_DTYPE}) into ${models} (remote models allowed for this step only)`);
    log(`4. write ${installedPath()}`);
    return;
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'total-recall-runtime', version: '0.0.0', private: true, dependencies: { [TF]: version } }, null, 2)}\n`,
  );

  if (installedVersion(dir) === version) {
    log(`dependencies: ${TF} ${version} already installed, skipping npm`);
  } else {
    log(`dependencies: ${npmText}`);
    const r = spawnSync('npm', NPM_ARGS, { cwd: dir, stdio: 'inherit', env: { ...process.env, ...NPM_ENV } });
    if (r.error) throw new Error(`could not run npm: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`npm install failed (exit ${r.status})`);
  }

  if (fs.existsSync(modelFileIn(models))) {
    log(`model: ${MODEL_NAME} already present in ${models}, skipping download`);
  } else {
    const tf = resolveTransformers();
    if (tf.source !== 'runtime' || !tf.entry) throw new Error(`${TF} is not installed in ${path.join(dir, 'node_modules')}`);
    log(`model: downloading ${MODEL_NAME} (${MODEL_DTYPE}) into ${models} ...`);
    const { env, pipeline } = await import(pathToFileURL(tf.entry).href);
    env.cacheDir = models;
    env.allowRemoteModels = true;
    await pipeline('feature-extraction', MODEL_NAME, { dtype: MODEL_DTYPE });
    if (!fs.existsSync(modelFileIn(models))) throw new Error(`download finished but ${modelFileIn(models)} is missing`);
    log(`model: downloaded to ${models}`);
  }

  fs.writeFileSync(installedPath(), `${JSON.stringify({ transformers: version, model: MODEL_ID })}\n`);
  log(`setup complete: ${installedPath()}`);
}

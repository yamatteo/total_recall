import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_NAME } from './embed.js';
import { memoryHome, modelCacheDir } from './paths.js';
import { openDb } from './db.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Path of the q8 model file inside the cache. */
export const modelFile = () => path.join(modelCacheDir(), ...MODEL_NAME.split('/'), 'onnx', 'model_quantized.onnx');

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

  const tf = path.join(root, 'node_modules', '@huggingface', 'transformers');
  out.push({
    name: 'dependencies',
    ok: fs.existsSync(tf),
    detail: tf,
    fix: `cd ${root} && ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install`,
  });

  const model = modelFile();
  const cache = modelCacheDir();
  const warm =
    `import {env,pipeline} from '@huggingface/transformers'; env.cacheDir=${JSON.stringify(cache)}; ` +
    `await pipeline('feature-extraction','${MODEL_NAME}',{dtype:'q8'})`;
  out.push({
    name: 'embedding model',
    ok: fs.existsSync(model),
    detail: model,
    fix: `cd ${root} && node --input-type=module -e ${JSON.stringify(warm)}`,
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


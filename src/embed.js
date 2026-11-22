import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODEL_DIM, MODEL_DTYPE, MODEL_ID, MODEL_NAME, QUERY_PREFIX } from './model-id.js';
import { modelCacheDir, repoRoot, resolveTransformers } from './runtime.js';

/**
 * @typedef {object} Embedder
 * @property {string} model identifier recorded in the index meta, e.g. "Xenova/bge-small-en-v1.5:q8"
 * @property {number} dim
 * @property {(texts: string[]) => Promise<Float32Array[]>} embedPassages unprefixed, normalised
 * @property {(query: string) => Promise<Float32Array>} embedQuery prefixed, normalised
 */

export { MODEL_DIM, MODEL_DTYPE, MODEL_ID, MODEL_NAME, QUERY_PREFIX };

/**
 * Real embedder: bge-small-en-v1.5 (q8), offline from the local cache.
 * @returns {Embedder}
 */
export function createBgeEmbedder() {
  /** @type {Promise<any> | null} */
  let pipe = null;
  const load = () => {
    pipe ??= (async () => {
      const r = resolveTransformers();
      /** @type {any} */
      let tf;
      try {
        tf = r.source === 'runtime' && r.entry ? await import(pathToFileURL(r.entry).href) : await import('@huggingface/transformers');
      } catch (e) {
        throw new Error(`cannot load @huggingface/transformers (run: node ${path.join(repoRoot(), 'bin', 'total-recall.js')} setup): ${e instanceof Error ? e.message : String(e)}`);
      }
      const { env, pipeline } = tf;
      env.cacheDir = modelCacheDir();
      env.allowRemoteModels = false;
      return pipeline('feature-extraction', MODEL_NAME, { dtype: MODEL_DTYPE });
    })();
    return pipe;
  };
  /** @param {string[]} texts */
  const run = async (texts) => {
    if (!texts.length) return [];
    const p = await load();
    const out = await p(texts, { pooling: 'cls', normalize: true });
    const data = /** @type {Float32Array} */ (out.data);
    return texts.map((_, i) => Float32Array.from(data.subarray(i * MODEL_DIM, (i + 1) * MODEL_DIM)));
  };
  return {
    model: MODEL_ID,
    dim: MODEL_DIM,
    embedPassages: run,
    embedQuery: async (q) => /** @type {Float32Array} */ ((await run([QUERY_PREFIX + q]))[0]),
  };
}

/** @param {Float32Array} v */
export { dot, fromBlob, toBlob } from './vec.js';

import { modelCacheDir } from './paths.js';

/**
 * @typedef {object} Embedder
 * @property {string} model identifier recorded in the index meta, e.g. "Xenova/bge-small-en-v1.5:q8"
 * @property {number} dim
 * @property {(texts: string[]) => Promise<Float32Array[]>} embedPassages unprefixed, normalised
 * @property {(query: string) => Promise<Float32Array>} embedQuery prefixed, normalised
 */

export const MODEL_NAME = 'Xenova/bge-small-en-v1.5';
export const MODEL_DTYPE = 'q8';
export const MODEL_ID = `${MODEL_NAME}:${MODEL_DTYPE}`;
export const MODEL_DIM = 384;
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

/**
 * Real embedder: bge-small-en-v1.5 (q8), offline from the local cache.
 * @returns {Embedder}
 */
export function createBgeEmbedder() {
  /** @type {Promise<any> | null} */
  let pipe = null;
  const load = () => {
    pipe ??= (async () => {
      const { env, pipeline } = await import('@huggingface/transformers');
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
export const toBlob = (v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

/** @param {Uint8Array} b */
export function fromBlob(b) {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

/** @param {Float32Array} a @param {Float32Array} b */
export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += /** @type {number} */ (a[i]) * /** @type {number} */ (b[i]);
  return s;
}

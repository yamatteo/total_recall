import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const SESSION = 'sess-0001';
export const TRANSCRIPT = path.join(FIXTURES, `${SESSION}.jsonl`);
export const ITEMS = path.join(FIXTURES, 'items.json');

/** @returns {string} */
export const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tr-test-'));

/**
 * Deterministic bag-of-words embedder (hashed into 384 dims, normalised).
 * @param {string} model
 * @returns {import('../src/embed.js').Embedder}
 */
export function fakeEmbedder(model = 'fake:test') {
  /** @param {string} t */
  const vec = (t) => {
    const v = new Float32Array(384);
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let h = 2166136261;
      for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
      v[(h >>> 0) % 384] += 1;
    }
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  };
  return {
    model,
    dim: 384,
    embedPassages: async (ts) => ts.map(vec),
    embedQuery: async (q) => vec(q),
  };
}

/** @param {unknown} obj */
export function writeJson(/** @type {string} */ dir, /** @type {string} */ name, obj) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

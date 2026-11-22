import { describe, expect, it } from 'vitest';
import { createBgeEmbedder, dot, MODEL_DIM } from '../src/embed.js';

describe('bge-small-en-v1.5 q8 (offline)', () => {
  const e = createBgeEmbedder();

  it('ranks the paraphrased item first and uses the query prefix', async () => {
    const texts = [
      'Fixed a race condition in the session cache by adding a mutex around refresh.',
      'The deployment pipeline uses blue-green releases on Kubernetes with automatic rollback.',
      'Recipe tip: let the sourdough starter double in size before mixing the dough.',
    ];
    const vecs = await e.embedPassages(texts);
    expect(vecs).toHaveLength(3);
    expect(vecs[0]).toHaveLength(MODEL_DIM);
    const q = await e.embedQuery('intermittent concurrency bug with cached sessions');
    const scores = vecs.map((v) => dot(q, v));
    expect(scores.indexOf(Math.max(...scores))).toBe(0);

    const plain = /** @type {Float32Array} */ ((await e.embedPassages(['intermittent concurrency bug with cached sessions']))[0]);
    expect(Array.from(plain)).not.toEqual(Array.from(q));
  }, 100_000);
});

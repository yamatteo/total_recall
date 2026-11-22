// Vector helpers (kept apart from embed.js so that nothing here pulls in the embedding model).

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

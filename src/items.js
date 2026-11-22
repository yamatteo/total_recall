import { redactText } from './redact.js';

/**
 * @typedef {{kind: 'overview'|'finding'|'mistake'|'decision', scope: 'project'|'global', text: string, quotes: string[]}} Item
 */

export const KINDS = ['overview', 'finding', 'mistake', 'decision'];
export const SCOPES = ['project', 'global'];
export const MIN_QUOTE = 15;
export const MAX_TEXT = 1000;

export class ItemsError extends Error {
  /** @param {string[]} errors */
  constructor(errors) {
    super(`invalid items:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    this.name = 'ItemsError';
    this.errors = errors;
  }
}

/**
 * Validate the items JSON and return redacted items. Throws ItemsError.
 * @param {unknown} input
 * @returns {Item[]}
 */
export function validateItems(input) {
  /** @type {string[]} */
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ItemsError(['top level must be an object']);
  const top = /** @type {Record<string, unknown>} */ (input);
  for (const k of Object.keys(top)) if (k !== 'items') errors.push(`unknown top-level field "${k}"`);
  if (!Array.isArray(top.items)) throw new ItemsError([...errors, '"items" must be an array']);

  /** @type {Item[]} */
  const items = [];
  let overviews = 0;
  top.items.forEach((raw, i) => {
    const at = `item ${i}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    const it = /** @type {Record<string, any>} */ (raw);
    for (const k of Object.keys(it)) {
      if (!['kind', 'scope', 'text', 'quotes'].includes(k)) errors.push(`${at}: unknown field "${k}"`);
    }
    if (!KINDS.includes(it.kind)) errors.push(`${at}: kind must be one of ${KINDS.join('|')}`);
    if (!SCOPES.includes(it.scope)) errors.push(`${at}: scope must be one of ${SCOPES.join('|')}`);
    if (typeof it.text !== 'string' || !it.text.trim()) errors.push(`${at}: text must be a non-empty string`);
    else if (it.text.length > MAX_TEXT) errors.push(`${at}: text is ${it.text.length} chars, max ${MAX_TEXT}`);
    const quotes = it.quotes === undefined ? [] : it.quotes;
    if (!Array.isArray(quotes) || quotes.some((q) => typeof q !== 'string')) {
      errors.push(`${at}: quotes must be an array of strings`);
    } else {
      quotes.forEach((q, j) => {
        if (q.trim().length < MIN_QUOTE) errors.push(`${at}: quote ${j} is shorter than ${MIN_QUOTE} chars`);
      });
      if (it.kind === 'overview') overviews++;
      else if (KINDS.includes(it.kind) && quotes.length < 1) errors.push(`${at}: ${it.kind} needs at least 1 quote`);
    }
    {
      items.push({
        kind: it.kind,
        scope: it.scope,
        text: typeof it.text === 'string' ? redactText(it.text.trim()) : '',
        quotes: Array.isArray(quotes) ? quotes.filter((q) => typeof q === 'string').map(redactText) : [],
      });
    }
  });
  if (overviews !== 1) errors.push(`exactly one overview item is required, found ${overviews}`);
  if (errors.length) throw new ItemsError(errors);
  return items;
}

/**
 * Resolve each item's quotes to entry uuids. Returns anchors per item, or the unmatched quotes.
 * @param {Item[]} items
 * @param {Array<{uuid: string, norm: string}>} index normalised text per entry
 * @param {(s: string) => string} normalize
 * @returns {{anchors: Array<Array<{uuid: string, quote: string}>>, unmatched: Array<{item: number, quote: string}>}}
 */
export function resolveQuotes(items, index, normalize) {
  /** @type {Array<Array<{uuid: string, quote: string}>>} */
  const anchors = [];
  /** @type {Array<{item: number, quote: string}>} */
  const unmatched = [];
  items.forEach((it, i) => {
    /** @type {Array<{uuid: string, quote: string}>} */
    const list = [];
    const seen = new Set();
    for (const q of it.quotes) {
      const nq = normalize(q);
      const hits = index.filter((e) => e.norm.includes(nq));
      if (!hits.length) unmatched.push({ item: i, quote: q });
      for (const h of hits) {
        const key = `${h.uuid}\0${q}`;
        if (!seen.has(key)) {
          seen.add(key);
          list.push({ uuid: h.uuid, quote: q });
        }
      }
    }
    anchors.push(list);
  });
  return { anchors, unmatched };
}

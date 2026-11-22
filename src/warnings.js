/**
 * Suppress exactly the node:sqlite ExperimentalWarning; all others still show.
 * Must run before node:sqlite is first imported.
 */
export function suppressSqliteWarning() {
  const orig = process.emitWarning;
  /** @type {any} */
  const patched = function (/** @type {any} */ warning, /** @type {any[]} */ ...args) {
    const msg = typeof warning === 'string' ? warning : warning && warning.message;
    const type = typeof args[0] === 'string' ? args[0] : args[0] && args[0].type;
    const name = type || (warning && warning.name);
    if (name === 'ExperimentalWarning' && typeof msg === 'string' && /SQLite/i.test(msg)) return;
    return orig.call(process, warning, ...args);
  };
  process.emitWarning = patched;
}

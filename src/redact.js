/**
 * Best-effort secret redaction. Patterns are heuristic and will miss things.
 */

const SECRET_NAME = '[A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)[A-Za-z0-9_.-]*';

/** @type {Array<[RegExp, string | ((...m: string[]) => string)]>} */
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED:private-key]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED:jwt]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED:api-key]'],
  [/\b(?:gh[pos]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED:github-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  [
    new RegExp(`(\\b${SECRET_NAME}["']?\\s*[=:]\\s*)("[^"\\n]*"|'[^'\\n]*'|[^\\s"',;]+)`, 'gi'),
    (_m, prefix, value) => (value.startsWith('[REDACTED') ? prefix + value : `${prefix}[REDACTED:secret]`),
  ],
];

/** @param {string} text */
export function redactText(text) {
  let out = text;
  for (const [re, rep] of RULES) {
    out = out.replace(re, /** @type {any} */ (rep));
  }
  return out;
}

/** Placeholder for the result of reading an env file. */
export const ENV_FILE_REDACTION = '[REDACTED:env-file]';

/**
 * Does this tool call read a .env / .env.* file?
 * @param {string} name tool name
 * @param {any} input tool input
 */
export function readsEnvFile(name, input) {
  if (!input || typeof input !== 'object') return false;
  const envName = /(^|[\\/])\.env(\.[^\\/\s]+)?$/;
  if (name === 'Read' && typeof input.file_path === 'string') return envName.test(input.file_path);
  if (name === 'Bash' && typeof input.command === 'string') {
    return /\b(?:cat|less|more|head|tail|bat|nl|tac|source|grep|sed|awk)\b[^|;&\n]*(?:^|[\s/\\'"])\.env(?:\.[\w.-]+)?(?=$|[\s'";|&])/.test(
      input.command,
    );
  }
  return false;
}

import { ENV_FILE_REDACTION, readsEnvFile, redactText } from './redact.js';

/**
 * @typedef {import('./parse.js').Entry} Entry
 * @typedef {{kind: 'message', uuid: string, role: string, timestamp: string, full: string, text: string}
 *   | {kind: 'boundary', line: string}} Block
 */

const TOOL_INPUT_MAX = 300;
const HEAD_LINES = 20;
const TAIL_LINES = 10;

/** @param {string} s */
function truncateInput(s) {
  return s.length > TOOL_INPUT_MAX ? `${s.slice(0, TOOL_INPUT_MAX)}…` : s;
}

/**
 * Keep the first 20 and last 10 lines of long output.
 * @param {string} text
 */
export function truncateLines(text) {
  const lines = text.split('\n');
  if (lines.length <= HEAD_LINES + TAIL_LINES) return text;
  const omitted = lines.length - HEAD_LINES - TAIL_LINES;
  return [...lines.slice(0, HEAD_LINES), `[… ${omitted} lines omitted …]`, ...lines.slice(-TAIL_LINES)].join('\n');
}

/** @param {any} content */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Clean one transcript's entries into blocks (redacted). `full` is the untruncated text used
 * for quote matching; `text` is the display text (long tool results truncated).
 * @param {Entry[]} entries
 * @returns {Block[]}
 */
export function cleanEntries(entries) {
  /** @type {Map<string, {name: string, input: any}>} */
  const tools = new Map();
  /** @type {Block[]} */
  const blocks = [];
  for (const e of entries) {
    if (e.type === 'system') {
      if (e.subtype === 'compact_boundary') {
        const m = e.compactMetadata || {};
        blocks.push({
          kind: 'boundary',
          line: `# compact boundary ${e.timestamp ?? ''} ${m.trigger ?? ''} ${m.preTokens ?? '?'}→${m.postTokens ?? '?'}`,
        });
      }
      continue;
    }
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    const content = e.message?.content;
    /** @type {Array<{full: string, text: string}>} */
    const parts = [];
    /** @param {string} t */
    const plain = (t) => {
      const r = redactText(t);
      parts.push({ full: r, text: r });
    };
    if (typeof content === 'string') {
      plain(content);
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string') {
          plain(b.text);
        } else if (b.type === 'tool_use') {
          tools.set(b.id, { name: b.name, input: b.input });
          plain(`tool: ${b.name} ${truncateInput(JSON.stringify(b.input ?? {}))}`);
        } else if (b.type === 'tool_result') {
          const call = tools.get(b.tool_use_id);
          const raw = resultText(b.content);
          if (call && readsEnvFile(call.name, call.input)) {
            plain(`result: ${ENV_FILE_REDACTION}`);
          } else if (raw.trim()) {
            const full = redactText(raw);
            parts.push({ full: `result: ${full}`, text: `result: ${truncateLines(full)}` });
          }
        }
        // thinking, images, tool_reference and anything else: dropped
      }
    }
    const full = parts.map((p) => p.full).join('\n').trim();
    const text = parts.map((p) => p.text).join('\n').trim();
    if (!full) continue;
    const role = e.isCompactSummary ? 'compact-summary' : e.type;
    blocks.push({ kind: 'message', uuid: e.uuid, role, timestamp: e.timestamp ?? '', full, text });
  }
  return blocks;
}

/**
 * Content lines starting with `#` get a leading space so that only structural lines
 * (`## <uuid> <role> <timestamp>`, `# compact boundary …`, `# subagent …`) start with `#`.
 * @param {string} text
 */
function escapeHeadings(text) {
  return text.replace(/^#/gm, ' #');
}

/** @param {Block[]} blocks */
export function renderBlocks(blocks) {
  return blocks
    .map((b) =>
      b.kind === 'boundary' ? b.line : `## ${b.uuid} ${b.role} ${b.timestamp}\n\n${escapeHeadings(b.text)}`,
    )
    .join('\n\n');
}

/**
 * Render the full transcript.md: main blocks, then each subagent under its heading.
 * @param {Block[]} main
 * @param {Array<{id: string, description: string | null, blocks: Block[]}>} subagents
 */
export function renderTranscript(main, subagents) {
  const sections = [renderBlocks(main)];
  for (const s of subagents) {
    const desc = s.description?.replace(/\s+/g, ' ').trim();
    const head = `# subagent ${s.id}${desc ? `: ${desc}` : ''}`;
    sections.push(`${head}\n\n${renderBlocks(s.blocks)}`);
  }
  return `${sections.join('\n\n')}\n`;
}

/** @param {string} s */
export function normalizeText(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

import { ENV_FILE_REDACTION, readsEnvFile, redactText } from './redact.js';

/**
 * @typedef {import('./parse.js').Entry} Entry
 * @typedef {{kind: 'message', uuid: string, role: string, timestamp: string, text: string}
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
 * Clean one transcript's entries into blocks (redacted, truncated).
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
    /** @type {string[]} */
    const parts = [];
    if (typeof content === 'string') {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string') {
          parts.push(b.text);
        } else if (b.type === 'tool_use') {
          tools.set(b.id, { name: b.name, input: b.input });
          parts.push(`tool: ${b.name} ${truncateInput(JSON.stringify(b.input ?? {}))}`);
        } else if (b.type === 'tool_result') {
          const call = tools.get(b.tool_use_id);
          const raw = resultText(b.content);
          if (call && readsEnvFile(call.name, call.input)) {
            parts.push(`result: ${ENV_FILE_REDACTION}`);
          } else if (raw.trim()) {
            parts.push(`result: ${truncateLines(raw)}`);
          }
        }
        // thinking, images, tool_reference and anything else: dropped
      }
    }
    const text = redactText(parts.join('\n')).trim();
    if (!text) continue;
    const role = e.isCompactSummary ? 'compact-summary' : e.type;
    blocks.push({ kind: 'message', uuid: e.uuid, role, timestamp: e.timestamp ?? '', text });
  }
  return blocks;
}

/** @param {Block[]} blocks */
export function renderBlocks(blocks) {
  return blocks
    .map((b) => (b.kind === 'boundary' ? b.line : `## ${b.uuid} ${b.role} ${b.timestamp}\n\n${b.text}`))
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
    const head = `# subagent ${s.id}${s.description ? `: ${s.description}` : ''}`;
    sections.push(`${head}\n\n${renderBlocks(s.blocks)}`);
  }
  return `${sections.join('\n\n')}\n`;
}

/** @param {string} s */
export function normalizeText(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

import { createPatch } from 'diff';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Session } from '../session.js';
import { setFileSnapshot } from '../session.js';
import type { AnthropicMessage, ContentBlock } from './cache.js';
import { estimateTokens } from '../pricing.js';

// ── Debug logging ────────────────────────────────────────────────────────────

const DEBUG_DIR = join(homedir(), '.trimr');
const DEBUG_LOG = join(DEBUG_DIR, 'debug-differ.log');

function debugLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
    appendFileSync(DEBUG_LOG, line);
  } catch { /* */ }
}

// ── File block detection ──────────────────────────────────────────────────────

interface DetectedFile {
  filename: string;
  content: string;
  /** The exact original fenced block string including backticks */
  originalBlock: string;
}

/**
 * Extracts fenced code blocks from text.
 * Supports:
 *   ```src/main.ts          <- filename in header
 *   ```typescript src/main.ts  <- lang + filename
 *   ```typescript            <- language-only (used as key)
 */
function detectFileBlocks(text: string): DetectedFile[] {
  const files: DetectedFile[] = [];
  // Non-greedy match; allows nested content
  const fenceRegex = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = fenceRegex.exec(text)) !== null) {
    const header = match[1].trim();
    const content = match[2];
    const originalBlock = match[0];

    // Try to find a filename-looking token in the header
    let filename = '';
    const parts = header.split(/\s+/);
    for (const part of parts) {
      if (part.includes('/') || (part.includes('.') && part.length > 2)) {
        filename = part;
        break;
      }
    }

    if (!filename) {
      filename = header ? `__block_${header}_${idx}` : `__block_${idx}`;
    }

    files.push({ filename, content, originalBlock });
    idx++;
  }

  return files;
}

// ── Tool use map builder ─────────────────────────────────────────────────────

/**
 * Scans all messages for assistant tool_use blocks that read files.
 * Builds a map of tool_use_id -> file_path so we can identify which
 * tool_result blocks contain file contents.
 */
function buildToolUseMap(messages: AnthropicMessage[]): Map<string, string> {
  const map = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type !== 'tool_use') continue;

      const id = block.id as string | undefined;
      const name = block.name as string | undefined;
      const input = block.input as Record<string, unknown> | undefined;
      if (!id || !input) continue;

      // Match any tool that reads files — Read, read_file, str_replace_editor, etc.
      const filePath =
        (input.file_path as string | undefined) ??
        (input.path as string | undefined) ??
        (input.filename as string | undefined);

      if (filePath) {
        map.set(id, filePath);
        debugLog(`[toolmap] ${name}(${id.slice(0, 12)}) -> ${filePath}`);
      }
    }
  }

  debugLog(`[toolmap] built map with ${map.size} entries`);
  return map;
}

// ── Tool result text extraction ──────────────────────────────────────────────

/**
 * Extracts the text content from a tool_result block's content field.
 * tool_result.content can be: string | ContentBlock[] | undefined
 */
function extractToolResultText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((b: { type?: string; text?: string }) => b.type === 'text' && typeof b.text === 'string')
      .map((b: { text: string }) => b.text);
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}

// ── Tool result processor ────────────────────────────────────────────────────

/**
 * Processes a tool_result content block. If the corresponding tool_use was
 * a file read, diffs or omits the content against the session snapshot.
 */
function processToolResult(
  block: ContentBlock,
  toolUseMap: Map<string, string>,
  session: Session,
): { block: ContentBlock; tokensSaved: number; diffed: boolean } {
  const toolUseId = block.tool_use_id as string | undefined;
  if (!toolUseId) {
    debugLog(`[tool_result] no tool_use_id on block`);
    return { block, tokensSaved: 0, diffed: false };
  }

  const filePath = toolUseMap.get(toolUseId);
  if (!filePath) {
    debugLog(`[tool_result] ${toolUseId.slice(0, 12)} not in tool map (not a file read)`);
    return { block, tokensSaved: 0, diffed: false };
  }

  const content = extractToolResultText(block.content);
  if (!content) {
    debugLog(`[tool_result] ${filePath}: could not extract text content`);
    return { block, tokensSaved: 0, diffed: false };
  }

  const contentTokens = estimateTokens(content);
  if (contentTokens < 50) {
    debugLog(`[tool_result] ${filePath}: too small (${contentTokens} tokens), skipping`);
    // Still store snapshot for future comparisons
    setFileSnapshot(session, filePath, { content, timestamp: Date.now() });
    return { block, tokensSaved: 0, diffed: false };
  }

  const snap = session.fileSnapshots.get(filePath);

  if (snap && snap.content === content) {
    // Identical — replace with compact reference
    const ref = `[TokenDiff: "${filePath}" unchanged — omitted (${contentTokens} tokens saved)]`;
    const saved = contentTokens - estimateTokens(ref);
    debugLog(`[tool_result] ${filePath}: UNCHANGED, saving ~${saved} tokens`);

    setFileSnapshot(session, filePath, { content, timestamp: Date.now() });

    // Replace the content inside the tool_result block
    if (typeof block.content === 'string') {
      return { block: { ...block, content: ref }, tokensSaved: Math.max(0, saved), diffed: true };
    } else {
      return { block: { ...block, content: ref }, tokensSaved: Math.max(0, saved), diffed: true };
    }
  } else if (snap) {
    // Changed — build diff if it's shorter
    const patch = createPatch(filePath, snap.content, content, '', '', { context: 3 });
    const diffLines = patch.split('\n').slice(2).join('\n');
    const diffRef = `[TokenDiff: "${filePath}" — diff from previous version]\n` +
      '```diff\n' + diffLines + '\n```';

    const originalTokens = contentTokens;
    const diffTokens = estimateTokens(diffRef);

    debugLog(`[tool_result] ${filePath}: CHANGED, original=${originalTokens} diff=${diffTokens}`);

    setFileSnapshot(session, filePath, { content, timestamp: Date.now() });

    if (diffTokens < originalTokens) {
      const saved = originalTokens - diffTokens;
      debugLog(`[tool_result] ${filePath}: using diff, saving ~${saved} tokens`);
      if (typeof block.content === 'string') {
        return { block: { ...block, content: diffRef }, tokensSaved: saved, diffed: true };
      } else {
        return { block: { ...block, content: diffRef }, tokensSaved: saved, diffed: true };
      }
    }
    debugLog(`[tool_result] ${filePath}: diff not shorter, keeping original`);
    return { block, tokensSaved: 0, diffed: false };
  }

  // First time seeing this file — just store snapshot
  debugLog(`[tool_result] ${filePath}: first seen, storing snapshot (${contentTokens} tokens)`);
  setFileSnapshot(session, filePath, { content, timestamp: Date.now() });
  return { block, tokensSaved: 0, diffed: false };
}

// ── Diff builder ──────────────────────────────────────────────────────────────

function buildDiffBlock(filename: string, oldContent: string, newContent: string): string {
  const patch = createPatch(filename, oldContent, newContent, '', '', { context: 3 });
  // createPatch outputs:
  //   Index: filename\n===...===\n--- ...\n+++ ...\n@@...
  // Strip the first two decorator lines to save tokens
  const lines = patch.split('\n');
  const diffBody = lines.slice(2).join('\n');

  return (
    `[TokenDiff: "${filename}" — diff from previous version]\n` +
    '```diff\n' +
    diffBody +
    '\n```'
  );
}

// ── Content processor ─────────────────────────────────────────────────────────

function processText(
  text: string,
  session: Session,
): { processed: string; tokensSaved: number; diffCount: number } {
  const files = detectFileBlocks(text);
  let processed = text;
  let tokensSaved = 0;
  let diffCount = 0;

  debugLog(`[processText] found ${files.length} fenced code blocks`);
  for (const file of files) {
    debugLog(`[processText] block: "${file.filename}" (${estimateTokens(file.content)} tokens)`);
  }

  for (const file of files) {
    const snap = session.fileSnapshots.get(file.filename);

    if (snap && snap.content === file.content) {
      // Identical — omit entirely
      const ref = `[TokenDiff: "${file.filename}" unchanged — omitted]`;
      processed = processed.replace(file.originalBlock, ref);
      tokensSaved += estimateTokens(file.content);
      diffCount++;
    } else if (snap) {
      // Changed — replace with diff if it's actually shorter
      const diffBlock = buildDiffBlock(file.filename, snap.content, file.content);
      const originalTokens = estimateTokens(file.originalBlock);
      const diffTokens = estimateTokens(diffBlock);

      if (diffTokens < originalTokens) {
        processed = processed.replace(file.originalBlock, diffBlock);
        tokensSaved += originalTokens - diffTokens;
        diffCount++;
      }
    }

    // Always refresh snapshot
    setFileSnapshot(session, file.filename, {
      content: file.content,
      timestamp: Date.now(),
    });
  }

  return { processed, tokensSaved, diffCount };
}

// ── Assistant history compression ─────────────────────────────────────────────

/**
 * Strips code blocks from old assistant messages in the conversation history.
 *
 * In multi-turn coding sessions the model echoes entire files back. Those
 * full files then get resent verbatim in every subsequent request's history,
 * costing thousands of tokens per turn. We replace them with a one-line
 * reference marker — the model has already seen the content.
 *
 * Only touches messages that are NOT the last assistant turn (the last
 * assistant message must stay intact for the model to have proper context).
 */
function compressAssistantHistory(
  messages: AnthropicMessage[],
): { messages: AnthropicMessage[]; tokensSaved: number } {
  let tokensSaved = 0;

  // Find index of last assistant message — preserve it verbatim
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { lastAssistantIdx = i; break; }
  }

  const processed = messages.map((msg, idx) => {
    if (msg.role !== 'assistant' || idx === lastAssistantIdx) return msg;

    const compress = (text: string): string => {
      return text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_match, header, content) => {
        const saved = estimateTokens(content);
        if (saved < 50) return _match; // not worth replacing tiny blocks
        tokensSaved += saved;
        const label = header.trim() || 'code';
        return `[TokenDiff: ${label} — assistant output omitted from history, ${saved} tokens]`;
      });
    };

    if (typeof msg.content === 'string') {
      return { ...msg, content: compress(msg.content) };
    }

    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map((block) =>
          block.type === 'text' && typeof block.text === 'string'
            ? { ...block, text: compress(block.text) }
            : block,
        ),
      };
    }

    return msg;
  });

  return { messages: processed, tokensSaved };
}

// ── Main export ───────────────────────────────────────────────────────────────

export function applyFileDiffing(
  messages: AnthropicMessage[],
  session: Session,
): { messages: AnthropicMessage[]; tokensSaved: number; diffCount: number } {
  let totalSaved = 0;
  let totalDiffs = 0;

  // Log what we're working with
  debugLog(`\n====== applyFileDiffing called ======`);
  debugLog(`messages count: ${messages.length}, snapshots in session: ${session.fileSnapshots.size}`);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const contentDesc = typeof msg.content === 'string'
      ? `string(${msg.content.length} chars)`
      : Array.isArray(msg.content)
        ? `blocks[${msg.content.map(b => b.type).join(', ')}]`
        : 'unknown';
    debugLog(`  msg[${i}] role=${msg.role} content=${contentDesc}`);
  }

  // Stage A — compress old assistant turns first (removes echoed files from history)
  const { messages: historyCompressed, tokensSaved: historySaved } =
    compressAssistantHistory(messages);
  totalSaved += historySaved;
  if (historySaved > 0) {
    debugLog(`[stage-A] assistant history compression saved ~${historySaved} tokens`);
  }

  // Stage B — build tool_use map for file path resolution
  const toolUseMap = buildToolUseMap(historyCompressed);

  // Stage C — diff/omit user-sent file blocks (text fences + tool_result blocks)
  const processed = historyCompressed.map((msg) => {
    if (msg.role !== 'user') return msg;

    if (typeof msg.content === 'string') {
      const { processed, tokensSaved, diffCount } = processText(msg.content, session);
      totalSaved += tokensSaved;
      totalDiffs += diffCount;
      return { ...msg, content: processed };
    }

    if (Array.isArray(msg.content)) {
      const newBlocks: ContentBlock[] = msg.content.map((block) => {
        // Existing: process fenced code blocks in text content
        if (block.type === 'text' && typeof block.text === 'string') {
          const { processed, tokensSaved, diffCount } = processText(block.text, session);
          totalSaved += tokensSaved;
          totalDiffs += diffCount;
          return { ...block, text: processed };
        }

        // NEW: process tool_result blocks (file contents from Read tool etc.)
        if (block.type === 'tool_result') {
          const { block: newBlock, tokensSaved, diffed } = processToolResult(block, toolUseMap, session);
          totalSaved += tokensSaved;
          if (diffed) totalDiffs++;
          return newBlock;
        }

        return block;
      });
      return { ...msg, content: newBlocks };
    }

    return msg;
  });

  debugLog(`[result] totalSaved=${totalSaved} totalDiffs=${totalDiffs}`);
  return { messages: processed, tokensSaved: totalSaved, diffCount: totalDiffs };
}

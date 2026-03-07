import { createPatch } from 'diff';
import type { Session } from '../session.js';
import type { AnthropicMessage, ContentBlock } from './cache.js';
import { estimateTokens } from '../pricing.js';

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
 *   ```src/main.ts          ← filename in header
 *   ```typescript src/main.ts  ← lang + filename
 *   ```typescript            ← language-only (used as key)
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
    session.fileSnapshots.set(file.filename, {
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

  // Stage A — compress old assistant turns first (removes echoed files from history)
  const { messages: historyCompressed, tokensSaved: historySaved } =
    compressAssistantHistory(messages);
  totalSaved += historySaved;

  // Stage B — diff/omit user-sent file blocks
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
        if (block.type === 'text' && typeof block.text === 'string') {
          const { processed, tokensSaved, diffCount } = processText(block.text, session);
          totalSaved += tokensSaved;
          totalDiffs += diffCount;
          return { ...block, text: processed };
        }
        return block;
      });
      return { ...msg, content: newBlocks };
    }

    return msg;
  });

  return { messages: processed, tokensSaved: totalSaved, diffCount: totalDiffs };
}

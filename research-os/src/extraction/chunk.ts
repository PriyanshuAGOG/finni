import { normalizeText } from '../lib/text';

export interface Chunk {
  index: number;
  text: string;
  tokenCount: number;
  headingPath: string | null;
  pageNumber: number | null;
  startOffset: number;
  endOffset: number;
  contentType: 'body' | 'abstract' | 'heading' | 'table' | 'reference';
}

export interface ChunkOptions {
  targetTokens?: number;
  overlapTokens?: number;
  pageOffsets?: Array<{ page: number; start: number; end: number }>;
}

/** Roughly four characters per token for English prose. */
const CHARS_PER_TOKEN = 4;

/**
 * Splits a document into retrievable chunks.
 *
 * Chunks are built from whole paragraphs and sentences so a retrieved
 * passage is readable on its own, and each one keeps the character
 * offsets and page number it came from. Those locators are what let a
 * citation point at an exact passage rather than at a whole document.
 */
export function chunkDocument(text: string, options: ChunkOptions = {}): Chunk[] {
  const targetTokens = options.targetTokens ?? 350;
  const overlapTokens = options.overlapTokens ?? 50;
  const targetChars = targetTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;

  const normalized = normalizeText(text);
  if (normalized.length === 0) return [];

  const blocks = splitIntoBlocks(normalized);
  const chunks: Chunk[] = [];

  let buffer: string[] = [];
  let bufferStart = 0;
  let bufferLength = 0;
  let headingPath: string | null = null;
  let index = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const chunkText = buffer.join('\n\n').trim();
    if (chunkText.length === 0) {
      buffer = [];
      bufferLength = 0;
      return;
    }
    const endOffset = bufferStart + chunkText.length;
    chunks.push({
      index: index++,
      text: chunkText,
      tokenCount: Math.ceil(chunkText.length / CHARS_PER_TOKEN),
      headingPath,
      pageNumber: pageForOffset(bufferStart, options.pageOffsets),
      startOffset: bufferStart,
      endOffset,
      contentType: classifyContent(chunkText, headingPath),
    });
    buffer = [];
    bufferLength = 0;
  };

  for (const block of blocks) {
    if (block.isHeading) {
      // A heading starts a new chunk so retrieved passages do not span
      // section boundaries, and it is recorded as the path for the
      // chunks that follow.
      flush();
      headingPath = headingPath && block.level > 1 ? `${headingPath} > ${block.text}` : block.text;
      bufferStart = block.start;
      continue;
    }

    if (bufferLength > 0 && bufferLength + block.text.length > targetChars) {
      const previousEnd = bufferStart + bufferLength;
      flush();

      // Carry the tail of the previous chunk forward so a statement that
      // straddles a boundary is still retrievable in one piece.
      const tail = overlapChars > 0 ? tailSentences(blocks, previousEnd, overlapChars) : '';
      if (tail) {
        buffer.push(tail);
        bufferLength = tail.length;
        bufferStart = Math.max(0, previousEnd - tail.length);
      } else {
        bufferStart = block.start;
      }
    }

    if (bufferLength === 0) bufferStart = block.start;

    // A single oversized paragraph is split on sentence boundaries.
    if (block.text.length > targetChars * 1.5) {
      for (const piece of splitLongBlock(block.text, targetChars)) {
        if (bufferLength > 0) flush();
        buffer.push(piece);
        bufferLength = piece.length;
        flush();
      }
      continue;
    }

    buffer.push(block.text);
    bufferLength += block.text.length + 2;
  }

  flush();
  return chunks;
}

interface Block {
  text: string;
  start: number;
  isHeading: boolean;
  level: number;
}

function splitIntoBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let offset = 0;

  for (const raw of text.split(/\n{2,}/)) {
    const start = text.indexOf(raw, offset);
    const resolvedStart = start >= 0 ? start : offset;
    offset = resolvedStart + raw.length;

    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    blocks.push({
      text: trimmed,
      start: resolvedStart,
      isHeading: isHeading(trimmed),
      level: headingLevel(trimmed),
    });
  }

  return blocks;
}

/** A short line with no terminal punctuation reads as a section heading. */
function isHeading(text: string): boolean {
  if (text.length > 120) return false;
  if (text.includes('\n')) return false;
  if (/[.!?;:]$/.test(text)) return false;
  const words = text.split(/\s+/).length;
  if (words > 14) return false;
  return (
    /^[A-Z0-9]/.test(text) &&
    (text === text.toUpperCase() ||
      /^\d+[.)]?\s/.test(text) ||
      /^(abstract|introduction|background|methods?|materials|results|discussion|conclusions?|references|limitations|funding|acknowledgements?)\b/i.test(
        text,
      ))
  );
}

function headingLevel(text: string): number {
  if (/^\d+\.\d+/.test(text)) return 2;
  return 1;
}

function classifyContent(text: string, headingPath: string | null): Chunk['contentType'] {
  const heading = (headingPath ?? '').toLowerCase();
  if (heading.includes('abstract')) return 'abstract';
  if (heading.includes('reference') || heading.includes('bibliograph')) return 'reference';
  // A high density of digits and separators is characteristic of a table.
  const digits = (text.match(/\d/g) ?? []).length;
  if (digits / Math.max(text.length, 1) > 0.25 && text.includes('\t')) return 'table';
  return 'body';
}

function splitLongBlock(text: string, targetChars: number): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const pieces: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current.length + sentence.length > targetChars && current.length > 0) {
      pieces.push(current.trim());
      current = '';
    }
    current += (current ? ' ' : '') + sentence;
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

function tailSentences(blocks: Block[], endOffset: number, overlapChars: number): string {
  const preceding = blocks.filter((b) => b.start < endOffset && !b.isHeading).slice(-2);
  if (preceding.length === 0) return '';
  const combined = preceding.map((b) => b.text).join(' ');
  const sentences = combined.split(/(?<=[.!?])\s+/);
  let tail = '';
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const candidate = `${sentences[i]} ${tail}`.trim();
    if (candidate.length > overlapChars) break;
    tail = candidate;
  }
  return tail;
}

function pageForOffset(
  offset: number,
  pageOffsets?: Array<{ page: number; start: number; end: number }>,
): number | null {
  if (!pageOffsets || pageOffsets.length === 0) return null;
  for (const page of pageOffsets) {
    if (offset >= page.start && offset < page.end) return page.page;
  }
  return pageOffsets[pageOffsets.length - 1].page;
}

/**
 * Human-readable locator for a chunk. This is what appears next to a
 * citation, so it has to mean something to a reader checking the source.
 */
export function chunkLocator(chunk: {
  pageNumber?: number | null;
  headingPath?: string | null;
  chunkIndex?: number | null;
  startOffset?: number | null;
}): string {
  const parts: string[] = [];
  if (chunk.pageNumber) parts.push(`p. ${chunk.pageNumber}`);
  if (chunk.headingPath) parts.push(chunk.headingPath);
  if (parts.length === 0 && chunk.chunkIndex != null) parts.push(`passage ${chunk.chunkIndex + 1}`);
  if (chunk.startOffset != null) parts.push(`offset ${chunk.startOffset}`);
  return parts.join(', ');
}

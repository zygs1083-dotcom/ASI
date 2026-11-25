const HARD_BREAK_RE = /[。！？!?；;\n]/;
const SOFT_BREAK_RE = /[，,、：:]/;

/**
 * Strips markdown formatting and inline code clutter so TTS reads naturally.
 */
export function sanitizeForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '（这里有一段代码，我已贴在对话面板里）')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SentenceChunkerOptions {
  /** Minimum character count before splitting on a hard punctuation mark (default 2). */
  minSentenceChars?: number;
  /** Threshold at which soft punctuation (commas) can also split long spoken sentences (default 44). */
  softBreakThreshold?: number;
  /** Maximum chunk length before forcing a whitespace/char split (default 140). */
  maxChunkChars?: number;
}

/**
 * Incremental Chinese/English sentence chunker for low-latency streaming TTS.
 * Starts speaking the first sentence while the LLM continues generating.
 */
export class SentenceStreamChunker {
  private buffer = '';
  private readonly minSentenceChars: number;
  private readonly softBreakThreshold: number;
  private readonly maxChunkChars: number;

  constructor(options: SentenceChunkerOptions = {}) {
    this.minSentenceChars = options.minSentenceChars ?? 2;
    this.softBreakThreshold = options.softBreakThreshold ?? 44;
    this.maxChunkChars = options.maxChunkChars ?? 140;
  }

  push(delta: string): string[] {
    if (!delta) return [];
    this.buffer += delta;
    const emitted: string[] = [];

    while (this.buffer.length > 0) {
      const cutIndex = this.findNextCutIndex();
      if (cutIndex === -1) break;
      const piece = this.buffer.slice(0, cutIndex).trim();
      this.buffer = this.buffer.slice(cutIndex).trimStart();
      if (piece) {
        emitted.push(piece);
      }
    }

    return emitted;
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest ? [rest] : [];
  }

  reset(): void {
    this.buffer = '';
  }

  private findNextCutIndex(): number {
    let inFence = false;

    for (let i = 0; i < this.buffer.length; i += 1) {
      // Hold back splitting inside fenced code blocks (``` ... ```) so sanitizeForSpeech
      // receives the complete code block and replaces it instead of reading raw code aloud.
      if (this.buffer.startsWith('```', i)) {
        if (!inFence) {
          inFence = true;
          i += 2;
          continue;
        }
        inFence = false;
        let end = i + 3;
        while (end < this.buffer.length && (this.buffer[end] === '\r' || this.buffer[end] === '\n')) {
          end += 1;
        }
        return end;
      }

      if (inFence) {
        continue;
      }

      const ch = this.buffer[i] ?? '';
      const next = this.buffer[i + 1] ?? '';
      const prev = i > 0 ? (this.buffer[i - 1] ?? '') : '';

      // Do not split inside decimal numbers, versions, filenames, ellipses, or abbreviations
      if (ch === '.') {
        if (prev === '.' || next === '.' || /\d/.test(prev) || /\d/.test(next) || /[A-Za-z]/.test(next)) {
          continue;
        }
        const beforeDot = this.buffer.slice(0, i);
        if (/(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|Jr|Sr|vs|etc|e\.g|i\.e)$/i.test(beforeDot)) {
          continue;
        }
      }

      // Only cut on English period when trailing whitespace has actually arrived (never mid-token on next === '')
      const isEnglishPeriod = ch === '.' && /\s/.test(next);
      const isHard = HARD_BREAK_RE.test(ch) || isEnglishPeriod;

      if (isHard && i + 1 >= this.minSentenceChars) {
        // Consume trailing closing quotes/brackets like `。”` or `！）`
        let end = i + 1;
        while (end < this.buffer.length && /[”’"')】》]/.test(this.buffer[end] ?? '')) {
          end += 1;
        }
        return end;
      }

      if (SOFT_BREAK_RE.test(ch) && i + 1 >= this.softBreakThreshold) {
        return i + 1;
      }
    }

    if (inFence) {
      // Safety cap only for extraordinarily long unclosed code blocks
      if (this.buffer.length >= this.maxChunkChars * 8) {
        return this.maxChunkChars * 8;
      }
      return -1;
    }

    if (this.buffer.length >= this.maxChunkChars) {
      const spaceIdx = this.buffer.lastIndexOf(' ', this.maxChunkChars);
      return spaceIdx > this.minSentenceChars ? spaceIdx : this.maxChunkChars;
    }

    return -1;
  }
}

/**
 * Turns a reply streamed in small text deltas into speakable pieces, as early as possible.
 *
 * - A piece ends at sentence punctuation followed by whitespace, or at a newline. A full stop at the
 *   very end of the buffer waits for the next delta, since it could still turn out to be "3.5".
 * - Common abbreviations ("e.g.", "Mr.") don't end a sentence.
 * - The first piece of a reply is kept short, so the voice can start on it quickly: it ends at a
 *   comma once it's long enough, or failing that at a word break near `maxFirstChars`. Rendering
 *   speech takes about 1 s per 90 characters, so a 90-character opening sentence would delay the
 *   first audio by a second, while the rest renders as the opening plays.
 * - Fenced code blocks are dropped: code is for the screen, not the ear.
 *
 * Pure and synchronous; one instance per reply (call `reset()` when a reply is interrupted).
 */
export interface ChunkerOptions {
  /** A comma at or after this index may end the first piece of a reply. */
  readonly quickStartComma: number;
  /** With no comma or sentence end by then, the first piece ends at a word break before this. */
  readonly maxFirstChars: number;
}

const DEFAULTS: ChunkerOptions = { quickStartComma: 20, maxFirstChars: 48 };
const ABBREVIATIONS = /(?:\b(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|St|approx)\.)$/i;
const FENCE = "```";

export class SentenceChunker {
  private buffer = "";
  private inCode = false;
  private emitted = 0;
  private readonly options: ChunkerOptions;

  constructor(options: Partial<ChunkerOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Add streamed text; returns the pieces that are now complete. */
  push(delta: string): string[] {
    this.buffer += delta;
    this.dropCode();
    const out: string[] = [];
    let piece: string | null;
    while ((piece = this.next()) !== null) {
      if (piece) out.push(piece);
    }
    return out;
  }

  /** The reply has finished: return whatever is left. */
  flush(): string[] {
    this.dropCode(true);
    const rest = this.buffer.trim();
    this.buffer = "";
    if (!rest) return [];
    this.emitted++;
    return [rest];
  }

  /** Forget everything, e.g. after the reply was interrupted. */
  reset(): void {
    this.buffer = "";
    this.inCode = false;
    this.emitted = 0;
  }

  private next(): string | null {
    const end = this.findEnd();
    if (end === -1) return null;
    const piece = this.buffer.slice(0, end).trim();
    this.buffer = this.buffer.slice(end).replace(/^\s+/, "");
    if (piece) this.emitted++;
    return piece;
  }

  /** Index just past the end of the next complete piece, or -1. */
  private findEnd(): number {
    const text = this.buffer;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\n") return i + 1;
      if (ch === "," && this.emitted === 0 && i >= this.options.quickStartComma && /\s/.test(text[i + 1] ?? "")) {
        return i + 1;
      }
      if (ch === "." || ch === "!" || ch === "?") {
        const after = text[i + 1];
        if (after === undefined) return -1; // could be "3.5": wait for more text
        if (!/\s/.test(after)) continue;
        if (ch === "." && ABBREVIATIONS.test(text.slice(0, i + 1))) continue;
        return i + 1;
      }
    }
    if (this.emitted === 0 && text.length > this.options.maxFirstChars) {
      const cut = text.lastIndexOf(" ", this.options.maxFirstChars);
      if (cut >= this.options.quickStartComma) return cut;
    }
    return -1;
  }

  /** Remove fenced code blocks, including one still open at the end of the buffer. */
  private dropCode(final = false): void {
    let out = "";
    let rest = this.buffer;
    while (rest) {
      const at = rest.indexOf(FENCE);
      if (at === -1) {
        // Hold back a trailing "`" or "``": it may be the start of a fence split across deltas.
        const hold = final ? "" : (rest.match(/`{1,2}$/)?.[0] ?? "");
        if (!this.inCode) out += rest.slice(0, rest.length - hold.length);
        this.buffer = out + hold;
        return;
      }
      if (!this.inCode) out += rest.slice(0, at);
      this.inCode = !this.inCode;
      rest = rest.slice(at + FENCE.length);
    }
    this.buffer = out;
  }
}

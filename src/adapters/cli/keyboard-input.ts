import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { InputEvent, SpeechInput } from "../../application/ports.js";

/** Typed prompts as utterances: one line, one utterance. Ends at EOF (Ctrl+D or end of a pipe). */
export class KeyboardInput implements SpeechInput {
  constructor(private readonly stdin: Readable = process.stdin) {}

  async *events(signal: AbortSignal): AsyncIterable<InputEvent> {
    const rl = createInterface({ input: this.stdin, terminal: false });
    const onAbort = () => rl.close();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const line of rl) {
        const text = line.trim();
        if (text) yield { kind: "utterance", text, speechMs: 0, sttMs: 0 };
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      rl.close();
    }
  }
}

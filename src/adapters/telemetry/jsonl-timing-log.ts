import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TimingSink, TurnTimings } from "../../application/ports.js";

/** One JSON line per turn. Logging must never break a conversation, so failures are swallowed. */
export class JsonlTimingLog implements TimingSink {
  constructor(private readonly path: string) {}

  record(timings: TurnTimings): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.path, `${JSON.stringify(timings)}\n`, { mode: 0o600 });
    } catch {
      // a timing line is not worth a crash
    }
  }
}

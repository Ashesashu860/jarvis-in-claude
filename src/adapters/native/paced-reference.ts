/**
 * Feeds the echo canceller what the speaker is playing, at the pace it plays.
 *
 * The voice queues whole sentences on the speaker well before they sound; the canceller needs the
 * far-end audio "as it is played, in played order". So each rendered piece is scheduled at its
 * playhead start time and pushed in small chunks as the clock reaches them. A hush clears it.
 */
import type { Clock } from "../../application/ports.js";

export interface ReferenceTarget {
  push(samples: Float32Array): void;
}

interface Segment { readonly samples: Float32Array; readonly rate: number; readonly startAt: number; sent: number }

export class PacedReference {
  private readonly segments: Segment[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  /** `leadMs`: how far ahead of the clock to push, so the reference never lags the echo. */
  constructor(
    private readonly target: ReferenceTarget,
    private readonly clock: Clock,
    private readonly chunkMs = 20,
    private readonly leadMs = 20,
  ) {}

  schedule(samples: Float32Array, sampleRate: number, startAt: number): void {
    if (samples.length === 0) return;
    this.segments.push({ samples, rate: sampleRate, startAt, sent: 0 });
    this.timer ??= setInterval(() => { this.tick(); }, this.chunkMs);
  }

  clear(): void {
    this.segments.length = 0;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Push everything now due. Exposed for tests; the interval calls it. */
  tick(): void {
    const now = this.clock.now() + this.leadMs;
    for (let seg = this.segments[0]; seg; seg = this.segments[0]) {
      if (now < seg.startAt) break;
      const due = Math.min(seg.samples.length, Math.ceil(((now - seg.startAt) / 1000) * seg.rate));
      if (due > seg.sent) {
        this.target.push(seg.samples.subarray(seg.sent, due));
        seg.sent = due;
      }
      if (seg.sent < seg.samples.length) break;
      this.segments.shift();
    }
    if (this.segments.length === 0) this.clear();
  }
}

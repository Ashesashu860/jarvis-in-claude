/**
 * SpeechOutput on the native engine: cleans each piece for speech, renders it with the Synthesizer
 * and queues it on the AudioSink. Rendering the next piece starts as soon as the previous one is
 * queued, so it happens while that one plays and streamed sentences follow each other without gaps.
 *
 * Playback times come from the audio itself: the sink plays continuously, so a piece starts when
 * everything queued before it has played (`playhead`). `firstAudio` and `done` are scheduled from
 * that, and a hush cancels them along with everything queued.
 */
import { AsyncQueue } from "../../application/async-queue.js";
import type { Clock, PlaybackEvent, SpeechOutput } from "../../application/ports.js";
import { cleanForSpeech } from "../../domain/speech-cleaner.js";
import type { TurnId } from "../../domain/turn-state.js";
import type { AudioSink, Synthesizer } from "./audio-ports.js";

type Item =
  | { kind: "piece"; gen: number; turnId: TurnId | null; text: string }
  | { kind: "end"; gen: number; turnId: TurnId };

export interface NativeVoiceOptions {
  readonly synth: Synthesizer;
  readonly sink: AudioSink;
  readonly clock: Clock;
  /** Everything played goes here too, with the clock time it starts playing: the echo canceller's reference. */
  readonly onAudio?: (samples: Float32Array, sampleRate: number, startAt: number) => void;
  /** Called when playback is cut off, so the echo reference stops too. */
  readonly onHush?: () => void;
  readonly onError?: (message: string) => void;
}

export class NativeVoiceOutput implements SpeechOutput {
  private readonly events = new AsyncQueue<PlaybackEvent>();
  private readonly queue: Item[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly started = new Set<TurnId>();
  private gen = 0;
  private playhead = 0; // clock time at which everything queued so far has played
  private working = false;
  private spoken: { text: string; until: number }[] = []; // recent pieces, for the echo filter

  constructor(private readonly opts: NativeVoiceOptions) {}

  say(text: string, turnId: TurnId): void { this.enqueue({ kind: "piece", gen: this.gen, turnId, text }); }
  endTurn(turnId: TurnId): void { this.enqueue({ kind: "end", gen: this.gen, turnId }); }
  announce(text: string): void { this.enqueue({ kind: "piece", gen: this.gen, turnId: null, text }); }

  hush(): void {
    this.gen++;
    this.queue.length = 0;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.started.clear();
    this.opts.sink.stop();
    this.playhead = this.opts.clock.now();
    this.opts.onHush?.();
  }

  /** What Jarvis has said, playing now or finished within the last `windowMs`. */
  recentSpeech(windowMs = 4000): string {
    const since = this.opts.clock.now() - windowMs;
    this.spoken = this.spoken.filter((p) => p.until >= since);
    return this.spoken.map((p) => p.text).join(" ");
  }

  /** Is anything playing or about to? (Speech heard now may be the user talking over Jarvis.) */
  isSpeaking(): boolean {
    return this.working || this.queue.length > 0 || this.opts.clock.now() < this.playhead;
  }

  /** Render once and open the sound device now, so the first reply doesn't pay for either. */
  async prepare(): Promise<void> {
    await this.opts.synth.render("Ready.");
    await this.opts.sink.write(new Float32Array(Math.round(this.opts.synth.sampleRate * 0.05)));
  }

  async *playback(signal: AbortSignal): AsyncIterable<PlaybackEvent> {
    signal.addEventListener("abort", () => this.events.close(), { once: true });
    yield* this.events;
  }

  // ------------------------------------------------------------------ internals
  private enqueue(item: Item): void {
    this.queue.push(item);
    if (!this.working) void this.work();
  }

  private async work(): Promise<void> {
    this.working = true;
    try {
      for (let item = this.queue.shift(); item; item = this.queue.shift()) {
        if (item.gen !== this.gen) continue;
        if (item.kind === "end") this.scheduleAt(this.playhead, () => this.emit({ kind: "done", turnId: item.turnId }));
        else await this.play(item);
      }
    } finally {
      this.working = false;
    }
  }

  private async play(item: Extract<Item, { kind: "piece" }>): Promise<void> {
    const text = cleanForSpeech(item.text);
    if (!text) return;
    let samples: Float32Array;
    try {
      samples = await this.opts.synth.render(text);
    } catch (err) {
      this.opts.onError?.(`The voice couldn't say that: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (item.gen !== this.gen || samples.length === 0) return; // hushed while rendering
    const { clock, sink, synth } = this.opts;
    const startAt = Math.max(clock.now(), this.playhead);
    this.playhead = startAt + (samples.length / synth.sampleRate) * 1000;
    this.spoken.push({ text, until: this.playhead });
    await sink.write(samples);
    if (item.gen !== this.gen) return; // hushed while queuing
    this.opts.onAudio?.(samples, synth.sampleRate, startAt);
    const turnId = item.turnId;
    if (turnId && !this.started.has(turnId)) {
      this.started.add(turnId);
      this.scheduleAt(startAt, () => this.emit({ kind: "firstAudio", turnId }));
    }
  }

  private scheduleAt(at: number, fn: () => void): void {
    const gen = this.gen;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (gen === this.gen) fn();
    }, Math.max(0, at - this.opts.clock.now()));
    this.timers.add(t);
  }

  private emit(ev: { kind: "firstAudio" | "done"; turnId: TurnId }): void {
    if (ev.kind === "done") this.started.delete(ev.turnId);
    this.events.push({ ...ev, at: this.opts.clock.now() });
  }
}

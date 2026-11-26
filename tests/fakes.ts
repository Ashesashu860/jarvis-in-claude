/** Test doubles for every port. Fakes, not mocks: each behaves like a small real implementation. */
import { AsyncQueue } from "../src/application/async-queue.js";
import type {
  AgentBrain, AgentControl, AgentEvent, Clock, InputEvent, PlaybackEvent, SpeechInput, SpeechOutput, TimingSink, TurnTimings,
} from "../src/application/ports.js";
import type { ModelChoice } from "../src/domain/intents.js";

export class FakeInput implements SpeechInput {
  readonly queue = new AsyncQueue<InputEvent>();
  say(text: string): void { this.queue.push({ kind: "utterance", text, speechMs: 1000, sttMs: 500 }); }
  bargeIn(): void { this.queue.push({ kind: "bargeIn", at: 0 }); }
  close(): void { this.queue.close(); }
  async *events(signal: AbortSignal): AsyncIterable<InputEvent> {
    signal.addEventListener("abort", () => this.queue.close(), { once: true });
    yield* this.queue;
  }
}

export class FakeOutput implements SpeechOutput {
  readonly spoken: string[] = [];
  readonly announced: string[] = [];
  hushes = 0;
  private readonly events = new AsyncQueue<PlaybackEvent>();
  private started = new Set<string>();
  say(text: string, turnId: string): void {
    if (!this.started.has(turnId)) { this.started.add(turnId); this.events.push({ kind: "firstAudio", turnId, at: 0 }); }
    this.spoken.push(text);
  }
  endTurn(turnId: string): void { this.events.push({ kind: "done", turnId, at: 0 }); }
  announce(text: string): void { this.announced.push(text); }
  hush(): void { this.hushes++; }
  async *playback(signal: AbortSignal): AsyncIterable<PlaybackEvent> {
    signal.addEventListener("abort", () => this.events.close(), { once: true });
    yield* this.events;
  }
}

/** Replies with a script per prompt; a turn can be held open to test interrupts. */
export class FakeBrain implements AgentBrain, AgentControl {
  readonly prompts: string[] = [];
  readonly controls: string[] = [];
  interrupts = 0;
  private live: AsyncQueue<AgentEvent> | null = null;
  constructor(private readonly script: (prompt: string) => AgentEvent[] | "hold") {}

  async *send(text: string, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.prompts.push(text);
    const reply = this.script(text);
    if (reply === "hold") {
      const q = new AsyncQueue<AgentEvent>();
      this.live = q;
      signal.addEventListener("abort", () => q.close(), { once: true });
      q.push({ kind: "text", delta: "One. Two. " });
      yield* q;
      return;
    }
    for (const ev of reply) yield ev;
  }
  /** Deltas that arrive late, after an interrupt was requested. */
  lateDelta(delta: string): void { this.live?.push({ kind: "text", delta }); }
  interrupt(): Promise<void> { this.interrupts++; return Promise.resolve(); }
  setModel(model: ModelChoice): Promise<void> { this.controls.push(`model:${model}`); return Promise.resolve(); }
  setPermissionMode(mode: "plan" | "default"): Promise<void> { this.controls.push(`mode:${mode}`); return Promise.resolve(); }
  newSession(): Promise<void> { this.controls.push("new"); return Promise.resolve(); }
  close(): Promise<void> { this.controls.push("close"); return Promise.resolve(); }
}

export class MemoryTimings implements TimingSink {
  readonly records: TurnTimings[] = [];
  record(t: TurnTimings): void { this.records.push(t); }
}

export function fakeClock(): Clock & { advance(ms: number): void } {
  let t = 0;
  return { now: () => t, wall: () => new Date(0), advance(ms) { t += ms; } };
}

export const reply = (...parts: string[]): AgentEvent[] => [
  ...parts.map((delta) => ({ kind: "text" as const, delta })),
  { kind: "done", sessionId: "s1" },
];

export async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Renders 10 ms of audio per character, after `delayMs`. */
export class FakeSynth {
  readonly sampleRate = 1000;
  readonly rendered: string[] = [];
  constructor(private readonly delayMs = 1) {}
  async render(text: string): Promise<Float32Array> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    this.rendered.push(text);
    return new Float32Array(text.length * 10);
  }
}

export class FakeSink {
  written = 0;
  stops = 0;
  write(samples: Float32Array): Promise<void> { this.written += samples.length; return Promise.resolve(); }
  stop(): void { this.stops++; }
}

/** A scripted microphone: tests push frames and speech/silence edges. */
export class FakeMic {
  readonly sampleRate = 1000;
  private frameL: ((s: Float32Array) => void)[] = [];
  private speechL: (() => void)[] = [];
  private silenceL: (() => void)[] = [];
  closed = false;
  onFrame(l: (s: Float32Array) => void): void { this.frameL.push(l); }
  onSpeech(l: () => void): void { this.speechL.push(l); }
  onSilence(l: () => void): void { this.silenceL.push(l); }
  close(): void { this.closed = true; }
  /** One utterance: `ms` of audio framed in 10 ms chunks between speech and silence. */
  utter(ms: number): void {
    for (const l of this.speechL) l();
    for (let i = 0; i < ms / 10; i++) for (const l of this.frameL) l(new Float32Array(10).fill(0.1));
    for (const l of this.silenceL) l();
  }
  frames(ms: number): void {
    for (let i = 0; i < ms / 10; i++) for (const l of this.frameL) l(new Float32Array(10));
  }
}

/** Returns the scripted transcripts in order. */
export class FakeTranscriber {
  readonly heard: number[] = [];
  constructor(private readonly texts: string[]) {}
  transcribe(samples: Float32Array): Promise<string> {
    this.heard.push(samples.length);
    return Promise.resolve(this.texts.shift() ?? "");
  }
}

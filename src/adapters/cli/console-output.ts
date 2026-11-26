import type { Writable } from "node:stream";
import { AsyncQueue } from "../../application/async-queue.js";
import type { Clock, PlaybackEvent, SpeechOutput } from "../../application/ports.js";
import type { TurnId } from "../../domain/turn-state.js";

/**
 * SpeechOutput that prints instead of speaking: the typed mode, and a stand-in until the
 * voice engine arrives (M2). A piece counts as "played" as soon as it is printed.
 */
export class ConsoleOutput implements SpeechOutput {
  private readonly events = new AsyncQueue<PlaybackEvent>();
  private speaking: TurnId | null = null;

  constructor(
    private readonly out: Writable = process.stdout,
    private readonly clock: Clock = { now: () => performance.now(), wall: () => new Date() },
    private readonly name = "Jarvis",
  ) {}

  say(text: string, turnId: TurnId): void {
    if (this.speaking !== turnId) {
      this.speaking = turnId;
      this.out.write(`${this.name}: `);
      this.events.push({ kind: "firstAudio", turnId, at: this.clock.now() });
    }
    this.out.write(`${text} `);
  }

  endTurn(turnId: TurnId): void {
    if (this.speaking === turnId) this.out.write("\n");
    this.speaking = null;
    this.events.push({ kind: "done", turnId, at: this.clock.now() });
  }

  announce(text: string): void {
    if (this.speaking) this.out.write("\n");
    this.speaking = null;
    this.out.write(`${this.name}: ${text}\n`);
  }

  hush(): void {
    if (this.speaking) this.out.write(" [cut off]\n");
    this.speaking = null;
  }

  async *playback(signal: AbortSignal): AsyncIterable<PlaybackEvent> {
    signal.addEventListener("abort", () => this.events.close(), { once: true });
    yield* this.events;
  }
}

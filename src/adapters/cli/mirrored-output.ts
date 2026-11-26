import type { PlaybackEvent, SpeechOutput } from "../../application/ports.js";
import type { TurnId } from "../../domain/turn-state.js";

/**
 * Composite SpeechOutput: everything goes to the primary (the voice) and to each mirror (the
 * console transcript), but only the primary's playback events count, since they say when the
 * words were actually heard.
 */
export class MirroredOutput implements SpeechOutput {
  constructor(private readonly primary: SpeechOutput, private readonly mirrors: readonly SpeechOutput[]) {}

  say(text: string, turnId: TurnId): void { for (const o of this.all()) o.say(text, turnId); }
  endTurn(turnId: TurnId): void { for (const o of this.all()) o.endTurn(turnId); }
  announce(text: string): void { for (const o of this.all()) o.announce(text); }
  hush(): void { for (const o of this.all()) o.hush(); }

  playback(signal: AbortSignal): AsyncIterable<PlaybackEvent> {
    return this.primary.playback(signal);
  }

  private all(): readonly SpeechOutput[] {
    return [this.primary, ...this.mirrors];
  }
}

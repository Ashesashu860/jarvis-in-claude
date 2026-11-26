/**
 * SpeechInput from the microphone: the MicSource's voice activity detector marks where speech starts
 * and ends (its hold-off is the end-of-speech wait); the audio in between, plus a short pre-roll so
 * the first syllable isn't clipped, is transcribed and delivered as one utterance.
 */
import { AsyncQueue } from "../../application/async-queue.js";
import type { Clock, InputEvent, SpeechInput } from "../../application/ports.js";
import { isNoise } from "../../domain/noise.js";
import type { MicSource, Transcriber } from "./audio-ports.js";

export interface MicInputOptions {
  readonly mic: MicSource;
  readonly transcriber: Transcriber;
  readonly clock: Clock;
  /** Speech shorter than this is a click or a cough, not a prompt. */
  readonly minSpeechMs?: number;
  readonly prerollMs?: number;
  /** While this returns true, speech is ignored (Jarvis is talking; replaced by barge-in in M4). */
  readonly muted?: () => boolean;
}

/** Collects frames into utterances. Pure: no device, no timers. */
export class UtteranceSegmenter {
  private preroll: Float32Array[] = [];
  private prerollLen = 0;
  private current: Float32Array[] | null = null;

  constructor(private readonly sampleRate: number, private readonly prerollMs = 300) {}

  frame(samples: Float32Array): void {
    if (this.current) {
      this.current.push(samples);
      return;
    }
    this.preroll.push(samples);
    this.prerollLen += samples.length;
    const keep = (this.prerollMs / 1000) * this.sampleRate;
    while (this.preroll.length > 1 && this.prerollLen - (this.preroll[0]?.length ?? 0) >= keep) {
      this.prerollLen -= this.preroll.shift()?.length ?? 0;
    }
  }

  speechStarted(): void {
    if (this.current) return;
    this.current = [...this.preroll];
    this.preroll = [];
    this.prerollLen = 0;
  }

  /** Speech ended: the utterance's audio, or null if none was being captured. */
  speechEnded(): Float32Array | null {
    const parts = this.current;
    this.current = null;
    if (!parts) return null;
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  get capturing(): boolean {
    return this.current !== null;
  }
}

export class MicInput implements SpeechInput {
  constructor(private readonly opts: MicInputOptions) {}

  events(signal: AbortSignal): AsyncIterable<InputEvent> {
    const { mic, transcriber, clock } = this.opts;
    const out = new AsyncQueue<InputEvent>();
    const seg = new UtteranceSegmenter(mic.sampleRate, this.opts.prerollMs);
    const minSamples = ((this.opts.minSpeechMs ?? 350) / 1000) * mic.sampleRate;
    let ignoring = false; // this stretch of speech began while Jarvis was talking

    mic.onFrame((f) => seg.frame(f));
    mic.onSpeech(() => {
      ignoring = this.opts.muted?.() ?? false;
      seg.speechStarted();
      if (!ignoring) out.push({ kind: "speechStart", at: clock.now() });
    });
    mic.onSilence(() => {
      const audio = seg.speechEnded();
      if (!audio || ignoring || audio.length < minSamples) return;
      const speechMs = Math.round((audio.length / mic.sampleRate) * 1000);
      const t0 = clock.now();
      transcriber.transcribe(audio).then(
        (text) => {
          const trimmed = text.trim();
          if (!isNoise(trimmed)) out.push({ kind: "utterance", text: trimmed, speechMs, sttMs: Math.round(clock.now() - t0) });
        },
        () => undefined, // a failed transcription is one missed utterance, not a crash
      );
    });
    signal.addEventListener("abort", () => { mic.close(); out.close(); }, { once: true });
    return out;
  }
}

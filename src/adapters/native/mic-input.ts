/**
 * SpeechInput from the microphone: the MicSource's voice activity detector marks where speech starts
 * and ends (its hold-off is the end-of-speech wait); the audio in between, plus a short pre-roll so
 * the first syllable isn't clipped, is transcribed and delivered as one utterance.
 *
 * Barge-in: speech that starts while Jarvis is talking may be the user talking over him, or Jarvis
 * himself coming back through the microphone (echo cancellation on laptop speakers leaves a lot of
 * him in; see spike/FINDINGS.md). So once it has lasted `bargeInMs`, the last moment of it is
 * transcribed, and only if those words aren't what Jarvis has just been saying does a `bargeIn` go
 * out, cutting him off. The speech carries on being captured and arrives as the next utterance.
 * A finished transcript that is mostly his recent words is dropped too.
 */
import { AsyncQueue } from "../../application/async-queue.js";
import type { Clock, InputEvent, SpeechInput } from "../../application/ports.js";
import { isCuttingIn, isEcho, type CutInRule } from "../../domain/echo.js";
import { isNoise } from "../../domain/noise.js";
import type { MicSource, Transcriber } from "./audio-ports.js";

export interface MicInputOptions {
  readonly mic: MicSource;
  readonly transcriber: Transcriber;
  readonly clock: Clock;
  /** Speech shorter than this is a click or a cough, not a prompt. */
  readonly minSpeechMs?: number;
  readonly prerollMs?: number;
  /** Is Jarvis talking right now? */
  readonly speaking?: () => boolean;
  /** What Jarvis has just said, to recognise his own voice in a transcript. */
  readonly recentSpeech?: () => string;
  /**
   * Talking over Jarvis: after `afterMs` of speech, what's heard is checked against `rule`.
   * With "stopWord" (loudspeakers) speech over him that isn't a stop word is ignored, as his own
   * echo would be. `false`: talking over him does nothing, and speech over him is ignored.
   */
  readonly bargeIn?: { readonly afterMs: number; readonly rule: CutInRule } | false;
  /** Detector score that counts a frame as speech, for the barge-in count. */
  readonly vadThreshold?: number;
  /** Diagnostics: each barge-in check, what it heard and whether it cut Jarvis off. */
  readonly onCheck?: (heard: string, cutIn: boolean) => void;
}

/** How much of the latest speech the barge-in check transcribes. */
const CHECK_MS = 1500;

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
    return parts ? concat(parts) : null;
  }

  get capturing(): boolean {
    return this.current !== null;
  }

  /** The last `samples` of the speech being captured (empty if none). */
  tail(samples: number): Float32Array {
    const parts: Float32Array[] = [];
    let n = 0;
    for (let i = (this.current?.length ?? 0) - 1; i >= 0 && n < samples; i--) {
      const p = this.current?.[i];
      if (!p) break;
      parts.unshift(p);
      n += p.length;
    }
    const all = concat(parts);
    return all.length > samples ? all.subarray(all.length - samples) : all;
  }

  /** Drop all but the last `samples` of the speech being captured. */
  keepLast(samples: number): void {
    if (this.current) this.current = [this.tail(samples)];
  }
}

function concat(parts: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Moonshine handles one transcription at a time: queue them, in order. */
function serial(t: Transcriber): (samples: Float32Array) => Promise<string> {
  let chain: Promise<unknown> = Promise.resolve();
  return (samples) => {
    const next = chain.then(() => t.transcribe(samples));
    chain = next.catch(() => undefined);
    return next;
  };
}

export class MicInput implements SpeechInput {
  constructor(private readonly opts: MicInputOptions) {}

  events(signal: AbortSignal): AsyncIterable<InputEvent> {
    const { mic, clock } = this.opts;
    const transcribe = serial(this.opts.transcriber);
    const out = new AsyncQueue<InputEvent>();
    const seg = new UtteranceSegmenter(mic.sampleRate, this.opts.prerollMs);
    const minSamples = ((this.opts.minSpeechMs ?? 350) / 1000) * mic.sampleRate;
    const bargeIn = this.opts.bargeIn ?? { afterMs: 250, rule: "anySpeech" as const };
    const bargeInMs = bargeIn === false ? false : bargeIn.afterMs;
    const rule = bargeIn === false ? null : bargeIn.rule;
    const threshold = this.opts.vadThreshold ?? 0.5;
    const checkSamples = CHECK_MS / 1000 * mic.sampleRate;
    const speaking = () => this.opts.speaking?.() ?? false;
    const recent = () => this.opts.recentSpeech?.() ?? "";
    let stretch = 0; // which stretch of speech the state below belongs to
    let overJarvis = false; // this stretch began while Jarvis was talking
    let voicedMs = 0;
    let nextCheckMs = 0;
    let checking = false;
    let cutIn = false;

    const check = () => {
      checking = true;
      const mine = stretch;
      transcribe(seg.tail(checkSamples)).then(
        (text) => {
          checking = false;
          if (mine !== stretch || cutIn || !speaking()) return;
          const heard = text.trim();
          const user = rule !== null && !isNoise(heard) && isCuttingIn(heard, recent(), rule);
          this.opts.onCheck?.(heard, user);
          if (!user) return; // Jarvis's own voice: keep listening
          cutIn = true;
          // Keep what the user said for the next utterance. On loudspeakers the stop word was the
          // command and the rest is mostly Jarvis's echo, so only what follows is kept.
          seg.keepLast(rule === "stopWord" ? 0 : checkSamples);
          out.push({ kind: "bargeIn", at: clock.now() });
        },
        () => { checking = false; },
      );
    };

    mic.onFrame((f, score) => {
      seg.frame(f);
      if (!overJarvis || cutIn || bargeInMs === false || !seg.capturing) return;
      if (score >= threshold) voicedMs += (f.length / mic.sampleRate) * 1000;
      if (voicedMs >= nextCheckMs && !checking && speaking()) {
        nextCheckMs = voicedMs + bargeInMs; // re-check as the speech goes on
        check();
      }
    });
    mic.onSpeech(() => {
      if (seg.capturing) return;
      stretch++;
      overJarvis = speaking();
      voicedMs = 0;
      nextCheckMs = bargeInMs === false ? Infinity : bargeInMs;
      cutIn = false;
      seg.speechStarted();
      if (!overJarvis) out.push({ kind: "speechStart", at: clock.now() });
    });
    mic.onSilence(() => {
      const audio = seg.speechEnded();
      stretch++;
      if (!audio || audio.length < minSamples) return;
      // Speech that began over Jarvis and never cut him off: with no barge-in, or on loudspeakers
      // (where it's mostly his own echo), it's ignored, as in a half-duplex conversation.
      if (overJarvis && !cutIn && rule !== "anySpeech") return;
      const speechMs = Math.round((audio.length / mic.sampleRate) * 1000);
      const t0 = clock.now();
      transcribe(audio).then(
        (text) => {
          const trimmed = text.trim();
          if (isNoise(trimmed) || isEcho(trimmed, recent())) return;
          out.push({ kind: "utterance", text: trimmed, speechMs, sttMs: Math.round(clock.now() - t0) });
        },
        () => undefined, // a failed transcription is one missed utterance, not a crash
      );
    });
    signal.addEventListener("abort", () => { mic.close(); out.close(); }, { once: true });
    return out;
  }
}

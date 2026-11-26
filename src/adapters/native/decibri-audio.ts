/** AudioSink and MicSource on decibri (prebuilt native audio for Node). */
import { Microphone, Speaker } from "decibri";
import type { AudioSink, MicSource } from "./audio-ports.js";
import type { ReferenceTarget } from "./paced-reference.js";

const asBuffer = (f: Float32Array) => Buffer.from(f.buffer, f.byteOffset, f.byteLength);

/** One speaker kept open for the session (opening one costs ~250 ms). Reopened after a hush. */
export class DecibriSink implements AudioSink {
  private speaker: Speaker | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly sampleRate: number) {}

  write(samples: Float32Array): Promise<void> {
    // writeAsync calls must be sequential to keep samples in order.
    const next = this.chain.then(async () => {
      this.speaker ??= new Speaker({ sampleRate: this.sampleRate, channels: 1, dtype: "float32" });
      await this.speaker.writeAsync(asBuffer(samples));
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  stop(): void {
    const s = this.speaker;
    this.speaker = null;
    this.chain = Promise.resolve();
    s?.stop();
  }
}

export interface MicOptions {
  /** How long the voice detector waits in silence before deciding you've finished. */
  readonly endOfSpeechMs: number;
  /** 0–1: how sure the detector must be that it's speech. */
  readonly threshold?: number;
  /**
   * Cancel the echo of what's played (push it with `push`), at this reference sample rate.
   * Omit for no echo cancellation.
   */
  readonly echoReferenceRate?: number;
  /** Echo canceller tuning (spikes and diagnostics). */
  readonly echoTailMs?: number;
  readonly echoSuppression?: "conservative" | "off";
  readonly highpass?: 80 | 100 | false;
}

/** The microphone, with echo cancellation when asked: `push` feeds it what the speaker plays. */
export class DecibriMic implements MicSource, ReferenceTarget {
  readonly sampleRate = 16000;
  private constructor(private readonly mic: Microphone) {}

  /** Opening loads the Silero detector, about 2 s, so do it once at start-up. */
  static async open(opts: MicOptions): Promise<DecibriMic> {
    const mic = await Microphone.open({
      sampleRate: 16000, channels: 1, dtype: "float32", framesPerBuffer: 480,
      ...(opts.highpass === false ? {} : { highpass: opts.highpass ?? 80 }),
      vad: { model: "silero", threshold: opts.threshold ?? 0.5, holdoffMs: opts.endOfSpeechMs },
      ...(opts.echoReferenceRate
        ? { aec: { model: "tau" as const, referenceSampleRate: opts.echoReferenceRate, referenceChannels: 1,
                   ...(opts.echoTailMs ? { tailMs: opts.echoTailMs } : {}),
                   ...(opts.echoSuppression ? { suppression: opts.echoSuppression } : {}) } }
        : {}),
    });
    return new DecibriMic(mic);
  }

  onFrame(listener: (samples: Float32Array, vadScore: number) => void): void {
    this.mic.on("data", (chunk: Buffer) => {
      // Copy: the chunk's memory may be reused.
      listener(new Float32Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)), this.mic.vadScore);
    });
  }
  push(samples: Float32Array): void { this.mic.pushAecReference(asBuffer(samples)); }
  /** The echo canceller's report (null without echo cancellation), for diagnostics. */
  echoMetrics(): ReturnType<Microphone["aecMetrics"]> { return this.mic.aecMetrics(); }
  onSpeech(listener: () => void): void { this.mic.on("speech", listener); }
  onSilence(listener: () => void): void { this.mic.on("silence", listener); }
  close(): void { this.mic.stop(); }
}

/**
 * Does the default output go to headphones (no echo into the microphone)? Judged from the device's
 * name; anything unrecognised counts as a loudspeaker, the safer guess.
 */
export function outputIsHeadphones(): boolean {
  const out = Speaker.devices().find((d) => d.isDefault);
  return out !== undefined && /headphone|headset|airpods|earbuds|earphones|buds|beats/i.test(`${out.name} ${out.id}`);
}

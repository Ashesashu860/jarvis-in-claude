/**
 * Small interfaces inside the native engine, so the voice and the microphone can be tested without
 * a sound card or models. Each has one real implementation (sherpa-onnx or decibri) and a test fake.
 */
export interface Synthesizer {
  readonly sampleRate: number;
  /** Mono float32 samples for one piece of speech. */
  render(text: string): Promise<Float32Array>;
}

export interface AudioSink {
  /** Queue samples for playback; resolves once queued (not once played). */
  write(samples: Float32Array): Promise<void>;
  /** Stop at once and drop what's queued. The sink reopens on the next write. */
  stop(): void;
}

export interface Transcriber {
  /** 16 kHz mono float32 in, text out. */
  transcribe(samples: Float32Array): Promise<string>;
}

/** A live microphone with voice activity detection: frames, plus speech/silence edges. */
export interface MicSource {
  readonly sampleRate: number;
  onFrame(listener: (samples: Float32Array) => void): void;
  onSpeech(listener: () => void): void;
  onSilence(listener: () => void): void;
  close(): void;
}

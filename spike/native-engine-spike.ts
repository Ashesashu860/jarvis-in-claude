// M3 spike: can a native Node engine (sherpa-onnx + decibri) replace jarvis-voice's Python engine?
// Measures Kokoro load and first-sentence render, Whisper base.en vs Moonshine base accuracy and speed,
// silent playback through the speaker, and that the microphone delivers audio.
// Run: npx tsx spike/native-engine-spike.ts            (plays nothing audible: playback is zeroed)
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { Microphone, Speaker } from "decibri";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- the package ships no types
const sherpa = require("sherpa-onnx-node");

const M = join(homedir(), ".cache", "jarvis-rt", "models");
const K = join(M, "kokoro-int8-multi-lang-v1_0");
const ms = (t0: number) => `${(performance.now() - t0).toFixed(0)} ms`;

// ---------------------------------------------------------------- voice
let t = performance.now();
const tts = new sherpa.OfflineTts({
  model: {
    kokoro: { model: join(K, "model.int8.onnx"), voices: join(K, "voices.bin"), tokens: join(K, "tokens.txt"),
              lexicon: join(K, "lexicon-gb-en.txt"), dataDir: join(K, "espeak-ng-data"), lang: "en-gb" },
    numThreads: 4, debug: false, provider: "cpu",
  },
  maxNumSentences: 1,
});
console.log(`kokoro load ${ms(t)}  sampleRate ${tts.sampleRate}  speakers ${tts.numSpeakers}`);
const DANIEL = 24;
const say = (text: string) => tts.generate({ text, sid: DANIEL, speed: 1.05 }) as { samples: Float32Array; sampleRate: number };
for (const text of ["Warm up.", "Certainly, sir.", "Certainly, sir.", "I've taken the liberty of reviewing the tests,",
                    "and I'm afraid two of them are failing on the daemon path."]) {
  t = performance.now();
  const a = say(text);
  console.log(`  render ${ms(t).padStart(7)} for ${(a.samples.length / a.sampleRate).toFixed(2)} s audio: ${text}`);
}

// ---------------------------------------------------------------- hearing: render speech, resample to 16 kHz, transcribe
function to16k(samples: Float32Array, rate: number): Float32Array {
  const ratio = rate / 16000;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio, i0 = Math.floor(x), f = x - i0;
    out[i] = (samples[i0] ?? 0) * (1 - f) + (samples[i0 + 1] ?? 0) * f;
  }
  return out;
}
const phrase = "Deep dive and check if your replies can be made faster in any way, please.";
const clip = say(phrase);
const audio16 = to16k(clip.samples, clip.sampleRate);

const W = join(M, "sherpa-onnx-whisper-base.en");
const MS = join(M, "sherpa-onnx-moonshine-base-en-quantized-2026-02-27");
const recognizers: Record<string, object> = {
  "whisper base.en int8": { whisper: { encoder: join(W, "base.en-encoder.int8.onnx"), decoder: join(W, "base.en-decoder.int8.onnx"), language: "en", task: "transcribe" },
                            tokens: join(W, "base.en-tokens.txt") },
  "moonshine base (q)":   { moonshine: { encoder: join(MS, "encoder_model.ort"), mergedDecoder: join(MS, "decoder_model_merged.ort") },
                            tokens: join(MS, "tokens.txt") },
};
for (const [name, modelConfig] of Object.entries(recognizers)) {
  t = performance.now();
  const rec = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 },
                                             modelConfig: { ...modelConfig, numThreads: 4, provider: "cpu", debug: 0 } });
  const load = ms(t);
  for (let run = 0; run < 2; run++) {
    t = performance.now();
    const stream = rec.createStream();
    stream.acceptWaveform({ samples: audio16, sampleRate: 16000 });
    rec.decode(stream);
    const text = (rec.getResult(stream) as { text: string }).text.trim();
    if (run === 1) console.log(`${name.padEnd(22)} load ${load.padStart(8)}  transcribe ${ms(t).padStart(6)} (${(audio16.length / 16000).toFixed(1)} s): ${text}`);
  }
}

// ---------------------------------------------------------------- speaker (silent) and mic
t = performance.now();
const speaker = new Speaker({ sampleRate: clip.sampleRate, channels: 1, dtype: "float32" });
const silent = new Float32Array(Math.floor(clip.sampleRate * 0.5));
await speaker.writeAsync(Buffer.from(silent.buffer));
await speaker.drainAsync();
console.log(`speaker: 0.5 s of silence written and drained in ${ms(t)}`);
speaker.stop();

t = performance.now();
const mic = await Microphone.open({ sampleRate: 16000, channels: 1, dtype: "float32", framesPerBuffer: 480, vad: "silero" });
let frames = 0, peak = 0;
mic.on("data", (chunk: Buffer) => {
  const f = new Float32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 4);
  frames += f.length;
  for (const v of f) peak = Math.max(peak, Math.abs(v));
});
await new Promise((r) => setTimeout(r, 1500));
mic.stop();
console.log(`mic: opened in ${ms(t)}; ${(frames / 16000).toFixed(2)} s of audio in 1.5 s; peak level ${peak.toFixed(4)}`);

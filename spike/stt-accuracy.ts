// Moonshine base vs Whisper base.en on real recorded speech (the models' own test clips). M3 spike.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const sherpa = require("sherpa-onnx-node");
const M = join(homedir(), ".cache", "jarvis-rt", "models");
const W = join(M, "sherpa-onnx-whisper-base.en"), MS = join(M, "sherpa-onnx-moonshine-base-en-quantized-2026-02-27");
const recs = {
  whisper: new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { whisper: { encoder: join(W, "base.en-encoder.int8.onnx"), decoder: join(W, "base.en-decoder.int8.onnx"), language: "en", task: "transcribe" }, tokens: join(W, "base.en-tokens.txt"), numThreads: 4 } }),
  moonshine: new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { moonshine: { encoder: join(MS, "encoder_model.ort"), mergedDecoder: join(MS, "decoder_model_merged.ort") }, tokens: join(MS, "tokens.txt"), numThreads: 4 } }),
};
const dir = join(W, "test_wavs");
for (const f of readdirSync(dir).filter((n) => n.endsWith(".wav"))) {
  const wave = sherpa.readWave(join(dir, f));
  console.log(`\n${f} (${(wave.samples.length / wave.sampleRate).toFixed(1)} s)`);
  for (const [name, rec] of Object.entries(recs)) {
    const t = performance.now();
    const s = rec.createStream(); s.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate }); rec.decode(s);
    console.log(`  ${name.padEnd(9)} ${(performance.now() - t).toFixed(0).padStart(4)} ms  ${rec.getResult(s).text.trim()}`);
  }
}

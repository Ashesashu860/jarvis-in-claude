// Which Kokoro build and thread count renders the first words fastest? (M3 spike)
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const sherpa = require("sherpa-onnx-node");
const M = join(homedir(), ".cache", "jarvis-rt", "models");
for (const [dir, file] of [["kokoro-multi-lang-v1_0", "model.onnx"], ["kokoro-int8-multi-lang-v1_0", "model.int8.onnx"]] as const) {
  for (const threads of [1, 2, 4, 8]) {
    for (const provider of threads === 4 ? ["cpu", "coreml"] : ["cpu"]) {
      const K = join(M, dir);
      let tts;
      try {
        tts = new sherpa.OfflineTts({ model: { kokoro: { model: join(K, file), voices: join(K, "voices.bin"), tokens: join(K, "tokens.txt"),
          lexicon: join(K, "lexicon-gb-en.txt") }, numThreads: threads, debug: false, provider }, maxNumSentences: 1 });
      } catch (e) { console.log(`${file} ${provider} x${threads}: unavailable (${String(e).slice(0, 60)})`); continue; }
      tts.generate({ text: "Warm up.", sid: 24, speed: 1.05 });
      const best = (text: string) => { let b = 1e9; for (let i = 0; i < 3; i++) { const t = performance.now(); tts.generate({ text, sid: 24, speed: 1.05 }); b = Math.min(b, performance.now() - t); } return b.toFixed(0).padStart(5); };
      console.log(`${file.padEnd(16)} ${provider.padEnd(6)} threads ${threads}:  short ${best("Certainly, sir.")} ms   long ${best("I've taken the liberty of reviewing the tests, sir.")} ms`);
    }
  }
}

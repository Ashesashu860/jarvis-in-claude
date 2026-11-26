// Does every word survive now? Render with the real voice, transcribe with Moonshine, compare. (M3)
import { modelsDir } from "../src/adapters/native/models.js";
import { KokoroSynthesizer, MoonshineTranscriber } from "../src/adapters/native/sherpa-engine.js";
const root = modelsDir();
const [voice, ears] = await Promise.all([KokoroSynthesizer.load(root, "bm_daniel", 1.05), MoonshineTranscriber.load(root)]);
const to16k = (s: Float32Array, rate: number) => { const r = rate / 16000, o = new Float32Array(Math.floor(s.length / r)); for (let i = 0; i < o.length; i++) o[i] = s[Math.floor(i * r)] ?? 0; return o; };
await voice.render("Warm up.");
for (const text of ["What's the capital of France?", "It happens, and it makes sense.", "Push it to GitHub, then run npm test.",
                    "The JSON file says Jarvis, sir.", "Certainly, sir. Two of the tests are failing."]) {
  const t = performance.now();
  const audio = await voice.render(text);
  const ms = (performance.now() - t).toFixed(0);
  console.log(`${ms.padStart(5)} ms  said: ${text.padEnd(42)} heard: ${await ears.transcribe(to16k(audio, voice.sampleRate))}`);
}

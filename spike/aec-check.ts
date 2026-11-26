// M4: does the echo canceller keep Jarvis's own voice out of the microphone?
// Plays the same sentences through the real speaker with the real microphone open, once per variant,
// and reports, per sentence, how much of the playback the voice detector took for speech (frames
// scoring >= 0.5), plus the canceller's ERLE. Stay quiet while it runs.
// Run: npx tsx spike/aec-check.ts [variant ...]   (variants: off, on, lead60, tail400, nohp, supoff)
import { DecibriMic, DecibriSink, type MicOptions } from "../src/adapters/native/decibri-audio.js";
import { modelsDir } from "../src/adapters/native/models.js";
import { NativeVoiceOutput } from "../src/adapters/native/native-voice-output.js";
import { PacedReference } from "../src/adapters/native/paced-reference.js";
import { KokoroSynthesizer } from "../src/adapters/native/sherpa-engine.js";
import { systemClock } from "../src/adapters/system-clock.js";

const LINES = [
  "Certainly, sir.",
  "I have read the configuration file and the three tests that cover it.",
  "The failure comes from a missing environment variable, which I have now added.",
  "Shall I run the whole suite again, or would you prefer to look at the change first?",
];

const VARIANTS: Record<string, { mic: Partial<MicOptions>; aec: boolean; leadMs?: number }> = {
  off: { mic: {}, aec: false },
  on: { mic: {}, aec: true },
  lead60: { mic: {}, aec: true, leadMs: 60 },
  lag: { mic: {}, aec: true, leadMs: -40 },
  tail400: { mic: { echoTailMs: 400 }, aec: true },
  nohp: { mic: { highpass: false }, aec: true },
  supoff: { mic: { echoSuppression: "off" }, aec: true },
};

const synth = await KokoroSynthesizer.load(modelsDir(), "bm_daniel", 1.05);
const names = process.argv.slice(2).length ? process.argv.slice(2) : ["off", "on"];

for (const name of names) {
  const v = VARIANTS[name];
  if (!v) throw new Error(`unknown variant ${name}`);
  const mic = await DecibriMic.open({ endOfSpeechMs: 700, ...v.mic, ...(v.aec ? { echoReferenceRate: synth.sampleRate } : {}) });
  const reference = new PacedReference(mic, systemClock, 20, v.leadMs ?? 20);
  let line = -1;
  const voiced: number[] = LINES.map(() => 0), total: number[] = LINES.map(() => 0);
  const voice = new NativeVoiceOutput({
    synth, sink: new DecibriSink(synth.sampleRate), clock: systemClock,
    onAudio: (s, rate, at) => {
      if (v.aec) reference.schedule(s, rate, at);
      const idx = ++line;
      setTimeout(() => { current = idx; }, Math.max(0, at - systemClock.now()));
    },
  });
  let current = -1;
  await voice.prepare();
  line = -1;
  mic.onFrame((f, score) => {
    if (current < 0 || !voice.isSpeaking()) return;
    const ms = (f.length / 16000) * 1000;
    total[current] = (total[current] ?? 0) + ms;
    if (score >= 0.5) voiced[current] = (voiced[current] ?? 0) + ms;
  });
  const rounds = Number(process.env.ROUNDS ?? 1);
  for (let round = 1; round <= rounds; round++) {
    voiced.fill(0); total.fill(0); line = -1; current = -1;
    await new Promise((r) => setTimeout(r, round === 1 ? 500 : 3000)); // a pause, as between replies
    for (const l of LINES) voice.announce(l);
    await new Promise((r) => setTimeout(r, 300));
    while (voice.isSpeaking()) await new Promise((r) => setTimeout(r, 50));
    const pct = voiced.map((x, i) => `${Math.round((x / Math.max(1, total[i] ?? 1)) * 100)}%`);
    const m = mic.echoMetrics();
    console.log(`${name.padEnd(8)} reply ${round}: speech-like per sentence: ${pct.join("  ")}` +
      (m ? `   erle ${m.erleDb.toFixed(1)} dB, delay ${m.delaySamples}, doubleTalk ${m.doubleTalk}` : ""));
  }
  mic.close();
  current = -1;
  await new Promise((r) => setTimeout(r, 600));
}
process.exit(0);

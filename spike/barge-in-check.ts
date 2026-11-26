// M4 on real hardware: speaker, microphone, echo canceller, Moonshine and MicInput's barge-in check.
// 1. Jarvis (bm_daniel) speaks replies with nobody talking: every barge-in is a false one.
// 2. A "user" (bf_emma, played on a second speaker stream that neither the echo canceller nor the echo
//    filter knows about, as with a real person) talks over him: how soon is he cut off, and what is heard?
// Stay quiet while it runs. Run: npx tsx spike/barge-in-check.ts
import { DecibriMic, DecibriSink } from "../src/adapters/native/decibri-audio.js";
import { MicInput } from "../src/adapters/native/mic-input.js";
import { modelsDir } from "../src/adapters/native/models.js";
import { NativeVoiceOutput } from "../src/adapters/native/native-voice-output.js";
import { PacedReference } from "../src/adapters/native/paced-reference.js";
import { KokoroSynthesizer, MoonshineTranscriber } from "../src/adapters/native/sherpa-engine.js";
import { systemClock } from "../src/adapters/system-clock.js";

const REPLIES = [
  ["Certainly, sir.", "I have read the configuration file and the three tests that cover it.",
   "The failure comes from a missing environment variable, which I have now added.", "Shall I run the whole suite again?"],
  ["Of course.", "The build takes about forty seconds on this machine, most of it spent compiling the native modules.",
   "I could cache those between runs, which would bring it down to roughly ten seconds."],
  ["Done, sir.", "All eighty tests pass, and the linter has nothing to say.", "I have left the commit unpushed, as you asked."],
];
const INTERRUPTIONS = ["Wait, stop. Use the other database instead.", "Hold on, Jarvis.", "No, no, that's the wrong file."];

const root = modelsDir();
const [synth, userSynth, transcriber] = await Promise.all([
  KokoroSynthesizer.load(root, "bm_daniel", 1.05), KokoroSynthesizer.load(root, "bf_emma", 1.0), MoonshineTranscriber.load(root),
]);
const mic = await DecibriMic.open({ endOfSpeechMs: 700, echoReferenceRate: synth.sampleRate });
const reference = new PacedReference(mic, systemClock);
const voice = new NativeVoiceOutput({
  synth, sink: new DecibriSink(synth.sampleRate), clock: systemClock,
  onAudio: (s, rate, at) => reference.schedule(s, rate, at), onHush: () => reference.clear(),
});
const userSink = new DecibriSink(userSynth.sampleRate);
await voice.prepare();
await userSink.write(new Float32Array(1200));

const checks: string[] = [];
const input = new MicInput({
  mic, transcriber, clock: systemClock, bargeIn: { afterMs: 250, rule: (process.env.RULE ?? "stopWord") as "stopWord" | "anySpeech" },
  speaking: () => voice.isSpeaking(), recentSpeech: () => voice.recentSpeech(),
  onCheck: (heard, cut) => checks.push(`${cut ? "CUT " : "echo"} "${heard}"`),
});
const events: { kind: string; at: number; text?: string }[] = [];
const stop = new AbortController();
void (async () => {
  for await (const ev of input.events(stop.signal)) {
    events.push({ kind: ev.kind, at: ev.kind === "utterance" ? systemClock.now() : ev.at, ...(ev.kind === "utterance" ? { text: ev.text } : {}) });
    if (ev.kind === "bargeIn") voice.hush();
  }
})();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = async () => { await sleep(300); while (voice.isSpeaking()) await sleep(50); await sleep(1500); };

console.log("1. Jarvis alone: any barge-in is a false one");
let falseCuts = 0;
for (const [round, reply] of [...REPLIES, ...REPLIES].entries()) {
  const n = events.length; checks.length = 0;
  for (const line of reply) voice.announce(line);
  await quiet();
  const cuts = events.slice(n).filter((e) => e.kind === "bargeIn").length;
  falseCuts += cuts;
  console.log(`   reply ${round + 1}: ${cuts} barge-ins; checks: ${checks.join(" | ") || "none"}`);
}
console.log(`   => ${falseCuts} false barge-ins in ${REPLIES.length * 2} replies`);

console.log("2. The user talks over Jarvis");
for (const [i, words] of INTERRUPTIONS.entries()) {
  const n = events.length; checks.length = 0;
  for (const line of REPLIES[i % REPLIES.length] ?? []) voice.announce(line);
  await sleep(2500);
  const userAudio = await userSynth.render(words);
  const t0 = systemClock.now();
  await userSink.write(userAudio);
  await sleep((userAudio.length / userSynth.sampleRate) * 1000);
  await quiet();
  const after = events.slice(n);
  const cut = after.find((e) => e.kind === "bargeIn");
  const heard = after.filter((e) => e.kind === "utterance").map((e) => `"${e.text}"`);
  console.log(`   "${words}": ${cut ? `cut off ${Math.round(cut.at - t0)} ms after the user started` : "NOT cut off"}; ` +
    `heard ${heard.join(", ") || "nothing"}; checks: ${checks.join(" | ")}`);
}
const m = mic.echoMetrics();
console.log(`echo canceller: erle ${m?.erleDb.toFixed(1)} dB, delay ${m?.delaySamples}`);
stop.abort();
process.exit(0);

// M4 spike: does Apple's voice processing keep Jarvis out of the microphone, and hear the user over him?
// Renders a Jarvis reply and a user interruption with Kokoro, then runs the Swift helper (vpio-spike)
// with voice processing off and on, alone and with the user cutting in, and scores each recording:
// share of Jarvis-only time Silero calls speech, and what Moonshine hears.
// Run: swiftc -O spike/vpio/vpio-spike.swift -o <bin>; VPIO_BIN=<bin> npx tsx spike/vpio/vpio-check.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { File as AudioFile } from "decibri";
import { modelsDir } from "../../src/adapters/native/models.js";
import { KokoroSynthesizer, MoonshineTranscriber } from "../../src/adapters/native/sherpa-engine.js";

const BIN = process.env.VPIO_BIN ?? "vpio-spike";
const dir = mkdtempSync(join(tmpdir(), "jrt-vpio-"));
const REPLY = "Certainly, sir. I have read the configuration file and the three tests that cover it. " +
  "The failure comes from a missing environment variable, which I have now added. Shall I run the whole suite again?";
const USER = "Hold on, Jarvis. Use the other database instead.";
const USER_AT = 4.0; // seconds after Jarvis starts

function wav(path: string, samples: Float32Array, rate: number): void {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36);
  b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), 44 + i * 2));
  writeFileSync(path, b);
}

const root = modelsDir();
const [daniel, emma, stt] = await Promise.all([
  KokoroSynthesizer.load(root, "bm_daniel", 1.05), KokoroSynthesizer.load(root, "bf_emma", 1.0), MoonshineTranscriber.load(root),
]);
const parts = [];
for (const s of REPLY.split(/(?<=[.?])\s+/)) parts.push(await daniel.render(s));
const jarvis = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
let at = 0; for (const p of parts) { jarvis.set(p, at); at += p.length; }
wav(join(dir, "jarvis.wav"), jarvis, daniel.sampleRate);
const user = await emma.render(USER);
wav(join(dir, "user.wav"), user, emma.sampleRate);
const jarvisSec = jarvis.length / daniel.sampleRate, userSec = user.length / emma.sampleRate;

for (const vp of [false, true]) {
  for (const withUser of [false, true]) {
    const out = join(dir, `out-${vp}-${withUser}.raw`);
    execFileSync(BIN, [join(dir, "jarvis.wav"), out, ...(vp ? [] : ["--novp"]), ...(withUser ? [join(dir, "user.wav"), String(USER_AT)] : [])], { stdio: ["ignore", "ignore", "ignore"] });
    const raw = readFileSync(out);
    const rec = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const report = await AudioFile.buffer(rec, { inputRate: 16000, sampleRate: 16000, vad: "silero" }).analyze();
    // Jarvis plays from t=1 s (the helper's settle time); the user from 1 + USER_AT.
    const inJarvisOnly = (t: number) => t >= 1 && t < 1 + jarvisSec && !(withUser && t >= 1 + USER_AT && t < 1 + USER_AT + userSec + 0.3);
    const inUser = (t: number) => withUser && t >= 1 + USER_AT && t < 1 + USER_AT + userSec;
    const jw = report.scores.filter((w) => inJarvisOnly(w.start)), uw = report.scores.filter((w) => inUser(w.start));
    const pct = (ws: typeof jw) => `${Math.round((ws.filter((w) => w.isSpeech).length / Math.max(1, ws.length)) * 100)}%`;
    const userClip = rec.subarray(Math.round((1 + USER_AT - 0.2) * 16000), Math.round((1 + USER_AT + userSec + 0.3) * 16000));
    const heard = withUser ? (await stt.transcribe(userClip)).trim() : "";
    const lastSec = rec.subarray(Math.round((1 + 6) * 16000), Math.round((1 + 7.5) * 16000));
    const echoHeard = !withUser ? (await stt.transcribe(lastSec)).trim() : "";
    const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / Math.max(1, a.length));
    console.log(`voice processing ${vp ? "ON " : "OFF"} ${withUser ? "+ user" : "alone "}: Jarvis-only time scored as speech ${pct(jw)}` +
      (withUser ? `, user time ${pct(uw)}; heard over Jarvis: "${heard}"` : `; 1.5 s of Jarvis-only audio transcribes as "${echoHeard}", rms ${rms(lastSec).toFixed(4)}`));
  }
}

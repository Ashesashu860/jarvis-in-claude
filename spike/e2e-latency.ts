// M3 end-to-end latency, muted: a spoken prompt (Kokoro-rendered, resampled to 16 kHz) goes through the real
// MicInput -> Moonshine -> ConversationService -> Claude (Sonnet) -> chunker -> Kokoro -> a muted sink.
// The real microphone's end-of-speech wait (700 ms by default) is not included: add it to the totals.
// Run: npx tsx spike/e2e-latency.ts
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationService } from "../src/application/conversation-service.js";
import { PolicyPermissionDecider } from "../src/application/policy-permission-decider.js";
import type { TurnTimings } from "../src/application/ports.js";
import { ClaudeAgentBrain } from "../src/adapters/brain/claude-agent-brain.js";
import { MicInput } from "../src/adapters/native/mic-input.js";
import { modelsDir } from "../src/adapters/native/models.js";
import { NativeVoiceOutput } from "../src/adapters/native/native-voice-output.js";
import { KokoroSynthesizer, MoonshineTranscriber } from "../src/adapters/native/sherpa-engine.js";
import { systemClock } from "../src/adapters/system-clock.js";
import type { AudioSink, MicSource } from "../src/adapters/native/audio-ports.js";

class MutedSink implements AudioSink {
  write(): Promise<void> { return Promise.resolve(); }
  stop(): void { /* nothing playing */ }
}

class ScriptedMic implements MicSource {
  readonly sampleRate = 16000;
  private frame: ((s: Float32Array) => void) | null = null;
  private speech: (() => void) | null = null;
  private silence: (() => void) | null = null;
  onFrame(l: (s: Float32Array) => void): void { this.frame = l; }
  onSpeech(l: () => void): void { this.speech = l; }
  onSilence(l: () => void): void { this.silence = l; }
  close(): void { /* scripted */ }
  utter(samples: Float32Array): void {
    this.speech?.();
    for (let i = 0; i < samples.length; i += 480) this.frame?.(samples.subarray(i, i + 480));
    this.silence?.();
  }
}

const to16k = (s: Float32Array, rate: number) => {
  const r = rate / 16000, out = new Float32Array(Math.floor(s.length / r));
  for (let i = 0; i < out.length; i++) out[i] = s[Math.floor(i * r)] ?? 0;
  return out;
};

const root = modelsDir();
const [synth, transcriber] = await Promise.all([KokoroSynthesizer.load(root, "bm_george", 1.0), MoonshineTranscriber.load(root)]);
const voiceSynth = await KokoroSynthesizer.load(root, "bm_daniel", 1.05);
const voice = new NativeVoiceOutput({ synth: voiceSynth, sink: new MutedSink(), clock: systemClock });
await voice.prepare();
const mic = new ScriptedMic();
const records: TurnTimings[] = [];
const brain = new ClaudeAgentBrain({
  model: "sonnet", cwd: mkdtempSync(join(tmpdir(), "jrt-e2e-")), permission: new PolicyPermissionDecider(),
  systemAppend: "Replies are read aloud. Open with a very short sentence under eight words, then plain sentences.",
});
brain.start();
const service = new ConversationService({
  input: new MicInput({ mic, transcriber, clock: systemClock }), output: voice, brain, control: brain,
  timings: { record: (t) => records.push(t) }, clock: systemClock, newId: randomUUID, persona: { address: "sir" },
});
const stop = new AbortController();
const running = service.run(stop.signal);
await new Promise((r) => setTimeout(r, 4000)); // like a person: the session warms up before the first question

for (const prompt of ["What's the capital of France?", "Why do streamed replies feel faster?", "Give me one tip for naming variables."]) {
  const spoken = await synth.render(prompt);
  const n = records.length;
  mic.utter(to16k(spoken, synth.sampleRate));
  while (records.length === n) await new Promise((r) => setTimeout(r, 20));
  const r = records.at(-1);
  if (r) {
    const total = (r.sttMs ?? 0) + (r.firstAudioMs ?? 0);
    console.log(`heard "${r.heard}"\n   transcribe ${r.sttMs} ms + Claude's first text ${r.firstTextMs} ms, first piece ${r.firstSentenceMs} ms, first audio ${r.firstAudioMs} ms` +
      `\n   = ${total} ms after speech ends; with the 700 ms end-of-speech wait: ${total + 700} ms`);
  }
}
stop.abort();
await running;

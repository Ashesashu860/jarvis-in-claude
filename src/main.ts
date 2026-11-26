#!/usr/bin/env node
/**
 * Composition root: the only file that knows every concrete class. It reads flags and settings,
 * builds the adapters, hands them to the ConversationService, and runs it.
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { ConversationService } from "./application/conversation-service.js";
import { PolicyPermissionDecider } from "./application/policy-permission-decider.js";
import type { SpeechInput, SpeechOutput } from "./application/ports.js";
import { ClaudeAgentBrain } from "./adapters/brain/claude-agent-brain.js";
import { ConsoleOutput } from "./adapters/cli/console-output.js";
import { KeyboardInput } from "./adapters/cli/keyboard-input.js";
import { MirroredOutput } from "./adapters/cli/mirrored-output.js";
import { defaultPaths, loadConfig, type Config } from "./adapters/config/file-config.js";
import { DecibriMic, DecibriSink, outputIsHeadphones } from "./adapters/native/decibri-audio.js";
import { MicInput } from "./adapters/native/mic-input.js";
import { installModels, missingModels, modelsDir } from "./adapters/native/models.js";
import { NativeVoiceOutput } from "./adapters/native/native-voice-output.js";
import { PacedReference } from "./adapters/native/paced-reference.js";
import { KokoroSynthesizer, MoonshineTranscriber } from "./adapters/native/sherpa-engine.js";
import { FileSessionStore } from "./adapters/store/file-session-store.js";
import { systemClock } from "./adapters/system-clock.js";
import { JsonlTimingLog } from "./adapters/telemetry/jsonl-timing-log.js";
import { DEFAULT_RULES } from "./domain/permission-policy.js";

const VOICE_STYLE = (address: string) =>
  "Your replies are read aloud as they stream. Open with a very short sentence (under eight words) that answers " +
  "or acknowledges, then continue in plain, spoken sentences; no markdown, lists, tables, emoji or code in what " +
  "is spoken. Put code in files, not in replies. The user's words come from speech recognition and may contain " +
  "small errors: infer what they meant. " +
  `Be calm, precise and economical, with a dry, understated British wit. Address the user as '${address}'.`;

const HELP = `jarvis-rt: talk to Claude Code in real time

Usage: jarvis-rt [--new] [--type] [--text] [--model opus|sonnet|haiku] [--cwd DIR]
       jarvis-rt setup        download the voice and speech models (about 440 MB, once)

  --new        start a new conversation instead of resuming the last one here
  --type       type prompts instead of speaking them
  --text       print replies only; don't speak them
  --model      Claude model (default from settings: sonnet)
  --cwd        directory Claude works in (default: current)
  -h, --help   show this help

Speak after "Listening…"; a short pause ends your turn. To cut Jarvis off, talk over him (on loudspeakers,
say "stop", "wait" or "hold on"), or press Ctrl+C. Ctrl+C twice quits.
Say "new conversation", "use opus", "plan mode", "stop" or "goodbye".
When Jarvis asks "Shall I…?" before an edit or a command, answer "yes", "no" or "always".`;

/** Kokoro's output rate: the echo canceller's reference rate. */
const KOKORO_RATE = 24000;

const log = (line: string) => process.stderr.write(`${line}\n`);

async function setup(): Promise<number> {
  const root = modelsDir();
  if (missingModels(root).length === 0) {
    log(`Models are already installed in ${root}.`);
    return 0;
  }
  await installModels(root, log);
  log(`Done. Models are in ${root}. Run jarvis-rt to start.`);
  return 0;
}

interface Speech {
  readonly input: SpeechInput;
  readonly output: SpeechOutput;
  readonly listening: boolean;
  /** How talking over Jarvis works, to tell the user. */
  readonly bargeIn: string | null;
}

/** Build the voice and the ears, falling back to text and typing when the models aren't installed. */
async function buildSpeech(config: Config, flags: { type: boolean; text: boolean }): Promise<Speech> {
  const transcript = new ConsoleOutput();
  const wantVoice = config.voice && !flags.text;
  const wantMic = config.listen && !flags.type;
  const root = modelsDir();
  if ((wantVoice || wantMic) && missingModels(root).length > 0) {
    log("The voice and speech models aren't installed yet: run `jarvis-rt setup`. Using text for now.");
    return { input: new KeyboardInput(), output: transcript, listening: false, bargeIn: null };
  }

  // What the speaker plays is fed, at playback pace, to the microphone's echo canceller.
  let mic: DecibriMic | null = null;
  const reference = new PacedReference({ push: (samples) => mic?.push(samples) }, systemClock);
  let voice: NativeVoiceOutput | null = null;
  if (wantVoice) {
    const synth = await KokoroSynthesizer.load(root, config.speaker, config.speed);
    voice = new NativeVoiceOutput({
      synth, sink: new DecibriSink(synth.sampleRate), clock: systemClock, onError: log,
      onAudio: (samples, rate, startAt) => reference.schedule(samples, rate, startAt),
      onHush: () => reference.clear(),
    });
    await voice.prepare();
  }
  const output: SpeechOutput = voice ? new MirroredOutput(voice, [transcript]) : transcript;

  if (!wantMic) return { input: new KeyboardInput(), output, listening: false, bargeIn: null };
  const [openedMic, transcriber] = await Promise.all([
    DecibriMic.open({ endOfSpeechMs: config.endOfSpeechMs, ...(voice ? { echoReferenceRate: KOKORO_RATE } : {}) }),
    MoonshineTranscriber.load(root),
  ]);
  mic = openedMic;
  const rule = config.bargeIn === "auto" ? (outputIsHeadphones() ? "anySpeech" : "stopWord") : config.bargeIn;
  const input = new MicInput({
    mic, transcriber, clock: systemClock,
    speaking: () => voice?.isSpeaking() ?? false,
    recentSpeech: () => voice?.recentSpeech() ?? "",
    bargeIn: !voice || rule === "off" ? false : { afterMs: config.bargeInMs, rule },
  });
  const bargeIn = !voice || rule === "off" ? null
    : rule === "anySpeech" ? "talk over me to cut me off"
    : "say \"stop\", \"wait\" or \"hold on\" to cut me off (on loudspeakers I'd hear myself)";
  return { input, output, listening: true, bargeIn };
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      new: { type: "boolean", default: false },
      type: { type: "boolean", default: false },
      text: { type: "boolean", default: false },
      model: { type: "string" },
      cwd: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (positionals[0] === "setup") return setup();
  if (positionals.length > 0) {
    log(`Unknown command "${positionals.join(" ")}". Try jarvis-rt --help.`);
    return 2;
  }

  const paths = defaultPaths();
  const config = loadConfig(paths.config);
  const model = values.model ?? config.model;
  if (model !== "opus" && model !== "sonnet" && model !== "haiku") {
    log(`--model must be opus, sonnet or haiku (got "${model}")`);
    return 2;
  }
  const cwd = values.cwd ?? process.cwd();

  const sessions = new FileSessionStore(paths.sessions, cwd);
  if (values.new) await sessions.clear();
  const resume = await sessions.last();

  // Permission questions are asked in the conversation, which needs the brain: bound once it exists.
  const conversation: { current?: ConversationService } = {};
  const brain = new ClaudeAgentBrain({
    model,
    cwd,
    systemAppend: VOICE_STYLE(config.address),
    permission: new PolicyPermissionDecider({ ...DEFAULT_RULES, autoAllow: config.autoAllow },
      (call, signal) => conversation.current?.ask(call, signal) ?? Promise.resolve("no")),
    resume,
    onSession: (id) => void sessions.save(id),
  });
  brain.start(); // the Claude session starts while the voice and microphone load

  log(`jarvis-rt · ${model} · ${cwd}${resume ? " · resuming the last conversation" : ""}`);
  log("Loading the voice and speech models…");
  const { input, output, listening, bargeIn } = await buildSpeech(config, { type: values.type, text: values.text });

  const service = new ConversationService({
    input,
    output,
    brain,
    control: brain,
    timings: new JsonlTimingLog(paths.timings),
    clock: systemClock,
    newId: randomUUID,
    persona: { address: config.address },
  });

  conversation.current = service;

  // Ctrl+C: cut the current reply off; a second Ctrl+C while idle quits.
  const stop = new AbortController();
  let lastSigint = 0;
  process.on("SIGINT", () => {
    const busy = service.currentState.kind === "thinking" || service.currentState.kind === "speaking";
    if (busy) service.dispatch({ kind: "bargeIn" });
    else if (Date.now() - lastSigint < 1500) stop.abort();
    else log("\n(Ctrl+C again to quit)");
    lastSigint = Date.now();
  });

  log(listening ? "Listening… speak whenever you're ready." : "Type a prompt and press Enter.");
  if (bargeIn) log(`While I talk, ${bargeIn}.`);
  await service.run(stop.signal);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);

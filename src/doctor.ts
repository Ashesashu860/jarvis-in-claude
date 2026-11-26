/**
 * `jarvis-rt doctor`: is everything jarvis-rt needs in place? Part of the composition root, since it
 * builds the real adapters; each check is small and stands alone. It makes no sound and asks Claude
 * nothing, so it's free to run.
 */
import { claudeLogin } from "./adapters/brain/claude-agent-brain.js";
import { runChecks, type Check } from "./adapters/cli/doctor-report.js";
import { defaultPaths, loadConfig, type Config } from "./adapters/config/file-config.js";
import { DecibriMic, outputIsHeadphones } from "./adapters/native/decibri-audio.js";
import { missingModels, modelsDir } from "./adapters/native/models.js";
import { KokoroSynthesizer, MoonshineTranscriber } from "./adapters/native/sherpa-engine.js";
import { parseBlend } from "./adapters/native/voice-blend.js";
import { Speaker } from "decibri";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const to16k = (s: Float32Array, rate: number) => {
  const r = rate / 16000, out = new Float32Array(Math.floor(s.length / r));
  for (let i = 0; i < out.length; i++) out[i] = s[Math.floor(i * r)] ?? 0;
  return out;
};

export async function doctor(write: (line: string) => void): Promise<number> {
  const paths = defaultPaths();
  const root = modelsDir();
  let config: Config | null = null;
  let spoken: { samples: Float32Array; rate: number } | null = null;
  const PHRASE = "Good evening, sir. All systems are ready.";

  const checks: Check[] = [
    {
      name: "Node.js",
      run: () => {
        const major = Number(process.versions.node.split(".")[0]);
        return Promise.resolve(major >= 22
          ? { status: "ok", detail: process.versions.node }
          : { status: "fail", detail: `${process.versions.node} is too old`, fix: "Install Node.js 22 or newer (https://nodejs.org)." });
      },
    },
    {
      name: "Settings",
      run: () => {
        try {
          config = loadConfig(paths.config);
          return Promise.resolve({ status: "ok", detail: `${paths.config} (voice ${config.speaker}, model ${config.model})` });
        } catch (err) {
          return Promise.resolve({ status: "fail", detail: err instanceof Error ? err.message : String(err), fix: `Fix or delete ${paths.config}.` });
        }
      },
    },
    {
      name: "Models",
      run: () => {
        const missing = missingModels(root);
        return Promise.resolve(missing.length === 0
          ? { status: "ok", detail: root }
          : { status: "fail", detail: `missing ${missing.map((m) => m.name).join(" and ")}`, fix: "Run jarvis-rt setup (about 440 MB, once)." });
      },
    },
    {
      name: "Voice",
      run: async () => {
        if (missingModels(root).length > 0) return { status: "fail", detail: "no models", fix: "Run jarvis-rt setup." };
        const c = config ?? loadConfig(paths.config);
        const voice = c.speaker === "jarvis" ? parseBlend(c.blend) : c.speaker;
        const synth = await KokoroSynthesizer.load(root, voice, c.speed);
        await synth.render("Ready."); // the first render warms up
        const t0 = performance.now();
        const samples = await synth.render(PHRASE);
        spoken = { samples, rate: synth.sampleRate };
        return { status: "ok", detail: `${c.speaker}, "${PHRASE}" rendered in ${Math.round(performance.now() - t0)} ms` };
      },
    },
    {
      name: "Speech recognition",
      run: async () => {
        if (!spoken) return { status: "fail", detail: "skipped: the voice didn't load", fix: "Fix the voice first." };
        const stt = await MoonshineTranscriber.load(root);
        const t0 = performance.now();
        const heard = (await stt.transcribe(to16k(spoken.samples, spoken.rate))).trim();
        const ms = Math.round(performance.now() - t0);
        return /evening/i.test(heard)
          ? { status: "ok", detail: `heard the voice back as "${heard}" in ${ms} ms` }
          : { status: "warn", detail: `heard "${heard}" instead of "${PHRASE}"`, fix: "Run jarvis-rt setup again to re-download the models." };
      },
    },
    {
      name: "Speaker",
      run: () => {
        const out = Speaker.devices().find((d) => d.isDefault);
        if (!out) return Promise.resolve({ status: "fail", detail: "no output device", fix: "Connect speakers or headphones." });
        const mode = outputIsHeadphones() ? "headphones: talk over Jarvis to cut him off"
          : "loudspeakers: say \"stop\", \"wait\" or \"hold on\" to cut him off (headphones let any speech do it)";
        return Promise.resolve({ status: "ok", detail: `${out.name} (${mode})` });
      },
    },
    {
      name: "Microphone",
      run: async () => {
        const mic = await DecibriMic.open({ endOfSpeechMs: 700 });
        let peak = 0, frames = 0;
        mic.onFrame((f) => { frames++; for (const x of f) peak = Math.max(peak, Math.abs(x)); });
        await sleep(1500);
        mic.close();
        if (frames === 0 || peak === 0) {
          return { status: "fail", detail: frames === 0 ? "no audio arrived" : "only silence (access is probably blocked)",
            fix: "Allow your terminal in System Settings → Privacy & Security → Microphone, then restart the terminal." };
        }
        return peak < 0.002
          ? { status: "warn", detail: `very quiet (peak ${peak.toFixed(4)})`, fix: "Check the input device and level in System Settings → Sound." }
          : { status: "ok", detail: `receiving sound (peak ${peak.toFixed(3)} over 1.5 s)` };
      },
    },
    {
      name: "Claude Code login",
      run: async () => {
        try {
          const login = await claudeLogin();
          return { status: "ok", detail: [login.provider === "firstParty" ? "signed in" : `via ${login.provider}`, login.plan].filter(Boolean).join(", ") };
        } catch (err) {
          return { status: "fail", detail: err instanceof Error ? err.message : String(err), fix: "Run claude once and sign in (or set ANTHROPIC_API_KEY)." };
        }
      },
    },
  ];
  return (await runChecks(checks, write)) ? 0 : 1;
}

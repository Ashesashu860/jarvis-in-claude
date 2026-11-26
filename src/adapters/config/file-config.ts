import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { JARVIS_BLEND, parseBlend } from "../native/voice-blend.js";

export const ConfigSchema = z.object({
  address: z.string().min(1).default("sir"),
  model: z.enum(["opus", "sonnet", "haiku"]).default("sonnet"),
  autoAllow: z.array(z.string()).default(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]),
  /** Speak replies aloud (false: text only). */
  voice: z.boolean().default(true),
  /** "jarvis" (the blend below), or a stock Kokoro voice: bm_daniel, bm_george, bm_fable, bm_lewis, bf_emma, … */
  speaker: z.enum(["jarvis", "bm_daniel", "bm_fable", "bm_george", "bm_lewis", "bf_alice", "bf_emma", "bf_isabella", "bf_lily"]).default("jarvis"),
  /** The "jarvis" voice: a mix of stock voices, "voice:weight,…". */
  blend: z.string().default(JARVIS_BLEND).refine((b) => { try { parseBlend(b); return true; } catch { return false; } },
    { error: 'a blend is "voice:weight,…" of bm_daniel, bm_george, bm_fable, bm_lewis, bf_alice, bf_emma, bf_isabella, bf_lily' }),
  speed: z.number().min(0.5).max(2).default(1.05),
  /** Listen through the microphone (false: type prompts). */
  listen: z.boolean().default(true),
  /** Silence, in milliseconds, that means you've finished speaking. */
  endOfSpeechMs: z.number().int().min(200).max(3000).default(700),
  /**
   * Talking over Jarvis. "auto": any speech cuts him off on headphones, only "stop", "wait",
   * "hold on", "Jarvis"… on loudspeakers (whose echo would otherwise cut him off). "anySpeech" or
   * "stopWord" force one; "off": he always finishes.
   */
  bargeIn: z.enum(["auto", "anySpeech", "stopWord", "off"]).default("auto"),
  /** How long you must talk over Jarvis before he stops, so a cough doesn't cut him off. */
  bargeInMs: z.number().int().min(100).max(2000).default(250),
});
export type Config = z.infer<typeof ConfigSchema>;

export interface Paths {
  readonly config: string;
  readonly sessions: string;
  readonly timings: string;
}

export function defaultPaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const configHome = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const stateHome = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return {
    config: env.JARVIS_RT_CONFIG ?? join(configHome, "jarvis-rt", "config.json"),
    sessions: join(stateHome, "jarvis-rt", "sessions.json"),
    timings: join(stateHome, "jarvis-rt", "timings.jsonl"),
  };
}

/** Read and validate the config file; a missing file means defaults, a bad one is an error. */
export function loadConfig(path: string): Config {
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Can't read ${path}: ${(err as Error).message}`, { cause: err });
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Invalid settings in ${path}: ${issues}`);
  }
  return parsed.data;
}

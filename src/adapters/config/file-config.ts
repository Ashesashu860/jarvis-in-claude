import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const ConfigSchema = z.object({
  address: z.string().min(1).default("sir"),
  model: z.enum(["opus", "sonnet", "haiku"]).default("sonnet"),
  autoAllow: z.array(z.string()).default(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]),
  /** Speak replies aloud (false: text only). */
  voice: z.boolean().default(true),
  /** Kokoro voice: bm_daniel, bm_george, bm_fable, bm_lewis, bf_emma, … */
  speaker: z.enum(["bm_daniel", "bm_fable", "bm_george", "bm_lewis", "bf_alice", "bf_emma", "bf_isabella", "bf_lily"]).default("bm_daniel"),
  speed: z.number().min(0.5).max(2).default(1.05),
  /** Listen through the microphone (false: type prompts). */
  listen: z.boolean().default(true),
  /** Silence, in milliseconds, that means you've finished speaking. */
  endOfSpeechMs: z.number().int().min(200).max(3000).default(700),
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

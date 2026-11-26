/** Where the speech models live, which ones are needed, and downloading them (`jarvis-rt setup`). */
import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

export interface ModelSpec {
  readonly name: string;
  readonly dir: string;
  readonly url: string;
  /** Files that must exist after unpacking. */
  readonly files: readonly string[];
  readonly approxMb: number;
}

export const KOKORO: ModelSpec = {
  name: "Kokoro voice (v1.0, full precision)",
  dir: "kokoro-multi-lang-v1_0",
  url: `${RELEASES}/tts-models/kokoro-multi-lang-v1_0.tar.bz2`,
  files: ["model.onnx", "voices.bin", "tokens.txt", "lexicon-gb-en.txt"],
  approxMb: 333,
};

export const MOONSHINE: ModelSpec = {
  name: "Moonshine speech recognition (base, English)",
  dir: "sherpa-onnx-moonshine-base-en-quantized-2026-02-27",
  url: `${RELEASES}/asr-models/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2`,
  files: ["encoder_model.ort", "decoder_model_merged.ort", "tokens.txt"],
  approxMb: 106,
};

export const REQUIRED_MODELS: readonly ModelSpec[] = [KOKORO, MOONSHINE];

/** British Kokoro voices (speaker ids from the model's own id2speaker metadata). */
export const VOICES = { bm_daniel: 24, bm_fable: 25, bm_george: 26, bm_lewis: 27, bf_alice: 20, bf_emma: 21, bf_isabella: 22, bf_lily: 23 } as const;
export type VoiceName = keyof typeof VOICES;

export function modelsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.JARVIS_RT_MODELS ?? join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "jarvis-rt", "models");
}

export function missingModels(root: string): ModelSpec[] {
  return REQUIRED_MODELS.filter((m) => !m.files.every((f) => existsSync(join(root, m.dir, f))));
}

/** Download and unpack every missing model. `log` gets one line per step. */
export async function installModels(root: string, log: (line: string) => void): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const m of missingModels(root)) {
    const archive = join(root, `${m.dir}.tar.bz2.part`);
    log(`Downloading ${m.name}, about ${m.approxMb} MB…`);
    const res = await fetch(m.url);
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${m.url}`);
    const expected = Number(res.headers.get("content-length") ?? 0);
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(archive));
    const got = (await stat(archive)).size;
    if (expected && got !== expected) {
      await rm(archive, { force: true });
      throw new Error(`Download of ${m.name} was cut off (${got} of ${expected} bytes). Run setup again.`);
    }
    log(`Unpacking ${m.name}…`);
    await promisify(execFile)("tar", ["xjf", archive, "-C", root]);
    await rm(archive, { force: true });
    if (missingModels(root).includes(m)) throw new Error(`${m.name} unpacked but files are missing in ${join(root, m.dir)}.`);
  }
}

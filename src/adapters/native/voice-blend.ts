/**
 * A voice of jarvis-rt's own: a weighted mix of stock Kokoro voices (each is a 510 x 256 table of
 * style vectors, so a mix is their weighted sum). The model insists on its 54 voice slots, so the
 * mix goes into a copy of voices.bin in place of the last slot, a Chinese voice jarvis-rt never
 * uses. The copy is made once per blend, next to the models; the downloaded file is left alone.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KOKORO, VOICES, type VoiceName } from "./models.js";

/** The original Jarvis voice: 60% bm_daniel (steady, brisk), 25% bm_george (crisp), 15% bm_fable (warm). */
export const JARVIS_BLEND = "bm_daniel:0.6,bm_george:0.25,bm_fable:0.15";
/** The slot the blend replaces in the copy. */
export const BLEND_SLOT = 53;
const PER_VOICE = 510 * 256;

export type Blend = readonly (readonly [VoiceName, number])[];

/** "bm_daniel:0.6,bm_george:0.4" -> weights summing to 1. Throws on unknown voices or bad weights. */
export function parseBlend(text: string): Blend {
  const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("A blend needs at least one voice, e.g. bm_daniel:0.6,bm_george:0.4");
  const raw = parts.map((p): [VoiceName, number] => {
    const [name = "", weight = "1"] = p.split(":").map((s) => s.trim());
    if (!(name in VOICES)) throw new Error(`Unknown voice "${name}" in blend. Voices: ${Object.keys(VOICES).join(", ")}`);
    const w = Number(weight);
    if (!Number.isFinite(w) || w <= 0) throw new Error(`Weight for ${name} must be a positive number (got "${weight}")`);
    return [name as VoiceName, w];
  });
  const total = raw.reduce((n, [, w]) => n + w, 0);
  return raw.map(([n, w]) => [n, w / total] as const);
}

/** The voice table with slot BLEND_SLOT replaced by the blend. Pure. */
export function mixVoices(voices: Float32Array, blend: Blend): Float32Array {
  if (voices.length % PER_VOICE !== 0 || voices.length / PER_VOICE <= BLEND_SLOT) throw new Error("Unexpected voices.bin layout");
  const out = new Float32Array(voices);
  const mix = new Float32Array(PER_VOICE);
  for (const [name, w] of blend) {
    const at = VOICES[name] * PER_VOICE;
    for (let i = 0; i < PER_VOICE; i++) mix[i] = (mix[i] ?? 0) + w * (voices[at + i] ?? 0);
  }
  out.set(mix, BLEND_SLOT * PER_VOICE);
  return out;
}

/** Path to a voices.bin holding `blend` at BLEND_SLOT, creating it on first use. */
export function blendedVoicesFile(root: string, blend: Blend): string {
  const key = createHash("sha256").update(JSON.stringify(blend)).digest("hex").slice(0, 12);
  const path = join(root, `voices-blend-${key}.bin`);
  if (existsSync(path)) return path;
  const buf = readFileSync(join(root, KOKORO.dir, "voices.bin"));
  const voices = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const mixed = mixVoices(voices, blend);
  writeFileSync(`${path}.part`, Buffer.from(mixed.buffer));
  renameSync(`${path}.part`, path);
  return path;
}

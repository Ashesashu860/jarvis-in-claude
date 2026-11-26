import { describe, expect, it } from "vitest";
import { runChecks } from "../../src/adapters/cli/doctor-report.js";
import { ConfigSchema } from "../../src/adapters/config/file-config.js";
import { BLEND_SLOT, JARVIS_BLEND, mixVoices, parseBlend } from "../../src/adapters/native/voice-blend.js";

const PER = 510 * 256;

describe("voice blend", () => {
  it("parses a blend and normalises the weights", () => {
    expect(parseBlend(JARVIS_BLEND)).toEqual([["bm_daniel", 0.6], ["bm_george", 0.25], ["bm_fable", 0.15]]);
    expect(parseBlend("bm_daniel:3, bm_lewis:1")).toEqual([["bm_daniel", 0.75], ["bm_lewis", 0.25]]);
    expect(parseBlend("bm_george")).toEqual([["bm_george", 1]]);
  });
  it("refuses unknown voices and bad weights", () => {
    expect(() => parseBlend("am_adam:1")).toThrow(/Unknown voice/);
    expect(() => parseBlend("bm_daniel:-1")).toThrow(/positive/);
    expect(() => parseBlend("")).toThrow(/at least one/);
    expect(ConfigSchema.safeParse({ blend: "nobody:1" }).success).toBe(false);
    expect(ConfigSchema.parse({})).toMatchObject({ speaker: "jarvis", blend: JARVIS_BLEND });
  });
  it("mixes the chosen voices into the blend slot and leaves the others alone", () => {
    const voices = new Float32Array(54 * PER);
    voices.fill(1, 24 * PER, 25 * PER); // bm_daniel = 1
    voices.fill(3, 26 * PER, 27 * PER); // bm_george = 3
    const out = mixVoices(voices, parseBlend("bm_daniel:1,bm_george:1"));
    expect(out[BLEND_SLOT * PER]).toBeCloseTo(2);
    expect(out[BLEND_SLOT * PER + PER - 1]).toBeCloseTo(2);
    expect(out[24 * PER]).toBe(1);
    expect(voices[BLEND_SLOT * PER]).toBe(0); // input untouched
    expect(() => mixVoices(new Float32Array(10), parseBlend("bm_daniel"))).toThrow(/layout/);
  });
});

describe("doctor report", () => {
  it("prints each check with a fix for problems; warnings don't fail, errors do", async () => {
    const lines: string[] = [];
    const ok = await runChecks([
      { name: "A", run: () => Promise.resolve({ status: "ok", detail: "fine" }) },
      { name: "B", run: () => Promise.resolve({ status: "warn", detail: "quiet", fix: "turn it up" }) },
    ], (l) => lines.push(l));
    expect(ok).toBe(true);
    expect(lines.slice(0, 3)).toEqual(["✓ A: fine", "! B: quiet", "    → turn it up"]);

    const failed = await runChecks([{ name: "C", run: () => Promise.reject(new Error("boom")) }], (l) => lines.push(l));
    expect(failed).toBe(false);
    expect(lines).toContain("✗ C: boom");
  });
});

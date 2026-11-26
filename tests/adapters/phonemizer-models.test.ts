import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KokoroPhonemizer, normalize } from "../../src/adapters/native/kokoro-phonemizer.js";
import { KOKORO, MOONSHINE, missingModels } from "../../src/adapters/native/models.js";

describe("Kokoro text normalisation (ported from kokoro-js)", () => {
  it.each([
    ["It costs £2.50.", "It costs 2 pounds and 50 pence."],
    ["Back in the 1990s.", "Back in the 19 90s."],
    ["Meet at 3:05.", "Meet at 3 oh 5."],
    ["Pi is 3.14", "Pi is 3 point 1 4"],
    ["Pages 4-7", "Pages 4 to 7"],
    ["Ask Dr. Smith", "Ask Doctor Smith"],
  ])("%s", (raw, out) => {
    expect(normalize(raw)).toBe(out);
  });
});

describe("KokoroPhonemizer", () => {
  it("gives every word phonemes, including ones Kokoro's lexicon lacks", async () => {
    const p = new KokoroPhonemizer();
    for (const word of ["makes", "happens", "GitHub", "Jarvis", "npm", "JSON"]) {
      expect((await p.phonemes(word)).length, word).toBeGreaterThan(1);
    }
  });

  it("keeps punctuation, which Kokoro uses for pauses and intonation", async () => {
    const out = await new KokoroPhonemizer().phonemes("Certainly, sir. Shall I?");
    expect(out).toMatch(/,/);
    expect(out).toMatch(/\./);
    expect(out.trim().endsWith("?")).toBe(true);
  });
});

describe("missingModels", () => {
  it("reports models until all their files exist", () => {
    const root = mkdtempSync(join(tmpdir(), "jrt-models-"));
    expect(missingModels(root).map((m) => m.dir)).toEqual([KOKORO.dir, MOONSHINE.dir]);
    for (const m of [KOKORO, MOONSHINE]) {
      mkdirSync(join(root, m.dir), { recursive: true });
      for (const f of m.files) writeFileSync(join(root, m.dir, f), "x");
    }
    expect(missingModels(root)).toEqual([]);
  });
});

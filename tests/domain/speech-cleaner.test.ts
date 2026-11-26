import { describe, expect, it } from "vitest";
import { cleanForSpeech } from "../../src/domain/speech-cleaner.js";

// The same cases as jarvis-voice's test_clean_for_speech_reads_code_naturally, plus markdown.
const CASES: [string, string][] = [
  ["I edited `speak_detached` in src/jarvis_voice/hooks.py:42.", "I edited speak detached in hooks dot py, line 42."],
  ["Released v0.3.0 at ~60 ms, 400 MB, 10s.", "Released version 0 point 3 point 0 at about 60 milliseconds, 400 megabytes, 10 seconds."],
  ["Run /jarvis:talk, e.g. now → done.", "Run jarvis talk, for example now to done."],
  ["Fixed parseConfig 🎉 & config.json", "Fixed parse Config and config dot json"],
  ["Use read/write, a 50/50 split, in the 1990s; version 3.5 is out.", "Use read/write, a 50/50 split, in the 1990s; version 3.5 is out."],
  ["See ~/.cache/jarvis-voice/models", "See models"],
  ["1 s later, took 0.78s.", "1 second later, took 0.78 seconds."],
  ["On macOS and iPhone via GitHub ✅", "On macOS and iPhone via GitHub"],
  ["1. First\n2) Second", "First Second"],
  ["**Done.** See [the docs](https://example.com) or https://x.dev/a.", "Done. See the docs or a link"],
];

describe("cleanForSpeech", () => {
  it.each(CASES)("%s", (raw, spoken) => {
    expect(cleanForSpeech(raw)).toBe(spoken);
  });
});

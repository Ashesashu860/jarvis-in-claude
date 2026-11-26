/**
 * The SpeechInput contract. Every adapter, and every fake, must pass this same suite
 * (Liskov substitution: the core can't tell them apart).
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { InputEvent, SpeechInput } from "../../src/application/ports.js";
import { KeyboardInput } from "../../src/adapters/cli/keyboard-input.js";
import { MicInput } from "../../src/adapters/native/mic-input.js";
import { FakeInput, FakeMic } from "../fakes.js";

interface Harness {
  input: SpeechInput;
  speak(text: string): void;
  close(): void;
}

const adapters: Record<string, () => Harness> = {
  KeyboardInput: () => {
    const stdin = new PassThrough();
    return { input: new KeyboardInput(stdin), speak: (t) => stdin.write(`${t}\n`), close: () => stdin.end() };
  },
  FakeInput: () => {
    const f = new FakeInput();
    return { input: f, speak: (t) => f.say(t), close: () => f.close() };
  },
  MicInput: () => {
    const mic = new FakeMic();
    const said: string[] = [];
    const transcriber = { transcribe: () => Promise.resolve(said.shift() ?? "") };
    const input = new MicInput({ mic, transcriber, clock: { now: () => performance.now(), wall: () => new Date() }, minSpeechMs: 100 });
    // The mic has no end of its own: closing it means aborting, so deliver what was said first.
    let ac: AbortController | null = null;
    return {
      input: { events: (signal: AbortSignal) => { ac = new AbortController(); signal.addEventListener("abort", () => ac?.abort()); return input.events(ac.signal); } },
      speak: (t) => { said.push(t); mic.utter(300); },
      close: () => { setTimeout(() => ac?.abort(), 20); },
    };
  },
};

async function collect(it: AsyncIterable<InputEvent>): Promise<InputEvent[]> {
  const out: InputEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

for (const [name, make] of Object.entries(adapters)) {
  describe(`SpeechInput contract: ${name}`, () => {
    it("delivers each utterance in order and ends when the source closes", async () => {
      const h = make();
      const events = collect(h.input.events(new AbortController().signal));
      h.speak("first thing");
      h.speak("second thing");
      h.close();
      const texts = (await events).flatMap((e) => (e.kind === "utterance" ? [e.text] : []));
      expect(texts).toEqual(["first thing", "second thing"]);
    });

    it("stops when the signal aborts", async () => {
      const h = make();
      const ac = new AbortController();
      const events = collect(h.input.events(ac.signal));
      h.speak("hello");
      await new Promise((r) => setTimeout(r, 5));
      ac.abort();
      await expect(events).resolves.toBeDefined();
    });

    it("never delivers an empty utterance", async () => {
      const h = make();
      const events = collect(h.input.events(new AbortController().signal));
      h.speak("real");
      h.close();
      expect((await events).every((e) => e.kind !== "utterance" || e.text.trim() !== "")).toBe(true);
    });
  });
}

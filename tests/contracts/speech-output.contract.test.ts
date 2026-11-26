/**
 * The SpeechOutput contract, run against every implementation: the core relies on
 * "firstAudio, then exactly one done, after endTurn" for every turn, and on hush never hanging.
 */
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { PlaybackEvent, SpeechOutput } from "../../src/application/ports.js";
import { ConsoleOutput } from "../../src/adapters/cli/console-output.js";
import { MirroredOutput } from "../../src/adapters/cli/mirrored-output.js";
import { NativeVoiceOutput } from "../../src/adapters/native/native-voice-output.js";
import { FakeSink, FakeSynth } from "../fakes.js";
import { FakeOutput, until } from "../fakes.js";

const sink = () => new Writable({ write(_c, _e, cb) { cb(); } });
const clock = { now: () => performance.now(), wall: () => new Date() };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

function nativeVoice(): Promise<SpeechOutput> {
  return Promise.resolve(new NativeVoiceOutput({ synth: new FakeSynth(), sink: new FakeSink(), clock }));
}

const implementations: Record<string, () => Promise<SpeechOutput>> = {
  ConsoleOutput: () => Promise.resolve(new ConsoleOutput(sink(), clock)),
  FakeOutput: () => Promise.resolve(new FakeOutput()),
  NativeVoiceOutput: nativeVoice,
  MirroredOutput: async () => new MirroredOutput(await nativeVoice(), [new ConsoleOutput(sink(), clock)]),
};

function record(output: SpeechOutput) {
  const ac = new AbortController();
  const events: PlaybackEvent[] = [];
  void (async () => { for await (const e of output.playback(ac.signal)) events.push(e); })();
  cleanups.push(() => { ac.abort(); return Promise.resolve(); });
  return events;
}

for (const [name, make] of Object.entries(implementations)) {
  describe(`SpeechOutput contract: ${name}`, () => {
    it("reports first audio, then exactly one done after endTurn", async () => {
      const out = await make();
      const events = record(out);
      out.say("Certainly, sir.", "t1");
      out.say("Two more pieces.", "t1");
      out.endTurn("t1");
      await until(() => events.some((e) => e.kind === "done"), 2000);
      await new Promise((r) => setTimeout(r, 30));
      const mine = events.filter((e) => e.turnId === "t1").map((e) => e.kind);
      expect(mine[0]).toBe("firstAudio");
      expect(mine.filter((k) => k === "done")).toHaveLength(1);
      expect(mine.at(-1)).toBe("done");
    });

    it("never reports done before endTurn", async () => {
      const out = await make();
      const events = record(out);
      out.say("Still streaming.", "t2");
      await new Promise((r) => setTimeout(r, 60));
      expect(events.some((e) => e.kind === "done")).toBe(false);
      out.endTurn("t2");
      await until(() => events.some((e) => e.kind === "done"), 2000);
    });

    it("hush stops the turn without hanging the next one", async () => {
      const out = await make();
      const events = record(out);
      out.say("A long reply.", "t3");
      out.hush();
      out.say("Next.", "t4");
      out.endTurn("t4");
      await until(() => events.some((e) => e.kind === "done" && e.turnId === "t4"), 2000);
    });
  });
}

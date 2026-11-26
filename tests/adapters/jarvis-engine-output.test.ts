import { afterEach, describe, expect, it } from "vitest";
import type { PlaybackEvent } from "../../src/application/ports.js";
import { JarvisEngineOutput } from "../../src/adapters/engine/jarvis-engine-output.js";
import { FakeEngine } from "../fake-engine.js";
import { until } from "../fakes.js";

const clock = { now: () => performance.now(), wall: () => new Date() };
const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const s of stops.splice(0)) await s(); });

function listen(out: JarvisEngineOutput): PlaybackEvent[] {
  const ac = new AbortController();
  const events: PlaybackEvent[] = [];
  void (async () => { for await (const e of out.playback(ac.signal)) events.push(e); })();
  stops.push(() => ac.abort());
  return events;
}

describe("JarvisEngineOutput", () => {
  it("sends pieces in order, tagged per turn, to its own session", async () => {
    const engine = new FakeEngine(1);
    await engine.start();
    stops.push(() => engine.stop());
    const out = new JarvisEngineOutput({ socketPath: engine.path, clock, startCommand: [] });
    const events = listen(out);
    for (const text of ["One.", "Two.", "Three.", "Four.", "Five."]) out.say(text, "t1");
    out.endTurn("t1");
    await until(() => events.some((e) => e.kind === "done"), 2000);
    expect(engine.said.map((s) => s.text)).toEqual(["One.", "Two.", "Three.", "Four.", "Five."]);
    expect(new Set(engine.said.map((s) => s.tag.split("#")[0]))).toEqual(new Set(["t1"]));
  });

  it("forwards hush to the engine", async () => {
    const engine = new FakeEngine(50);
    await engine.start();
    stops.push(() => engine.stop());
    const out = new JarvisEngineOutput({ socketPath: engine.path, clock, startCommand: [] });
    out.say("Long.", "t1");
    out.hush();
    await until(() => engine.hushes === 1, 2000);
  });

  it("doesn't hang when no daemon is running: warns once and finishes the turn", async () => {
    const warnings: string[] = [];
    const out = new JarvisEngineOutput({
      socketPath: "/tmp/jarvis-rt-no-such.sock", clock, startCommand: [], startTimeoutMs: 200,
      onWarning: (m) => warnings.push(m),
    });
    const events = listen(out);
    out.say("Hello?", "t1");
    out.say("Anyone?", "t1");
    out.endTurn("t1");
    await until(() => events.some((e) => e.kind === "done"), 3000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Voice unavailable/);
  });
});

import { describe, expect, it } from "vitest";
import { ConversationService } from "../../src/application/conversation-service.js";
import { FakeBrain, FakeInput, FakeOutput, MemoryTimings, fakeClock, reply, until } from "../fakes.js";

function setup(script: ConstructorParameters<typeof FakeBrain>[0]) {
  const input = new FakeInput();
  const output = new FakeOutput();
  const brain = new FakeBrain(script);
  const timings = new MemoryTimings();
  let n = 0;
  const service = new ConversationService({
    input, output, brain, control: brain, timings, clock: fakeClock(), newId: () => `t${++n}`, persona: { address: "sir" },
  });
  const running = service.run(new AbortController().signal);
  return { input, output, brain, timings, service, running };
}

describe("ConversationService", () => {
  it("speaks a streamed reply sentence by sentence and records the turn", async () => {
    const { input, output, brain, timings, running } = setup(() => reply("Certainly, sir. A port is ", "an interface. Done."));
    input.say("What is a port?");
    input.close();
    await running;
    expect(brain.prompts).toEqual(["What is a port?"]);
    expect(output.spoken).toEqual(["Certainly, sir.", "A port is an interface.", "Done."]);
    expect(timings.records).toHaveLength(1);
    expect(timings.records[0]).toMatchObject({ heard: "What is a port?", outcome: "done", speechMs: 1000, sttMs: 500 });
    expect(brain.controls).toContain("close");
  });

  it("on barge-in: hushes, interrupts, and never speaks text that arrives afterwards", async () => {
    const { input, output, brain, timings, running } = setup((p) => (p === "Count" ? "hold" : reply("Yes.")));
    input.say("Count");
    await until(() => output.spoken.length === 2); // "One." "Two."
    input.bargeIn();
    await until(() => brain.interrupts === 1);
    brain.lateDelta("Three. Four. ");
    input.say("Still there?");
    input.close();
    await running;
    expect(output.hushes).toBeGreaterThan(0);
    expect(output.spoken).toEqual(["One.", "Two.", "Yes."]);
    expect(timings.records.map((r) => r.outcome)).toEqual(["interrupted", "done"]);
  });

  it("carries out voice commands through the control port", async () => {
    const { input, output, brain, running } = setup(() => reply("Ok."));
    input.say("Use Opus");
    input.say("New conversation");
    input.say("Goodbye");
    await running;
    expect(brain.controls.slice(0, 2)).toEqual(["model:opus", "new"]);
    expect(output.announced).toEqual(["Switching to opus, sir.", "Of course, sir. Starting afresh.", "Very good, sir."]);
    expect(brain.prompts).toEqual([]);
  });

  it("turns a brain error into a spoken apology and keeps going", async () => {
    const { input, output, running } = setup((p) =>
      p === "Break" ? [{ kind: "error", message: "network down", retryable: true }] : reply("Fine."),
    );
    input.say("Break");
    input.say("Again");
    input.close();
    await running;
    expect(output.announced).toEqual(["I'm afraid something went wrong, sir: network down"]);
    expect(output.spoken).toEqual(["Fine."]);
  });
});

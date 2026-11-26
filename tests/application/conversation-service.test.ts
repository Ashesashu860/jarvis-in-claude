import { describe, expect, it } from "vitest";
import { ConversationService } from "../../src/application/conversation-service.js";
import type { AgentEvent } from "../../src/application/ports.js";
import type { Answer } from "../../src/domain/intents.js";
import { FakeBrain, FakeInput, FakeOutput, MemoryTimings, fakeClock, reply, until } from "../fakes.js";

function setup(script: ConstructorParameters<typeof FakeBrain>[0], askTimeoutMs?: number) {
  const input = new FakeInput();
  const output = new FakeOutput();
  const brain = new FakeBrain(script);
  const timings = new MemoryTimings();
  let n = 0;
  const service = new ConversationService({
    input, output, brain, control: brain, timings, clock: fakeClock(), newId: () => `t${++n}`, persona: { address: "sir" },
    ...(askTimeoutMs !== undefined ? { askTimeoutMs } : {}),
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

describe("ConversationService: permission questions and narration", () => {
  /** A turn that asks to run `npm test` mid-reply, the way the SDK calls canUseTool. */
  function asking(answers: Answer[], ref: { service?: ConversationService }) {
    return (p: string) => p !== "Run the tests" ? reply("Fine.") : async function* (signal: AbortSignal): AsyncIterable<AgentEvent> {
      yield { kind: "text", delta: "Right away. " };
      if (!ref.service) throw new Error("no service");
      answers.push(await ref.service.ask({ tool: "Bash", summary: "npm test", description: "Run the test suite" }, signal));
      yield* reply(answers.at(-1) === "no" ? "As you wish." : "All green.");
    };
  }

  it("asks out loud, and the user's yes lets the call run", async () => {
    const answers: Answer[] = [];
    const ref: { service?: ConversationService } = {};
    const h = setup(asking(answers, ref));
    ref.service = h.service;
    h.input.say("Run the tests");
    await until(() => h.output.spoken.includes("I'd like to run the test suite. Shall I, sir?"));
    h.input.say("Yes, go ahead.");
    await until(() => h.output.spoken.includes("All green."));
    expect(answers).toEqual(["yes"]);
    expect(h.output.spoken).toEqual(["Right away.", "I'd like to run the test suite. Shall I, sir?", "All green."]);
    expect(h.brain.prompts).toEqual(["Run the tests"]); // the answer was not sent to Claude as a prompt
    h.input.close();
    await h.running;
  });

  it("asks again, briefly, when the reply isn't an answer, and takes no for no", async () => {
    const answers: Answer[] = [];
    const ref: { service?: ConversationService } = {};
    const h = setup(asking(answers, ref));
    ref.service = h.service;
    h.input.say("Run the tests");
    await until(() => h.output.spoken.length === 2);
    h.input.say("What's the weather like?");
    await until(() => h.output.spoken.includes("Sorry, sir: yes or no?"));
    h.input.say("No, don't.");
    await until(() => h.output.spoken.includes("As you wish."));
    expect(answers).toEqual(["no"]);
    h.input.close();
    await h.running;
  });

  it("refuses when the user cuts in, and when nobody answers in time", async () => {
    const answers: Answer[] = [];
    const ref: { service?: ConversationService } = {};
    const h = setup(asking(answers, ref), 30);
    ref.service = h.service;
    h.input.say("Run the tests");
    await until(() => answers.length === 1, 2000); // timed out
    expect(answers).toEqual(["no"]);
    expect(h.output.spoken).toContain("I'll take that as a no, sir.");
    h.input.say("Run the tests");
    await until(() => h.output.spoken.filter((t) => t.startsWith("I'd like to")).length === 2);
    h.input.say("Stop.");
    await until(() => answers.length === 2);
    expect(answers).toEqual(["no", "no"]);
    expect(h.brain.interrupts).toBe(1);
    h.input.close();
    await h.running;
  });

  it("narrates calls that don't need asking, once per kind in a turn", async () => {
    const tool = (name: string, summary: string): AgentEvent => ({ kind: "tool", name, summary });
    const { input, output, running } = setup(() => [
      { kind: "text", delta: "Let me look. " }, tool("Read", "/repo/src/main.ts"), tool("Grep", "TODO"), tool("Glob", "**/*.ts"),
      { kind: "text", delta: "Found it" }, tool("Bash", "npm test"), ...reply(". Done."),
    ]);
    input.say("Find the bug");
    input.close();
    await running;
    expect(output.spoken).toEqual(["Let me look.", "Reading main.ts.", "Searching the code.", "Found it.", "Done."]);
  });
});

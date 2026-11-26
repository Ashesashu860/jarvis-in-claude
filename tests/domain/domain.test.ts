import { describe, expect, it } from "vitest";
import { parseIntent } from "../../src/domain/intents.js";
import { classify } from "../../src/domain/permission-policy.js";
import { SentenceChunker } from "../../src/domain/sentence-chunker.js";
import { createReducer, initialState, type Event, type State } from "../../src/domain/turn-state.js";

describe("SentenceChunker", () => {
  const feed = (deltas: string[], chunker = new SentenceChunker()) => [...deltas.flatMap((d) => chunker.push(d)), ...chunker.flush()];

  it("emits each sentence as soon as it is complete", () => {
    const c = new SentenceChunker();
    expect(c.push("Certainly, sir. I'll ")).toEqual(["Certainly, sir."]);
    expect(c.push("check the tests")).toEqual([]);
    expect(c.push(" now. Done")).toEqual(["I'll check the tests now."]);
    expect(c.flush()).toEqual(["Done"]);
  });

  it("waits on a full stop at the end of the buffer, so decimals survive", () => {
    expect(feed(["It took 3.", "5 seconds. Fine."])).toEqual(["It took 3.5 seconds.", "Fine."]);
  });

  it("keeps abbreviations inside the sentence", () => {
    expect(feed(["Right. Use a port, e.g. SpeechInput, for that. Then test."])).toEqual([
      "Right.",
      "Use a port, e.g. SpeechInput, for that.",
      "Then test.",
    ]);
  });

  it("cuts a long first sentence at a comma so speaking starts sooner, but only the first", () => {
    const out = feed(["I've taken the liberty of reviewing the tests, and two of them fail. Later, much later, more."]);
    expect(out).toEqual(["I've taken the liberty of reviewing the tests,", "and two of them fail.", "Later, much later, more."]);
  });

  it("drops fenced code blocks, even when the fence arrives in pieces", () => {
    expect(feed(["Here it is.\n``", "`ts\nconst x = 1;\n``", "`\nThat's all."])).toEqual(["Here it is.", "That's all."]);
  });

  it("forgets everything on reset (after an interrupt)", () => {
    const c = new SentenceChunker();
    c.push("Four. Five. Six");
    c.reset();
    expect(c.flush()).toEqual([]);
  });
});

describe("parseIntent", () => {
  it("only treats the whole utterance as a command", () => {
    expect(parseIntent("Goodbye, Jarvis.")).toEqual({ kind: "goodbye" });
    expect(parseIntent("Shut down the dev server").kind).toBe("prompt");
    expect(parseIntent("Let's start over.")).toEqual({ kind: "newConversation" });
    expect(parseIntent("Make the animation start over at the end").kind).toBe("prompt");
    expect(parseIntent("Okay, use Opus please")).toEqual({ kind: "useModel", model: "opus" });
    expect(parseIntent("Wait!")).toEqual({ kind: "pause" });
  });
});

describe("classify (permission policy)", () => {
  it("allows reading, asks for changes, and refuses destructive commands", () => {
    expect(classify("Read", "src/main.ts")).toBe("allow");
    expect(classify("Edit", "src/main.ts")).toBe("ask");
    expect(classify("Bash", "npm test")).toBe("ask");
    expect(classify("Bash", "rm -rf ~")).toBe("deny");
    expect(classify("Bash", "git push --force origin main")).toBe("deny");
  });
});

describe("turn reducer", () => {
  const reduce = createReducer({ address: "sir" });
  const run = (events: Event[], start: State = initialState) => {
    let state = start;
    const commands = [];
    for (const e of events) {
      const [s, c] = reduce(state, e);
      state = s;
      commands.push(...c);
    }
    return { state, kinds: commands.map((c) => c.kind), commands };
  };

  it("runs a turn: send, speak sentences, finish after playback", () => {
    const r = run([
      { kind: "utterance", text: "What is a port?", turnId: "t1" },
      { kind: "sentence", turnId: "t1", text: "An interface." },
      { kind: "replyDone", turnId: "t1" },
    ]);
    expect(r.kinds).toEqual(["send", "say", "endTurn"]);
    expect(r.state).toMatchObject({ kind: "speaking", replyDone: true });
    expect(run([{ kind: "playbackDone", turnId: "t1" }], r.state).state).toEqual({ kind: "listening" });
  });

  it("cuts the reply off on barge-in and ignores its late events", () => {
    const r = run([
      { kind: "utterance", text: "Count to thirty", turnId: "t1" },
      { kind: "sentence", turnId: "t1", text: "One." },
      { kind: "bargeIn" },
      { kind: "sentence", turnId: "t1", text: "Two." },
    ]);
    expect(r.kinds).toEqual(["send", "say", "hush", "interrupt"]);
    expect(r.state).toEqual({ kind: "listening" });
  });

  it("queues a prompt typed while a reply runs, and starts it afterwards", () => {
    const r = run([
      { kind: "utterance", text: "First", turnId: "t1" },
      { kind: "utterance", text: "Second", turnId: "t2" },
      { kind: "sentence", turnId: "t1", text: "Done." },
      { kind: "replyDone", turnId: "t1" },
      { kind: "playbackDone", turnId: "t1" },
    ]);
    expect(r.commands.flatMap((c) => (c.kind === "send" ? [c.text] : []))).toEqual(["First", "Second"]);
    expect(r.state).toMatchObject({ kind: "thinking", turnId: "t2" });
  });

  it("acts on a command at once, even mid-reply", () => {
    const r = run([
      { kind: "utterance", text: "Explain everything", turnId: "t1" },
      { kind: "utterance", text: "Stop.", turnId: "t2" },
    ]);
    expect(r.kinds).toEqual(["send", "hush", "interrupt"]);
    expect(r.state).toEqual({ kind: "listening" });
  });

  it("lets the reply finish when input closes, then exits", () => {
    const r = run([
      { kind: "utterance", text: "Hi", turnId: "t1" },
      { kind: "inputClosed" },
      { kind: "replyDone", turnId: "t1" },
    ]);
    expect(r.kinds).toEqual(["send", "exit"]);
    expect(r.state).toEqual({ kind: "idle" });
  });

  it("reports a failed reply politely and listens again", () => {
    const r = run([{ kind: "utterance", text: "Hi", turnId: "t1" }, { kind: "replyFailed", turnId: "t1", message: "offline" }]);
    expect(r.commands.at(-1)).toEqual({ kind: "acknowledge", text: "I'm afraid something went wrong, sir: offline" });
    expect(r.state).toEqual({ kind: "listening" });
  });
});

describe("SentenceChunker: a quick first piece", () => {
  it("ends a long first piece at a word break, without waiting for the sentence to end", () => {
    const c = new SentenceChunker();
    expect(c.push("A port is an interface that the application core defines")).toEqual(["A port is an interface that the application core"]);
    expect(c.push(" for the outside world. Fine.")).toEqual(["defines for the outside world."]);
  });

  it("leaves a short opening alone", () => {
    expect(new SentenceChunker().push("Certainly, sir. More")).toEqual(["Certainly, sir."]);
  });
});

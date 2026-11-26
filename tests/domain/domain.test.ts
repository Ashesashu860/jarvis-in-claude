import { describe, expect, it } from "vitest";
import { foreignWords, isCuttingIn, isEcho } from "../../src/domain/echo.js";
import { parseAnswer, parseIntent } from "../../src/domain/intents.js";
import { narration, permissionQuestion } from "../../src/domain/tool-speech.js";
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

describe("isEcho", () => {
  const said = "Certainly, sir. I've updated the config and the tests pass.";
  it("recognises Jarvis's own words coming back through the microphone", () => {
    expect(isEcho("I've updated the config", said)).toBe(true);
    expect(isEcho("the tests pass sir", said)).toBe(true);
  });
  it("lets the user's own words through, even with a few of Jarvis's in them", () => {
    expect(isEcho("stop", said)).toBe(false);
    expect(isEcho("wait, revert the config change", said)).toBe(false);
    expect(isEcho("anything", "")).toBe(false);
    expect(isEcho("", said)).toBe(false);
  });
});

describe("isCuttingIn", () => {
  const said = "Certainly, sir. I have read the configuration file and the three tests that cover it.";
  it("forgives small recognition errors in Jarvis's echo", () => {
    expect(foreignWords("I have read the configur files", said)).toEqual([]);
    expect(foreignWords("the three test that covered it", said)).toEqual([]);
  });
  it("on loudspeakers, needs a stop word Jarvis didn't say", () => {
    expect(isCuttingIn("the configuration hold on jarvis", said, "stopWord")).toBe(true);
    expect(isCuttingIn("wait", said, "stopWord")).toBe(true);
    expect(isCuttingIn("circumstruction of the mother body", said, "stopWord")).toBe(false); // garbled echo
    expect(isCuttingIn("please wait", "Please wait while I build it.", "stopWord")).toBe(false); // his own "wait"
  });
  it("on headphones, a fair share of new words is enough", () => {
    expect(isCuttingIn("actually use the other file", said, "anySpeech")).toBe(true);
    expect(isCuttingIn("I have read the configuration file", said, "anySpeech")).toBe(false);
    expect(isCuttingIn("bill bill bill bill", said, "anySpeech")).toBe(false); // a recogniser stuck on one word
  });
});

describe("tool speech", () => {
  it("asks in plain words, using Claude's own description when there is one", () => {
    expect(permissionQuestion({ tool: "Bash", summary: "npm test", description: "Run the test suite." }, "sir"))
      .toBe("I'd like to run the test suite. Shall I, sir?");
    expect(permissionQuestion({ tool: "Bash", summary: "git status" }, "sir")).toBe("I'd like to run git status. Shall I, sir?");
    expect(permissionQuestion({ tool: "Bash", summary: "a b c d e f g h i j" }, "sir")).toBe("I'd like to run a b c d e f g h, and so on. Shall I, sir?");
    expect(permissionQuestion({ tool: "Edit", summary: "/repo/src/main.ts" }, "madam")).toBe("I'd like to edit main.ts. Shall I, madam?");
    expect(permissionQuestion({ tool: "WebFetch", summary: "https://www.example.com/x" }, "sir")).toBe("I'd like to open example.com. Shall I, sir?");
  });
  it("narrates only the calls worth mentioning", () => {
    expect(narration({ tool: "Read", summary: "/a/b/config.json" })).toBe("Reading config.json.");
    expect(narration({ tool: "Grep", summary: "x" })).toBe("Searching the code.");
    expect(narration({ tool: "TodoWrite", summary: "" })).toBeNull();
  });
});

describe("parseAnswer", () => {
  it("hears yes, no and always in their everyday forms", () => {
    for (const t of ["Yes.", "yeah", "Sure, go ahead", "Go ahead please", "Do it", "yes sir", "OK", "y"]) expect(parseAnswer(t)).toBe("yes");
    for (const t of ["No.", "Nope", "Don't.", "No thanks", "Not now", "No, don't", "n", "Jarvis, no"]) expect(parseAnswer(t)).toBe("no");
    for (const t of ["Always.", "Yes, always", "Don't ask again"]) expect(parseAnswer(t)).toBe("always");
  });
  it("is not fooled by sentences that merely contain those words", () => {
    for (const t of ["No idea what that does", "Yes but first explain it", "What's the weather like?", ""]) expect(parseAnswer(t)).toBeNull();
  });
});

describe("turn reducer: asking", () => {
  const reduce = createReducer({ address: "sir" });
  const asking: State = { kind: "speaking", turnId: "t1", queue: [], exitAfter: false, replyDone: false, asking: { id: "q1", text: "Shall I?" } };
  it("takes the user's words as the answer while a question waits", () => {
    const [s, c] = reduce(asking, { kind: "utterance", text: "Yes please", turnId: "t2" });
    expect(c).toEqual([{ kind: "answer", id: "q1", answer: "yes" }]);
    expect(s).toMatchObject({ kind: "speaking", asking: null });
  });
  it("refuses when the reply is cut off while asking", () => {
    const [, c] = reduce(asking, { kind: "bargeIn" });
    expect(c.map((x) => x.kind)).toEqual(["answer", "hush", "interrupt"]);
    expect(c[0]).toEqual({ kind: "answer", id: "q1", answer: "no" });
  });
  it("ignores a late timeout for a question already answered", () => {
    const [s, c] = reduce({ ...asking, asking: null }, { kind: "permissionTimedOut", turnId: "t1", id: "q1" });
    expect(c).toEqual([]);
    expect(s).toMatchObject({ asking: null });
  });
});

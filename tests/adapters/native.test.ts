import { describe, expect, it } from "vitest";
import type { PlaybackEvent, InputEvent } from "../../src/application/ports.js";
import { MicInput, type MicInputOptions, UtteranceSegmenter } from "../../src/adapters/native/mic-input.js";
import { NativeVoiceOutput } from "../../src/adapters/native/native-voice-output.js";
import { PacedReference } from "../../src/adapters/native/paced-reference.js";
import { FakeMic, FakeSink, FakeSynth, FakeTranscriber, until } from "../fakes.js";

const clock = { now: () => performance.now(), wall: () => new Date() };

function listen(out: NativeVoiceOutput): PlaybackEvent[] {
  const events: PlaybackEvent[] = [];
  void (async () => { for await (const e of out.playback(new AbortController().signal)) events.push(e); })();
  return events;
}

describe("NativeVoiceOutput", () => {
  it("cleans pieces for speech and renders them in order", async () => {
    const synth = new FakeSynth();
    const out = new NativeVoiceOutput({ synth, sink: new FakeSink(), clock });
    const events = listen(out);
    out.say("I edited `speak_detached`.", "t1");
    out.say("**Done.**", "t1");
    out.endTurn("t1");
    await until(() => events.some((e) => e.kind === "done"), 2000);
    expect(synth.rendered).toEqual(["I edited speak detached.", "Done."]);
  });

  it("reports done only after the audio has had time to play", async () => {
    const out = new NativeVoiceOutput({ synth: new FakeSynth(0), sink: new FakeSink(), clock });
    const events = listen(out);
    const t0 = performance.now();
    out.say("x".repeat(15), "t1"); // 15 chars * 10 ms = 150 ms of audio
    out.endTurn("t1");
    await until(() => events.some((e) => e.kind === "done"), 2000);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(140);
    expect(events.map((e) => e.kind)).toEqual(["firstAudio", "done"]);
  });

  it("hush stops the sink, drops what's queued and cancels pending events", async () => {
    const sink = new FakeSink();
    const synth = new FakeSynth(5);
    const out = new NativeVoiceOutput({ synth, sink, clock });
    const events = listen(out);
    out.say("first piece", "t1");
    out.say("second piece", "t1");
    out.endTurn("t1");
    out.hush();
    await new Promise((r) => setTimeout(r, 80));
    expect(sink.stops).toBe(1);
    expect(events.filter((e) => e.turnId === "t1" && e.kind === "done")).toEqual([]);
    expect(synth.rendered.length).toBeLessThanOrEqual(1); // at most the one already rendering
    expect(out.isSpeaking()).toBe(false);
  });

  it("hands each piece's audio and start time to the echo reference, remembers what it said, and reports a hush", async () => {
    const played: { length: number; rate: number; startAt: number }[] = [];
    let hushes = 0;
    const synth = new FakeSynth(0);
    const out = new NativeVoiceOutput({
      synth, sink: new FakeSink(), clock,
      onAudio: (s, rate, startAt) => played.push({ length: s.length, rate, startAt }),
      onHush: () => hushes++,
    });
    const events = listen(out);
    out.say("Certainly, sir.", "t1");
    out.say("Done.", "t1");
    out.endTurn("t1");
    await until(() => events.some((e) => e.kind === "done"), 2000);
    expect(played).toHaveLength(2);
    expect(played[1]?.startAt).toBeGreaterThanOrEqual((played[0]?.startAt ?? 0) + 140); // queued after the first
    expect(out.recentSpeech()).toBe("Certainly, sir. Done.");
    expect(out.recentSpeech(-1000)).toBe(""); // older than the window
    out.hush();
    expect(hushes).toBe(1);
  });

  it("skips pieces with nothing speakable", async () => {
    const synth = new FakeSynth();
    const out = new NativeVoiceOutput({ synth, sink: new FakeSink(), clock });
    const events = listen(out);
    out.say("🎉", "t1");
    out.endTurn("t1");
    await until(() => events.some((e) => e.kind === "done"), 2000);
    expect(synth.rendered).toEqual([]);
  });
});

describe("UtteranceSegmenter", () => {
  it("keeps a short pre-roll so the first syllable isn't clipped", () => {
    const seg = new UtteranceSegmenter(1000, 30);
    for (let i = 0; i < 10; i++) seg.frame(new Float32Array(10).fill(i));
    seg.speechStarted();
    seg.frame(new Float32Array(10).fill(99));
    const audio = seg.speechEnded();
    expect(audio?.length).toBe(40); // 30 ms pre-roll + 10 ms of speech
    expect(audio?.[0]).toBe(7);
    expect(seg.speechEnded()).toBeNull();
  });
});

describe("MicInput", () => {
  function run(mic: FakeMic, transcriber: FakeTranscriber, opts: Partial<MicInputOptions> = {}) {
    const ac = new AbortController();
    const events: InputEvent[] = [];
    const input = new MicInput({ mic, transcriber, clock, minSpeechMs: 300, prerollMs: 0, ...opts });
    void (async () => { for await (const e of input.events(ac.signal)) events.push(e); })();
    return { events, stop: () => ac.abort() };
  }

  it("turns one stretch of speech into one utterance", async () => {
    const mic = new FakeMic();
    const { events, stop } = run(mic, new FakeTranscriber(["What is a port?"]));
    mic.utter(500);
    await until(() => events.some((e) => e.kind === "utterance"));
    expect(events.map((e) => e.kind)).toEqual(["speechStart", "utterance"]);
    expect(events[1]).toMatchObject({ kind: "utterance", text: "What is a port?", speechMs: 500 });
    stop();
    expect(mic.closed).toBe(true);
  });

  it("ignores clicks and noise transcripts", async () => {
    const mic = new FakeMic();
    const transcriber = new FakeTranscriber(["Thank you.", "Real request"]);
    const { events } = run(mic, transcriber);
    mic.utter(100);        // too short: a click
    mic.utter(600);        // "Thank you." is what recognisers write over noise
    mic.utter(600);
    await until(() => events.some((e) => e.kind === "utterance"));
    expect(events.filter((e) => e.kind === "utterance")).toMatchObject([{ text: "Real request" }]);
    expect(transcriber.heard).toHaveLength(2);
  });

  const anySpeech = { afterMs: 250, rule: "anySpeech" as const };
  const stopWord = { afterMs: 250, rule: "stopWord" as const };

  it("cuts Jarvis off once the user has talked over him long enough, then delivers what they said", async () => {
    const mic = new FakeMic();
    // The first transcription is the barge-in check on the latest moment; the second, the whole utterance.
    const transcriber = new FakeTranscriber(["actually use the", "Actually, use the other file."]);
    const { events } = run(mic, transcriber, { speaking: () => true, recentSpeech: () => "Certainly, sir.", bargeIn: anySpeech });
    mic.startSpeech();
    mic.speech(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(events.map((e) => e.kind)).toEqual([]); // not yet: could be a cough
    mic.speech(100);
    await until(() => events.length > 0);
    expect(events.map((e) => e.kind)).toEqual(["bargeIn"]);
    mic.speech(300);
    mic.endSpeech();
    await until(() => events.some((e) => e.kind === "utterance"));
    expect(events.map((e) => e.kind)).toEqual(["bargeIn", "utterance"]); // one barge-in per stretch
    expect(transcriber.heard).toHaveLength(2);
  });

  it("does not cut Jarvis off on his own voice coming back through the microphone", async () => {
    const mic = new FakeMic();
    const checks: string[] = [];
    const transcriber = new FakeTranscriber(["the build pass", "the build passed sir", "Certainly sir the build passed"]);
    const { events } = run(mic, transcriber, {
      speaking: () => true, recentSpeech: () => "Certainly, sir. The build passed.", bargeIn: anySpeech,
      onCheck: (heard) => checks.push(heard),
    });
    mic.startSpeech();
    for (let i = 0; i < 6; i++) { mic.speech(100); await new Promise((r) => setTimeout(r, 5)); }
    mic.endSpeech();
    await until(() => transcriber.heard.length === 3);
    await new Promise((r) => setTimeout(r, 10));
    expect(checks).toEqual(["the build pass", "the build passed sir"]); // re-checked as the speech went on
    expect(events).toEqual([]); // no barge-in, and the echo isn't delivered as a prompt
  });

  it("does not count frames the detector isn't sure are speech", async () => {
    const mic = new FakeMic();
    const transcriber = new FakeTranscriber([""]);
    const { events } = run(mic, transcriber, { speaking: () => true, bargeIn: anySpeech });
    mic.startSpeech();
    mic.speech(1000, 0.2); // a murmur
    mic.endSpeech();
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e.kind === "bargeIn")).toEqual([]);
    expect(transcriber.heard).toHaveLength(1); // only the final transcription, no check
  });

  it("on loudspeakers, only a stop word cuts in, and what follows it is the next utterance", async () => {
    const mic = new FakeMic();
    const transcriber = new FakeTranscriber(["the bill bill bill", "certainly hold on jarvis", "use the other database"]);
    const { events } = run(mic, transcriber, {
      speaking: () => !events.some((e) => e.kind === "bargeIn"), recentSpeech: () => "Certainly, sir. The build passed.", bargeIn: stopWord,
    });
    mic.startSpeech();
    mic.speech(300);
    await until(() => transcriber.heard.length === 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual([]); // garbled echo: not a stop word
    mic.speech(300);
    await until(() => events.some((e) => e.kind === "bargeIn"));
    mic.speech(500);
    mic.endSpeech();
    await until(() => events.some((e) => e.kind === "utterance"));
    expect(events.filter((e) => e.kind === "utterance")).toMatchObject([{ text: "use the other database" }]);
    expect(transcriber.heard[2]).toBe(500); // only the audio after the stop word (FakeMic: 1 sample per ms)
  });

  it("on loudspeakers, speech over Jarvis without a stop word is ignored", async () => {
    const mic = new FakeMic();
    const transcriber = new FakeTranscriber(["of coo of coo", "of course"]);
    const { events } = run(mic, transcriber, { speaking: () => true, recentSpeech: () => "Of course.", bargeIn: stopWord });
    mic.utter(400);
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([]);
    expect(transcriber.heard).toHaveLength(1); // the check; the rest isn't even transcribed
  });

  it("drops a finished transcript that is Jarvis's own words", async () => {
    const mic = new FakeMic();
    const transcriber = new FakeTranscriber(["the build passed sir", "and run the tests"]);
    const { events } = run(mic, transcriber, { recentSpeech: () => "Certainly, sir. The build passed." });
    mic.utter(600);
    mic.utter(600);
    await until(() => events.some((e) => e.kind === "utterance"));
    expect(events.filter((e) => e.kind === "utterance")).toMatchObject([{ text: "and run the tests" }]);
  });

  it("with barge-in off, ignores speech that starts while Jarvis is talking", async () => {
    const mic = new FakeMic();
    let speaking = true;
    const transcriber = new FakeTranscriber(["Real request"]);
    const { events } = run(mic, transcriber, { speaking: () => speaking, bargeIn: false });
    mic.utter(600);        // ignored, not even transcribed
    speaking = false;
    mic.utter(600);
    await until(() => events.some((e) => e.kind === "utterance"));
    expect(events.map((e) => e.kind)).toEqual(["speechStart", "utterance"]);
    expect(transcriber.heard).toHaveLength(1);
  });
});

describe("PacedReference", () => {
  it("pushes each piece as the clock reaches it, in played order, and stops on clear", () => {
    let now = 0;
    const pushed: number[] = [];
    const ref = new PacedReference({ push: (s) => pushed.push(s.length) }, { now: () => now, wall: () => new Date() }, 20, 0);
    ref.schedule(new Float32Array(1000), 1000, 100); // 1 s of audio starting at t=100 ms
    ref.schedule(new Float32Array(500), 1000, 1100);
    ref.tick();
    expect(pushed).toEqual([]); // not playing yet
    now = 150; ref.tick();
    now = 1100; ref.tick();
    expect(pushed).toEqual([50, 950]);
    now = 1300; ref.tick();
    expect(pushed).toEqual([50, 950, 200]);
    ref.clear();
    now = 2000; ref.tick();
    expect(pushed.reduce((a, b) => a + b, 0)).toBe(1200);
  });
});

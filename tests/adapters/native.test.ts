import { describe, expect, it } from "vitest";
import type { PlaybackEvent, InputEvent } from "../../src/application/ports.js";
import { MicInput, UtteranceSegmenter } from "../../src/adapters/native/mic-input.js";
import { NativeVoiceOutput } from "../../src/adapters/native/native-voice-output.js";
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
  function run(mic: FakeMic, transcriber: FakeTranscriber, muted = () => false) {
    const ac = new AbortController();
    const events: InputEvent[] = [];
    const input = new MicInput({ mic, transcriber, clock, muted, minSpeechMs: 300, prerollMs: 0 });
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

  it("ignores clicks, noise transcripts, and speech while Jarvis is talking", async () => {
    const mic = new FakeMic();
    let speaking = true;
    const transcriber = new FakeTranscriber(["Thank you.", "Real request"]);
    const { events } = run(mic, transcriber, () => speaking);
    mic.utter(600);        // Jarvis is talking: ignored, not even transcribed
    speaking = false;
    mic.utter(100);        // too short: a click
    mic.utter(600);        // "Thank you." is what recognisers write over noise
    mic.utter(600);
    await until(() => events.some((e) => e.kind === "utterance"));
    expect(events.filter((e) => e.kind === "utterance")).toMatchObject([{ text: "Real request" }]);
    expect(transcriber.heard).toHaveLength(2);
  });
});

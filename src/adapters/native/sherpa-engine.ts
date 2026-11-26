/** Synthesizer (Kokoro) and Transcriber (Moonshine) on sherpa-onnx, both fully offline. */
import { join } from "node:path";
import sherpa from "sherpa-onnx-node";
import type { Synthesizer, Transcriber } from "./audio-ports.js";
import { KokoroPhonemizer } from "./kokoro-phonemizer.js";
import { KOKORO, MOONSHINE, VOICES, type VoiceName } from "./models.js";

/** 4 threads measured fastest on Apple Silicon (305 ms for "Certainly, sir."; see spike/FINDINGS.md). */
const THREADS = 4;

export class KokoroSynthesizer implements Synthesizer {
  private readonly phonemizer = new KokoroPhonemizer("en");

  private constructor(private readonly tts: sherpa.OfflineTts, private readonly sid: number, private readonly speed: number) {}

  static async load(root: string, voice: VoiceName, speed: number): Promise<KokoroSynthesizer> {
    const dir = join(root, KOKORO.dir);
    const tts = await sherpa.OfflineTts.createAsync({
      model: {
        kokoro: { model: join(dir, "model.onnx"), voices: join(dir, "voices.bin"), tokens: join(dir, "tokens.txt"),
                  lexicon: join(dir, "lexicon-gb-en.txt") },
        numThreads: THREADS, debug: false, provider: "cpu",
      },
      maxNumSentences: 1,
    });
    return new KokoroSynthesizer(tts, VOICES[voice], speed);
  }

  get sampleRate(): number {
    return this.tts.sampleRate;
  }

  /**
   * We phonemize the text ourselves and pass the phonemes: sherpa-onnx's own lexicon path silently
   * drops every word it doesn't know.
   */
  async render(text: string): Promise<Float32Array> {
    const phonemes = await this.phonemizer.phonemes(text);
    if (!phonemes) return new Float32Array(0);
    // One codepoint per phoneme symbol (stress marks and length marks are separate symbols to Kokoro).
    const codepoints: number[] = [];
    for (let i = 0; i < phonemes.length; i++) {
      const cp = phonemes.codePointAt(i) ?? 32;
      codepoints.push(cp);
      if (cp > 0xffff) i++; // skip the second half of a surrogate pair
    }
    const phonemeCodepoints = [codepoints];
    const audio = await this.tts.generateAsync({
      text, sid: this.sid, speed: this.speed,
      generationConfig: { sid: this.sid, speed: this.speed, phonemeCodepoints },
    });
    return audio.samples;
  }
}

export class MoonshineTranscriber implements Transcriber {
  private constructor(private readonly rec: sherpa.OfflineRecognizer) {}

  static async load(root: string): Promise<MoonshineTranscriber> {
    const dir = join(root, MOONSHINE.dir);
    const rec = await sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        moonshine: { encoder: join(dir, "encoder_model.ort"), mergedDecoder: join(dir, "decoder_model_merged.ort") },
        tokens: join(dir, "tokens.txt"), numThreads: THREADS, provider: "cpu", debug: 0,
      },
    });
    return new MoonshineTranscriber(rec);
  }

  async transcribe(samples: Float32Array): Promise<string> {
    const stream = this.rec.createStream();
    stream.acceptWaveform({ samples, sampleRate: 16000 });
    await this.rec.decodeAsync(stream);
    return this.rec.getResult(stream).text;
  }
}

/** The subset of sherpa-onnx-node (which ships no types) that jarvis-rt uses. */
declare module "sherpa-onnx-node" {
  export interface GeneratedAudio { samples: Float32Array; sampleRate: number }
  export interface GenerationConfig { sid?: number; speed?: number; phonemeCodepoints?: number[][] }
  export interface TtsRequest { text: string; sid: number; speed: number; generationConfig?: GenerationConfig }
  export class OfflineTts {
    constructor(config: object);
    static createAsync(config: object): Promise<OfflineTts>;
    readonly sampleRate: number;
    readonly numSpeakers: number;
    generateAsync(request: TtsRequest): Promise<GeneratedAudio>;
  }
  export class OfflineStream {
    acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void;
  }
  export class OfflineRecognizer {
    constructor(config: object);
    static createAsync(config: object): Promise<OfflineRecognizer>;
    createStream(): OfflineStream;
    decodeAsync(stream: OfflineStream): Promise<unknown>;
    getResult(stream: OfflineStream): { text: string };
  }
}

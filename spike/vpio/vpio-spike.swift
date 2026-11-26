// Spike: Apple's voice processing (AEC) on AVAudioEngine.
// Plays <jarvis.wav> through the voice-processed output, records the microphone (echo cancelled) as
// raw 16 kHz mono float32 to <out.raw>. Optionally plays <user.wav> from a separate process after
// <delay> seconds: audio the canceller knows nothing about, like a person in the room.
// Usage: vpio-spike <jarvis.wav> <out.raw> [--novp] [<user.wav> <delay>]
import AVFoundation
import Foundation

var args = Array(CommandLine.arguments.dropFirst())
let useVP = !args.contains("--novp")
args.removeAll { $0 == "--novp" }
guard args.count >= 2 else { FileHandle.standardError.write("usage\n".data(using: .utf8)!); exit(2) }
let jarvisURL = URL(fileURLWithPath: args[0]), outPath = args[1]
let userWav: String? = args.count >= 4 ? args[2] : nil
let userDelay = args.count >= 4 ? Double(args[3]) ?? 2.0 : 0

let engine = AVAudioEngine()
let input = engine.inputNode
let output = engine.outputNode
_ = engine.mainMixerNode
if useVP {
  try input.setVoiceProcessingEnabled(true)
  try output.setVoiceProcessingEnabled(true)
  input.isVoiceProcessingAGCEnabled = ProcessInfo.processInfo.environment["VP_AGC"] == "1"
  if #available(macOS 14.0, *) {
    input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
  }
}
let player = AVAudioPlayerNode()
engine.attach(player)
let file = try AVAudioFile(forReading: jarvisURL)
engine.connect(player, to: engine.mainMixerNode, format: file.processingFormat)

let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
let inFormat = input.outputFormat(forBus: 0)
// Voice processing delivers several channels; the processed voice is channel 0.
let monoIn = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: inFormat.sampleRate, channels: 1, interleaved: false)!
let converter = AVAudioConverter(from: monoIn, to: outFormat)!
FileManager.default.createFile(atPath: outPath, contents: nil)
let out = FileHandle(forWritingAtPath: outPath)!
input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { buf, _ in
  let cap = AVAudioFrameCount(Double(buf.frameLength) * 16000 / inFormat.sampleRate) + 16
  guard let o = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else { return }
  guard let mono = AVAudioPCMBuffer(pcmFormat: monoIn, frameCapacity: buf.frameLength),
        let src = buf.floatChannelData?[0], let dst = mono.floatChannelData?[0] else { return }
  mono.frameLength = buf.frameLength
  dst.update(from: src, count: Int(buf.frameLength))
  var fed = false
  converter.convert(to: o, error: nil) { _, status in
    if fed { status.pointee = .noDataNow; return nil }
    fed = true; status.pointee = .haveData; return mono
  }
  let n = Int(o.frameLength)
  if n > 0, let p = o.floatChannelData?[0] { out.write(Data(bytes: p, count: n * 4)) }
}
try engine.start()
FileHandle.standardError.write("vp=\(useVP) in=\(inFormat)\n".data(using: .utf8)!)
Thread.sleep(forTimeInterval: 1.0) // let the canceller settle
player.scheduleFile(file, at: nil)
player.play()
if let u = userWav {
  DispatchQueue.global().asyncAfter(deadline: .now() + userDelay) {
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/afplay"); p.arguments = [u]; try? p.run()
  }
}
let seconds = Double(file.length) / file.processingFormat.sampleRate
Thread.sleep(forTimeInterval: seconds + 1.5)
engine.stop()
out.closeFile()

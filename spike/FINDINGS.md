# M0 spike findings (2026-11-26)

`npx tsx spike/stream-spike.ts`, Agent SDK `@anthropic-ai/claude-agent-sdk` 0.3.332, model alias `sonnet`
(resolved to `claude-sonnet-5-5`), MacBook Air, home network. Two runs.

## Measured

| Turn | First text | First full sentence | Reply done |
|---|---|---|---|
| 1, new session (run 1, includes the first tsx compile) | — | 5527 ms | 5757 ms |
| 1, new session (run 2) | 1302 ms | 1748 ms | 2098 ms |
| 2, warm session | 660 ms | 1002 ms | 1026 ms |
| 4, warm, after an interrupt | 779 ms | 813 ms | 836 ms |
| `interrupt()` call | returned in **5 ms** | turn ended as `error_during_execution` | session kept working |

**Latency estimate, updated:** end-of-speech wait 0.8 s + transcription 0.55 s + first sentence about 0.9 s
(warm) + voice render 0.3 s, about **2.5–2.6 s** to first audio. The 2.5 s median target is tight: lowering
the wait to 0.7 s, or adding streaming speech recognition later, gives margin. A new session pays an extra
0.7–4.5 s once, so **start `query()` at app launch**, so process start-up overlaps with the user's first words.

## Confirmed API shapes (from the installed `sdk.d.ts`)

- `SDKUserMessage = { type: "user", message: MessageParam, parent_tool_use_id: string | null, priority?, … }`.
  Streaming input mode takes an `AsyncIterable` of these; one `session_id` is kept across turns.
- `SDKPartialAssistantMessage = { type: "stream_event", event: BetaRawMessageStreamEvent, parent_tool_use_id,
  session_id, ttft_ms?, … }`. Text arrives as `content_block_delta` with `delta.type === "text_delta"`.
  Subagent chatter has a non-null `parent_tool_use_id`, so filter it out.
- `SDKSystemMessage` (`subtype: "init"`) carries `session_id`, `model`, `permissionMode`, `apiKeySource`.
- `SDKResultMessage`: `subtype: "success" | error subtypes`, with `ttft_ms` and `duration_ms`, which are useful for the timing log.
- `CanUseTool = (toolName, input, { signal, suggestions?, blockedPath?, … }) => Promise<PermissionResult>`;
  `PermissionResult = { behavior: "allow", updatedInput?, … } | { behavior: "deny", message, interrupt? }`.
- `PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`.

## Implications for the build

1. **Auth works with the Claude Code login**: `apiKeySource: "none"`, no API key needed.
2. **`settingSources: []` is required.** Without it the user's settings load jarvis-voice's hooks into this
   session, and it would speak twice. Also set `JARVIS_VOICE_CHILD=1` in `env`.
3. **Text arrives in bursts.** After `interrupt()`, text already received (here "Four" to "Seventeen") must
   be dropped by the chunker. Interrupt clears the turn's buffer and ignores deltas until the next turn.
4. **A bare name in `allowedTools` bypasses `canUseTool`** (the SDK warns about it). Use it on purpose for
   Read, Glob and Grep; everything else falls through to `canUseTool`, which becomes the spoken permission
   dialog. Use scoped `disallowedTools` rules for things that are never allowed.
5. **The ports in the architecture hold.** `AgentEvent.text` maps to `text_delta`, `tool` to
   `content_block_start` with `tool_use`, `done` to `result`, and `interrupt()` to `query.interrupt()`.

# M3 spike: a native engine replaces jarvis-voice (2026-11-26)

jarvis-voice was removed from this Mac, so jarvis-rt gets its own engine in Node: **sherpa-onnx-node 2.0.3**
(Kokoro voice, Moonshine/Whisper recognition, prebuilt for Apple Silicon) and **decibri 5.8** (microphone with
Silero VAD, denoise and echo cancellation; speaker). Scripts: `spike/native-engine-spike.ts`,
`spike/tts-bench.ts`, `spike/stt-accuracy.ts`. Models live in `~/.cache/jarvis-rt/models`.

| Voice (Kokoro v1.0, speaker 24 = bm_daniel) | "Certainly, sir." | longer sentence |
|---|---|---|
| fp32 `model.onnx`, CPU, 4 threads (**chosen**) | **305 ms** | 665 ms |
| fp32, 2 threads / 8 threads | 496 / 327 ms | 1051 / 734 ms |
| int8 `model.int8.onnx`, CPU, 4 threads | 683 ms | 1751 ms |
| CoreML provider | crashes on int8, slower on fp32 | — |
| (old jarvis-voice Python engine, for comparison) | 330 ms | 760 ms |

| Recognition (real recorded speech) | 6.6 s clip | 16.7 s clip | accuracy |
|---|---|---|---|
| **Moonshine base, quantized (chosen)** | **71 ms** | **234 ms** | same as Whisper; better punctuation, British spelling |
| Whisper base.en int8 | 361 ms | 899 ms | reference |
| (old jarvis-voice: Whisper small.en on the Apple GPU) | ~550 ms per 4 s | | |

Other measurements: Kokoro loads in 0.6 s; opening the speaker costs about 250 ms, and opening the microphone
with Silero VAD about 2.4 s, so both stay open for the whole session. The microphone delivered audio with the
terminal's existing permission. Voice IDs are in the model's metadata (`id2speaker`): bm_daniel 24, bm_fable 25,
bm_george 26, bm_lewis 27, so the old Jarvis blend can be rebuilt as a custom `voices.bin` entry later.

**Estimated spoken turn:** a 0.7 s end-of-speech wait, 0.1 s transcription, about 0.9 s for Claude's first piece,
and 0.3 s for the voice, about **2.0 s** to first audio, against 2.7–3.0 s on the jarvis-voice engine and 5–12 s
with its hooks.

## M4: barge-in (2026-11-26, MacBook Air built-in speakers and microphone, volume 25%)

**Echo cancellation (decibri `aec: 'tau'`) barely works on these speakers.** `spike/aec-check.ts` plays the same
reply through the speaker with the microphone open, and reports the share of playback that Silero scores as
speech. Without cancellation it is 80–94%. With cancellation, and the reference paced to the playhead (pushing
ahead can lose the delay for good, per decibri's changelog), the canceller finds the delay (about 45–55 ms) but
ERLE stays at 0–6 dB. Some sentences fall to 0–17% once it converges, but it doesn't hold: over three replies in one
session, 30–90% of every sentence still scored as speech. Turning off the 80 Hz highpass, a 400 ms tail, or
`suppression: 'off'` made no reliable difference. The likely cause: the speakers sit centimetres from the microphone,
behind Apple's speaker processing, which a linear canceller can't model.

**So barge-in checks the words, not just the sound** (`spike/barge-in-check.ts`, real speaker, microphone,
canceller and Moonshine). After 250 ms of speech over Jarvis, the last 1.5 s is transcribed and compared with what
he just said:

| rule | false barge-ins (Jarvis alone, 6 replies) | real interruptions caught (3) |
|---|---|---|
| any speech that isn't Jarvis's words | **5 of 6**: the echo transcribes as new-looking words ("Circumstruction", "dons dons dons", "bill bill bill…") | — (Jarvis had already cut himself off) |
| **only a stop word Jarvis didn't say (loudspeakers)** | **0** | 0: a second voice from the *same* speaker, overlapping him, transcribes as nonsense |

The "user" in that test came from the same laptop speaker at the same level as Jarvis, which is the worst
case. A person near the laptop reaches the microphone directly, so this needs a real-voice test. Headphones
have no echo, so there any speech over Jarvis cuts him off ("auto" picks by output device name). Once he is
cut off, what the user said transcribes cleanly ("Hold on, Jarvis.", "Wait stop use the other database instead").

**Apple voice processing (AVAudioEngine `setVoiceProcessingEnabled`, FaceTime's canceller): inconclusive.**
`spike/vpio/` builds a Swift helper that plays through the voice-processed output and records the microphone. It
needs the output node enabled explicitly (otherwise initialisation fails with -10875) and delivers 7 channels at
96 kHz. Its recordings came out very quiet (peaks around 0.07, as loud in the silent first second as during
playback) and transcribed as nonsense even with processing off, so the capture path is suspect, and this measured
nothing reliable yet. It is the most promising next step for loudspeakers: a native helper that owns both speaker
and microphone.

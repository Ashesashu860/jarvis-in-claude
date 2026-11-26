# jarvis-rt

A real-time voice front end for Claude Code: Jarvis starts speaking from the **first streamed sentence** of
Claude's reply, and stops the moment you talk over it. Speech stays on your Mac.

Built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), sherpa-onnx and decibri, with a hexagonal
(ports and adapters) architecture. See the architecture page and `~/Documents/jarvis-rt-plan.md`.

## Status

| Milestone | State |
|---|---|
| M0 spike: streaming, sessions, interrupt measured (`spike/FINDINGS.md`) | done |
| M1 skeleton: typed conversation, resumes after restart, timing log | done |
| M2 mouth: replies spoken as they stream | done |
| M3 ears + native engine: microphone, Moonshine, Kokoro, all in Node (jarvis-voice no longer needed) | **done** |
| M4 barge-in: talk over Jarvis to cut him off (any speech on headphones; "stop", "wait", "hold on" on loudspeakers) | **done** (real voice: "hold on" works on laptop speakers) |
| M5 spoken permissions ("Shall I, sir?" / yes, no, always) and narration of reads and searches | **done** |
| M6 polish: `doctor`, the Jarvis voice blend, CI, install script | next |

## Install and use

```bash
npm install
npm start -- setup        # downloads the voice and speech models once, about 440 MB, to ~/.cache/jarvis-rt/models
npm start                 # speak after "Listening…"; resumes the last conversation in this folder
npm start -- --new        # start afresh
npm start -- --type       # type prompts instead of speaking
npm start -- --text       # print replies only, no voice
npm start -- --model opus
```

macOS asks for **microphone access** for your terminal the first time. A short pause (0.7 s, `endOfSpeechMs`)
ends your turn. To cut Jarvis off, talk over him: on headphones anything you say does it; on loudspeakers
(where he'd hear himself) say "stop", "wait", "hold on" or "Jarvis", then carry on with what you want.
`"bargeIn"` in the config forces `"anySpeech"`, `"stopWord"` or `"off"`. **Ctrl+C** also cuts a reply off;
**Ctrl+C twice** quits. Say "new conversation", "use opus", "plan mode", "stop" or "goodbye".

Reading and searching just happen, and Jarvis says so ("Reading main.ts.", "Searching the code.").
Edits and commands are asked about out loud ("I'd like to run the test suite. Shall I, sir?"): say or type
"yes", "no", or "always" (that tool, or for commands that exact command, for the rest of the session).
No answer in 30 s is a no, and so is "stop". Claude Code itself lets read-only commands (`ls`, `uname`, …)
run without asking. Destructive commands (`rm -rf ~`, `git push --force`, `sudo`, …) are always refused.

Settings, in `~/.config/jarvis-rt/config.json`: `address` (sir), `model` (sonnet), `speaker`
(bm_daniel, bm_george, bm_fable, bm_lewis, bf_emma, …), `speed` (1.05), `endOfSpeechMs` (700), `voice`,
`listen`, `autoAllow`. Per-turn timings are logged to `~/.local/state/jarvis-rt/timings.jsonl`.

## How it works

Everything runs on your Mac. Speech goes **microphone → decibri** (Silero voice detection; its hold-off is the
end-of-speech wait) **→ Moonshine** (sherpa-onnx, about 30 ms per utterance) **→ Claude** via the Agent SDK, one
live session, streaming. The reply goes **sentence chunker** (a short first piece) **→ speech cleaner**
("hooks.py:42" → "hooks dot py, line 42") **→ eSpeak phonemes** (offline WASM; sherpa-onnx's own lexicon would drop
unknown words) **→ Kokoro** (bm_daniel, about 0.3–0.5 s per sentence) **→ decibri speaker**. The next sentence
renders while the current one plays.

Measured end to end (real models, Sonnet, muted speaker): first audio **1.8–2.2 s** after you stop talking,
including the 0.7 s end-of-speech wait. That compares with 5–12 s through jarvis-voice's Claude Code hooks.
The process uses about 1.2 GB of memory while running.

## Develop

```bash
npm run check     # typecheck + lint (strict) + layer rules + tests
npm test
npx vitest run --coverage
```

Layout: `src/domain` (pure rules, no I/O) → `src/application` (ports and the conversation service) →
`src/adapters` (SDK, CLI, files). `src/main.ts` wires them. `npm run layers` fails if a dependency points
outwards.

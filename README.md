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
| M6 polish: `jarvis-rt doctor`, the Jarvis voice blend, CI workflow, install script | **done** |

## Install and use

Needs macOS, Node.js 22+, and Claude Code signed in once (`claude`).

```bash
scripts/install.sh        # dependencies, build, `jarvis-rt` in ~/.local/bin, models (about 440 MB, once), doctor
jarvis-rt doctor          # check models, voice, speech recognition, speaker, microphone and Claude login
jarvis-rt                 # speak after "Listening…"; resumes the last conversation in this folder
jarvis-rt --new           # start afresh
jarvis-rt --type          # type prompts instead of speaking
jarvis-rt --text          # print replies only, no voice
jarvis-rt --model opus
scripts/install.sh --uninstall   # remove the command (models and settings are kept)
```

From the checkout without installing: `npm install`, `npm start -- setup`, `npm start`. After pulling changes,
re-run `scripts/install.sh` (or `npm run build`): the command runs the built code.

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

Settings, in `~/.config/jarvis-rt/config.json`: `address` (sir), `model` (sonnet), `speaker` (`jarvis`, or a
stock voice: bm_daniel, bm_george, bm_fable, bm_lewis, bf_emma, …), `blend` (the `jarvis` voice, by default
`bm_daniel:0.6,bm_george:0.25,bm_fable:0.15`, the original jarvis-voice mix of stock Apache-2.0 Kokoro voices),
`speed` (1.05), `endOfSpeechMs` (700), `bargeIn` (auto), `bargeInMs` (250), `voice`, `listen`, `autoAllow`. Per-turn timings are logged to `~/.local/state/jarvis-rt/timings.jsonl`.

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

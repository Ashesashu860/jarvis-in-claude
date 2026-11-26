# jarvis-rt

A real-time voice front end for Claude Code: Jarvis starts speaking from the **first streamed sentence** of
Claude's reply, and stops the moment you talk over it. Speech stays on your Mac.

Built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) with a hexagonal
(ports and adapters) architecture. See the architecture page and `~/Documents/jarvis-rt-plan.md`.

## Status

| Milestone | State |
|---|---|
| M0 spike: streaming, sessions, interrupt measured (`spike/FINDINGS.md`) | done |
| M1 skeleton: typed conversation, resumes after restart, timing log | done |
| M2 mouth: replies spoken in the Jarvis voice as they stream | **done** |
| M3 ears (mic), M4 barge-in, M5 spoken permissions, M6 polish | next |

## Use (typed input for now)

Needs [jarvis-voice](https://github.com/Ashesashu860/jarvis-voice) installed (`jarvis` on PATH, from the
`fix/voice-session-and-hangs` branch or later) for the voice; jarvis-rt starts its speech daemon itself.
Without it, or with `--text`, replies are printed only.

```bash
npm install
npm start                 # resumes the last conversation in this folder
npm start -- --new        # start afresh
npm start -- --model opus
npm start -- --text       # print only, no voice
```

Type a prompt and press Enter. **Ctrl+C** cuts a reply off; **Ctrl+D** quits. Typed commands (spoken later):
"new conversation", "use opus", "plan mode", "stop", "goodbye". A prompt typed while Jarvis is replying
waits its turn.

Reading and searching are allowed; edits and commands need approval, which arrives in M5, so for now
Claude is told it can't do them. Destructive commands (`rm -rf ~`, `git push --force`, `sudo`, …) are
always refused.

Settings: `~/.config/jarvis-rt/config.json` (`address`, `model`, `autoAllow`, `voice`). Per-turn timings:
`~/.local/state/jarvis-rt/timings.jsonl`.

## Develop

```bash
npm run check     # typecheck + lint (strict) + layer rules + tests
npm test
npx vitest run --coverage
```

Layout: `src/domain` (pure rules, no I/O) → `src/application` (ports and the conversation service) →
`src/adapters` (SDK, CLI, files). `src/main.ts` wires them. `npm run layers` fails if a dependency points
outwards.

## How speaking works

Each piece of the streamed reply goes to the jarvis-voice speech daemon as a tagged `say` that joins the reply
already playing, so the next sentence renders while the current one plays. The daemon reports when each tag
starts and finishes, which drives the first-audio timing and the end of the turn. The first piece is kept short
(a comma, or a word break within 48 characters), since the voice renders about 90 characters a second. Making
text speakable (`hooks.py:42` → "hooks dot py, line 42") stays in the engine, so there's one implementation.

Measured (muted engine, Sonnet, warm): first audio **1.35–1.65 s** after the prompt is sent, against 2.1 s
before the short-first-piece change. With the mic's end-of-speech wait and transcription added in M3, that
comes to roughly 2.7–3.0 s, against 5–12 s with jarvis-voice's hooks.

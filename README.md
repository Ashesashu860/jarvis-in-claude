# jarvis-rt

A real-time voice front end for Claude Code: Jarvis starts speaking from the **first streamed sentence** of
Claude's reply, and stops the moment you talk over it. Speech stays on your Mac.

Built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) with a hexagonal
(ports and adapters) architecture. See the architecture page and `~/Documents/jarvis-rt-plan.md`.

## Status

| Milestone | State |
|---|---|
| M0 spike: streaming, sessions, interrupt measured (`spike/FINDINGS.md`) | done |
| M1 skeleton: typed conversation, resumes after restart, timing log | **done** |
| M2 mouth (voice), M3 ears (mic), M4 barge-in, M5 spoken permissions, M6 polish | next |

## Use (typed mode for now)

```bash
npm install
npm start                 # resumes the last conversation in this folder
npm start -- --new        # start afresh
npm start -- --model opus
```

Type a prompt and press Enter. **Ctrl+C** cuts a reply off; **Ctrl+D** quits. Typed commands (spoken later):
"new conversation", "use opus", "plan mode", "stop", "goodbye". A prompt typed while Jarvis is replying
waits its turn.

Reading and searching are allowed; edits and commands need approval, which arrives in M5, so for now
Claude is told it can't do them. Destructive commands (`rm -rf ~`, `git push --force`, `sudo`, …) are
always refused.

Settings: `~/.config/jarvis-rt/config.json` (`address`, `model`, `autoAllow`). Per-turn timings:
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

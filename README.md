# 🎙️ Jarvis in Claude

**Talk to Claude Code out loud, and hear it answer like Jarvis.**

Ask a question and Jarvis starts answering in about two seconds, while Claude is still writing the rest of the
reply. Talk over him and he stops. Before he edits a file or runs a command, he asks out loud:
*"I'd like to run the test suite. Shall I, sir?"* Just say yes.

Your voice never leaves your Mac. Listening, transcription and speech all run locally. Only the text of your
request goes to Claude.

```
you    ›  "Why is the login test failing?"
jarvis ›  "Reading auth.test.ts."  ·  "Searching the code."
jarvis ›  "The token expiry is compared in seconds, but the mock returns milliseconds.
           I'd like to edit auth.ts. Shall I, sir?"
you    ›  "Yes."
jarvis ›  "Done. The test passes now."
```

## Why it feels different

- **⚡ It answers fast.** Speech starts from the first sentence Claude streams, about 2 s after you stop talking.
  Voice add-ons that wait for the whole reply take 5–12 s.
- **✋ You can interrupt.** On headphones, just start talking. On laptop speakers, say *"stop"*, *"wait"* or
  *"hold on"*, and he won't mistake his own voice for yours.
- **🛡️ He asks before he acts.** Reading and searching just happen, and he tells you what he's doing. Edits and
  commands wait for your *yes*, *no* or *always*. Destructive commands (`rm -rf ~`, `git push --force`, `sudo`) are
  always refused.
- **🔒 Speech stays on your Mac.** Moonshine transcribes you and Kokoro speaks the replies. There are no cloud speech
  APIs and no audio uploads.
- **🧠 It's the full Claude Code.** Same tools and same sessions. Each project folder resumes its own conversation.
- **🎩 He sounds like Jarvis.** A British voice blend that's ready out of the box, and you can tune it.

## Get started

You need macOS, Node.js 22 or newer, and [Claude Code](https://claude.com/claude-code) signed in once (`claude`).

```bash
git clone https://github.com/Ashesashu860/jarvis-in-claude.git
cd jarvis-in-claude
scripts/install.sh
```

The installer builds the app, puts a `jarvis-rt` command in `~/.local/bin`, downloads the speech models (about
440 MB, once) and runs a health check. Then open any project and say hello:

```bash
cd ~/code/my-project
jarvis-rt
```

The first time, macOS asks for microphone access for your terminal. Speak after *"Listening…"*. A short pause
ends your turn.

## Talking to Jarvis

| Say | What happens |
|---|---|
| anything | It goes to Claude Code as your prompt |
| *"stop"*, *"wait"*, *"hold on"* | He stops talking at once |
| *"yes"*, *"no"*, *"always"* | Answers *"Shall I, sir?"*. *Always* means don't ask again for that tool or exact command this session |
| *"use opus"*, *"use sonnet"* | Switches model |
| *"plan mode"* | Claude plans without making changes |
| *"new conversation"* | Starts fresh |
| *"goodbye"* | Ends the session |

**Ctrl+C** cuts a reply short, and **Ctrl+C twice** quits. If you don't answer a question within 30 s, Jarvis
takes it as a no.

```bash
jarvis-rt               # talk (resumes this folder's last conversation)
jarvis-rt --new         # start a new conversation
jarvis-rt --type        # type instead of speaking, and still hear the replies
jarvis-rt --text        # text only, no voice
jarvis-rt --model opus
jarvis-rt doctor        # check the mic, voice, speech recognition, models and Claude login
```

## Make him yours

Settings live in `~/.config/jarvis-rt/config.json`:

```json
{
  "address": "sir",
  "model": "sonnet",
  "speaker": "jarvis",
  "blend": "bm_daniel:0.6,bm_george:0.25,bm_fable:0.15",
  "speed": 1.05,
  "endOfSpeechMs": 700,
  "bargeIn": "auto"
}
```

- **`address`**: what he calls you (*sir*, *madam*, your name…).
- **`speaker`**: `jarvis` for the blend, or any stock Kokoro voice (`bm_daniel`, `bm_george`, `bf_emma`, …).
- **`blend`**: mix your own voice from stock voices and weights.
- **`endOfSpeechMs`**: how long a pause ends your turn.
- **`bargeIn`**: `auto` picks the mode from your output device: talk over him freely on headphones, or use stop words on
  speakers. You can force it with `anySpeech`, `stopWord` or `off`.

## How it works

```
mic ─▶ voice detection ─▶ Moonshine (speech to text, ~30 ms) ─▶ Claude Code (streaming)
                                                                        │
speaker ◀─ Kokoro (text to speech) ◀─ speech cleanup ◀─ sentence splitter ◀┘
```

Everything except Claude runs inside one Node process on your Mac, using [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
and decibri. Claude Code runs through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) in one live session.
The next sentence is rendered while the current one plays, and code is tidied for speaking: `hooks.py:42` becomes
*"hooks dot py, line 42"*, and code blocks are skipped.

The code follows a hexagonal (ports and adapters) architecture: pure rules in `src/domain`, the conversation logic
and its ports in `src/application`, and the SDK, audio and files in `src/adapters`. Claude is one adapter behind an
`AgentBrain` port, so another brain could be plugged in. Measurements and the reasoning behind design decisions are in
[`spike/FINDINGS.md`](spike/FINDINGS.md).

## Develop

```bash
npm install
npm start -- setup      # download the models
npm start               # run from source
npm run check           # typecheck, strict lint, layer rules, tests
```

`npm run layers` fails if a dependency points the wrong way. After changing the source, run `npm run build` (or
`scripts/install.sh` again), because the installed command runs the built code. To remove the command, run
`scripts/install.sh --uninstall`. The models and settings are kept.

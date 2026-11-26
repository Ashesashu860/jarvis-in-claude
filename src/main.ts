#!/usr/bin/env node
/**
 * Composition root: the only file that knows every concrete class. It reads flags and settings,
 * builds the adapters, hands them to the ConversationService, and runs it.
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { ConversationService } from "./application/conversation-service.js";
import { PolicyPermissionDecider } from "./application/policy-permission-decider.js";
import { ClaudeAgentBrain } from "./adapters/brain/claude-agent-brain.js";
import { ConsoleOutput } from "./adapters/cli/console-output.js";
import { KeyboardInput } from "./adapters/cli/keyboard-input.js";
import { defaultPaths, loadConfig } from "./adapters/config/file-config.js";
import { FileSessionStore } from "./adapters/store/file-session-store.js";
import { systemClock } from "./adapters/system-clock.js";
import { JsonlTimingLog } from "./adapters/telemetry/jsonl-timing-log.js";
import { DEFAULT_RULES } from "./domain/permission-policy.js";

const VOICE_STYLE = (address: string) =>
  "Your replies are read aloud as they stream, so open with one short, plain sentence that answers or " +
  "summarises; no markdown, lists, tables, emoji or code in what is spoken. Put code in files, not in replies. " +
  `Be calm, precise and economical, with a dry, understated British wit. Address the user as '${address}'.`;

const HELP = `jarvis-rt: talk to Claude Code in real time

Usage: jarvis-rt [--new] [--model opus|sonnet|haiku] [--cwd DIR]

  --new        start a new conversation instead of resuming the last one here
  --model      Claude model (default from settings: sonnet)
  --cwd        directory Claude works in (default: current)
  -h, --help   show this help

Typed mode for now: type a prompt and press Enter. Ctrl+C cuts a reply off; Ctrl+D quits.
Say "new conversation", "use opus", "plan mode" or "goodbye" (typed, for now).`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      new: { type: "boolean", default: false },
      model: { type: "string" },
      cwd: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }

  const paths = defaultPaths();
  const config = loadConfig(paths.config);
  const model = values.model ?? config.model;
  if (model !== "opus" && model !== "sonnet" && model !== "haiku") {
    console.error(`--model must be opus, sonnet or haiku (got "${model}")`);
    return 2;
  }
  const cwd = values.cwd ?? process.cwd();

  const sessions = new FileSessionStore(paths.sessions, cwd);
  if (values.new) await sessions.clear();
  const resume = await sessions.last();

  const brain = new ClaudeAgentBrain({
    model,
    cwd,
    systemAppend: VOICE_STYLE(config.address),
    permission: new PolicyPermissionDecider({ ...DEFAULT_RULES, autoAllow: config.autoAllow }),
    resume,
    onSession: (id) => void sessions.save(id),
  });
  brain.start(); // warm up while the user types

  const service = new ConversationService({
    input: new KeyboardInput(),
    output: new ConsoleOutput(),
    brain,
    control: brain,
    timings: new JsonlTimingLog(paths.timings),
    clock: systemClock,
    newId: randomUUID,
    persona: { address: config.address },
  });

  // Ctrl+C: cut the current reply off; a second Ctrl+C while idle quits.
  const stop = new AbortController();
  let lastSigint = 0;
  process.on("SIGINT", () => {
    const busy = service.currentState.kind === "thinking" || service.currentState.kind === "speaking";
    if (busy) {
      service.dispatch({ kind: "bargeIn" });
    } else if (Date.now() - lastSigint < 1500) {
      stop.abort();
    } else {
      process.stderr.write("\n(Ctrl+C again to quit)\n");
    }
    lastSigint = Date.now();
  });

  console.error(`jarvis-rt · ${model} · ${cwd}${resume ? " · resuming the last conversation" : ""}`);
  await service.run(stop.signal);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);

/**
 * Recognises voice commands in what the user said. Only the whole utterance counts, so
 * "shut down the dev server" is a request for Claude, not a command to quit.
 *
 * The table is the extension point: a new command is a new row (open/closed principle).
 */
export type ModelChoice = "opus" | "sonnet" | "haiku";

export type Intent =
  | { kind: "prompt"; text: string }
  | { kind: "pause" }
  | { kind: "newConversation" }
  | { kind: "goodbye" }
  | { kind: "useModel"; model: ModelChoice }
  | { kind: "permissionMode"; mode: "plan" | "default" };

type Row = { phrases: readonly string[]; intent: Exclude<Intent, { kind: "prompt" }> };

const TABLE: readonly Row[] = [
  { phrases: ["stop", "wait", "hold on", "hang on", "pause", "quiet", "shush", "one second", "stop talking"], intent: { kind: "pause" } },
  { phrases: ["new conversation", "start over", "start afresh", "clear context", "reset conversation"], intent: { kind: "newConversation" } },
  { phrases: ["goodbye", "goodbye jarvis", "shut down", "power down", "exit"], intent: { kind: "goodbye" } },
  { phrases: ["use opus", "switch to opus"], intent: { kind: "useModel", model: "opus" } },
  { phrases: ["use sonnet", "switch to sonnet"], intent: { kind: "useModel", model: "sonnet" } },
  { phrases: ["use haiku", "switch to haiku"], intent: { kind: "useModel", model: "haiku" } },
  { phrases: ["plan mode", "plan first", "planning mode"], intent: { kind: "permissionMode", mode: "plan" } },
  { phrases: ["normal mode", "leave plan mode", "exit plan mode"], intent: { kind: "permissionMode", mode: "default" } },
];

const LEADING_FILLER = ["hey jarvis ", "jarvis ", "ok ", "okay ", "please ", "lets ", "let us "];
const TRAILING_FILLER = [" please", " jarvis", " now"];

export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function strip(n: string): string {
  let out = n;
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of LEADING_FILLER) if (out.startsWith(f)) { out = out.slice(f.length); changed = true; }
    for (const f of TRAILING_FILLER) if (out.endsWith(f)) { out = out.slice(0, -f.length); changed = true; }
  }
  return out.trim();
}

export function parseIntent(text: string): Intent {
  const core = strip(normalize(text));
  for (const row of TABLE) {
    if (row.phrases.includes(core)) return row.intent;
  }
  return { kind: "prompt", text: text.trim() };
}

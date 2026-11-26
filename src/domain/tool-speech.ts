/**
 * What Jarvis says about tool calls: the question when one needs the user's approval, and a short
 * narration for the ones that don't (so a long search isn't silence).
 */
export interface ToolCall {
  readonly tool: string;
  /** The command, path, pattern or URL. */
  readonly summary: string;
  /** Claude's own one-line description of the call, when it gives one (Bash does). */
  readonly description?: string;
}

const base = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const trimEnd = (s: string) => s.trim().replace(/[.!?]+$/, "");

/** Long commands are read out only up to a few words; the console shows them in full. */
function shortCommand(cmd: string, words = 8): string {
  const w = cmd.trim().split(/\s+/);
  return w.length > words ? `${w.slice(0, words).join(" ")}, and so on` : cmd.trim();
}

function action(call: ToolCall): string {
  const { tool, summary, description } = call;
  switch (tool) {
    case "Bash":
      return description ? lowerFirst(trimEnd(description)) : `run ${shortCommand(summary)}`;
    case "Edit": case "MultiEdit": case "NotebookEdit":
      return `edit ${base(summary)}`;
    case "Write":
      return `write ${base(summary)}`;
    case "WebFetch":
      return `open ${hostOf(summary)}`;
    default:
      return description ? lowerFirst(trimEnd(description)) : `use ${tool}`;
  }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "a web page"; }
}

export function permissionQuestion(call: ToolCall, address: string): string {
  return `I'd like to ${action(call)}. Shall I, ${address}?`;
}

/** A short line for calls that run without asking, or null for ones not worth mentioning. */
export function narration(call: ToolCall): string | null {
  switch (call.tool) {
    case "Read": return `Reading ${base(call.summary)}.`;
    case "Grep": case "Glob": return "Searching the code.";
    case "WebSearch": return "Searching the web.";
    case "WebFetch": return `Reading ${hostOf(call.summary)}.`;
    case "Task": case "Agent": return "I'll have a helper look into it.";
    default: return null;
  }
}

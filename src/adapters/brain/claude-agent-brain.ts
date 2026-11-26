/**
 * AgentBrain and AgentControl on top of the Claude Agent SDK.
 *
 * One `query()` runs in streaming input mode for the whole conversation, so every turn reuses
 * the same session and warm process (a new session costs 0.7–4.5 s once; see spike/FINDINGS.md).
 * This file is the anti-corruption layer: SDK messages are translated into AgentEvents here and
 * never reach the core.
 */
import { query as sdkQuery, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../../application/async-queue.js";
import type { AgentBrain, AgentControl, AgentEvent, PermissionDecider } from "../../application/ports.js";
import type { ModelChoice } from "../../domain/intents.js";

export type QueryFn = (args: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

export interface ClaudeAgentBrainOptions {
  readonly model: ModelChoice;
  readonly cwd: string;
  readonly systemAppend: string;
  /** Every tool call is decided by the core's policy; nothing is pre-approved in the SDK. */
  readonly permission: PermissionDecider;
  /** Session to continue, if any. */
  readonly resume?: string | null;
  /** Called with each new session id, so it can be stored and resumed next time. */
  readonly onSession?: (sessionId: string) => void;
  /** Injected for tests; defaults to the SDK's query(). */
  readonly queryFn?: QueryFn;
}

/** A short, speakable description of a tool call, used for permission prompts and narration. */
export function summarizeToolInput(tool: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === "string" ? input[k] : "");
  switch (tool) {
    case "Bash": return str("command");
    case "Edit": case "Write": case "Read": case "MultiEdit": return str("file_path");
    case "NotebookEdit": return str("notebook_path");
    case "Grep": case "Glob": return str("pattern");
    case "WebFetch": return str("url");
    case "WebSearch": return str("query");
    default: return str("description");
  }
}

export class ClaudeAgentBrain implements AgentBrain, AgentControl {
  private inbox: AsyncQueue<SDKUserMessage> | null = null;
  private q: Query | null = null;
  private turn: AsyncQueue<AgentEvent> | null = null;
  private sessionId: string | null;
  private interrupting = false;
  private readonly queryFn: QueryFn;

  constructor(private readonly opts: ClaudeAgentBrainOptions) {
    this.sessionId = opts.resume ?? null;
    this.queryFn = opts.queryFn ?? sdkQuery;
  }

  /** Start the session now, so its start-up overlaps with the user's first words. */
  start(): void {
    if (this.q) return;
    this.inbox = new AsyncQueue<SDKUserMessage>();
    this.q = this.queryFn({ prompt: this.inbox, options: this.options() });
    void this.read(this.q);
  }

  async *send(text: string, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.start();
    const turn = new AsyncQueue<AgentEvent>();
    this.turn = turn;
    const onAbort = () => turn.close();
    signal.addEventListener("abort", onAbort, { once: true });
    this.inbox?.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
    try {
      for await (const ev of turn) {
        yield ev;
        if (ev.kind === "done" || ev.kind === "interrupted" || ev.kind === "error") return;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (this.turn === turn) this.turn = null;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.q) return;
    this.interrupting = true;
    await this.q.interrupt();
  }

  async setModel(model: ModelChoice): Promise<void> {
    this.start();
    await this.q?.setModel(model);
  }

  async setPermissionMode(mode: "plan" | "default"): Promise<void> {
    this.start();
    await this.q?.setPermissionMode(mode);
  }

  async newSession(): Promise<void> {
    await this.close();
    this.sessionId = null;
    this.start();
  }

  close(): Promise<void> {
    this.inbox?.close();
    this.q?.close();
    this.turn?.close();
    this.inbox = null;
    this.q = null;
    this.turn = null;
    return Promise.resolve();
  }

  // ------------------------------------------------------------------ internals
  private options(): Options {
    return {
      model: this.opts.model,
      cwd: this.opts.cwd,
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: this.opts.systemAppend },
      // No user/project settings: they would load jarvis-voice's hooks and speak every reply twice.
      settingSources: [],
      env: { ...(process.env as Record<string, string>), JARVIS_VOICE_CHILD: "1" },
      ...(this.sessionId ? { resume: this.sessionId } : {}),
      canUseTool: async (toolName, input, { signal }) => {
        const verdict = await this.opts.permission.decide({ tool: toolName, summary: summarizeToolInput(toolName, input) }, signal);
        return verdict.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: verdict.reason };
      },
    };
  }

  /** The single reader of the SDK stream: routes each message to the current turn. */
  private async read(q: Query): Promise<void> {
    try {
      for await (const msg of q) this.route(msg);
    } catch (err) {
      this.turn?.push({ kind: "error", message: err instanceof Error ? err.message : String(err), retryable: true });
    } finally {
      if (this.q === q) {
        // The session ended underneath us: start a fresh process (resuming) on the next send.
        this.q = null;
        this.inbox = null;
        this.turn?.push({ kind: "error", message: "The Claude session ended unexpectedly.", retryable: true });
      }
    }
  }

  private route(msg: SDKMessage): void {
    const turn = this.turn;
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init" && msg.session_id !== this.sessionId) {
          this.sessionId = msg.session_id;
          this.opts.onSession?.(msg.session_id);
        }
        return;
      case "stream_event": {
        if (!turn || msg.parent_tool_use_id !== null) return; // subagent chatter is not spoken
        const ev = msg.event;
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") turn.push({ kind: "text", delta: ev.delta.text });
        return;
      }
      case "assistant": {
        if (!turn || msg.parent_tool_use_id !== null) return;
        for (const block of msg.message.content) {
          if (block.type === "tool_use") {
            const input = (block.input ?? {}) as Record<string, unknown>;
            turn.push({ kind: "tool", name: block.name, summary: summarizeToolInput(block.name, input) });
          }
        }
        return;
      }
      case "result": {
        const wasInterrupt = this.interrupting;
        this.interrupting = false;
        if (!turn) return;
        if (msg.subtype === "success") turn.push({ kind: "done", sessionId: msg.session_id, ...(msg.ttft_ms !== undefined && { ttftMs: msg.ttft_ms }) });
        else if (wasInterrupt) turn.push({ kind: "interrupted" });
        else turn.push({ kind: "error", message: msg.subtype.replace(/_/g, " "), retryable: false });
        return;
      }
      default:
        return;
    }
  }
}

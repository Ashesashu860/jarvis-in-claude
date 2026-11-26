/**
 * ClaudeAgentBrain against a scripted SDK: shapes follow the installed sdk.d.ts and the messages
 * seen in the M0 spike, so no API calls are made.
 */
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { ClaudeAgentBrain, summarizeToolInput, type QueryFn } from "../../src/adapters/brain/claude-agent-brain.js";
import { PolicyPermissionDecider } from "../../src/application/policy-permission-decider.js";
import type { PermissionDecider } from "../../src/application/ports.js";
import type { AgentEvent } from "../../src/application/ports.js";

const delta = (text: string, parent: string | null = null) =>
  ({ type: "stream_event", parent_tool_use_id: parent, session_id: "s1",
     event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } }) as unknown as SDKMessage;
const init = { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-5-5" } as unknown as SDKMessage;
const toolUse = { type: "assistant", parent_tool_use_id: null, session_id: "s1",
  message: { content: [{ type: "tool_use", id: "x", name: "Read", input: { file_path: "src/main.ts" } }] } } as unknown as SDKMessage;
const done = (subtype = "success") => ({ type: "result", subtype, session_id: "s1", ttft_ms: 650 }) as unknown as SDKMessage;

/** A fake query(): replies to each user message with the next scripted batch. */
function scriptedQuery(batches: SDKMessage[][]) {
  const seen: { options?: Options | undefined; prompts: string[]; interrupts: number } = { prompts: [], interrupts: 0 };
  const fn: QueryFn = ({ prompt, options }) => {
    seen.options = options;
    async function* run(): AsyncGenerator<SDKMessage, void> {
      yield init;
      for await (const user of prompt) {
        const content = user.message.content;
        seen.prompts.push(typeof content === "string" ? content : JSON.stringify(content));
        for (const m of batches.shift() ?? []) yield m;
      }
    }
    const gen = run();
    return Object.assign(gen, {
      interrupt: () => { seen.interrupts++; return Promise.resolve(undefined); },
      setModel: () => Promise.resolve(),
      setPermissionMode: () => Promise.resolve(),
      close: () => undefined,
    }) as unknown as Query;
  };
  return { fn, seen };
}

async function turn(brain: ClaudeAgentBrain, text: string): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of brain.send(text, new AbortController().signal)) out.push(ev);
  return out;
}

function makeBrain(fn: QueryFn, permission: PermissionDecider = new PolicyPermissionDecider(), sessions: string[] = []) {
  return new ClaudeAgentBrain({
    model: "sonnet", cwd: "/tmp", systemAppend: "Be brief.",
    permission, resume: "old-session", onSession: (id) => sessions.push(id), queryFn: fn,
  });
}

describe("ClaudeAgentBrain", () => {
  it("translates the SDK stream into AgentEvents and keeps one session across turns", async () => {
    const { fn, seen } = scriptedQuery([
      [delta("Hello "), delta("ignored", "sub-agent"), toolUse, delta("sir."), done()],
      [delta("Again."), done()],
    ]);
    const sessions: string[] = [];
    const brain = makeBrain(fn, new PolicyPermissionDecider(), sessions);
    expect(await turn(brain, "hi")).toEqual([
      { kind: "text", delta: "Hello " },
      { kind: "tool", name: "Read", summary: "src/main.ts" },
      { kind: "text", delta: "sir." },
      { kind: "done", sessionId: "s1", ttftMs: 650 },
    ]);
    expect((await turn(brain, "again")).at(-1)).toMatchObject({ kind: "done" });
    expect(seen.prompts).toEqual(["hi", "again"]);
    expect(sessions).toEqual(["s1"]);
    await brain.close();
  });

  it("starts the SDK safely: no user settings (no jarvis-voice hooks), resumes, pre-approves nothing", () => {
    const { fn, seen } = scriptedQuery([]);
    makeBrain(fn).start();
    expect(seen.options).toMatchObject({ settingSources: [], resume: "old-session", includePartialMessages: true });
    expect(seen.options?.allowedTools).toBeUndefined(); // every call goes through the core's policy
    expect(seen.options?.env?.JARVIS_VOICE_CHILD).toBe("1");
  });

  it("reports an interrupted turn as interrupted, and other failures as errors", async () => {
    const { fn, seen } = scriptedQuery([[delta("One. "), done("error_during_execution")], [done("error_max_turns")]]);
    const brain = makeBrain(fn);
    await brain.interrupt(); // nothing running yet: harmless
    brain.start();
    const first = brain.send("count", new AbortController().signal);
    const events: AgentEvent[] = [];
    await brain.interrupt();
    for await (const ev of first) events.push(ev);
    expect(seen.interrupts).toBe(1);
    expect(events.at(-1)).toEqual({ kind: "interrupted" });
    expect((await turn(brain, "go")).at(-1)).toEqual({ kind: "error", message: "error max turns", retryable: false });
  });

  it("asks the core's PermissionDecider from canUseTool", async () => {
    const { fn, seen } = scriptedQuery([]);
    makeBrain(fn).start();
    const canUseTool = seen.options?.canUseTool;
    if (!canUseTool) throw new Error("canUseTool missing");
    const signal = new AbortController().signal;
    await expect(canUseTool("Bash", { command: "rm -rf ~" }, { signal } as never)).resolves.toMatchObject({ behavior: "deny" });
    await expect(canUseTool("Edit", { file_path: "a.ts" }, { signal } as never)).resolves.toMatchObject({ behavior: "deny" });
    await expect(canUseTool("Read", { file_path: "a.ts" }, { signal } as never)).resolves.toMatchObject({ behavior: "allow" });
  });

  it("passes Claude's description of the call to the decider", async () => {
    const calls: unknown[] = [];
    const { fn, seen } = scriptedQuery([]);
    makeBrain(fn, { decide: (c) => { calls.push(c); return Promise.resolve({ allow: true }); } }).start();
    await seen.options?.canUseTool?.("Bash", { command: "npm test", description: "Run tests" }, { signal: new AbortController().signal } as never);
    expect(calls).toEqual([{ tool: "Bash", summary: "npm test", description: "Run tests" }]);
  });

  it("summarises tool inputs for speech", () => {
    expect(summarizeToolInput("Bash", { command: "npm test" })).toBe("npm test");
    expect(summarizeToolInput("Edit", { file_path: "src/a.ts" })).toBe("src/a.ts");
    expect(summarizeToolInput("Mystery", {})).toBe("");
  });
});

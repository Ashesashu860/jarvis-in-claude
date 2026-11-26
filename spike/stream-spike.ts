// M0 spike: prove that the Agent SDK streams a reply sentence by sentence in one live
// session, measure time to the first sentence, and check that interrupt() stops a turn.
// Run: npx tsx spike/stream-spike.ts
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** A push-based async iterable: streaming input mode reads user turns from it. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(text: string): void {
    this.queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
    this.wake?.();
  }
  close(): void {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      const next = this.queue.shift();
      if (next) { yield next; continue; }
      if (this.closed) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = null;
    }
  }
}

const SENTENCE_END = /[.!?](\s|$)/;
const VOICE_STYLE =
  "Your replies are read aloud. Keep them short and conversational; no markdown, lists or code.";

const inbox = new Inbox();
const q = query({
  prompt: inbox,
  options: {
    model: "sonnet",
    includePartialMessages: true,
    systemPrompt: { type: "preset", preset: "claude_code", append: VOICE_STYLE },
    settingSources: [],                 // no user plugins/hooks (keeps jarvis-voice out of it)
    env: { ...process.env as Record<string, string>, JARVIS_VOICE_CHILD: "1" },
    allowedTools: ["Read", "Glob", "Grep"],
    canUseTool: async (toolName) => ({ behavior: "deny", message: `spike: ${toolName} not allowed` }),
  },
});

type Turn = { prompt: string; interruptAfter?: number };
const turns: Turn[] = [
  { prompt: "In two short sentences, what is hexagonal architecture?" },
  { prompt: "And one downside, in one sentence?" },
  { prompt: "Count from one to thirty in words, one number per sentence, like 'One. Two.'", interruptAfter: 3 },
  { prompt: "Still there? Answer in five words." },
];

let t0 = 0, firstDelta = 0, firstSentence = 0, sentences = 0, buf = "", turnIdx = -1, interrupted = false;
const ms = (t: number) => `${(t - t0).toFixed(0).padStart(5)} ms`;

function startTurn(): void {
  turnIdx++;
  const turn = turns[turnIdx];
  if (!turn) { inbox.close(); return; }
  t0 = performance.now(); firstDelta = firstSentence = 0; sentences = 0; buf = ""; interrupted = false;
  console.log(`\n── turn ${turnIdx + 1}: ${turn.prompt}`);
  inbox.push(turn.prompt);
}

startTurn();
for await (const msg of q) {
  if (msg.type === "system" && msg.subtype === "init") {
    console.log(`session ${msg.session_id}  model ${msg.model}  auth ${msg.apiKeySource}`);
  } else if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
    const ev = msg.event;
    if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
      if (!firstDelta) { firstDelta = performance.now(); console.log(`  first text   ${ms(firstDelta)}`); }
      buf += ev.delta.text;
      let m: RegExpExecArray | null;
      while ((m = SENTENCE_END.exec(buf))) {
        const sentence = buf.slice(0, m.index + 1).trim();
        buf = buf.slice(m.index + m[0].length);
        sentences++;
        if (!firstSentence) firstSentence = performance.now();
        console.log(`  ${ms(performance.now())}  ▸ ${sentence}`);
        const limit = turns[turnIdx]?.interruptAfter;
        if (limit && sentences >= limit && !interrupted) {
          interrupted = true;
          const ti = performance.now();
          const r = await q.interrupt();
          console.log(`  interrupt() returned in ${(performance.now() - ti).toFixed(0)} ms ${JSON.stringify(r ?? null)}`);
        }
      }
    }
  } else if (msg.type === "result") {
    if (buf.trim()) console.log(`  ${ms(performance.now())}  ▸ ${buf.trim()}`);
    console.log(`  done ${ms(performance.now())}  (${msg.subtype}${interrupted ? ", interrupted" : ""}; first sentence at ${firstSentence ? ms(firstSentence) : "n/a"})`);
    startTurn();
  }
}
console.log("\nspike finished");

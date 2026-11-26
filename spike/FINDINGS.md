# M0 spike findings (2026-11-26)

`npx tsx spike/stream-spike.ts`, Agent SDK `@anthropic-ai/claude-agent-sdk` 0.3.332, model alias `sonnet`
(resolved to `claude-sonnet-5-5`), MacBook Air, home network. Two runs.

## Measured

| Turn | First text | First full sentence | Reply done |
|---|---|---|---|
| 1, new session (run 1, includes the first tsx compile) | — | 5527 ms | 5757 ms |
| 1, new session (run 2) | 1302 ms | 1748 ms | 2098 ms |
| 2, warm session | 660 ms | 1002 ms | 1026 ms |
| 4, warm, after an interrupt | 779 ms | 813 ms | 836 ms |
| `interrupt()` call | returned in **5 ms** | turn ended as `error_during_execution` | session kept working |

**Latency estimate, updated:** end-of-speech wait 0.8 s + transcription 0.55 s + first sentence about 0.9 s
(warm) + voice render 0.3 s, about **2.5–2.6 s** to first audio. The 2.5 s median target is tight: lowering
the wait to 0.7 s, or adding streaming speech recognition later, gives margin. A new session pays an extra
0.7–4.5 s once, so **start `query()` at app launch**, so process start-up overlaps with the user's first words.

## Confirmed API shapes (from the installed `sdk.d.ts`)

- `SDKUserMessage = { type: "user", message: MessageParam, parent_tool_use_id: string | null, priority?, … }`.
  Streaming input mode takes an `AsyncIterable` of these; one `session_id` is kept across turns.
- `SDKPartialAssistantMessage = { type: "stream_event", event: BetaRawMessageStreamEvent, parent_tool_use_id,
  session_id, ttft_ms?, … }`. Text arrives as `content_block_delta` with `delta.type === "text_delta"`.
  Subagent chatter has a non-null `parent_tool_use_id`, so filter it out.
- `SDKSystemMessage` (`subtype: "init"`) carries `session_id`, `model`, `permissionMode`, `apiKeySource`.
- `SDKResultMessage`: `subtype: "success" | error subtypes`, with `ttft_ms` and `duration_ms`, which are useful for the timing log.
- `CanUseTool = (toolName, input, { signal, suggestions?, blockedPath?, … }) => Promise<PermissionResult>`;
  `PermissionResult = { behavior: "allow", updatedInput?, … } | { behavior: "deny", message, interrupt? }`.
- `PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`.

## Implications for the build

1. **Auth works with the Claude Code login**: `apiKeySource: "none"`, no API key needed.
2. **`settingSources: []` is required.** Without it the user's settings load jarvis-voice's hooks into this
   session, and it would speak twice. Also set `JARVIS_VOICE_CHILD=1` in `env`.
3. **Text arrives in bursts.** After `interrupt()`, text already received (here "Four" to "Seventeen") must
   be dropped by the chunker. Interrupt clears the turn's buffer and ignores deltas until the next turn.
4. **A bare name in `allowedTools` bypasses `canUseTool`** (the SDK warns about it). Use it on purpose for
   Read, Glob and Grep; everything else falls through to `canUseTool`, which becomes the spoken permission
   dialog. Use scoped `disallowedTools` rules for things that are never allowed.
5. **The ports in the architecture hold.** `AgentEvent.text` maps to `text_delta`, `tool` to
   `content_block_start` with `tool_use`, `done` to `result`, and `interrupt()` to `query.interrupt()`.

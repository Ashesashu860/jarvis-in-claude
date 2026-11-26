import type { Answer } from "../domain/intents.js";
import { classify, DEFAULT_RULES, type PermissionRules } from "../domain/permission-policy.js";
import type { ToolCall } from "../domain/tool-speech.js";
import type { PermissionDecider } from "./ports.js";

/** Asks the user about one tool call (out loud, in the conversation). */
export type AskUser = (call: ToolCall, signal: AbortSignal) => Promise<Answer>;

/**
 * Applies the domain's PermissionPolicy, and asks the user (through `ask`) only when the policy
 * says so. "Always" is remembered for the rest of the session: for a tool, or for Bash, that exact
 * command. Without an asker, calls that need approval are declined with a reason for Claude.
 */
export class PolicyPermissionDecider implements PermissionDecider {
  private readonly remembered = new Set<string>();

  constructor(
    private readonly rules: PermissionRules = DEFAULT_RULES,
    private readonly ask?: AskUser,
  ) {}

  async decide(call: ToolCall, signal: AbortSignal) {
    switch (classify(call.tool, call.summary, this.rules)) {
      case "allow":
        return { allow: true } as const;
      case "deny":
        return { allow: false, reason: "This action is never allowed from voice mode." } as const;
      case "ask": {
        const key = call.tool === "Bash" ? `Bash ${call.summary}` : call.tool;
        if (this.remembered.has(key)) return { allow: true } as const;
        if (!this.ask) {
          return { allow: false, reason: "This needs the user's approval, which can't be asked for here. Tell the user what you wanted to do instead." } as const;
        }
        const answer = await this.ask(call, signal);
        if (answer === "always") this.remembered.add(key);
        if (answer !== "no") return { allow: true } as const;
        return { allow: false, reason: "The user said no. Ask what they'd like instead; don't retry the same call." } as const;
      }
    }
  }
}

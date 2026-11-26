import { classify, DEFAULT_RULES, type PermissionRules } from "../domain/permission-policy.js";
import type { PermissionDecider } from "./ports.js";

/** Asks the user about one tool call; true means yes. Spoken in M5, absent in typed mode for now. */
export type AskUser = (question: { tool: string; summary: string }, signal: AbortSignal) => Promise<boolean>;

/**
 * Applies the domain's PermissionPolicy, and asks the user (through `ask`) only when the
 * policy says so. Without an asker, calls that need approval are declined with a reason that
 * Claude passes on to the user.
 */
export class PolicyPermissionDecider implements PermissionDecider {
  constructor(
    private readonly rules: PermissionRules = DEFAULT_RULES,
    private readonly ask?: AskUser,
  ) {}

  async decide(request: { tool: string; summary: string }, signal: AbortSignal) {
    switch (classify(request.tool, request.summary, this.rules)) {
      case "allow":
        return { allow: true } as const;
      case "deny":
        return { allow: false, reason: "This action is never allowed from voice mode." } as const;
      case "ask":
        if (this.ask && (await this.ask(request, signal))) return { allow: true } as const;
        return {
          allow: false,
          reason: this.ask
            ? "The user declined."
            : "This needs the user's approval, which jarvis-rt can't ask for yet. Tell the user what you wanted to do instead.",
        } as const;
    }
  }
}

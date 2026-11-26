/**
 * Decides, without asking anyone, whether a tool call is allowed, must be asked about, or is
 * never allowed. Asking is the application's job (a spoken "Shall I…?" in M5).
 */
export type Verdict = "allow" | "ask" | "deny";

export interface PermissionRules {
  /** Tools that never need asking (reading and searching). */
  readonly autoAllow: readonly string[];
  /** Calls that are never allowed, matched against "<Tool> <summary>". */
  readonly alwaysDeny: readonly RegExp[];
}

export const DEFAULT_RULES: PermissionRules = {
  autoAllow: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
  alwaysDeny: [
    /^Bash .*\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\*)/i, // rm -rf on / ~ or *
    /^Bash .*\bgit\s+push\b.*--force\b/i,
    /^Bash .*\bgit\s+reset\s+--hard\b/i,
    /^Bash .*\bsudo\b/i,
    /^Bash .*\bmkfs\b|\bdd\s+if=/i,
  ],
};

export function classify(tool: string, summary: string, rules: PermissionRules = DEFAULT_RULES): Verdict {
  const call = `${tool} ${summary}`;
  if (rules.alwaysDeny.some((re) => re.test(call))) return "deny";
  if (rules.autoAllow.includes(tool)) return "allow";
  return "ask";
}

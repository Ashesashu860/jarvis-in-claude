/** Runs `jarvis-rt doctor`'s checks in order and prints one line each, with a fix for each problem. */
export type CheckResult =
  | { readonly status: "ok"; readonly detail: string }
  | { readonly status: "warn" | "fail"; readonly detail: string; readonly fix: string };

export interface Check {
  readonly name: string;
  run(): Promise<CheckResult>;
}

const MARK = { ok: "✓", warn: "!", fail: "✗" } as const;

/** True when nothing failed (warnings are fine). A check that throws counts as failed. */
export async function runChecks(checks: readonly Check[], write: (line: string) => void): Promise<boolean> {
  let ok = true;
  for (const check of checks) {
    let r: CheckResult;
    try {
      r = await check.run();
    } catch (err) {
      r = { status: "fail", detail: err instanceof Error ? err.message : String(err), fix: "See the message above." };
    }
    write(`${MARK[r.status]} ${check.name}: ${r.detail}`);
    if (r.status !== "ok") write(`    → ${r.fix}`);
    if (r.status === "fail") ok = false;
  }
  write(ok ? "\nAll good. Run jarvis-rt to start." : "\nSome checks failed; fix them and run jarvis-rt doctor again.");
  return ok;
}

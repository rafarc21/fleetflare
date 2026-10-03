// skills/junior/src/usage.ts
// Issue #218: local usage recording for junior calls that never reach the
// fleet Worker — a laptop/direct-transport run, where there is no studio to
// record a usage row server-side (apps/fleet/src/junior/usage.ts does that
// half, for proxy transport). Same field names as that D1 row (snake_case
// token/count fields), structurally parallel, so `fleet junior stats` (a
// later step on this issue) can merge the two.
//
// Only counts/ids/booleans/strings ever cross into this signature — never
// prompt/response text — so there is nothing here to redact, by
// construction.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

/** `~/.local/share/fleet/junior-usage.jsonl` — exported so `fleet junior
 *  stats` (apps/fleet/cli/junior.ts) reads the exact same path rather than
 *  duplicating the literal. */
export function juniorUsageLogPath(home: string): string {
  return join(home, ".local", "share", "fleet", "junior-usage.jsonl");
}

export interface LocalUsageRow {
  ts: number;
  mode: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  ok: boolean;
}

/**
 * Append one JSON line. Never throws — a usage-logging failure must never
 * block or fail the junior call (issue #218 Boundaries). On failure, logs one
 * line to stderr and returns normally.
 */
export function recordUsageLocal(env: Record<string, string | undefined>, row: LocalUsageRow): void {
  try {
    const home = env.HOME || homedir();
    const path = juniorUsageLogPath(home);
    mkdirSync(join(home, ".local", "share", "fleet"), { recursive: true });
    const line = JSON.stringify({
      ts: row.ts,
      id: hostname(),
      mode: row.mode,
      model: row.model,
      input_tokens: row.inputTokens,
      output_tokens: row.outputTokens,
      ok: row.ok,
    });
    appendFileSync(path, `${line}\n`);
  } catch (e) {
    console.error(`junior: usage log write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

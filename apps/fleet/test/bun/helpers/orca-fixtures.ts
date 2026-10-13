import type { OrcaResult } from "../../../cli/orca-workspace";

// Bun-lane shared orca fixtures (sweep 33 F4, issue #748): the three
// byte-identical pieces every orca suite below copies — the env that marks
// "inside Orca", the ok-OrcaResult wrapper, and the connected-terminal list
// payload. Per-suite fixtures (TERM_CREATED, CREATED, REPOS, worktrees,
// terminalEntries, fake) differ per file and stay local to each suite.

export const ORCA_ENV = { TERM_PROGRAM: "Orca" } as Record<string, string | undefined>;

export function ok(stdout: string): OrcaResult {
  return { ok: true, stdout, stderr: "", timedOut: false };
}

// The `fleet attach <id>` terminal is always titled "fleet" (MEASURED on
// 1.4.198 — see orca-workspace.ts's own comment): the process name, never
// the studio id and never the custom label `terminal rename` sets. Board
// #42: idempotency keys on BOTH `connected` AND `title === "fleet"` — this
// helper covers the common case (every entry IS the attach terminal), each
// argument is one terminal's `connected` value.
export function terminals(...connected: boolean[]): OrcaResult {
  return ok(JSON.stringify({
    ok: true,
    result: { terminals: connected.map((c, i) => ({ handle: `term_${i}`, title: "fleet", connected: c })) },
  }));
}

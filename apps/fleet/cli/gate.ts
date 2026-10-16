// apps/fleet/cli/gate.ts — `fleet gate start <pr>` / `fleet gate watch <pr> <runId>`
// (#715 Phase 1). Same request-building shape cli/models.ts already uses —
// one POST to kick a run off, one GET per poll, a thrown Error on anything
// but a 2xx. No GitHub token here: both routes are Access-JWT-authenticated
// board verbs, same lane as every other `fleet` command (src/gate/routes.ts
// owns the one place a real GitHub token gets minted, Task 14).
import { accessHeaders, detectRepo, type Credentials } from "./fleet";
import { errText } from "./diag";

export interface GateStatusResponse {
  state: "pending" | "success" | "failure" | "error";
  description?: string;
  statusPostFailed?: boolean;
}

const POLL_MS = 5_000;

/** `gate watch`'s overall ceiling: 45 minutes with no verdict ends the watch. */
export const GATE_WATCH_DEADLINE_MS = 45 * 60_000;

/** The repo this command targets: the folder's own `origin`, same source
 *  every other repo-scoped verb reads (`fleet ff`, `detectRepo`). */
async function gatedRepo(): Promise<string | null> {
  const detected = await detectRepo();
  if (!detected.slug) {
    console.error(`fleet gate: ${detected.reason ?? "this folder names no repo"}`);
    process.exitCode = 2;
    return null;
  }
  return detected.slug;
}

export async function cmdGateStart(creds: Credentials, pr: number): Promise<void> {
  const repo = await gatedRepo();
  if (!repo) return;
  let res: Response;
  try {
    res = await fetch(new URL("/studio/gate/start", creds.workerUrl), {
      method: "POST", headers: { ...accessHeaders(creds), "content-type": "application/json" },
      body: JSON.stringify({ repo, pr }),
    });
  } catch (err) {
    throw new Error(`fleet gate-start: could not reach ${creds.workerUrl}: ${errText(err)}`);
  }
  const body = await res.json() as { started?: boolean; runId?: string; error?: string };
  if (!res.ok || body.error) {
    console.error(`gate-start failed: ${body.error ?? res.status}`);
    process.exitCode = 2;
    return;
  }
  console.log(`gate-start: run ${body.runId} started for PR #${pr}`);
}

/** Pure — extracted so the exit-code mapping is unit-testable without a
 *  real network call, same "localci.sh exit convention" shape its own
 *  Exit comment states (localci.sh:24): 0 green, 1 red, 2 infra error,
 *  3 a status POST failed twice. statusPostFailed overrides the state's
 *  own code, since a stale gate/verdict is itself the failure to report. */
export function gateWatchExitCode(status: GateStatusResponse): number {
  if (status.statusPostFailed) return 3;
  switch (status.state) {
    case "success": return 0;
    case "failure": return 1;
    case "error": return 2;
    case "pending": return 2; // caller should not exit on pending, see cmdGateWatch
    default: return 2; // a missing/unknown state is never a green exit
  }
}

export type GateWatchDecision =
  | { kind: "terminal"; status: GateStatusResponse }
  | { kind: "continue" }
  | { kind: "deadline" };

/** Pure decision for one poll tick: a non-pending status ends the watch
 *  immediately, a pending one past the 45-min ceiling ends it as a deadline,
 *  otherwise keep polling. */
export function gateWatchDecision(status: GateStatusResponse, elapsedMs: number): GateWatchDecision {
  if (status.state !== "pending") return { kind: "terminal", status };
  return elapsedMs >= GATE_WATCH_DEADLINE_MS ? { kind: "deadline" } : { kind: "continue" };
}

/** The deadline's exit path: one operator-facing line, exit 2 (infra — the
 *  gate never reached a verdict, so this must never read as a green or red). */
export function onGateWatchDeadline(runId: string): void {
  console.error(`gate watch: no verdict after 45 min (run ${runId})`);
  process.exitCode = 2;
}

export async function cmdGateWatch(creds: Credentials, pr: number, runId: string): Promise<void> {
  const repo = await gatedRepo();
  if (!repo) return;
  const url = new URL("/studio/gate/status", creds.workerUrl);
  url.searchParams.set("repo", repo);
  url.searchParams.set("pr", String(pr));
  url.searchParams.set("runId", runId);
  const started = Date.now();
  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, { headers: accessHeaders(creds) });
    } catch (err) {
      console.error(`fleet gate-watch: could not reach ${creds.workerUrl}: ${errText(err)}`);
      process.exitCode = 2;
      return;
    }
    const status = await res.json() as GateStatusResponse;
    const decision = gateWatchDecision(status, Date.now() - started);
    if (decision.kind === "terminal") {
      console.log(`gate: ${decision.status.state}${decision.status.description ? ` — ${decision.status.description}` : ""}`);
      process.exitCode = gateWatchExitCode(decision.status);
      return;
    }
    if (decision.kind === "deadline") {
      onGateWatchDeadline(runId);
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

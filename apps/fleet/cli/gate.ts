// apps/fleet/cli/gate.ts — `fleet gate run <pr>` (start + watch, the one-shot verb), `fleet gate start <pr>` / `fleet gate watch <pr> <runId>`
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

export async function cmdGateWatch(creds: Credentials, pr: number, runId: string): Promise<void> {
  const repo = await gatedRepo();
  if (!repo) return;
  const url = new URL("/studio/gate/status", creds.workerUrl);
  url.searchParams.set("repo", repo);
  url.searchParams.set("pr", String(pr));
  url.searchParams.set("runId", runId);
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
    if (status.state !== "pending") {
      console.log(`gate: ${status.state}${status.description ? ` — ${status.description}` : ""}`);
      process.exitCode = gateWatchExitCode(status);
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export interface GateRunOptions {
  /** Poll interval. Tests shorten it; the CLI keeps the 5s default. */
  pollMs?: number;
}

/** `fleet gate run <pr>`: start the run, then poll its run id to a verdict.
 *  Exit 0 green, 1 red, 2 error or gate off. Any other exit code (a status
 *  POST that failed twice) reads as 2: a stale verdict is still not green. The
 *  repo is passed in, so a caller in any repo's checkout names it the same way. */
export async function runGate(creds: Credentials, repo: string, pr: number, opts: GateRunOptions = {}): Promise<number> {
  let runId: string;
  try {
    const res = await fetch(new URL("/studio/gate/start", creds.workerUrl), {
      method: "POST", headers: { ...accessHeaders(creds), "content-type": "application/json" },
      body: JSON.stringify({ repo, pr }),
    });
    const body = await res.json() as { started?: boolean; runId?: string; error?: string };
    if (!res.ok || body.error || typeof body.runId !== "string") {
      console.error(`gate-start failed: ${body.error ?? res.status}`);
      return 2;
    }
    runId = body.runId;
  } catch (err) {
    console.error(`fleet gate run: could not reach ${creds.workerUrl}: ${errText(err)}`);
    return 2;
  }
  console.log(`gate-start: run ${runId} started for PR #${pr}`);

  const url = new URL("/studio/gate/status", creds.workerUrl);
  url.searchParams.set("repo", repo);
  url.searchParams.set("pr", String(pr));
  url.searchParams.set("runId", runId);
  for (;;) {
    let status: GateStatusResponse;
    try {
      const res = await fetch(url, { headers: accessHeaders(creds) });
      status = await res.json() as GateStatusResponse;
    } catch (err) {
      console.error(`fleet gate run: could not reach ${creds.workerUrl}: ${errText(err)}`);
      return 2;
    }
    if (status.state !== "pending") {
      console.log(`gate: ${status.state}${status.description ? ` — ${status.description}` : ""}`);
      const code = gateWatchExitCode(status);
      return code === 0 || code === 1 ? code : 2;
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? POLL_MS));
  }
}

/** The CLI entry: the repo comes from the folder's own origin, as every repo-scoped verb does. */
export async function cmdGateRun(creds: Credentials, pr: number): Promise<void> {
  const repo = await gatedRepo();
  if (!repo) return;
  process.exitCode = await runGate(creds, repo, pr);
}


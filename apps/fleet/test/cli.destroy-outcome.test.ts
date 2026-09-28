import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  requestDestroy, DESTROY_CLIENT_TIMEOUT_MS, DESTROY_POLL_ATTEMPTS, DESTROY_POLL_INTERVAL_MS,
} from "../cli/destroy-outcome";
import { CONTAINER_PROBE_MS } from "../src/studio/do";
import { EXEC_CLASSES } from "../src/studio/sandbox-api";
import type { StudioStatus } from "../src/studio/types";

// Board task #203, measured 2026-09-24 ~21:20Z tearing down
// demosite-life--web-studio: `fleet destroy` printed "fleet: The operation
// timed out." and no teardown line, yet `fleet ls --fresh` then showed the
// studio STOPPED and `orca worktree list` showed 0 rows — the CLI's request
// timeout fired while the Worker's destroy (#129 probe-first, rescue sync,
// stop) kept running and SUCCEEDED. The operator was shown a failure for a
// success, and the CLI-side Orca teardown (#57/#135) never ran.
//
// cli/destroy-outcome.ts, not cli/fleet.ts — the same Bun-global reason
// test/cli.fleet.test.ts's header gives for importing cli/fleet-totals.ts
// directly.

const DESTROY_URL = "https://x/studio/demosite-life--web-studio/destroy";
const STATUS_URL = "https://x/studio/demosite-life--web-studio/status";
const ID = "demosite-life--web-studio";

function statusRow(state: StudioStatus["state"]): StudioStatus {
  return {
    id: ID, state, tailscaleHost: null, lastRefresh: null,
    error: null, lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
  };
}

/**
 * The fake slow Worker: its /destroy never answers (it hangs until the
 * client's own AbortSignal fires — exactly the measured shape), and its
 * /status answers from a queue, the last entry repeating.
 */
function fakeSlowWorker(statusReplies: (() => Promise<Response>)[]): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let next = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/destroy")) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }
    const reply = statusReplies[Math.min(next++, statusReplies.length - 1)];
    return reply();
  };
  return { fetchImpl, calls };
}

const noSleep = async (): Promise<void> => {};
const opts = (fetchImpl: typeof fetch) => ({ fetchImpl, timeoutMs: 20, sleep: noSleep });

describe("requestDestroy — a destroy request that times out never reports a verdict it does not have", () => {
  it("timed-out request, then status reads stopped: the destroy SUCCEEDED, and the Orca teardown runs", async () => {
    const { fetchImpl, calls } = fakeSlowWorker([async () => Response.json(statusRow("stopped"))]);
    const report = await requestDestroy({ destroy: DESTROY_URL, status: STATUS_URL }, {}, ID, opts(fetchImpl));

    expect(report.kind).toBe("timeout-stopped");
    expect(report.teardown).toBe(true);
    expect(report.status?.state).toBe("stopped");
    expect(report.exitCode).toBe(0);
    expect(report.lines.join("\n")).toContain("the destroy SUCCEEDED");
    // One poll was enough — the row was already stopped.
    expect(calls.filter((u) => u.endsWith("/status"))).toHaveLength(1);
  });

  it("timed-out request, status never reaches stopped: destroy still running, check fleet ls — and NO teardown claim", async () => {
    const { fetchImpl, calls } = fakeSlowWorker([async () => Response.json(statusRow("running"))]);
    const report = await requestDestroy({ destroy: DESTROY_URL, status: STATUS_URL }, {}, ID, opts(fetchImpl));

    expect(report.kind).toBe("timeout-running");
    expect(report.teardown).toBe(false);
    const text = report.lines.join("\n");
    expect(text).toContain("destroy still running");
    expect(text).toContain("fleet ls");
    expect(text).toContain("no Orca teardown ran");
    // The bound: DESTROY_POLL_ATTEMPTS reads, no more.
    expect(calls.filter((u) => u.endsWith("/status"))).toHaveLength(DESTROY_POLL_ATTEMPTS);
    // Never a verdict this side cannot support.
    expect(text).not.toMatch(/\bfailed\b/i);
  });

  it("timed-out request, status unreachable: says so, and never the word \"failed\" as the verdict", async () => {
    const { fetchImpl, calls } = fakeSlowWorker([async () => { throw new Error("connect ECONNREFUSED 10.0.0.1:443"); }]);
    const report = await requestDestroy({ destroy: DESTROY_URL, status: STATUS_URL }, {}, ID, opts(fetchImpl));

    expect(report.kind).toBe("timeout-unknown");
    expect(report.teardown).toBe(false);
    const text = report.lines.join("\n");
    expect(text).toContain("UNKNOWN");
    expect(text).toContain("did not answer");
    expect(text).toContain("connect ECONNREFUSED");
    expect(text).toContain("No Orca teardown ran");
    expect(text).not.toMatch(/\bfailed\b/i);
    expect(calls.filter((u) => u.endsWith("/status"))).toHaveLength(DESTROY_POLL_ATTEMPTS);
  });

  it("a status route answering non-2xx is unreachable, not a verdict — the row is never assumed stopped", async () => {
    const { fetchImpl } = fakeSlowWorker([async () => new Response("bad gateway", { status: 502 })]);
    const report = await requestDestroy({ destroy: DESTROY_URL, status: STATUS_URL }, {}, ID, opts(fetchImpl));

    expect(report.kind).toBe("timeout-unknown");
    expect(report.teardown).toBe(false);
    expect(report.lines.join("\n")).toContain("502");
  });

  it("a row that reaches stopped on a LATER poll is still the success it is", async () => {
    const { fetchImpl, calls } = fakeSlowWorker([
      async () => Response.json(statusRow("running")),
      async () => Response.json(statusRow("running")),
      async () => Response.json(statusRow("stopped")),
    ]);
    const report = await requestDestroy({ destroy: DESTROY_URL, status: STATUS_URL }, {}, ID, opts(fetchImpl));

    expect(report.kind).toBe("timeout-stopped");
    expect(report.teardown).toBe(true);
    expect(calls.filter((u) => u.endsWith("/status"))).toHaveLength(3);
  });

  it("a degraded row is NOT a confirmed stop — it polls on and reports the honest still-running message", async () => {
    const { fetchImpl } = fakeSlowWorker([async () => Response.json(statusRow("degraded"))]);
    const report = await requestDestroy({ destroy: DESTROY_URL, status: STATUS_URL }, {}, ID, opts(fetchImpl));

    expect(report.kind).toBe("timeout-running");
    expect(report.teardown).toBe(false);
  });

  it("a destroy that answers 200 needs no poll at all: the row it returned IS the outcome", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/destroy")) return Response.json(statusRow("stopped"));
      throw new Error("the status route must not be polled on a plain success");
    };
    const report = await requestDestroy({ destroy: DESTROY_URL, status: STATUS_URL }, {}, ID, opts(fetchImpl));

    expect(report.kind).toBe("ok");
    expect(report.teardown).toBe(true);
    expect(report.status?.state).toBe("stopped");
  });

  it("a refusal (409, an open assigned board task) stays a refusal — no poll, no teardown", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/destroy")) return new Response("destroy refused: task #7 is open", { status: 409 });
      throw new Error("a refusal must not be polled");
    };
    const report = await requestDestroy({ destroy: DESTROY_URL, status: STATUS_URL }, {}, ID, opts(fetchImpl));

    expect(report.kind).toBe("http-error");
    expect(report.teardown).toBe(false);
    expect(report.exitCode).toBe(1);
    expect(report.lines.join("\n")).toContain("destroy refused: task #7 is open");
  });
});

describe("the destroy request's own budget", () => {
  // #129's boot wait (sbAwaitReady: 30s instanceGet + 90s portReady) + the 8s
  // probe + #110's 120s sync class, plus slack for destroy()/record. Anything
  // past that (rescue-push and harvest are 300s rescue-class execs) is what
  // the poll is for — waiting longer on one socket buys nothing an operator
  // can read.
  it("covers the boot wait, the probe and one sync-class exec", () => {
    expect(DESTROY_CLIENT_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000 + CONTAINER_PROBE_MS + EXEC_CLASSES.sync.timeoutMs);
  });

  it("polls a bounded number of times, never forever", () => {
    expect(DESTROY_POLL_ATTEMPTS).toBe(6);
    expect(DESTROY_POLL_INTERVAL_MS).toBe(10_000);
  });
});

// The teardown gate, pinned in cli/fleet.ts's own source: the ONLY caller of
// removeStudioWorkspace on the destroy path is behind `report.teardown`,
// which only a confirmed `stopped` row ever sets.
describe("cli/fleet.ts's destroy flow", () => {
  it("runs the Orca teardown only when the report says the studio is confirmed stopped", () => {
    const src = env.TEST_CLI_FLEET_SRC;
    const from = src.indexOf("async function cmdDestroy(");
    const body = src.slice(from, src.indexOf("\n}", from));
    expect(body).toContain("await requestDestroy(");
    expect(body).toMatch(/if \(report\.teardown\)[\s\S]*?removeStudioWorkspace\(/);
    // No second, ungated call anywhere in that body.
    expect(body.match(/removeStudioWorkspace\(/g)).toHaveLength(1);
  });
});

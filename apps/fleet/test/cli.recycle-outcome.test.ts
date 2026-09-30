import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  requestRecycle, RECYCLE_CLIENT_TIMEOUT_MS, RECYCLE_POLL_ATTEMPTS, RECYCLE_POLL_INTERVAL_MS,
} from "../cli/recycle-outcome";
import { DESTROY_CLIENT_TIMEOUT_MS } from "../cli/destroy-outcome";
import { EXEC_CLASSES } from "../src/studio/sandbox-api";
import type { StudioStatus } from "../src/studio/types";
import type { ObservedSession } from "../src/studio/observed";

// Board task #133, measured 2026-09-30: `fleet recycle <id>` on a studio
// whose lead sat on a limit modal never returned (killed after 15 min) even
// though the container came back running. cmdRecycle's bare `fetch(...)`
// (cli/fleet.ts) carried no timeout, no AbortSignal — the exact class of bug
// #203 already fixed for `fleet destroy`. See cli/recycle-outcome.ts's own
// header for the full story and cli/destroy-outcome.ts's header for the
// original measured incident this mirrors.
//
// cli/recycle-outcome.ts, not cli/fleet.ts — same Bun-global reason
// test/cli.destroy-outcome.test.ts's header gives for importing
// cli/destroy-outcome.ts directly.

const RECYCLE_URL = "https://x/studio/demosite-life--web-studio/recycle";
const STATUS_URL = "https://x/studio/demosite-life--web-studio/status";
const ID = "demosite-life--web-studio";
const START = new Date("2026-09-30T12:00:00.000Z");

function session(over: Partial<ObservedSession> = {}): ObservedSession {
  return {
    verdict: "resumed", at: "2026-09-30T12:00:00.000Z", via: "recycle", restore: "restored",
    snapshotAgeS: 5, turnsBefore: 3, reason: null, ...over,
  };
}

function statusRow(
  state: StudioStatus["state"], observedSession?: ObservedSession | null,
  readiness?: StudioStatus["readiness"],
): StudioStatus {
  return {
    id: ID, state, tailscaleHost: null, lastRefresh: null,
    error: null, lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    observed: observedSession === undefined ? undefined : { session: observedSession } as StudioStatus["observed"],
    readiness,
  };
}

/**
 * The fake slow Worker: its /recycle never answers (it hangs until the
 * client's own AbortSignal fires — exactly the measured shape), and its
 * /status answers from a queue, the last entry repeating.
 */
function fakeSlowWorker(statusReplies: (() => Promise<Response>)[]): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let next = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/recycle")) {
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
const opts = (fetchImpl: typeof fetch) => ({ fetchImpl, timeoutMs: 20, sleep: noSleep, now: () => START });

describe("requestRecycle — a recycle request that times out never reports a verdict it does not have", () => {
  it("timed-out request, then status shows THIS recycle's own bring-up landed: recycle SUCCEEDED", async () => {
    const { fetchImpl, calls } = fakeSlowWorker([
      async () => Response.json(statusRow(
        "running", session({ at: "2026-09-30T12:00:05.000Z" }),
        { kind: "provisioned", checkedAt: "2026-09-30T12:00:06.000Z" },
      )),
    ]);
    const report = await requestRecycle({ recycle: RECYCLE_URL, status: STATUS_URL }, {}, ID, opts(fetchImpl));

    expect(report.kind).toBe("timeout-provisioned");
    expect(report.status?.state).toBe("running");
    expect(report.exitCode).toBe(0);
    expect(report.lines.join("\n")).toContain("recycle SUCCEEDED");
    // One poll was enough — the row already showed this recycle's own landing.
    expect(calls.filter((u) => u.endsWith("/status"))).toHaveLength(1);
  });

  it("timed-out request, status shows running but via an OLD bring-up: stays timeout-pending, never \"failed\"", async () => {
    const { fetchImpl, calls } = fakeSlowWorker([
      async () => Response.json(statusRow("running", session({ via: "provision", at: "2026-09-30T12:00:05.000Z" }))),
    ]);
    const report = await requestRecycle({ recycle: RECYCLE_URL, status: STATUS_URL }, {}, ID, opts(fetchImpl));

    expect(report.kind).toBe("timeout-pending");
    const text = report.lines.join("\n");
    expect(text).toContain("still running");
    expect(text).toContain("fleet ls");
    expect(text).not.toMatch(/\bfailed\b/i);
    // Review round 2, fix 2: a timeout outcome ("we don't know") must exit
    // with a code distinct from http-error's 1 ("the Worker refused this").
    expect(report.exitCode).toBe(2);
    // The bound: RECYCLE_POLL_ATTEMPTS reads, no more.
    expect(calls.filter((u) => u.endsWith("/status"))).toHaveLength(RECYCLE_POLL_ATTEMPTS);
  });

  it("timed-out request, status shows running+via=recycle but a STALE `at` before this call started: stays timeout-pending", async () => {
    const { fetchImpl } = fakeSlowWorker([
      async () => Response.json(statusRow("running", session({ via: "recycle", at: "2026-09-30T11:59:00.000Z" }))),
    ]);
    const report = await requestRecycle({ recycle: RECYCLE_URL, status: STATUS_URL }, {}, ID, opts(fetchImpl));

    expect(report.kind).toBe("timeout-pending");
    expect(report.lines.join("\n")).not.toMatch(/\bfailed\b/i);
  });

  // Clock-skew edge case (`bringupLanded`'s own doc comment): `startedAt` is
  // this CLI's own clock, `session.at` is stamped by the Worker on
  // Cloudflare's edge — never reconciled here. The two tests below prove
  // both directions of that asymmetry are understood, not silently ignored.
  it("a Worker clock running a hair BEHIND the CLI's reports the safe failure mode: an extra timeout-pending, never a crash or a false success", async () => {
    // Same real event as the very first test in this file (a genuine recycle
    // bring-up, `via: "recycle"`, WITH a fresh readiness write already
    // landed), but the Worker's own clock stamped both `session.at` AND
    // `readiness.checkedAt` one second BEFORE this side's `startedAt` — a
    // lagging server clock, not a stale row. `bringupLanded`'s strict `>=`
    // reads this as not-yet-proven: the safe direction (never a crash, never
    // a false success) — costs one extra poll cycle at worst.
    const { fetchImpl } = fakeSlowWorker([
      async () => Response.json(statusRow(
        "running", session({ via: "recycle", at: "2026-09-30T11:59:59.000Z" }),
        { kind: "provisioned", checkedAt: "2026-09-30T11:59:59.000Z" },
      )),
    ]);
    const report = await requestRecycle({ recycle: RECYCLE_URL, status: STATUS_URL }, {}, ID, opts(fetchImpl));

    expect(report.kind).toBe("timeout-pending");
    expect(report.lines.join("\n")).not.toMatch(/\bfailed\b/i);
  });

  it("documents the NARROWED residual risk: a Worker clock running ahead on BOTH stamps can still make a stale via=recycle row with its own fresh readiness satisfy the timestamp check (false success, not guarded against)", async () => {
    // This row is from a bring-up that, in real wall-clock terms, finished
    // BEFORE this call's own POST ever fired -- but the Worker's clock, if
    // running ahead of this CLI's, could stamp BOTH `session.at` AND
    // `readiness.checkedAt` with values that still read at/after
    // `startedAt`. bringupLanded has no way to tell this apart from a
    // genuine, freshly-landed bring-up: it is not fixed, only named in its
    // own doc comment. Requiring a fresh `readiness.checkedAt` (fix #133
    // review round 2) narrows this from "any fresh-looking session stamp" to
    // "two independent fresh-looking stamps, both from the same clock" — a
    // much smaller attack surface, but this test exists to prove the
    // remaining sliver is understood and pinned, not silently reintroduced
    // by a future "improvement" that starts guessing at skew tolerance.
    const { fetchImpl } = fakeSlowWorker([
      async () => Response.json(statusRow(
        "running", session({ via: "recycle", at: "2026-09-30T12:00:00.001Z" }),
        { kind: "provisioned", checkedAt: "2026-09-30T12:00:00.001Z" },
      )),
    ]);
    const report = await requestRecycle({ recycle: RECYCLE_URL, status: STATUS_URL }, {}, ID, opts(fetchImpl));

    expect(report.kind).toBe("timeout-provisioned");
  });

  // Fix #133 review round 2, finding 1 (the most severe): the real bug, not
  // just a clock-skew edge case. `provisionCore`'s own bring-up steps stamp
  // `observed.session` with `via: "recycle"` and a fresh `at` BEFORE this
  // recycle's own post-provision readiness check (do.ts's `recycleVerdict`,
  // up to 60s) ever runs. A poll landing inside that window used to see
  // `state: "running"` + a fresh `via: "recycle"` session and report
  // `timeout-provisioned` — SUCCEEDED — for a studio whose readiness check
  // could still come back "bare" moments later, flipping `state` to
  // `"degraded"` and 500ing. A row with no `readiness` at all (or one from
  // BEFORE this call started) proves the readiness write for THIS recycle
  // has not landed yet, so `bringupLanded` must not accept it.
  it("status shows a fresh via=recycle session but NO readiness write yet: stays timeout-pending, never a false success", async () => {
    const { fetchImpl } = fakeSlowWorker([
      async () => Response.json(statusRow("running", session({ at: "2026-09-30T12:00:05.000Z" }))),
    ]);
    const report = await requestRecycle({ recycle: RECYCLE_URL, status: STATUS_URL }, {}, ID, opts(fetchImpl));

    expect(report.kind).toBe("timeout-pending");
    expect(report.lines.join("\n")).not.toMatch(/\bfailed\b/i);
  });

  it("status shows a fresh via=recycle session but a STALE readiness write (from before this call started): stays timeout-pending, never a false success", async () => {
    const { fetchImpl } = fakeSlowWorker([
      async () => Response.json(statusRow(
        "running", session({ at: "2026-09-30T12:00:05.000Z" }),
        { kind: "provisioned", checkedAt: "2026-09-30T11:00:00.000Z" },
      )),
    ]);
    const report = await requestRecycle({ recycle: RECYCLE_URL, status: STATUS_URL }, {}, ID, opts(fetchImpl));

    expect(report.kind).toBe("timeout-pending");
    expect(report.lines.join("\n")).not.toMatch(/\bfailed\b/i);
  });

  it("timed-out request, status unreachable every attempt: timeout-unknown, never \"failed\"", async () => {
    const { fetchImpl, calls } = fakeSlowWorker([
      async () => { throw new Error("connect ECONNREFUSED 10.0.0.1:443"); },
    ]);
    const report = await requestRecycle({ recycle: RECYCLE_URL, status: STATUS_URL }, {}, ID, opts(fetchImpl));

    expect(report.kind).toBe("timeout-unknown");
    const text = report.lines.join("\n");
    expect(text).toContain("UNKNOWN");
    expect(text).toContain("did not answer");
    expect(text).toContain("connect ECONNREFUSED");
    expect(text).not.toMatch(/\bfailed\b/i);
    // Review round 2, fix 2: same distinct "unknown, not a refusal" code as
    // timeout-pending, not http-error's 1.
    expect(report.exitCode).toBe(2);
    expect(calls.filter((u) => u.endsWith("/status"))).toHaveLength(RECYCLE_POLL_ATTEMPTS);
  });

  it("a recycle that answers 200 needs no poll at all: the row it returned IS the outcome", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/recycle")) return Response.json(statusRow("running", session()));
      throw new Error("the status route must not be polled on a plain success");
    };
    const report = await requestRecycle({ recycle: RECYCLE_URL, status: STATUS_URL }, {}, ID, opts(fetchImpl));

    expect(report.kind).toBe("ok");
    expect(report.status?.state).toBe("running");
    expect(report.exitCode).toBe(0);
  });

  it("a refusal (409, a snapshot too old without --discard-unsynced) stays a refusal — no poll", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/recycle")) return new Response("recycle refused: snapshot is 2h old", { status: 409 });
      throw new Error("a refusal must not be polled");
    };
    const report = await requestRecycle({ recycle: RECYCLE_URL, status: STATUS_URL }, {}, ID, opts(fetchImpl));

    expect(report.kind).toBe("http-error");
    expect(report.exitCode).toBe(1);
    expect(report.lines.join("\n")).toContain("recycle refused: snapshot is 2h old");
  });

  it("a row that lands on a LATER poll is still the success it is", async () => {
    const { fetchImpl, calls } = fakeSlowWorker([
      async () => Response.json(statusRow("running", session({ via: "provision", at: "2026-09-30T12:00:05.000Z" }))),
      async () => Response.json(statusRow("provisioning", null)),
      async () => Response.json(statusRow(
        "running", session({ at: "2026-09-30T12:00:20.000Z" }),
        { kind: "provisioned", checkedAt: "2026-09-30T12:00:21.000Z" },
      )),
    ]);
    const report = await requestRecycle({ recycle: RECYCLE_URL, status: STATUS_URL }, {}, ID, opts(fetchImpl));

    expect(report.kind).toBe("timeout-provisioned");
    expect(calls.filter((u) => u.endsWith("/status"))).toHaveLength(3);
  });
});

describe("the recycle request's own budget", () => {
  // recycle runs destroy's entire pre-teardown phase (DESTROY_CLIENT_TIMEOUT_MS)
  // plus a fresh provisionCore run plus its own post-provision readiness check.
  it("covers destroy's own budget plus a provision-class exec plus a readiness-class exec", () => {
    expect(RECYCLE_CLIENT_TIMEOUT_MS).toBe(
      DESTROY_CLIENT_TIMEOUT_MS + EXEC_CLASSES.provision.timeoutMs + EXEC_CLASSES.readiness.timeoutMs,
    );
  });

  it("polls a bounded number of times, never forever", () => {
    expect(RECYCLE_POLL_ATTEMPTS).toBe(6);
    expect(RECYCLE_POLL_INTERVAL_MS).toBe(10_000);
  });

  // Review round 2, fix 3: the two tests above only pin the CONSTANTS, which
  // stay green even if `pollAfterNoAnswer`'s own loop ignored them (e.g. a
  // hardcoded `for (let i = 0; i < 6; i++)`). This test proves the bound is
  // actually load-bearing: a `/status` that NEVER satisfies `bringupLanded`
  // must be called EXACTLY `RECYCLE_POLL_ATTEMPTS` times, not "some number
  // <= it" — an off-by-one or a hardcoded loop bound would show up here even
  // if it happened to equal 6 today.
  it("a status that never lands this recycle's bring-up is polled EXACTLY RECYCLE_POLL_ATTEMPTS times, not merely a bounded-ish number", async () => {
    const { fetchImpl, calls } = fakeSlowWorker([
      async () => Response.json(statusRow("running", session({ via: "provision", at: "2026-09-30T12:00:05.000Z" }))),
    ]);
    const report = await requestRecycle({ recycle: RECYCLE_URL, status: STATUS_URL }, {}, ID, opts(fetchImpl));

    expect(report.kind).toBe("timeout-pending");
    const statusCalls = calls.filter((u) => u.endsWith("/status"));
    expect(statusCalls).toHaveLength(RECYCLE_POLL_ATTEMPTS);
    expect(statusCalls.length).toBe(6);
  });
});

// The confirmed-outcome gate, pinned in cli/fleet.ts's own source: the Orca/
// rescue-report side effects on the recycle path only ever run once the
// outcome is confirmed (an `ok` 200, or a `timeout-provisioned` verdict) —
// never on a `timeout-pending`/`timeout-unknown`/`http-error` report, whose
// `studio` this side never even has.
describe("cli/fleet.ts's recycle flow", () => {
  it("calls requestRecycle and gates the Orca workspace/rescue-report side effects behind a confirmed outcome", () => {
    const src = env.TEST_CLI_FLEET_SRC;
    const from = src.indexOf("async function cmdRecycle(");
    const body = src.slice(from, src.indexOf("\n}", from));
    expect(body).toContain("await requestRecycle(");
    expect(body).toMatch(/if \(report\.kind === "ok" \|\| report\.kind === "timeout-provisioned"\)[\s\S]*?ensureStudioWorkspace\(/);
    // No second, ungated call anywhere in that body.
    expect(body.match(/ensureStudioWorkspace\(/g)).toHaveLength(1);
  });
});

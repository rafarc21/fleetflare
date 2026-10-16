import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { gateWatchExitCode, gateWatchDecision, onGateWatchDeadline, GATE_WATCH_DEADLINE_MS, parseStatusResponse, runGate, type GateStatusResponse } from "../../cli/gate";

describe("gateWatchExitCode", () => {
  it("success -> 0", () => {
    expect(gateWatchExitCode({ state: "success" })).toBe(0);
  });
  it("failure -> 1", () => {
    expect(gateWatchExitCode({ state: "failure", description: "x" })).toBe(1);
  });
  it("error -> 2", () => {
    expect(gateWatchExitCode({ state: "error", description: "x" })).toBe(2);
  });
  it("missing or unknown state -> 2, never a green exit", () => {
    expect(gateWatchExitCode({} as GateStatusResponse)).toBe(2);
    expect(gateWatchExitCode({ state: "bogus" } as unknown as GateStatusResponse)).toBe(2);
  });
  it("statusPostFailed overrides the state's own code -> 3", () => {
    const status: GateStatusResponse = { state: "success", statusPostFailed: true };
    expect(gateWatchExitCode(status)).toBe(3);
  });
});

describe("gateWatchDecision", () => {
  it("a non-pending status is terminal immediately, even well before the deadline", () => {
    expect(gateWatchDecision({ state: "success" }, 0)).toEqual({ kind: "terminal", status: { state: "success" } });
  });
  it("a pending status before the deadline keeps watching", () => {
    expect(gateWatchDecision({ state: "pending" }, GATE_WATCH_DEADLINE_MS - 1)).toEqual({ kind: "continue" });
  });
  it("a pending status at or past the deadline ends the watch", () => {
    expect(gateWatchDecision({ state: "pending" }, GATE_WATCH_DEADLINE_MS)).toEqual({ kind: "deadline" });
  });
});

describe("onGateWatchDeadline", () => {
  it("prints the 45-min message and exits 2", () => {
    const originalExitCode = process.exitCode;
    const originalError = console.error;
    const lines: unknown[] = [];
    console.error = ((...args: unknown[]) => { lines.push(args); }) as typeof console.error;
    try {
      onGateWatchDeadline("run-abc");
      expect(process.exitCode).toBe(2);
      expect(lines[0]).toEqual(["gate watch: no verdict after 45 min (run run-abc)"]);
    } finally {
      process.exitCode = originalExitCode ?? 0;
      console.error = originalError;
    }
  });
});

// `fleet gate run <pr>` against a stub Worker: start, then poll the run id it
// returns. The stub answers each /status call from a script, so the exit code
// is decided by the same routes the real Worker serves.
const creds = { workerUrl: "", accessClientId: "id", accessClientSecret: "secret" };
let server: ReturnType<typeof Bun.serve> | undefined;

function stubWorker(opts: { start: () => Response; statuses: GateStatusResponse[] }) {
  const seen = { starts: [] as unknown[], statusCalls: 0 };
  server = Bun.serve({
    port: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/studio/gate/start" && req.method === "POST") {
        seen.starts.push(await req.json());
        return opts.start();
      }
      if (url.pathname === "/studio/gate/status") {
        const next = opts.statuses[Math.min(seen.statusCalls, opts.statuses.length - 1)];
        seen.statusCalls++;
        return Response.json(next);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { seen, creds: { ...creds, workerUrl: server.url.toString() } };
}

const STARTED = () => Response.json({ started: true, runId: "run-1" });

describe("runGate exit codes", () => {
  beforeEach(() => { server = undefined; });
  afterEach(() => { server?.stop(true); });

  it("green verdict -> 0, after a pending poll", async () => {
    const stub = stubWorker({ start: STARTED, statuses: [{ state: "pending" }, { state: "success" }] });
    expect(await runGate(stub.creds, "acme/example", 7, { pollMs: 1 })).toBe(0);
    expect(stub.seen.starts).toEqual([{ repo: "acme/example", pr: 7 }]);
    expect(stub.seen.statusCalls).toBe(2);
  });

  it("red verdict -> 1", async () => {
    const stub = stubWorker({ start: STARTED, statuses: [{ state: "failure", description: "x" }] });
    expect(await runGate(stub.creds, "acme/example", 7, { pollMs: 1 })).toBe(1);
  });

  it("error verdict -> 2", async () => {
    const stub = stubWorker({ start: STARTED, statuses: [{ state: "error", description: "x" }] });
    expect(await runGate(stub.creds, "acme/example", 7, { pollMs: 1 })).toBe(2);
  });

  it("a status POST that failed twice -> 2, not the 3 gate watch prints", async () => {
    const stub = stubWorker({ start: STARTED, statuses: [{ state: "success", statusPostFailed: true }] });
    expect(await runGate(stub.creds, "acme/example", 7, { pollMs: 1 })).toBe(2);
  });

  it("gate off (start refused with 404) -> 2, and never polls", async () => {
    const stub = stubWorker({
      start: () => Response.json({ error: "gate runner not enabled for this repo" }, { status: 404 }),
      statuses: [{ state: "success" }],
    });
    expect(await runGate(stub.creds, "acme/example", 7, { pollMs: 1 })).toBe(2);
    expect(stub.seen.statusCalls).toBe(0);
  });

  it("start answers 200 with no run id -> 2, never a green exit", async () => {
    const stub = stubWorker({ start: () => Response.json({ started: true }), statuses: [{ state: "success" }] });
    expect(await runGate(stub.creds, "acme/example", 7, { pollMs: 1 })).toBe(2);
    expect(stub.seen.statusCalls).toBe(0);
  });

  it("unreachable Worker -> 2", async () => {
    const dead = { ...creds, workerUrl: "http://127.0.0.1:1" };
    expect(await runGate(dead, "acme/example", 7, { pollMs: 1 })).toBe(2);
  });
});

describe("parseStatusResponse", () => {
  it("valid JSON status object parses", () => {
    const parsed = parseStatusResponse(JSON.stringify({ state: "success" }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.status.state).toBe("success");
  });
  it("non-JSON body (Cloudflare 500 HTML) is an error, never a green exit", () => {
    const parsed = parseStatusResponse("<html><body>500</body></html>");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.body.length).toBeLessThanOrEqual(200);
  });
  it("JSON that is not a status object (e.g. null) is an error too", () => {
    expect(parseStatusResponse("null").ok).toBe(false);
  });
});

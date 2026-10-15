import { describe, it, expect } from "bun:test";
import { afterEach, beforeEach } from "bun:test";
import { gateWatchExitCode, runGate, type GateStatusResponse } from "../../cli/gate";

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

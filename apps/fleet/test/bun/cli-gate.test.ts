import { describe, it, expect, afterEach, beforeEach, spyOn } from "bun:test";
import { gateWatchExitCode, gateWatchDecision, onGateWatchDeadline, GATE_WATCH_DEADLINE_MS, parseStatusResponse, parseStartResponse, firstLine, runGate, formatMs, legLines, gateStartLine, gateQueuedLine, gateLogHeader, type GateStatusResponse } from "../../cli/gate";

// #1085 (refs #715): the start line says whether the run was reattached or fresh.
describe("gateStartLine: reattached to a live run vs a fresh run (#1085)", () => {
  it("reused (a live run of the sha) -> reattached to live run", () => {
    expect(gateStartLine({ runId: "run-1", reused: true }, 7)).toBe("gate-start: reattached to live run run-1 for PR #7");
  });
  it("not reused (a fresh run) -> started fresh run", () => {
    expect(gateStartLine({ runId: "run-2", reused: false }, 7)).toBe("gate-start: started fresh run run-2 for PR #7");
  });
});

describe("gateQueuedLine", () => {
  it("names the retry", () => {
    expect(gateQueuedLine(7)).toBe("gate-start: queued (gate draining for deploy) for PR #7 — retry after the deploy");
  });
});

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

  it("start answers pending (gate draining): 2, prints the queued line, never polls", async () => {
    const stub = stubWorker({ start: () => Response.json({ started: false, pending: true }), statuses: [{ state: "success" }] });
    expect(await runGate(stub.creds, "acme/example", 7, { pollMs: 1 })).toBe(2);
    expect(stub.seen.statusCalls).toBe(0);
  });

  it("start answers a non-JSON HTML 500: 2, prints status + first line, never polls (#1276)", async () => {
    const stub = stubWorker({
      start: () => new Response("<html><body>Error</body></html>", { status: 500 }),
      statuses: [{ state: "success" }],
    });
    expect(await runGate(stub.creds, "acme/example", 7, { pollMs: 1 })).toBe(2);
    expect(stub.seen.statusCalls).toBe(0);
  });

  it("unreachable Worker -> 2", async () => {
    const dead = { ...creds, workerUrl: "http://127.0.0.1:1" };
    expect(await runGate(dead, "acme/example", 7, { pollMs: 1 })).toBe(2);
  });
});

// #1230: `fleet gate run --failed-only <pr>` sets failedOnly on the start body.
describe("runGate: the start body's failedOnly flag (#1230)", () => {
  beforeEach(() => { server = undefined; });
  afterEach(() => { server?.stop(true); });

  it("failedOnly set -> the start POST body carries failedOnly: true", async () => {
    const stub = stubWorker({ start: STARTED, statuses: [{ state: "success" }] });
    await runGate(stub.creds, "acme/example", 7, { pollMs: 1, failedOnly: true });
    expect(stub.seen.starts).toEqual([{ repo: "acme/example", pr: 7, failedOnly: true }]);
  });

  it("failedOnly absent -> the body carries no failedOnly key at all", async () => {
    const stub = stubWorker({ start: STARTED, statuses: [{ state: "success" }] });
    await runGate(stub.creds, "acme/example", 7, { pollMs: 1 });
    expect(stub.seen.starts).toEqual([{ repo: "acme/example", pr: 7 }]);
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

describe("parseStartResponse (#1276)", () => {
  it("parses a start body with an error field", () => {
    const parsed = parseStartResponse(JSON.stringify({ error: "gate start unavailable: boom" }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.body.error).toBe("gate start unavailable: boom");
  });
  it("a non-JSON body (Cloudflare HTML 500) is ok:false, never a throw", () => {
    const parsed = parseStartResponse("<html><body>Error</body></html>");
    expect(parsed.ok).toBe(false);
  });
  it("JSON null is ok:false too", () => {
    expect(parseStartResponse("null").ok).toBe(false);
  });
});

describe("firstLine (#1276)", () => {
  it("returns the first trimmed line, cut at 200 chars", () => {
    expect(firstLine("\n\n  Error\nrest")).toBe("Error");
    expect(firstLine("x".repeat(500))).toBe("x".repeat(200));
  });
});

describe("formatMs (#1049: wall time per leg)", () => {
  it("seconds under a minute, minutes and seconds above", () => {
    expect(formatMs(0)).toBe("0s");
    expect(formatMs(3_000)).toBe("3s");
    expect(formatMs(59_999)).toBe("59s");
    expect(formatMs(83_000)).toBe("1m23s");
    expect(formatMs(120_000)).toBe("2m0s");
  });
});

describe("legLines: one line per leg (#1049)", () => {
  it("no legs field -> no lines", () => {
    expect(legLines({ state: "error", description: "x" })).toEqual([]);
  });

  it("mark, padded name, wall time, then the summary or the description", () => {
    const lines = legLines({ state: "failure", legs: [
      { leg: "merge-tree", state: "success", ms: 3_000 },
      { leg: "vitest-1", state: "failure", ms: 83_000, summary: "Tests  1 failed | 1640 passed (1641)", description: "vitest-1 exited 1" },
    ] });
    expect(lines).toEqual([
      "ok   merge-tree  3s",
      "FAIL vitest-1    1m23s  Tests  1 failed | 1640 passed (1641)",
    ]);
  });

  it("a leg that passed on its retry reads FLKY, never ok", () => {
    const [line] = legLines({ state: "success", legs: [
      { leg: "bun-1", state: "success", ms: 5_000, description: "flaky: passed on retry" },
    ] });
    expect(line.startsWith("FLKY ")).toBe(true);
  });

  it("an error leg reads ERR; a leg with no time reads '-'", () => {
    const [line] = legLines({ state: "error", legs: [
      { leg: "lint", state: "error", description: "gate container failed: boom" },
    ] });
    expect(line).toBe("ERR  lint  -      gate container failed: boom");
  });

  it("the text is cut at 100 chars", () => {
    const [line] = legLines({ state: "failure", legs: [
      { leg: "lint", state: "failure", ms: 1_000, description: "x".repeat(150) },
    ] });
    expect(line.endsWith("x".repeat(100))).toBe(true);
    expect(line.includes("x".repeat(101))).toBe(false);
  });
});

describe("runGate prints one line per leg after the verdict (#1049)", () => {
  beforeEach(() => { server = undefined; });
  afterEach(() => { server?.stop(true); });

  it("verdict line first, then the leg lines; the exit code is unchanged", async () => {
    const legs = [
      { leg: "merge-tree", state: "success" as const, ms: 3_000 },
      { leg: "vitest-1", state: "failure" as const, ms: 83_000, summary: "Tests  1 failed | 1640 passed (1641)" },
    ];
    const status = { state: "failure" as const, description: "1/2 green; red: vitest-1 (run 01234567)", legs };
    const stub = stubWorker({ start: STARTED, statuses: [status] });
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((m?: unknown) => { logs.push(String(m)); });
    let code: number;
    try {
      code = await runGate(stub.creds, "acme/example", 7, { pollMs: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(1);
    expect(logs).toEqual([
      "gate-start: started fresh run run-1 for PR #7",
      "gate: failure — 1/2 green; red: vitest-1 (run 01234567)",
      ...legLines(status),
    ]);
  });
});

describe("gateLogHeader (#1318 r1)", () => {
  const h = (body: Parameters<typeof gateLogHeader>[3]) => gateLogHeader("acme/example", 9, "vitest-6", body);
  it("restores '<state> — <summary>' before '(run X)'", () => {
    expect(h({ state: "failure", summary: "Tests 1 failed", runId: "run-a" }))
      .toBe("gate log acme/example#9 vitest-6: failure — Tests 1 failed (run run-a)");
  });
  it("no summary or run -> just the state", () => {
    expect(h({ state: "success" })).toBe("gate log acme/example#9 vitest-6: success");
  });
});

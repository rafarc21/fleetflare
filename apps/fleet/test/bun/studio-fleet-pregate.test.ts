import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Board issue #105 (pre-gate): fleet.json's own optional `preflight` shell
// command, run by `studio-fleet task report <n>` before it posts a claimed
// "result"/"ok" envelope. container/studio-fleet has no `.ts` extension
// (baked verbatim into the studio image, exec'd via its own shebang — see
// that file's own header) but IS plain TS syntax Bun can load directly, so
// this file imports its pure functions the same way any other module would
// rather than source-pinning text (test/container.studio-fleet.test.ts still
// carries the source-pin coverage for the CLI wiring around these, since
// vitest-pool-workers itself cannot execute a Bun-specific module — see that
// file's own header).
//
// tsc cannot resolve this specifier at all (TS2307): its own module
// resolution requires a real extension to append candidates to, and this
// filename has none — that is a static-checker limitation, not a runtime
// one (Bun's own resolver, exercised every time this file actually runs,
// has no such trouble; `bun -e 'import("./container/studio-fleet")...'` was
// used to confirm that directly before writing this file).
// @ts-expect-error TS2307 — see the paragraph above.
const mod = await import("../../container/studio-fleet");
const { parseFleetPreflight, loadPreflightCommand, resolveRepoRoot, runPreflight, evaluatePreGate } = mod as {
  parseFleetPreflight: (json: string) => string | null;
  loadPreflightCommand: (repoRoot: string | null) => string | null;
  resolveRepoRoot: (env: Record<string, string | undefined>) => string | null;
  runPreflight: (cmd: string, cwd: string, timeoutMs?: number) => { cmd: string; exit: number; output: string };
  evaluatePreGate: (
    intent: unknown, status: unknown, preflight: { cmd: string; exit: number; output: string } | null,
  ) => { refuse: boolean; reason?: string };
};

describe("parseFleetPreflight — fleet.json's own tiny duplicate parse", () => {
  test("a declared preflight string is returned", () => {
    expect(parseFleetPreflight(JSON.stringify({ preflight: "bun run check:fast" }))).toBe("bun run check:fast");
  });

  test("absent field -> null", () => {
    expect(parseFleetPreflight(JSON.stringify({ blueprint: {}, roles: [] }))).toBeNull();
  });

  test("blank string -> null (same as absent, never a meaningless empty command)", () => {
    expect(parseFleetPreflight(JSON.stringify({ preflight: "   " }))).toBeNull();
  });

  test("wrong type -> null, not a throw (a malformed fleet.json must never block task report itself)", () => {
    expect(parseFleetPreflight(JSON.stringify({ preflight: 7 }))).toBeNull();
  });

  test("invalid JSON -> null", () => {
    expect(parseFleetPreflight("{not json")).toBeNull();
  });
});

describe("resolveRepoRoot — same STUDIO_ID derivation studio-bringup.sh's own claude-launch step uses", () => {
  test("STUDIO_ID names the repo before its first `--`", () => {
    expect(resolveRepoRoot({ STUDIO_ID: "fleetflare--web-studio" })).toBe("/workspace/fleetflare");
  });

  test("a numbered sibling instance (`--2`, `--3`) resolves to the same repo root", () => {
    expect(resolveRepoRoot({ STUDIO_ID: "fleetflare--web-studio--2" })).toBe("/workspace/fleetflare");
  });

  test("STUDIO_ID absent -> null, never a guessed path", () => {
    expect(resolveRepoRoot({})).toBeNull();
  });

  test("FLEET_REPO_ROOT_BASE overrides the /workspace base (test seam; absent in every real container)", () => {
    expect(resolveRepoRoot({ STUDIO_ID: "fleetflare--web-studio", FLEET_REPO_ROOT_BASE: "/tmp/fake" }))
      .toBe("/tmp/fake/fleetflare");
  });
});

describe("loadPreflightCommand — reads fleet.json from an arbitrary repo root", () => {
  let dir: string;
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), "fleet-pregate-"));
  };
  const teardown = () => rmSync(dir, { recursive: true, force: true });

  test("a fleet.json declaring preflight -> the command", () => {
    setup();
    try {
      writeFileSync(join(dir, "fleet.json"), JSON.stringify({ preflight: "bun run check:fast" }));
      expect(loadPreflightCommand(dir)).toBe("bun run check:fast");
    } finally {
      teardown();
    }
  });

  test("no fleet.json at all -> null, not a throw", () => {
    setup();
    try {
      expect(loadPreflightCommand(dir)).toBeNull();
    } finally {
      teardown();
    }
  });

  test("a fleet.json with no preflight field -> null", () => {
    setup();
    try {
      writeFileSync(join(dir, "fleet.json"), JSON.stringify({ blueprint: {}, roles: [] }));
      expect(loadPreflightCommand(dir)).toBeNull();
    } finally {
      teardown();
    }
  });

  test("repoRoot itself null (e.g. STUDIO_ID absent) -> null", () => {
    expect(loadPreflightCommand(null)).toBeNull();
  });
});

describe("runPreflight — a real subprocess, not a simulation", () => {
  test("exit 0, output captured", () => {
    const r = runPreflight("echo hi", process.cwd());
    expect(r.exit).toBe(0);
    expect(r.output).toContain("hi");
    expect(r.cmd).toBe("echo hi");
  });

  test("non-zero exit is reported, not swallowed", () => {
    const r = runPreflight("echo boom >&2; exit 3", process.cwd());
    expect(r.exit).toBe(3);
    expect(r.output).toContain("boom");
  });

  // Issue #105's own framing: "a 30-second pre-gate" — a check that overruns
  // is a broken cheap-check promise, treated as RED, never a hang. The
  // timeout itself is a deliberate test seam (an optional third param) —
  // production always calls with the 30s default; this test overrides it so
  // a timeout test finishes in well under a second, not 30.
  test("a command that overruns its timeout is killed and reported as a FAILED gate, not a hang", () => {
    const r = runPreflight("sleep 5", process.cwd(), 100);
    expect(r.exit).not.toBe(0);
    expect(r.exit).not.toBeNull();
  });
});

describe("evaluatePreGate — refuse ONLY a claimed-done result with a red pre-gate (issue #105: \"RED pre-gate = not done\")", () => {
  test("no preflight declared -> never refuse, regardless of intent/status", () => {
    expect(evaluatePreGate("result", "ok", null)).toEqual({ refuse: false });
  });

  test("a green pre-gate -> never refuse", () => {
    expect(evaluatePreGate("result", "ok", { cmd: "x", exit: 0, output: "" })).toEqual({ refuse: false });
  });

  test("a red pre-gate + result/ok -> refuse, naming the command and exit code", () => {
    const r = evaluatePreGate("result", "ok", { cmd: "bun run check:fast", exit: 1, output: "FAIL foo.test.ts" });
    expect(r.refuse).toBe(true);
    expect(r.reason).toContain("bun run check:fast");
    expect(r.reason).toContain("1");
    expect(r.reason).toContain("FAIL foo.test.ts");
  });

  test("a red pre-gate + result/blocked -> still runs (caller attaches it) but does NOT refuse", () => {
    expect(evaluatePreGate("result", "blocked", { cmd: "x", exit: 1, output: "" }).refuse).toBe(false);
  });

  test("a red pre-gate + result/partial -> does not refuse", () => {
    expect(evaluatePreGate("result", "partial", { cmd: "x", exit: 1, output: "" }).refuse).toBe(false);
  });

  test("a red pre-gate + a non-result intent (e.g. \"request\") -> does not refuse, whatever status is set", () => {
    expect(evaluatePreGate("request", "ok", { cmd: "x", exit: 1, output: "" }).refuse).toBe(false);
  });

  test("a timed-out pre-gate (exit 124) + result/ok -> refuses exactly like any other red exit", () => {
    expect(evaluatePreGate("result", "ok", { cmd: "x", exit: 124, output: "" }).refuse).toBe(true);
  });
});

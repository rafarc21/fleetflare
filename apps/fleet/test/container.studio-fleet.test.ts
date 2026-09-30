import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

// container/studio-fleet — Fleet Spawn P3, Task 3 (R-P3-2/R-P3-7).
//
// No `.ts` extension by design (baked verbatim into the studio image and
// exec'd directly via its own shebang — see that file's own header), so it
// is outside `tsc -p container`'s `**/*.ts` include and cannot be imported
// as a module either way. Source-pinned instead, injected as
// TEST_STUDIO_FLEET_SRC by vitest.config.ts — the SAME technique
// test/container.args.test.ts already uses for container/server.ts, and
// test/studio.session.test.ts uses for container/studio-bringup.sh. Every
// fragment pinned below was ALSO verified live: `bun run container/
// studio-fleet` was run directly for --help/no-args/bad-command/missing-role
// (env absent, so exit 2 was reached for the actual spawn attempt too), and
// a real HTTP round trip against a throwaway local server proved the
// success (200 -> "spawned <id> (<state>)", exit 0) and failure (401 -> the
// server's own body on stderr, exit 1) paths end to end. Review fix round 1
// added a top-level main().catch() (see that test's own comment below) —
// its uncaught-vs-caught behavior was live-verified the same way, before
// and after the fix, with an actual malformed FLEET_WORKER_URL. See
// task-3-report.md (base report + fix round section) for every transcript.
const src = () => env.TEST_STUDIO_FLEET_SRC;

describe("container/studio-fleet — source assertions", () => {
  it("is a bun script, directly executable via its own shebang", () => {
    expect(src().startsWith("#!/usr/bin/env bun\n")).toBe(true);
  });

  it("guarded so importing this file never runs main() on its own", () => {
    expect(src()).toContain("if (import.meta.main) {");
  });

  // Review fix round 1: main() previously ran unguarded (`main();`) — a
  // synchronous throw deep inside it (buildSpawnRequest's `new URL(...)` on
  // a malformed FLEET_WORKER_URL) surfaced as a raw, multi-line Bun stack
  // dump instead of this file's own one-line `studio-fleet: ...` convention
  // every other error path already follows. Live-executed with an actual
  // malformed FLEET_WORKER_URL after this fix (task-3-report.md's fix round
  // section has the full transcript) — vitest-pool-workers runs test files
  // inside workerd, which cannot spawn a real bun subprocess, so that
  // execution check lives outside this file, the same way the Docker smoke
  // and the real HTTP round-trip in the ORIGINAL report both do. This test
  // pins the source-level guarantee that makes that behavior possible.
  it("main() is wrapped in a top-level .catch() that uses the file's own error convention and exits non-zero", () => {
    expect(src()).toContain("main().catch((err) => {");
    expect(src()).toMatch(
      /main\(\)\.catch\(\(err\) => \{\s*console\.error\(`studio-fleet: \$\{err instanceof Error \? err\.message : String\(err\)\}`\);\s*process\.exit\(1\);/,
    );
  });

  it("--help / -h / bare invocation all resolve to the help branch", () => {
    expect(src()).toContain(
      'if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { kind: "help" };',
    );
  });

  it("only \"spawn\", \"resume\", \"task\" and \"memory\" are recognised commands; anything else is a usage error naming what it expected", () => {
    expect(src()).toContain('if (argv[0] !== "spawn" && argv[0] !== "resume") {');
    expect(src()).toContain('expected "spawn", "resume", "task" or "memory"');
    // P5 §9: the Release Studio runs the compaction pass from inside its own
    // container at sprint close, so the verb has to exist on THIS binary.
    expect(src()).toContain('if (argv[0] === "memory") return parseMemoryArgs(argv.slice(1));');
    expect(src()).toContain('fleet memory compact');
    // The help must say what a demotion does, since "demote" reads like
    // "delete" to anyone who has not read the spec.
    expect(src()).toContain("never deletes a memory file");
  });

  it("spawn requires a role argument", () => {
    expect(src()).toContain('if (!role) return { kind: "usage-error", message: `${verb}: missing <role>` };');
  });

  it("a usage error exits 1", () => {
    expect(src()).toContain('if (cmd.kind === "usage-error") {');
    expect(src()).toMatch(/if \(cmd\.kind === "usage-error"\) \{[\s\S]{0,200}process\.exit\(1\);/);
  });

  // The env-absent contract (R-P3-2's own binding: "Env absent → clear error
  // exit 2") — pure resolveEnv (env passed in, not read from process.env
  // inside it) names EXACTLY which var(s) are missing, and main()'s call
  // site is what turns that into exit 2, distinct from every other error
  // path's exit 1 above/below.
  it("resolveEnv is pure (env passed as a parameter, not read from process.env inside it) and names the missing var(s)", () => {
    expect(src()).toContain(
      "export function resolveEnv(env: Record<string, string | undefined>): SpawnEnv | { error: string } {",
    );
    expect(src()).toContain("const workerUrl = env.FLEET_WORKER_URL;");
    expect(src()).toContain("const token = env.FLEET_SPAWN_TOKEN;");
    expect(src()).toContain('missing.join(", ")');
  });

  it("env-absent exits 2, distinct from every other error path's exit 1", () => {
    expect(src()).toMatch(/if \("error" in spawnEnv\) \{[\s\S]{0,80}process\.exit\(2\);/);
  });

  it("the request is POST /fleet/spawn with the exact X-Fleet-Spawn-Token header spawn.ts expects, and a {role} JSON body", () => {
    expect(src()).toContain('const SPAWN_TOKEN_HEADER = "X-Fleet-Spawn-Token";');
    expect(src()).toContain('new URL("/fleet/spawn", env.workerUrl).toString()');
    expect(src()).toContain('method: "POST",');
    expect(src()).toContain("headers: { [SPAWN_TOKEN_HEADER]: env.token,");
    // Issue #59: `extra` is empty for a bare `spawn <role>`, so the body stays
    // byte-identical to the pre-#59 `{role}` (test/bun/studio-fleet-directs).
    expect(src()).toContain("body: JSON.stringify({ role, ...extra }),");
  });

  it("a non-ok response prints the server's own error body and exits 1 (never swallowed)", () => {
    expect(src()).toMatch(/if \(!res\.ok\) \{[\s\S]{0,200}process\.exit\(1\);/);
    // P4a-2 named the command in this line (`built.what`) — spawn is no longer
    // the only thing this binary does, and "spawn failed" on a `task report`
    // would send a lead debugging the wrong call.
    expect(src()).toContain("${built.what} failed (${res.status}): ${text}");
  });

  it("a network failure (fetch itself throwing) is caught and exits 1, never an uncaught rejection", () => {
    expect(src()).toContain("} catch (err) {");
    expect(src()).toContain("request to ${built.url} failed:");
  });

  it("success prints the child's id and state, not the raw response verbatim", () => {
    expect(src()).toContain('return `${cmd.kind === "resume" ? "resumed" : "spawned"} ${status.id ?? "?"} (${status.state ?? "?"})`;');
  });

  it("never logs the spawn token itself under any code path (grep for the literal env var name, not just usage)", () => {
    // The token flows only through `env.token` (the resolved SpawnEnv) and
    // the request init's headers — never string-interpolated into a
    // console.log/console.error anywhere in the file.
    expect(src()).not.toMatch(/console\.(log|error)\([^)]*FLEET_SPAWN_TOKEN/);
    expect(src()).not.toMatch(/console\.(log|error)\([^)]*\benv\.token\b/);
  });
});

// --- P4a-2: the board verbs -------------------------------------------------
//
// Same source-pinning technique as everything above (this file is baked into
// the image and exec'd via its own shebang, so it cannot be imported as a
// module here). The parse half is ALSO exercised as real code — `bun -e` over
// the actual file — during live verification; these pins are what keeps the
// wire contract from drifting away from src/board/routes.ts's own route
// grammar without a test noticing.

describe("container/studio-fleet — the board verbs (P4a-2)", () => {
  it("task ls / show <n> / report <n> / state <n> <to> are the four, and <n> must be numeric", () => {
    expect(src()).toContain('if (sub === "ls") return { kind: "task-ls" };');
    expect(src()).toContain('if (sub !== "show" && sub !== "report" && sub !== "state") {');
    expect(src()).toContain("expected ls, show, report, state, new or assign");
    expect(src()).toContain("missing or non-numeric <n>");
  });

  it("issue #59: task new / assign exist and hold no policy — the Worker gates both on org-chart edges", () => {
    // The CLI only shapes the ask. Every refusal (non-edge, other repo, self,
    // junior, unassigned) is the Worker's: test/board.fleet-directs.test.ts.
    expect(src()).toContain('if (sub === "new") {');
    expect(src()).toContain('if (sub === "assign") {');
    expect(src()).toContain("buildTaskRequest(env, `/${cmd.number}/assign`, body)");
    expect(src()).not.toContain("maySpawn");
  });

  // Board issue #41, half two: the verb that closes the loop. A task a lead
  // is ACTIVELY working used to sit at `submitted` until a coordinator moved
  // it by hand, so every monitor read a healthy studio as stalled.
  describe("task state <n> <to> (board issue #41)", () => {
    it("offers exactly the three states a lead may set", () => {
      expect(src()).toContain('const LEAD_TASK_STATES = ["working", "input_required", "failed"];');
    });

    it("refuses `completed` in the CLI itself, naming who owns that verdict — no request is even built", () => {
      expect(src()).toContain("a lead may not mark its own task completed");
      expect(src()).toContain("verifies");
      // Client-side courtesy only. The Worker refuses it too, which is the
      // enforcement — see src/board/board.ts's LEAD_TASK_STATES.
      expect(src()).toContain("the Worker refuses it too");
    });

    it("POSTs {to} to /fleet/tasks/<n>/state and sends no label call of any kind", () => {
      expect(src()).toContain("buildTaskRequest(env, `/${cmd.number}/state`, JSON.stringify({ to: cmd.to }))");
      // The whole point: the lead asks, the Worker writes. Nothing in this
      // binary ever reaches GitHub.
      expect(src()).not.toContain("api.github.com");
      expect(src()).not.toContain("gh issue");
    });

    it("the help text says which three states, and that completed is not one of them", () => {
      expect(src()).toContain("fleet task state <n> <working|input_required|failed>");
      expect(src()).toContain("You cannot mark your own task completed");
    });

    it("prints the before -> after the Worker actually wrote, not the state that was asked for", () => {
      expect(src()).toContain("task ${cmd.number} is now ${moved.state ?? \"?\"}");
    });
  });

  it("every board call goes to /fleet/tasks with the same one spawn-token header", () => {
    expect(src()).toContain('new URL(`/fleet/tasks${path}`, env.workerUrl).toString()');
    expect(src()).toContain("[SPAWN_TOKEN_HEADER]: env.token");
  });

  it("no `repo` is ever sent — the Worker decides which board this studio reads", () => {
    expect(src()).not.toMatch(/JSON\.stringify\(\{[^}]*\brepo\b/);
    expect(src()).toContain("resolveStudioBoardRepo");
  });

  it("the envelope is read from STDIN, and an empty stdin is refused rather than posted", () => {
    expect(src()).toContain("const body = await Bun.stdin.text();");
    expect(src()).toContain('if (body.trim() === "") {');
    expect(src()).toContain("reads the envelope JSON from stdin");
  });

  it("the help text carries a copyable heredoc and the §6 enums, so a lead never has to guess the shape", () => {
    expect(src()).toContain("fleet task report 71 <<'EOF'");
    expect(src()).toContain("intent: request|result|error|clarify|escalate");
    expect(src()).toContain("status: ok|partial|failed|blocked");
    expect(src()).toContain("The Worker stamps msg_id, task_id, schema_version and");
  });

  it("the help text states the single-writer rule to the agent that could break it", () => {
    // Board issue #41 narrowed the rule from "you never move a task's state"
    // to "you never write a label": the lead now ASKS (fleet task state), and
    // the Worker is still the only thing that writes.
    expect(src()).toContain("The Worker is the single writer of the board");
    expect(src()).toContain("Never label, close or reopen a board");
  });

  it("an empty listing says so rather than printing nothing", () => {
    expect(src()).toContain('return "(no tasks assigned to this studio)";');
  });
});

// --- Board issue #105: pre-gate ---------------------------------------------
//
// The behavioral coverage for these functions (real fleet.json fixtures,
// a real subprocess in runPreflight, a real timeout kill, and the full CLI
// wired end to end against a fake Worker) lives in
// test/bun/studio-fleet-pregate.test.ts and
// test/bun/studio-fleet-report-cli.test.ts — this file cannot execute
// container/studio-fleet at all (vitest-pool-workers runs inside workerd,
// which cannot spawn a real bun subprocess; see this file's own header).
// What is pinned here is the CONTRACT: the exact identifiers and wiring a
// future edit must not silently weaken.

describe("container/studio-fleet — pre-gate (board issue #105)", () => {
  it("has its own tiny fleet.json preflight parse, duplicated from blueprint.ts's FleetConfig rather than imported", () => {
    expect(src()).toContain("export function parseFleetPreflight(json: string): string | null {");
    // Same "own literal, never import the Worker's src/ tree" convention
    // SPAWN_TOKEN_HEADER/LEAD_TASK_STATES already keep — see this file's
    // own header.
    expect(src()).not.toMatch(/from ["']\.\.\/src/);
  });

  it("resolves the repo root from STUDIO_ID, the SAME derivation studio-bringup.sh's claude-launch step uses — never the calling shell's cwd", () => {
    expect(src()).toContain("export function resolveRepoRoot(env: Record<string, string | undefined>): string | null {");
    expect(src()).toContain('`/workspace/${studioId.split("--")[0]}`');
  });

  it("runs the declared command as a real subprocess with a 30-second timeout and a kill on overrun", () => {
    expect(src()).toContain("const PREFLIGHT_TIMEOUT_MS = 30_000;");
    expect(src()).toContain("export function runPreflight(cmd: string, cwd: string, timeoutMs: number = PREFLIGHT_TIMEOUT_MS): PreflightResult {");
    expect(src()).toContain('cmd: ["sh", "-c", cmd],');
    expect(src()).toContain("killSignal: \"SIGKILL\"");
    // A timed-out process (Bun reports exitCode null) reads as exit 124 — a
    // FAILED gate, never a silent pass and never a hang.
    expect(src()).toContain("proc.exitCode ?? 124");
  });

  it('the refusal rule is scoped to EXACTLY intent "result" + status "ok" — every other combination still runs and attaches the pre-gate but is never refused', () => {
    expect(src()).toContain(
      "export function evaluatePreGate(\n  intent: unknown, status: unknown, preflight: PreflightResult | null,\n): { refuse: boolean; reason?: string } {",
    );
    expect(src()).toContain("if (preflight === null || preflight.exit === 0) return { refuse: false };");
    expect(src()).toContain('if (intent !== "result" || status !== "ok") return { refuse: false };');
  });

  it("task report: no preflight declared is a COMPLETE no-op — the raw stdin body is posted byte for byte, never parsed", () => {
    expect(src()).toContain("const preflightCmd = loadPreflightCommand(repoRoot);");
    expect(src()).toContain("let finalBody = body;");
    expect(src()).toContain("if (preflightCmd !== null) {");
  });

  it("task report: a refused pre-gate prints the reason to stderr and exits 1 WITHOUT ever building the POST", () => {
    expect(src()).toMatch(/if \(gate\.refuse\) \{\s*console\.error\(`studio-fleet: \$\{gate\.reason\}`\);\s*process\.exit\(1\);/);
    // The refusal check runs strictly before buildTaskRequest is called for
    // the envelope path — a refused report must never reach the fetch at all.
    const refuseIdx = src().indexOf("if (gate.refuse) {");
    const buildIdx = src().indexOf("buildTaskRequest(env, `/${cmd.number}/envelope`, finalBody)");
    expect(refuseIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeGreaterThan(refuseIdx);
  });

  it("a posted envelope carries the pre-gate result under `pre_gate` when one was declared and run", () => {
    expect(src()).toContain("envelope.pre_gate = preflight;");
  });

  it("the help text documents the feature and its no-fleet.json no-op", () => {
    expect(src()).toContain("Board issue #105 (pre-gate)");
    expect(src()).toContain('this is a complete no-op');
  });
});

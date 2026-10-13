import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRINGUP, runSnippet } from "./exec-snippet";

// Board issue #2 (gates single source): the three hook scripts moved out of
// studio-bringup.sh's own heredocs into real files at the repo root
// (gates/*.sh) — cloud bring-up reads from them via a `cp` from the
// blueprint clone. (The Mac `fleet gates install` verb that once read from
// these same files was cancelled by board issue #20 — the operator, 2026-09-21:
// "I don't want any of these locks" — and removed entirely.) Read
// directly off disk here rather than extracted out of BRINGUP: this file
// runs under bun:test with real filesystem access, unlike
// test/studio.session.test.ts (workerd, no filesystem — see that suite's
// own vitest.config.ts bindings for the equivalent wiring there). Every
// behavioral test below is unchanged: same snippet content, same runSnippet
// calls, same assertions.
const LEAD_GATE = readFileSync(join(import.meta.dir, "../../../../gates/lead-gate.sh"), "utf8");
const COMPLETION_GATE = readFileSync(join(import.meta.dir, "../../../../gates/completion-gate.sh"), "utf8");

// Same bug family as commit 3072ae6 (wake-cmd.test.ts inheriting ambient
// TMUX and killing this studio's own real tmux server): runSnippet merges
// `{...process.env, ...opts.env}` (exec-snippet.ts), so any call that does
// not set STUDIO_ID explicitly silently inherits whatever happens to be in
// the AMBIENT shell -- set inside this studio's own container, unset on a
// bare CI runner. Board issue #20's `[ -n "${STUDIO_ID:-}" ] || exit 0`
// guard (gates/lead-gate.sh:11) then makes every blocking-behavior test
// below pass or fail depending on WHERE the suite runs, not on what the
// gate actually does. Baking a real-looking, always-present STUDIO_ID into
// this single helper fixes every leadGate() call site in the file at once:
// deterministic blocking behavior regardless of the ambient environment.
function leadGate(payload: unknown) {
  return runSnippet({
    script: bakeIsMaestro(false),
    stdin: JSON.stringify(payload),
    shell: "bash",
    env: { STUDIO_ID: "test-studio--role" },
  });
}

// Board issue #16 (bake-at-materialization fix, v2 — ported onto the real
// gates/lead-gate.sh file per #17's single-source extraction, not the old
// heredoc). The raw file this test reads off disk is byte-identical to what
// studio-bringup.sh's `cp` places at ~/.claude/hooks/lead-gate.sh, but the
// real bring-up script bakes IS_MAESTRO in as a SEPARATE step right after
// that copy (a `sed -i` run against the COPIED file, gated on $STUDIO_NAME
// — see studio-bringup.sh's lead-gate materialization block, right after its
// `chmod 0755`). The raw file is never a runnable artifact on its own —
// IS_MAESTRO is unconditionally assigned at module scope, so the placeholder
// must always be substituted before the script can even be interpreted.
// Replaying that same substitution here (rather than special-casing it
// away) is a MORE faithful test than reading a runtime marker file ever
// was: it proves the actual two-step mechanism (file copy + bake-in
// substitution) end to end instead of assuming either half works.
function bakeIsMaestro(isMaestro: boolean): string {
  // Anchored to the assignment line specifically, mirroring the real
  // `sed -i 's/^IS_MAESTRO = __IS_MAESTRO_BOOL__$/.../'` studio-bringup.sh
  // itself runs against the copied file.
  return LEAD_GATE.replace(
    /^IS_MAESTRO = __IS_MAESTRO_BOOL__$/m,
    `IS_MAESTRO = ${isMaestro ? "True" : "False"}`,
  );
}

// Every studio other than maestro keeps the unconditional member exemption
// regardless of IS_MAESTRO, so `leadGate` above (used by every pre-existing
// test in this file) bakes in False — the default, non-maestro outcome.
function leadGateAsStudio(payload: unknown, isMaestro: boolean) {
  return runSnippet({
    script: bakeIsMaestro(isMaestro),
    stdin: JSON.stringify(payload),
    shell: "bash",
    env: { STUDIO_ID: "test-studio--role" },
  });
}

// Completion gate's FIRST two guards (studio-bringup.sh:883, :888) refuse
// before ever reaching verification_intent (:953). A test must clear both to
// prove anything about the real check: real git checkout, plan doc actually
// committed (:903 requires a non-empty `git log`, not a working-tree
// file). Builds that repo once per test; caller seeds the record.
function makeCheckedOutRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "fleet-gate-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "PLAN.md"), "# plan\n");
  execFileSync("git", ["add", "PLAN.md"], { cwd: repo });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      // A host with global commit.gpgsign=true fails this non-interactively
      // before any assertion runs (open upstream issue in the project this
      // work came from). Force both off for this fixture's own commit only.
      "-c",
      "commit.gpgsign=false",
      "-c",
      "gpg.format=openpgp",
      "commit",
      "-q",
      "-m",
      "plan",
    ],
    { cwd: repo },
  );
  return repo;
}

// The pre-#361 IN-TREE record shape (.fleet/done/<task>.json inside the
// product checkout). Used only to prove the gate refuses it (#361).
function writeTaskRecord(repo: string, task: string, record: unknown): string {
  const dir = join(repo, ".fleet", "done");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${task}.json`);
  writeFileSync(p, JSON.stringify(record));
  return p;
}

function validRecord(overrides: Record<string, unknown> = {}) {
  return {
    plan: "PLAN.md",
    verification: [{ cmd: "bun run test", exit: 0, output: "ok" }],
    verification_intent: { url: "http://localhost:3000", steps: ["open the page"], expected: "page loads" },
    ...overrides,
  };
}

describe("lead gate, executed", () => {
  test("blocks the LEAD's Write with exit 2", () => {
    const r = leadGate({ tool_name: "Write", tool_input: { file_path: "/workspace/x.ts" } });
    expect(r.code).toBe(2);
    // Stable invariant across all FIVE refusal sites this hook script can
    // take (:584/:591 non-Bash, :610/:627/:653 Bash-specific -- :610 added
    // by D1), not one branch's prose tail. This specific call -- a bare
    // Write with a readable file_path -- hits :591 (write_shaped: name +
    // locator), the SECOND non-Bash site, not the first (:584 fires only
    // when tool_input itself is unreadable). The two non-Bash sites share
    // the lowercase "leads never implement -- dispatch a member"; the three
    // Bash-specific sites append a fuller sentence and a capital "Dispatch"
    // after it. Case follows punctuation before it, not a rewording to
    // chase.
    expect(r.stderr).toContain("leads never implement");
  });

  test("permits a MEMBER's Write — agent_id present means it is not the lead", () => {
    const r = leadGate({ tool_name: "Write", agent_id: "member-1", tool_input: { file_path: "/workspace/x.ts" } });
    expect(r.code).toBe(0);
  });

  test("permits a member identified by agent_type", () => {
    // studio-bringup.sh:547 exempts on `agent_id` OR `agent_type`. Both
    // branches must be pinned: a member wrongly blocked is the regression
    // that starved members once already.
    const r = leadGate({ tool_name: "Write", agent_type: "implementer", tool_input: { file_path: "/workspace/x.ts" } });
    expect(r.code).toBe(0);
  });

  test("blocks a lead Bash write-form", () => {
    const r = leadGate({ tool_name: "Bash", tool_input: { command: "echo hi > /workspace/x.ts" } });
    expect(r.code).toBe(2);
  });

  test("permits a lead Bash read-form", () => {
    const r = leadGate({ tool_name: "Bash", tool_input: { command: "git status" } });
    expect(r.code).toBe(0);
  });

  test("malformed stdin does not crash the hook into permitting a write", () => {
    // I1 (Important): the fail-closed answer here is DETERMINISTIC, not one
    // of two acceptable outcomes -- `expect([0, 2]).toContain(r.code)` stays
    // green even if refuse()'s own `sys.exit(2)` were changed to
    // `sys.exit(0)` (a silent permit). Pin the actual exit code and the
    // stderr message, not just "either fail-closed answer is fine".
    // Bypasses the leadGate() helper (malformed stdin, not JSON), so STUDIO_ID
    // must be pinned here too -- same reasoning as leadGate() itself above.
    const r = runSnippet({
      script: bakeIsMaestro(false),
      stdin: "not json",
      shell: "bash",
      env: { STUDIO_ID: "test-studio--role" },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("lead-gate: unreadable hook payload -- refusing");
  });
});

describe("lead gate matches on shape", () => {
  test("blocks a lead's write through a tool NOT on the old list", () => {
    const r = leadGate({ tool_name: "MultiEdit", tool_input: { file_path: "/workspace/x.ts" } });
    expect(r.code).toBe(2);
  });

  test("blocks NotebookEdit — the only real tool whose refusal depends on notebook_path being in the locator tuple", () => {
    // Verified by hand twice in review, tested by nobody until now.
    // Writeish name (matches "notebook") + notebook_path locator -> refuse.
    // new_source is deliberately NOT a content key, so this exercises the
    // name+locator path specifically, not has_write_content.
    const r = leadGate({
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: "/workspace/nb.ipynb", new_source: "print(1)" },
    });
    expect(r.code).toBe(2);
  });

  test("permits an unrecognised READ-shaped tool — an unknown tool is not a write", () => {
    const r = leadGate({ tool_name: "Glob", tool_input: { pattern: "**/*.ts" } });
    expect(r.code).toBe(0);
  });

  test("a member is still exempt whatever the tool is called", () => {
    const r = leadGate({ tool_name: "MultiEdit", agent_id: "member-1", tool_input: { file_path: "/workspace/x.ts" } });
    expect(r.code).toBe(0);
  });

  test("permits Read — file_path is a LOCATOR, not a write signal", () => {
    // Review Finding 1 (Critical): Read's ONLY required param is file_path,
    // the same key Write/Edit use. A lead that cannot Read cannot function.
    const r = leadGate({ tool_name: "Read", tool_input: { file_path: "/workspace/plan.md" } });
    expect(r.code).toBe(0);
  });

  test("permits Grep — path is its directory scope, not a write signal", () => {
    const r = leadGate({ tool_name: "Grep", tool_input: { pattern: "TODO", path: "/workspace/src" } });
    expect(r.code).toBe(0);
  });

  test("permits Glob WITH a path — the collision case the first shape test dodged", () => {
    // Round 1's only read-shaped test omitted `path`, the one input that
    // sidesteps the file_path/path collision. Pins WITH path alongside the
    // existing without-path test above.
    const r = leadGate({ tool_name: "Glob", tool_input: { pattern: "**/*.ts", path: "/workspace/src" } });
    expect(r.code).toBe(0);
  });

  test("permits TodoWrite — name matches the write regex but there is no locator", () => {
    // Name-alone is not enough: TodoWrite's tool_input carries only `todos`,
    // no file_path/path/notebook_path. A lead losing its own todo
    // bookkeeping would be a real degradation, not this gate's job.
    const r = leadGate({ tool_name: "TodoWrite", tool_input: { todos: [] } });
    expect(r.code).toBe(0);
  });

  test("permits Task — no locator, no write content, name not writeish", () => {
    // Closes the brief's full example list (decision #3: Read, Glob, Grep,
    // Task, WebFetch). Review process note: "the list is the specification."
    const r = leadGate({
      tool_name: "Task",
      tool_input: { description: "survey", prompt: "look around", subagent_type: "general-purpose" },
    });
    expect(r.code).toBe(0);
  });

  test("permits WebFetch — url is not a locator key this gate recognises", () => {
    const r = leadGate({ tool_name: "WebFetch", tool_input: { url: "https://example.com", prompt: "summarize" } });
    expect(r.code).toBe(0);
  });

  describe("blocks a non-writeish, no-locator tool that carries write CONTENT anyway", () => {
    // The task's own motivating scenario: a future delegation-shaped tool
    // this regex has never seen. Neither name_writeish nor has_locator fires
    // -- only has_write_content does. Reviewer's own table names this row
    // ("some future SaveFile {content}"). Without this branch a brand new
    // write-capable tool with an unremarkable name would pass silently.
    //
    // Round 4 (the one that matters): every key in this tuple, not just
    // `content`. Before this test.each, 5 of 6 keys (contents/edits/
    // new_string/new_str/patch) were exercised by NOTHING -- deleting any
    // one of them from the production tuple left the WHOLE suite green.
    // Non-writeish tool NAME is deliberate: it isolates the content-key
    // path from the name+locator path, so a regression in one cannot be
    // masked by the other.
    test.each(["content", "contents", "edits", "new_string", "new_str", "patch"])(
      "tool_input carrying ONLY '%s' still refuses",
      (key) => {
        const r = leadGate({ tool_name: "SaveFile", tool_input: { [key]: "some text" } });
        expect(r.code).toBe(2);
      },
    );
  });

  test("a null tool_input does not fail OPEN through an uncaught exception", () => {
    // Review Finding 2 (Important): payload.get("tool_input", {}) returns
    // None -- not {} -- when the KEY is present with value null; the default
    // only applies when the key is ABSENT. `any(k in None ...)` then raises
    // TypeError, python exits 1 uncaught, and exit 1 PERMITS (only exit 2
    // blocks). Fixed via `payload.get("tool_input") or {}`.
    //
    // Tool name MUST be non-writeish here. Verified empirically: with a
    // writeish name (e.g. "Write"), Python's `or` short-circuits on the
    // name-match before `tool_input` is ever touched, so that payload never
    // reaches the buggy line at all -- it exits 2 on BOTH the broken and
    // fixed code, proving nothing. "Read" forces evaluation past the
    // name-match, onto the line that actually crashed.
    //
    // Expected 0, not 1: with tool_input normalized to {}, no locator/content
    // to prove a write and a non-writeish name -- same "insufficient
    // evidence" path Read-with-file_path takes above, deterministic, not a
    // crash that happens to land on a permitting exit code.
    const r = leadGate({ tool_name: "Read", tool_input: null });
    expect(r.code).not.toBe(1);
    expect(r.code).toBe(0);
  });

  test("a null tool_input on a Bash call does not fail OPEN either", () => {
    // Same crash, Bash's OWN branch: `payload.get("tool_input", {}).get(
    // "command", "")` -- the {} default only applies when the KEY is
    // ABSENT, so a present `null` still returns None, and `None.get(...)`
    // raises AttributeError, uncaught, exit 1 -- which PERMITS (only exit 2
    // blocks), skipping the ENTIRE redirect/FORMS scan, not just the shape
    // test. Confirmed via direct script execution before writing this test.
    //
    // Expected 0, not 1: fixed the same way (`or {}`), tool_input normalizes
    // to {}, `.get("command", "")` then returns "" -- an empty command has
    // no redirect and matches no FORMS pattern, so it falls through to the
    // script's final sys.exit(0). This is not a new rule: a Bash call whose
    // tool_input is `{}` (command key simply absent) already takes this
    // exact path today and already exits 0 -- null is normalized to the
    // same {}, so it must land on the same answer.
    const r = leadGate({ tool_name: "Bash", tool_input: null });
    expect(r.code).not.toBe(1);
    expect(r.code).toBe(0);
  });

  describe("D1: Bash's own tool_input read fails OPEN on a TRUTHY non-dict (deferred finding, taken now)", () => {
    // `(payload.get("tool_input") or {})` substitutes {} only on FALSY --
    // None (absent or explicit null, both covered by the test directly
    // above) is falsy and already safe. A PRESENT but non-dict value (a
    // string, a list, a number) is truthy, so `or {}` never fires,
    // `.get("command", "")` is then called ON that str/list/int, and python
    // raises AttributeError uncaught -- exit 1, which PERMITS the call (only
    // exit 2 blocks), skipping the entire redirect/FORMS scan. Confirmed via
    // direct script execution before writing this test.
    //
    // Decision: refuse, not permit -- same fail-CLOSED reasoning the
    // non-Bash branch already uses for ITS unreadable-tool_input case
    // (round 3): cannot verify a command that cannot even be read, so an
    // accident of a Python crash must not be the thing deciding "safe".
    // A false refusal costs the lead one turn (dispatch a member); a false
    // permit via an uncaught exception is undefined behavior standing in
    // for a security decision.
    //
    // This does NOT extend to None/absent (the test above, unchanged): Bash
    // has no name-based signal the way Edit/Write do, so a tool_input that
    // is simply NOT THERE carries no evidence of a write either way, and
    // stays a permit. Only a PRESENT, malformed value is this defect.
    test.each([
      ["a bare string", "a string"],
      ["a list", ["x"]],
      ["a number", 123],
    ])("tool_input as %s refuses instead of crashing into a permit", (_label, tool_input) => {
      const r = leadGate({ tool_name: "Bash", tool_input });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("leads never implement");
    });
  });

  describe("a writeish name with unreadable input refuses instead of permitting", () => {
    // Review round 3 (Important), controller's own defect: `or {}` closed
    // the CRASH but not the HOLE. A lead's Write with null/absent tool_input
    // has no locator and no content key either way -- write_shaped came out
    // false, so it PERMITTED, just via a clean exit 0 instead of an
    // accidental exit 1. Same outcome, cleaner mechanism, hole still open.
    //
    // Ruling: writeish NAME + unreadable input (absent, null, or not a dict)
    // -> refuse. Same fail-CLOSED reasoning the unparseable-whole-payload
    // guard already uses: cannot verify safety, and the call is NAMED like a
    // write -> block. A false refusal costs one turn (dispatch a member); a
    // false permit is a silent write, found later or never.
    test("Write with tool_input: null refuses", () => {
      const r = leadGate({ tool_name: "Write", tool_input: null });
      expect(r.code).toBe(2);
    });

    test("Write with tool_input key absent entirely refuses", () => {
      const r = leadGate({ tool_name: "Write" });
      expect(r.code).toBe(2);
    });

    test("Edit with tool_input present but NOT a dict (a string) refuses", () => {
      const r = leadGate({ tool_name: "Edit", tool_input: "a string" });
      expect(r.code).toBe(2);
    });

    test("TodoWrite with a real, readable dict still PASSES — the refusal is for unreadable input, not for a locator-less dict", () => {
      const r = leadGate({ tool_name: "TodoWrite", tool_input: { todos: [] } });
      expect(r.code).toBe(0);
    });

    test("Bash with tool_input: null still PASSES — Bash is not a writeish name, and its own analysis needs a command string it does not have", () => {
      const r = leadGate({ tool_name: "Bash", tool_input: null });
      expect(r.code).toBe(0);
    });
  });
});

describe("lead gate no-ops without STUDIO_ID (defense in depth, board issue #20)", () => {
  // the operator, 2026-09-21: "I don't want any of these locks. there's useful and
  // legit usage of both of these." The Mac `fleet gates install` verb is
  // gone (board issue #20 cancels that half of #2), but nothing stops a
  // human from hand-copying gates/lead-gate.sh into ~/.claude/hooks/ on a
  // Mac by mistake. STUDIO_ID is set in every cloud studio's own process
  // environment (see src/studio/do.ts / provision.ts) and inherited by any
  // hook subprocess Claude Code spawns as a child of that environment. It
  // is NEVER set on the operator's Mac. So the guard makes the hook do nothing at
  // all outside a real cloud studio, regardless of how it got onto disk.
  test("a lead's Write is NOT refused when STUDIO_ID is absent — the hook does nothing at all outside a cloud studio", () => {
    const r = runSnippet({
      script: LEAD_GATE,
      stdin: JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/workspace/x.ts" } }),
      shell: "bash",
      env: { STUDIO_ID: "" },
    });
    expect(r.code).toBe(0);
    expect(r.stderr.trim()).toBe("");
  });

  test("the same lead Write IS refused when STUDIO_ID is set — no regression to real behavior inside a studio", () => {
    // Board issue #16 (v2): the guard passes STUDIO_ID through to the real
    // gate logic below it, which now unconditionally assigns IS_MAESTRO at
    // module scope (see bakeIsMaestro's own comment) — the raw,
    // unsubstituted LEAD_GATE would NameError before ever reaching this
    // refusal, so bake in the non-maestro default like every other execution
    // of this script in this file does.
    const r = runSnippet({
      script: bakeIsMaestro(false),
      stdin: JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/workspace/x.ts" } }),
      shell: "bash",
      env: { STUDIO_ID: "fleetflare--web-studio" },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("leads never implement");
  });
});

describe("completion gate no-ops without STUDIO_ID (defense in depth, board issue #20)", () => {
  // Same reasoning as the lead-gate guard above: no cloud studio, no effect.
  test("a stop with no .fleet/done.json anywhere is NOT refused when STUDIO_ID is absent", () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-gate-home-"));
    try {
      const r = runSnippet({
        script: COMPLETION_GATE,
        stdin: JSON.stringify({ stop_hook_active: false, cwd: "/no/such/dir" }),
        shell: "bash",
        env: { HOME: home, STUDIO_ID: "" },
      });
      expect(r.code).toBe(0);
      expect(r.stderr.trim()).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the same missing-record stop IS refused when STUDIO_ID is set — no regression to real behavior inside a studio", () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-gate-home-"));
    try {
      const r = runSnippet({
        script: COMPLETION_GATE,
        stdin: JSON.stringify({ stop_hook_active: false, cwd: "/no/such/dir" }),
        shell: "bash",
        // A synthetic STUDIO_ID that resolves to no real /workspace
        // directory, so repo_dir() falls back to payload.cwd — same
        // fixture-isolation reasoning the tests above this one use for
        // STUDIO_ID: "" (see the C1 comment above "completion gate,
        // executed"), just proving the opposite (set, not absent) side.
        env: { HOME: home, STUDIO_ID: "no-such-studio--test" },
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("No git checkout");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test("the installed matcher is not a fixed tool list", () => {
  expect(BRINGUP).not.toContain('"matcher": "Edit|Write|NotebookEdit|Bash"');
});

describe("install-marker hook wiring (board #350, round 5 review, item 1)", () => {
  // Behavioral coverage of the hook SCRIPT itself lives in
  // test/bun/install-marker-gate.test.ts (the "single source of truth, read
  // raw" convention this file's own header states for lead-gate.sh/
  // completion-gate.sh) — this only pins that studio-bringup.sh actually
  // installs and registers it, the same way the maestro bake-in tests below
  // pin the MECHANISM, not just the script's own logic in isolation.
  test("copies the single-source gates/install-marker.sh into the hooks directory and makes it executable", () => {
    expect(BRINGUP).toContain("cp /opt/blueprint/gates/install-marker.sh ~/.claude/hooks/install-marker.sh");
    expect(BRINGUP).toContain("chmod 0755 ~/.claude/hooks/install-marker.sh");
  });

  test("registers it as a PostToolUse hook, guarded to fail OPEN (never blocks) on a missing/non-executable script — unlike lead-gate/completion-gate's fail-CLOSED posture, this hook enforces no security/completion invariant", () => {
    expect(BRINGUP).toContain('cfg.setdefault("hooks", {}).setdefault("PostToolUse", [])');
    expect(BRINGUP).toContain('[ -x \\"$S\\" ] && exec \\"$S\\" || exit 0');
    expect(BRINGUP).not.toContain('"S=\\"$HOME/.claude/hooks/install-marker.sh\\"; [ -x \\"$S\\" ] || { echo');
  });

  test("registered in the SAME bring-up block as lead-gate/session-reemit, so one bring-up installs all three hooks or none", () => {
    const leadGateAt = BRINGUP.indexOf("cp /opt/blueprint/gates/lead-gate.sh");
    const sessionReemitAt = BRINGUP.indexOf("cp /opt/blueprint/gates/session-reemit.sh");
    const installMarkerAt = BRINGUP.indexOf("cp /opt/blueprint/gates/install-marker.sh");
    expect(leadGateAt).toBeGreaterThan(-1);
    expect(sessionReemitAt).toBeGreaterThan(leadGateAt);
    expect(installMarkerAt).toBeGreaterThan(sessionReemitAt);
    // All three sit before the completion-gate block's own, separate
    // STUDIO_COMPLETION_GATE conditional starts.
    expect(installMarkerAt).toBeLessThan(BRINGUP.indexOf("STUDIO_COMPLETION_GATE"));
  });
});

describe("lead gate, maestro no-proxy (board issue #16)", () => {
  // Maestro Studio has a declared roster of zero — so inside a maestro
  // session, ANY call carrying agent_id/agent_type is, by construction, a
  // subagent MAESTRO ITSELF spawned, never a "real" member. The fix closes
  // the by-proxy hole this opened without touching any other studio's
  // legitimate exemption. IS_MAESTRO is now baked into the hook script's
  // OWN bytes at materialization time (see leadGateAsStudio above), never
  // re-derived from a separate file at decision (PreToolUse) time — a
  // maestro subagent tampering with a runtime marker file can no longer
  // flip this mid-session, which is exactly the gap this fix closes.

  test("maestro + subagent + Write is now BLOCKED — the core fix", () => {
    const r = leadGateAsStudio(
      { tool_name: "Write", agent_id: "subagent-1", tool_input: { file_path: "/workspace/x.ts" } },
      true,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("leads never implement");
  });

  test("non-maestro + member + Write stays PERMITTED — no regression for a real roster", () => {
    const r = leadGateAsStudio(
      { tool_name: "Write", agent_id: "member-1", tool_input: { file_path: "/workspace/x.ts" } },
      false,
    );
    expect(r.code).toBe(0);
  });

  test("maestro + the LEAD's own call (no agent_id) + Write stays BLOCKED — unchanged, pre-existing behavior", () => {
    const r = leadGateAsStudio({ tool_name: "Write", tool_input: { file_path: "/workspace/x.ts" } }, true);
    expect(r.code).toBe(2);
  });

  test("maestro + subagent + a genuinely READ-shaped call stays PERMITTED — the new scrutiny only catches writes", () => {
    const r = leadGateAsStudio(
      { tool_name: "Read", agent_id: "subagent-1", tool_input: { file_path: "/workspace/plan.md" } },
      true,
    );
    expect(r.code).toBe(0);
  });
});

describe("lead gate, a lead may redirect its own mid-flight subagent (board issue #45)", () => {
  // Measured 2026-09-23 in demosite-life--release-studio: the maestro posted a
  // correction to board task 796 (a plan step asserted a guard against the
  // string "ACMR", which is ABSENT from lefthook.yml, so the test it described
  // would have passed vacuously), the lead READ the correction and AGREED with
  // it, and then reported it could not forward it to the already-running task4
  // subagent. The subagent kept building against a brief its own lead knew was
  // defective, and the lead's only remaining move was to let it finish and
  // reject it afterwards -- a whole worker-context of spend to reach a verdict
  // the lead held before the work started.
  //
  // What the repo-tracked bytes actually do, measured before writing these
  // tests rather than assumed from the report: the CANONICAL SendMessage shape
  // ({to, message, summary}) was ALREADY permitted -- "SendMessage" does not
  // match the writeish-name regex and none of to/message/summary is a locator
  // or a write-content key, so it fell through to the final sys.exit(0). That
  // permit was an ACCIDENT OF PARAMETER NAMING, not a rule: there was no
  // statement anywhere in this gate that a lead may message its own subagent,
  // and the moment a message payload carries any of the six content keys the
  // has_write_content check names (content/contents/edits/new_string/new_str/
  // patch -- that check matches on KEYS, never on tool_name, and by its own
  // comment reaches every MCP server this fleet mounts) the same coordination
  // message is refused. That refusal is the failing case below, and it is a
  // real one: a message is not a file write whatever its body parameter
  // happens to be called.
  //
  // Honest about the limit of this fix, the same way the gate's own HONEST
  // SCOPE paragraph is: the refusal the release-studio lead reported for the
  // canonical shape could NOT be reproduced from these bytes. Making the
  // permit explicit is still the right answer -- an incidental pass is one
  // renamed parameter away from the outage that was reported -- but nobody
  // should read these tests as proof that the reported refusal came from this
  // file.

  test("a lead's canonical redirect to its own subagent is permitted", () => {
    // Pin, not proof: this exact shape already exited 0 before the fix (see
    // the block comment above). It is here so that a future narrowing of the
    // permit cannot silently take the plain case down with it.
    const r = leadGateAsStudio(
      {
        tool_name: "SendMessage",
        tool_input: {
          to: "task4",
          message: "stop: the plan step asserts a guard against ACMR, absent from lefthook.yml",
          summary: "correction to task 796",
        },
      },
      false,
    );
    expect(r.code).toBe(0);
  });

  test("a lead's redirect is permitted even when the message body parameter is named like write content", () => {
    // THE failing test. Before the fix this exited 2 with "leads never
    // implement -- dispatch a member": has_write_content matches on the KEY
    // `content`, with no reference at all to the tool doing the carrying, so a
    // pure coordination message was refused for the name of its body
    // parameter. Measured directly against gates/lead-gate.sh before the fix
    // existed, not inferred.
    const r = leadGateAsStudio(
      {
        tool_name: "SendMessage",
        tool_input: { to: "task4", content: "stop: ACMR is absent from lefthook.yml, the assertion is vacuous" },
      },
      false,
    );
    expect(r.code).toBe(0);
  });

  test("the permit is for the messaging tool only — a lead's Write addressed to a subagent is still refused", () => {
    // The permit must not become a general "anything a lead sends a subagent"
    // exemption. A `to` key buys nothing: this is still a Write with a
    // locator, and it still refuses.
    const r = leadGateAsStudio(
      { tool_name: "Write", tool_input: { to: "task4", file_path: "/workspace/x.ts", content: "x" } },
      false,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("leads never implement");
  });

  test("a lead's file-writing Bash is still refused — the messaging permit does not reach the Bash half", () => {
    const r = leadGateAsStudio({ tool_name: "Bash", tool_input: { command: "echo hi > /workspace/x.ts" } }, false);
    expect(r.code).toBe(2);
  });

  describe("the maestro-by-proxy direction (board issue #23/#16) stays closed", () => {
    // #23's whole point: a maestro must not implement THROUGH a subagent, and
    // a message is the exact channel a proxied write would use. The narrow
    // rule shipped here is the one the issue explicitly allows: the permit
    // applies to NON-MAESTRO roles only, whose subagents ARE supposed to
    // implement. Inside a maestro session nothing about messaging changes --
    // a message-shaped call is evaluated by exactly the same write-shape
    // checks it faced before.

    test("maestro handing a subagent literal file content through the message channel is refused", () => {
      const r = leadGateAsStudio(
        { tool_name: "SendMessage", tool_input: { to: "sub-1", content: "export const x = 1;\n" } },
        true,
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("leads never implement");
    });

    test("maestro handing a subagent a patch through the message channel is refused", () => {
      const r = leadGateAsStudio(
        { tool_name: "SendMessage", tool_input: { to: "sub-1", patch: "--- a/x\n+++ b/x\n" } },
        true,
      );
      expect(r.code).toBe(2);
    });

    test("maestro is not newly blocked either — its canonical coordination message still passes, exactly as before", () => {
      // No regression in the other direction: excluding maestro from the
      // named permit does not introduce a refusal it did not have. A
      // {to, message, summary} call carries no locator and no write-content
      // key, so it falls through the write-shape checks to exit 0 -- measured
      // against the pre-fix bytes as well as these.
      const r = leadGateAsStudio(
        { tool_name: "SendMessage", tool_input: { to: "sub-1", message: "status?", summary: "status check" } },
        true,
      );
      expect(r.code).toBe(0);
    });

    test("the maestro subagent's own Write is STILL refused — the real enforcement point is the write, not the message", () => {
      // The honest half of the rule, pinned as a test rather than left as
      // prose in a PR body: a plain-language instruction ("write the file
      // yourself") is indistinguishable from a legitimate redirect at this
      // hook, and maestro could already put that instruction in a Task prompt
      // today (Task is permitted, see "permits Task" above). What stops the
      // proxy is that the subagent's OWN write call falls through into the
      // same scrutiny -- unchanged by board issue #45.
      const r = leadGateAsStudio(
        { tool_name: "Write", agent_id: "sub-1", tool_input: { file_path: "/workspace/x.ts", content: "x" } },
        true,
      );
      expect(r.code).toBe(2);
    });
  });
});

describe("lead gate, IS_MAESTRO bake-in mechanism itself (board issue #16)", () => {
  // Proves the SUBSTITUTION mechanics work as bring-up would actually run
  // them, not just the python body in isolation: the real gates/lead-gate.sh
  // file still carries the literal placeholder token until
  // studio-bringup.sh's own `sed -i` (outside the file, run right after the
  // lead-gate `cp` + `chmod 0755`, in the same block that has $STUDIO_NAME)
  // replaces it on the COPIED file at ~/.claude/hooks/lead-gate.sh — never
  // on gates/lead-gate.sh itself. Confirms neither substitution outcome
  // leaves a stray token and both produce syntactically valid Python — a
  // compile-only check, no execution, so this cannot be satisfied by
  // accident the way an exit-code-only test could be.
  test("the raw gates/lead-gate.sh file still carries the unsubstituted placeholder", () => {
    expect(LEAD_GATE).toContain("IS_MAESTRO = __IS_MAESTRO_BOOL__");
  });

  test.each([
    ["maestro", true],
    ["non-maestro", false],
  ])("substituting the placeholder for %s leaves no stray token and stays valid Python", (_label, isMaestro) => {
    const substituted = bakeIsMaestro(isMaestro);
    expect(substituted).not.toContain("__IS_MAESTRO_BOOL__");
    expect(substituted).toContain(`IS_MAESTRO = ${isMaestro ? "True" : "False"}`);

    // gates/lead-gate.sh is bash (a `#!/usr/bin/env bash` script that execs
    // `python3 -c '...'` on its own stdin-reading payload) — extract just
    // the single-quoted python program the same way `exec python3 -c '...'`
    // does, and hand THAT to `compile()`, rather than trying to compile the
    // whole bash wrapper as Python.
    const opener = "exec python3 -c '\n";
    const openAt = substituted.indexOf(opener);
    expect(openAt).toBeGreaterThan(-1);
    const bodyStart = openAt + opener.length;
    const bodyEnd = substituted.lastIndexOf("\n'");
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    const pyProgram = substituted.slice(bodyStart, bodyEnd);

    const tmpDir = mkdtempSync(join(tmpdir(), "fleet-gate-syntax-"));
    const tmpPy = join(tmpDir, "lead_gate_body.py");
    writeFileSync(tmpPy, pyProgram);
    try {
      execFileSync("python3", [
        "-c",
        `compile(open(${JSON.stringify(tmpPy)}).read(), ${JSON.stringify(tmpPy)}, "exec")`,
      ]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("completion gate, generated prose", () => {
  // The gap this locks: the gate's HOWTO once named plan / verification /
  // verification_intent and never `learnings`, so the teardown harvest found
  // nothing on every recycle -- a pipe with no water. Fixed; pinned here.
  test("the emitted HOWTO asks for learnings", () => {
    expect(COMPLETION_GATE).toContain("learnings");
  });

  test("it still demands verification intent", () => {
    // Tightened (review, Minor): bare "verification_intent" matches the
    // Python variable name too, so only vanishing from the WHOLE script
    // fails it. Assert the HOWTO's actual shape line instead -- fails if
    // that line is reworded or removed, not just if the token disappears.
    expect(COMPLETION_GATE).toContain('\\"verification_intent\\": {\\"url\\"');
  });

  test("learnings is named OPTIONAL and never a refusal condition", () => {
    expect(COMPLETION_GATE).toMatch(/learnings is OPTIONAL/);
    expect(COMPLETION_GATE).toMatch(/never checks it|[Nn]ever a refusal/);
  });

  test("no stale wording claiming the gate checks learnings", () => {
    expect(COMPLETION_GATE).not.toMatch(/learnings (is )?required/i);
  });
});

describe("completion gate, executed", () => {
  // Fake HOME each run: the gate writes a refusal counter under
  // ~/.claude/.fleet-stop-gate, and after 5 real runs MAX_REFUSALS stands it
  // down. STUDIO_ID pinned to a synthetic value: present (the #20 guard lets
  // the gate run) yet resolving to no real /workspace dir, so repo_dir()
  // falls back to payload.cwd -- the fixture, never an ambient studio's repo.
  // FLEET_WORKSPACE pinned for the same reason: the record dir (#361).
  test("refuses a done-report with no verification intent, and names the field", () => {
    const { repo, ws } = gateFixture();
    try {
      onBranch(repo, "fix-222-thing");
      writeLocalRecord(ws, "222", broken);
      const r = gateIn(repo, ws);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("verification_intent");
      expect(r.stderr).toContain("222.json");
      // Past the early git-checkout guard, to the real check.
      expect(r.stderr).not.toContain("No git checkout");
    } finally {
      cleanup(repo, ws);
    }
  });

  test("a well-formed record in the workspace record dir lets the stop through", () => {
    const { repo, ws } = gateFixture();
    try {
      onBranch(repo, "fix-222-thing");
      writeLocalRecord(ws, "222", validRecord());
      expect(gateIn(repo, ws).code).toBe(0);
    } finally {
      cleanup(repo, ws);
    }
  });
});

// Issue #361: completion records used to live IN the product repo
// (.fleet/done/<task>.json, #316), so every task's PR committed one -- public
// operator exhaust. The record now lives OUTSIDE the checkout, at
// $FLEET_WORKSPACE/.fleet/done/<task>.json (/workspace in a studio, beside
// working-set.md), never committed. The Worker copies it to the private ops
// repo at teardown (do.ts archiveDoneRecords); the gate never touches any repo.
const GIT_ID = ["-c", "user.email=t@e.com", "-c", "user.name=T", "-c", "commit.gpgsign=false"];
function gateFixture(): { repo: string; ws: string } {
  return { repo: makeCheckedOutRepo(), ws: mkdtempSync(join(tmpdir(), "fleet-gate-ws-")) };
}
function cleanup(...dirs: string[]) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
function writeLocalRecord(ws: string, task: string, record: unknown): string {
  const dir = join(ws, ".fleet", "done");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${task}.json`);
  writeFileSync(p, JSON.stringify(record));
  return p;
}
function gateIn(repo: string, ws: string, env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "fleet-gate-home-"));
  try {
    return runSnippet({
      script: COMPLETION_GATE,
      stdin: JSON.stringify({ stop_hook_active: false, cwd: repo }),
      shell: "bash",
      env: { HOME: home, STUDIO_ID: "no-such-studio--test", FLEET_WORKSPACE: ws, FLEET_TASK: "", ...env },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
const broken = { plan: "PLAN.md", verification: [{ cmd: "bun run test", exit: 0, output: "ok" }] };
function onBranch(repo: string, name: string) {
  execFileSync("git", ["checkout", "-q", "-b", name], { cwd: repo });
}
function commitAll(repo: string, msg: string) {
  execFileSync("git", [...GIT_ID, "add", "-A"], { cwd: repo });
  execFileSync("git", [...GIT_ID, "commit", "-q", "-m", msg], { cwd: repo });
}
/** A repo whose origin/main already carries in-tree `records` -- the
 *  pre-#361 shape, still on main until the #351 scrub lands. */
function repoWithMergedRecords(records: Record<string, unknown>): { repo: string; origin: string } {
  const repo = makeCheckedOutRepo();
  for (const [task, rec] of Object.entries(records)) writeTaskRecord(repo, task, rec);
  commitAll(repo, "merged tasks");
  const origin = mkdtempSync(join(tmpdir(), "fleet-gate-origin-"));
  execFileSync("git", ["init", "-q", "--bare", origin]);
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: repo });
  execFileSync("git", ["push", "-q", "origin", "HEAD:refs/heads/main"], { cwd: repo });
  execFileSync("git", ["fetch", "-q", "origin"], { cwd: repo });
  return { repo, origin };
}

describe("completion gate, record outside the product checkout (#361)", () => {
  // Must catch: a gate that still reads the record from the product tree.
  test("an in-tree .fleet/done/<task>.json alone never satisfies the gate — refused, naming the workspace path", () => {
    const { repo, ws } = gateFixture();
    try {
      onBranch(repo, "fix-222-thing");
      writeTaskRecord(repo, "222", validRecord());
      const r = gateIn(repo, ws);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(join(ws, ".fleet", "done", "222.json"));
      expect(r.stderr).toContain("never commit");
    } finally {
      cleanup(repo, ws);
    }
  });

  // Must catch: a gate that lets a branch re-create .fleet/done/* on main.
  test("a branch that commits an in-tree record is refused even with a valid workspace record", () => {
    const { repo, origin } = repoWithMergedRecords({ "250": validRecord() });
    const ws = mkdtempSync(join(tmpdir(), "fleet-gate-ws-"));
    try {
      onBranch(repo, "fix-222-thing");
      writeTaskRecord(repo, "222", validRecord());
      commitAll(repo, "record in tree");
      writeLocalRecord(ws, "222", validRecord());
      const r = gateIn(repo, ws);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("never commit");
      expect(r.stderr).toContain(".fleet/done/222.json");
    } finally {
      cleanup(repo, origin, ws);
    }
  });

  test("an uncommitted legacy .fleet/done.json in the tree is refused the same way", () => {
    const { repo, ws } = gateFixture();
    try {
      onBranch(repo, "fix-222-thing");
      mkdirSync(join(repo, ".fleet"), { recursive: true });
      writeFileSync(join(repo, ".fleet", "done.json"), JSON.stringify(validRecord()));
      writeLocalRecord(ws, "222", validRecord());
      const r = gateIn(repo, ws);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("never commit");
    } finally {
      cleanup(repo, ws);
    }
  });

  // The #351 scrub PR itself deletes .fleet/done/* -- a deletion is not a write.
  test("a branch that DELETES merged in-tree records passes", () => {
    const { repo, origin } = repoWithMergedRecords({ "250": validRecord(), "316": validRecord() });
    const ws = mkdtempSync(join(tmpdir(), "fleet-gate-ws-"));
    try {
      onBranch(repo, "scrub-351");
      rmSync(join(repo, ".fleet", "done", "250.json"));
      commitAll(repo, "scrub");
      rmSync(join(repo, ".fleet", "done", "316.json")); // uncommitted deletion too
      writeLocalRecord(ws, "351", validRecord());
      const r = gateIn(repo, ws);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
    } finally {
      cleanup(repo, origin, ws);
    }
  });

  test("in-tree records already on main, untouched by this branch, never block it", () => {
    const { repo, origin } = repoWithMergedRecords({ "250": validRecord() });
    const ws = mkdtempSync(join(tmpdir(), "fleet-gate-ws-"));
    try {
      onBranch(repo, "fix-400-thing");
      writeLocalRecord(ws, "400", validRecord());
      expect(gateIn(repo, ws).code).toBe(0);
    } finally {
      cleanup(repo, origin, ws);
    }
  });

  // Must catch: a gate that fails when FLEET_OPS_REPO is unset or bad -- the
  // gate never consults the ops repo; the Worker is its only writer.
  test.each([["unset", ""], ["not owner/name", "garbage"], ["set", "rafarc21/fleetflare-ops"]])(
    "FLEET_OPS_REPO %s: a valid workspace record passes — the gate never consults the ops repo",
    (_label, value) => {
      const { repo, ws } = gateFixture();
      try {
        onBranch(repo, "fix-222-thing");
        writeLocalRecord(ws, "222", validRecord());
        const r = gateIn(repo, ws, { FLEET_OPS_REPO: value });
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
      } finally {
        cleanup(repo, ws);
      }
    },
  );

  test("task 400 with no record refuses, naming .fleet/done/400.json — a sibling task's record never passes for it", () => {
    const { repo, ws } = gateFixture();
    try {
      onBranch(repo, "fix-400-thing");
      writeLocalRecord(ws, "250", validRecord());
      const r = gateIn(repo, ws);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(".fleet/done/400.json");
    } finally {
      cleanup(repo, ws);
    }
  });

  test("the branch names 222: 222.json is the record checked, even beside a valid sibling", () => {
    const { repo, ws } = gateFixture();
    try {
      onBranch(repo, "fix-222-thing");
      writeLocalRecord(ws, "222", broken);
      writeLocalRecord(ws, "111", validRecord());
      const r = gateIn(repo, ws);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("222.json");
      expect(r.stderr).toContain("verification_intent");
    } finally {
      cleanup(repo, ws);
    }
  });

  // #363 review round 2 (BLOCKER): the workspace dir outlives a task, so its
  // one record may be an EARLIER task's. It never speaks for a branch that
  // names no task -- the #316 rule.
  test("no task number in the branch and one leftover workspace record: refused, never passed on it", () => {
    const { repo, ws } = gateFixture();
    try {
      onBranch(repo, "feature-polish");
      writeLocalRecord(ws, "250", validRecord());
      const r = gateIn(repo, ws);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("cannot tell which task");
      // #363 round 3: writing a record no longer names the task -- the fix is
      // the branch name or FLEET_TASK, and the refusal says exactly that.
      expect(r.stderr).toContain("Put the issue number in the branch name (e.g. 361-slug) or set FLEET_TASK.");
      expect(r.stderr).not.toContain("/<issue>.json for the task you are closing");
    } finally {
      cleanup(repo, ws);
    }
  });

  test("no task number in the branch and several workspace records: refuses, listing them, never guesses", () => {
    const { repo, ws } = gateFixture();
    try {
      onBranch(repo, "some-work");
      writeLocalRecord(ws, "111", validRecord());
      writeLocalRecord(ws, "222", validRecord());
      const r = gateIn(repo, ws);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("cannot tell which task");
      expect(r.stderr).toContain("111.json");
    } finally {
      cleanup(repo, ws);
    }
  });

  test("no task number and no record: refuses loud, naming the workspace record dir", () => {
    const { repo, ws } = gateFixture();
    try {
      onBranch(repo, "some-work");
      const r = gateIn(repo, ws);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("cannot tell which task");
      expect(r.stderr).toContain(join(ws, ".fleet", "done"));
    } finally {
      cleanup(repo, ws);
    }
  });

  test("a number glued to letters (a user prefix like rafarc21/) is not a task number", () => {
    const { repo, ws } = gateFixture();
    try {
      onBranch(repo, "rafarc21/400-thing");
      const r = gateIn(repo, ws);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(".fleet/done/400.json");
    } finally {
      cleanup(repo, ws);
    }
  });

  test("FLEET_TASK, when set, names the task outright", () => {
    const { repo, ws } = gateFixture();
    try {
      onBranch(repo, "fix-111-thing");
      writeLocalRecord(ws, "111", validRecord());
      const r = gateIn(repo, ws, { FLEET_TASK: "333" });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(".fleet/done/333.json");
    } finally {
      cleanup(repo, ws);
    }
  });

  test("FLEET_WORKSPACE unset: the record dir is /workspace/.fleet/done, named in the refusal", () => {
    const repo = makeCheckedOutRepo();
    const home = mkdtempSync(join(tmpdir(), "fleet-gate-home-"));
    try {
      onBranch(repo, "fix-999991-thing");
      const r = runSnippet({
        script: COMPLETION_GATE,
        stdin: JSON.stringify({ stop_hook_active: false, cwd: repo }),
        shell: "bash",
        env: { HOME: home, STUDIO_ID: "no-such-studio--test", FLEET_WORKSPACE: "", FLEET_TASK: "" },
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("/workspace/.fleet/done/999991.json");
    } finally {
      cleanup(repo, home);
    }
  });
});

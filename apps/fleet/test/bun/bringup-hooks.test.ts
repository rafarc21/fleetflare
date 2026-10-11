import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnippet } from "./exec-snippet";

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
const BRINGUP = readFileSync(join(import.meta.dir, "../../container/studio-bringup.sh"), "utf8");
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

const REEMIT = readFileSync(join(import.meta.dir, "../../../../gates/session-reemit.sh"), "utf8");

function reemit(payload: unknown, workingSet: string) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-ws-"));
  mkdirSync(join(dir, ".fleet"), { recursive: true });
  writeFileSync(join(dir, ".fleet", "working-set.md"), workingSet);
  try {
    return runSnippet({
      script: REEMIT, stdin: JSON.stringify(payload), shell: "bash",
      env: { FLEET_WORKSPACE: dir },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("session re-emit hook", () => {
  test("replays the working set when source is compact", () => {
    const r = reemit({ source: "compact" }, "THE BRIEF");
    expect(r.stdout).toContain("THE BRIEF");
    expect(r.code).toBe(0);
  });

  test("replays it on clear too", () => {
    expect(reemit({ source: "clear" }, "THE BRIEF").stdout).toContain("THE BRIEF");
  });

  test("stays silent on a normal startup — bring-up already sent the prompt", () => {
    const r = reemit({ source: "startup" }, "THE BRIEF");
    expect(r.stdout.trim()).toBe("");
    expect(r.code).toBe(0);
  });

  test("stays silent on resume — --continue restores the transcript itself", () => {
    expect(reemit({ source: "resume" }, "THE BRIEF").stdout.trim()).toBe("");
  });

  test("a missing working-set file is silent, never a crash", () => {
    const r = runSnippet({
      script: REEMIT, stdin: JSON.stringify({ source: "compact" }), shell: "bash",
      env: { FLEET_WORKSPACE: "/no/such/dir" },
    });
    // Review finding (Minor): code-only left this vacuous -- deleting the
    // guard line still exits 0 via the trailing `exit 0`, while leaking the
    // "Context was compacted..." header with no body. Assert stdout too.
    expect(r.stdout.trim()).toBe("");
    expect(r.code).toBe(0);
  });

  test("malformed payload is silent, never a crash", () => {
    const r = runSnippet({ script: REEMIT, stdin: "not json", shell: "bash" });
    expect(r.code).toBe(0);
    // Review finding (Minor, M5): code-only was vacuous here too -- no
    // FLEET_WORKSPACE override means the default path (/workspace/...) does
    // not exist on the runner, so exit 0 held regardless of what the
    // malformed-payload branch actually does. The test right below seeds a
    // real working-set file so this assertion has something to catch.
    expect(r.stdout.trim()).toBe("");
  });

  test("malformed payload stays silent even with a real working set on disk to leak (review Minor)", () => {
    // The test above only proves silence with an UNSET FLEET_WORKSPACE,
    // where the default path (/workspace/...) does not exist on the runner
    // -- so a code-only, no-seed check would pass whether or not the
    // malformed-payload branch actually stays silent, purely because there
    // is nothing on disk to leak. Seeding a real file here is what makes
    // the assertion mean something: an empty `case` guard regression that
    // let a malformed payload fall through to the compact/clear branch
    // would leak THIS content, and the code-only check above would still
    // read 0 either way.
    const dir = mkdtempSync(join(tmpdir(), "fleet-ws-"));
    mkdirSync(join(dir, ".fleet"), { recursive: true });
    writeFileSync(join(dir, ".fleet", "working-set.md"), "THE BRIEF");
    try {
      const malformed = runSnippet({
        script: REEMIT, stdin: "not json", shell: "bash",
        env: { FLEET_WORKSPACE: dir },
      });
      expect(malformed.code).toBe(0);
      expect(malformed.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an all-whitespace working set (empty ROLE_PROMPT_B64 -> a one-newline file) is treated as nothing to replay, not a bare header (review Minor)", () => {
    // studio-bringup.sh writes the working set as `printf '%s\n' "$role_prompt"`
    // -- when ROLE_PROMPT_B64 decodes to an empty string (unset, or empty),
    // that is ONE byte on disk (a lone newline), not zero. The file is still
    // readable, so a readability-only guard lets the hook print the
    // "Context was compacted..." header with nothing real under it.
    const r = reemit({ source: "compact" }, "\n");
    expect(r.stdout.trim()).toBe("");
    expect(r.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #221 (PR3b), Task 5 — the hook heartbeat, the second (higher-
// precision) leg of the ACTIVITY column, composed with (never replacing)
// PR3a's pane leg. See docs/superpowers/plans/2026-09-25-pr3b-hook-
// heartbeat.md, Task 5.
// ---------------------------------------------------------------------------
const ACTIVITY_HEARTBEAT = readFileSync(join(import.meta.dir, "../../../../gates/activity-heartbeat.sh"), "utf8");

// Issue #221 fix round 2, item 2 (maestro review, PR #352) — the hook script
// now refuses to write unless it can prove it is running as a hook of the
// LEAD's own top-level claude session (gates/activity-heartbeat.sh's own
// is_lead_session, mirroring memguard.ts's #238 resolveLeadParentPid/
// isProtected from the hook script's OWN side). Every test below that
// expects an actual WRITE to happen now needs a REAL process tree proving
// that — not a mock — because the fix itself walks real `/proc` ancestry.
//
// The technique: a copy of the real bash binary, saved to a file literally
// named "claude". On Linux, `/proc/<pid>/comm` reflects the basename of the
// PATH actually passed to execve() -- confirmed empirically -- regardless of
// argv[0] tricks (`exec -a` does NOT change it), so running that copy
// directly (not via a `#!/bin/bash` shebang script, which would execve the
// INTERPRETER's own path instead) gives a real process whose comm is
// "claude". Every `-c` invocation below ends in `; true` (or is itself a
// multi-statement script) specifically so bash's own "last command" exec-
// optimization never fires: without a trailing statement, bash would
// exec-REPLACE itself into the next hop rather than fork it, silently
// merging two hops into the SAME pid and destroying the parent/child
// distinction the fix depends on. Confirmed empirically before writing
// these tests (a single-statement `-c 'sleep 2'` measurably replaces the
// bash process rather than forking a child for it).
let cachedFakeClaude: string | null = null;
function fakeClaudeBinary(): string {
  if (cachedFakeClaude) return cachedFakeClaude;
  const dir = mkdtempSync(join(tmpdir(), "fleet-fake-claude-"));
  const dest = join(dir, "claude");
  const bashPath = execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
  copyFileSync(bashPath, dest);
  chmodSync(dest, 0o755);
  cachedFakeClaude = dest;
  return dest;
}

// A stub `tmux` on PATH answering ONLY
// `display-message -p -t studio:claude '#{pane_pid}'` (is_lead_session's own
// address for that exact pane, the SAME command studio-bringup.sh/
// memguard.ts already use) with whatever pid was written to
// FAKE_TMUX_PANE_PID_FILE — the constructed "pane shell" process writes its
// OWN pid there at the top of its own script, so the TS side never needs to
// correlate a Bun-reported pid against the real one itself.
let cachedTmuxStubDir: string | null = null;
function tmuxStubDir(): string {
  if (cachedTmuxStubDir) return cachedTmuxStubDir;
  const dir = mkdtempSync(join(tmpdir(), "fleet-fake-tmux-"));
  writeFileSync(
    join(dir, "tmux"),
    `#!/usr/bin/env bash
if [ -n "\${FAKE_TMUX_PANE_PID_FILE:-}" ] && [ -f "$FAKE_TMUX_PANE_PID_FILE" ]; then
  cat "$FAKE_TMUX_PANE_PID_FILE"
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );
  cachedTmuxStubDir = dir;
  return dir;
}

// Issue #370: a fake `date` mimicking BSD/macOS — passes `%3N` through as the
// LITERAL text "3N" instead of digits (real observed BSD behavior; there is
// no `%N` conversion at all in BSD strftime), exactly the bug that produced
// a malformed `...3NZ` timestamp on a Mac host. No `gdate` on this PATH
// either, so `write_state`'s fallback chain must reach its whole-second
// floor. Delegates to the REAL `date` (via env, since our fake shadows the
// bare name on PATH) for any format that doesn't ask for `%3N`, so the
// fallback call still returns a genuinely valid instant.
function fakeBsdDateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-fake-bsd-date-"));
  writeFileSync(
    join(dir, "date"),
    `#!/usr/bin/env bash
fmt="$2"
if [[ "$fmt" == *"%3N"* ]]; then
  real="$(/usr/bin/date -u +%Y-%m-%dT%H:%M:%S)"
  echo "\${real}.3NZ"
  exit 0
fi
exec /usr/bin/date "$@"
`,
    { mode: 0o755 },
  );
  return dir;
}

function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
function dq(s: string): string {
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

// One claude-named hop (comm="claude") that runs `bash scriptPath` as ITS
// OWN child — the trailing `; true` forces a real fork rather than an
// exec-replace, so the "claude" comm survives as a genuine ANCESTOR of the
// script, not merged into the same pid as it.
function claudeHop(fakeClaudePath: string, scriptPath: string): string {
  return `${sq(fakeClaudePath)} -c ${dq(`bash ${sq(scriptPath)}; true`)}`;
}
// Wraps an inner command in one more (non-claude) `bash -c` hop — models a
// Bash-tool shell sitting between the lead and a nested `claude -p` it
// spawned, so the nested claude's own ppid is that intermediary, never the
// pane shell.
function shellHop(inner: string): string {
  return `bash -c ${dq(`${inner}; true`)}`;
}

// Issue #370: every test that goes through runHeartbeatWithAncestry runs on
// Linux only. Two macOS facts make that harness impossible there, and neither
// is a hook bug:
//   1. no /proc -- is_lead_session's ancestry walk reads /proc/<pid>/comm and
//      /proc/<pid>/stat, so on macOS it fails closed (no write), by design;
//   2. launch constraints -- macOS SIGKILLs a copy of /bin/bash run from any
//      other path, so fakeClaudeBinary's "claude" hop dies before the hook
//      even starts ("Killed: 9" on stderr).
// Production is Linux only (studio containers). On macOS these tests would
// fail, or pass vacuously ("nothing written" because nothing CAN be), so they
// are skipped there, not weakened. The Linux docker lane runs all of them,
// the nested-claude refusal mutant included.
const linuxOnly = test.skipIf(process.platform !== "linux");

type AncestryMode = "lead" | "nested" | "no-tmux";

/** Runs `gates/activity-heartbeat.sh` as a hook fired from a REAL,
 *  constructed process tree:
 *   - "lead": the script's nearest claude-named ancestor is a DIRECT child
 *     of the "pane shell" — is_lead_session must pass.
 *   - "nested": one extra non-claude hop sits between the pane shell and the
 *     nearest claude-named ancestor (a nested `claude -p`'s real shape) —
 *     is_lead_session must fail.
 *   - "no-tmux": no tmux at all on PATH — is_lead_session must fail closed. */
function runHeartbeatWithAncestry(opts: {
  payload: unknown;
  activityPath: string;
  studioId?: string;
  rawStdin?: string;
  mode: AncestryMode;
  extraPathDir?: string;
}): { code: number; stdout: string; stderr: string; written: unknown } {
  const workDir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-ancestry-"));
  try {
    const heartbeatPath = join(workDir, "heartbeat.sh");
    writeFileSync(heartbeatPath, ACTIVITY_HEARTBEAT, { mode: 0o755 });
    const panePidFile = join(workDir, "pane.pid");
    const paneScript = join(workDir, "pane_shell.sh");
    const fakeClaude = fakeClaudeBinary();
    const leafHop = claudeHop(fakeClaude, heartbeatPath);
    const topHop = opts.mode === "nested" ? shellHop(leafHop) : leafHop;
    writeFileSync(
      paneScript,
      `#!/usr/bin/env bash\necho "$$" > ${sq(panePidFile)}\n${topHop}\ntrue\n`,
      { mode: 0o755 },
    );
    const pathPrefix = opts.mode === "no-tmux" ? "" : `${tmuxStubDir()}:`;
    const fakeDatePrefix = opts.extraPathDir ? `${opts.extraPathDir}:` : "";
    const stdin = opts.rawStdin ?? JSON.stringify(opts.payload);
    const proc = Bun.spawnSync({
      cmd: ["bash", paneScript],
      stdin: Buffer.from(stdin),
      env: {
        ...process.env,
        PATH: `${fakeDatePrefix}${pathPrefix}${process.env.PATH ?? ""}`,
        FLEET_ACTIVITY_PATH: opts.activityPath,
        STUDIO_ID: opts.studioId ?? "test-studio--role",
        FAKE_TMUX_PANE_PID_FILE: panePidFile,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    let written: unknown;
    try {
      written = JSON.parse(readFileSync(opts.activityPath, "utf8"));
    } catch {
      written = undefined;
    }
    return {
      code: proc.exitCode ?? -1,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
      written,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// Every EXISTING test below models the real lead's own hook firing, so the
// default routes through the "lead" ancestry tree (is_lead_session passes,
// write_state's own body actually runs) — a bare `runSnippet` call, as this
// helper used before the round-2 fix, has NO claude-named ancestor at all
// and would now have every write silently skipped.
function heartbeat(
  payload: unknown,
  opts: {
    activityPath?: string;
    studioId?: string;
    rawStdin?: string;
    mode?: AncestryMode;
    extraPathDir?: string;
  } = {},
): { code: number; stdout: string; stderr: string; written: unknown } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-"));
  try {
    const activityPath = opts.activityPath ?? join(dir, ".fleet", "activity.json");
    return runHeartbeatWithAncestry({
      payload,
      activityPath,
      studioId: opts.studioId,
      rawStdin: opts.rawStdin,
      mode: opts.mode ?? "lead",
      extraPathDir: opts.extraPathDir,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("activity-heartbeat hook — event to state map", () => {
  linuxOnly("UserPromptSubmit writes working", () => {
    const r = heartbeat({ hook_event_name: "UserPromptSubmit" });
    expect(r.code).toBe(0);
    expect(r.written).toMatchObject({ state: "working" });
    // Issue #221 fix round 3, LOW (maestro review, PR #352) — `write_state`
    // now stamps millisecond precision (`%3N`) on GNU `date`, so `at` is
    // `...:SS.mmmZ`, not the old whole-second `...:SSZ`. Issue #370: this
    // test is linuxOnly (GNU date, as in production), so the ms shape is
    // REQUIRED here; the whole-second degrade has its own fake-BSD-date test.
    expect((r.written as { at: string }).at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  // Issue #370 — RED/GREEN against the actual bug: PRE-FIX write_state asked
  // GNU-only `date -u +...%3N...Z` unconditionally, so on a BSD/macOS `date`
  // (no `%N` conversion, and no `gdate` on PATH) it wrote a malformed
  // "...3NZ" string — `Date.parse` reads that as NaN. fakeBsdDateDir()
  // reproduces exactly that observed BSD output shape. This confirms the
  // ACTUAL shipped script degrades to a valid whole-second stamp instead.
  linuxOnly("UserPromptSubmit on a BSD-style date (no %N, no gdate): degrades to a valid whole-second stamp, never a malformed 3N string", () => {
    const r = heartbeat(
      { hook_event_name: "UserPromptSubmit" },
      { extraPathDir: fakeBsdDateDir() },
    );
    expect(r.code).toBe(0);
    expect(r.written).toMatchObject({ state: "working" });
    const at = (r.written as { at: string }).at;
    expect(at).not.toContain("3N");
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Number.isFinite(Date.parse(at))).toBe(true);
  });

  linuxOnly("Stop writes idle", () => {
    const r = heartbeat({ hook_event_name: "Stop" });
    expect(r.code).toBe(0);
    expect(r.written).toMatchObject({ state: "idle" });
  });

  linuxOnly("Notification with notification_type permission_prompt writes waiting-question", () => {
    const r = heartbeat({ hook_event_name: "Notification", notification_type: "permission_prompt" });
    expect(r.code).toBe(0);
    expect(r.written).toMatchObject({ state: "waiting-question" });
  });

  linuxOnly("Notification with notification_type elicitation_dialog writes waiting-question", () => {
    const r = heartbeat({ hook_event_name: "Notification", notification_type: "elicitation_dialog" });
    expect(r.written).toMatchObject({ state: "waiting-question" });
  });

  linuxOnly("Notification with notification_type idle_prompt writes idle", () => {
    const r = heartbeat({ hook_event_name: "Notification", notification_type: "idle_prompt" });
    expect(r.written).toMatchObject({ state: "idle" });
  });

  linuxOnly("Notification with no notification_type but a permission-shaped message falls back to waiting-question", () => {
    const r = heartbeat({ hook_event_name: "Notification", message: "Claude needs your permission to use Bash" });
    expect(r.written).toMatchObject({ state: "waiting-question" });
  });

  linuxOnly("Notification with no notification_type but a 'waiting for your input' message falls back to idle", () => {
    const r = heartbeat({ hook_event_name: "Notification", message: "Claude is waiting for your input" });
    expect(r.written).toMatchObject({ state: "idle" });
  });

  linuxOnly("Notification with an unrecognised type and no matching message text writes nothing, still exit 0", () => {
    const r = heartbeat({ hook_event_name: "Notification", notification_type: "something_else", message: "hi" });
    expect(r.code).toBe(0);
    expect(r.written).toBeUndefined();
  });

  linuxOnly("SessionStart writes NOTHING — a deliberate scope cut, see the script's own header", () => {
    const r = heartbeat({ hook_event_name: "SessionStart", source: "startup" });
    expect(r.code).toBe(0);
    expect(r.written).toBeUndefined();
  });

  linuxOnly("an unrecognised event writes nothing, still exit 0", () => {
    const r = heartbeat({ hook_event_name: "SomeFutureEvent" });
    expect(r.code).toBe(0);
    expect(r.written).toBeUndefined();
  });
});

describe("activity-heartbeat hook — silent, always exit 0 (never blocks a turn)", () => {
  linuxOnly("malformed stdin: exit 0, nothing written, no stderr noise", () => {
    const r = heartbeat(undefined, { rawStdin: "not json" });
    expect(r.code).toBe(0);
    expect(r.written).toBeUndefined();
    expect(r.stderr.trim()).toBe("");
    expect(r.stdout.trim()).toBe("");
  });

  linuxOnly("empty stdin: exit 0, nothing written", () => {
    const r = heartbeat(undefined, { rawStdin: "" });
    expect(r.code).toBe(0);
    expect(r.written).toBeUndefined();
  });

  // MUTANT PROOF (c) — the heartbeat hook must be provably fail-open even
  // when it cannot write its own output file. A blocker FILE (not a
  // directory) sitting where the target's own parent directory would need
  // to be created makes `mkdir -p` fail regardless of the running user's
  // privileges (a plain permission bit is not a reliable proof under a
  // root-run test harness, where root ignores them).
  linuxOnly("MUTANT PROOF (c): an unwritable target path still exits 0, never propagates the write failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-blocked-"));
    try {
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "not a directory");
      const activityPath = join(blocker, "activity.json"); // dirname(activityPath) === blocker, a FILE
      // Routed through the "lead" ancestry tree (not a bare runSnippet) so
      // is_lead_session passes and write_state's real, unwritable-path body
      // actually runs — otherwise this would exit 0 vacuously via the
      // round-2 identity gate instead of the mkdir/write fail-open path
      // this test means to prove.
      const r = runHeartbeatWithAncestry({
        payload: { hook_event_name: "UserPromptSubmit" },
        activityPath,
        mode: "lead",
      });
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Issue #221 fix round 2, item 3 (maestro review, PR #352) — bash reports a
  // redirection OPEN failure (as opposed to the redirected command's own
  // stderr) to whatever stderr is in effect BEFORE that redirection is
  // applied. `> "$tmp" 2>/dev/null` therefore leaks straight to the REAL
  // stderr when `$tmp` itself cannot be opened, regardless of the trailing
  // `2>/dev/null` — confirmed empirically before writing this test. A
  // filename long enough to trip ENAMETOOLONG reproduces the open failure
  // independent of the running user's privileges (root ignores permission
  // bits, but not this) — the SAME reason MUTANT PROOF (c) above uses a
  // blocker FILE instead of a permission bit for its own scenario.
  linuxOnly("MUTANT PROOF (item 3): an unwritable tmp file (name too long) never leaks a redirection error to real stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-longname-"));
    try {
      const longBase = `${"a".repeat(250)}.json`;
      const activityPath = join(dir, longBase);
      const r = runHeartbeatWithAncestry({
        payload: { hook_event_name: "UserPromptSubmit" },
        activityPath,
        mode: "lead",
      });
      expect(r.code).toBe(0);
      expect(r.stderr.trim()).toBe("");
      expect(r.written).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("STUDIO_ID absent: no-op entirely, same guard shape as the existing gates", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-"));
    try {
      const activityPath = join(dir, "activity.json");
      const r = runSnippet({
        script: ACTIVITY_HEARTBEAT,
        stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
        shell: "bash",
        env: { FLEET_ACTIVITY_PATH: activityPath, STUDIO_ID: "" },
      });
      expect(r.code).toBe(0);
      expect(r.stderr.trim()).toBe("");
      expect(() => readFileSync(activityPath, "utf8")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("activity-heartbeat hook — atomic write", () => {
  linuxOnly("no .tmp file is left behind after a successful write", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-"));
    try {
      const activityPath = join(dir, "activity.json");
      runHeartbeatWithAncestry({
        payload: { hook_event_name: "UserPromptSubmit" },
        activityPath,
        mode: "lead",
      });
      const entries = readdirSync(dir);
      expect(entries).toEqual(["activity.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("activity-heartbeat hook — lead-only heartbeat (issue #221 fix round 2, item 2)", () => {
  linuxOnly("MUTANT PROOF (d): a Stop fired from the LEAD's own top-level session overwrites the heartbeat", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-lead-"));
    try {
      const activityPath = join(dir, "activity.json");
      writeFileSync(activityPath, JSON.stringify({ state: "working", at: "2026-09-25T12:00:00Z" }));
      const r = runHeartbeatWithAncestry({
        payload: { hook_event_name: "Stop" },
        activityPath,
        mode: "lead",
      });
      expect(r.code).toBe(0);
      expect(r.written).toMatchObject({ state: "idle" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // THE core fix, proven against a REAL process tree: a nested `claude -p`
  // subprocess (comm="claude", but sitting behind an extra non-claude hop —
  // its real parent is a Bash-tool shell, never the pane) finishing its own
  // sub-task must NOT overwrite the real lead's own "still working" claim.
  // Before this fix, ANY claude-named process sharing STUDIO_ID/HOME could
  // write here — this is exactly the memguard.ts #238 scenario (a nested
  // `claude -p` the lead itself spawns), from the hook script's own side.
  linuxOnly("MUTANT PROOF (d): a Stop fired from a NESTED claude -p subprocess never overwrites the lead's own heartbeat", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-nested-"));
    try {
      const activityPath = join(dir, "activity.json");
      const seeded = { state: "working", at: "2026-09-25T12:00:00Z" };
      writeFileSync(activityPath, JSON.stringify(seeded));
      const r = runHeartbeatWithAncestry({
        payload: { hook_event_name: "Stop" },
        activityPath,
        mode: "nested",
      });
      // Still silent, still exit 0 — this file's own fail-open-on-exit-code
      // header is unchanged; only the WRITE is refused.
      expect(r.code).toBe(0);
      expect(r.stderr.trim()).toBe("");
      expect(r.written).toEqual(seeded); // untouched — the real lead's own claim survives
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  linuxOnly("a nested claude -p is refused even with NOTHING already written — a blanket identity rule, not just overwrite protection", () => {
    // Honest about the shape of the fix: is_lead_session is a blanket
    // refusal, not a "only refuse if it would overwrite something" rule —
    // pinning this the other way (an empty starting file) would be
    // dishonest about what the guard actually does. It refuses this write
    // too; asserted here so a future change narrowing the guard to
    // "only when a write already exists" shows up as a real behavior change.
    const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-nested-empty-"));
    try {
      const activityPath = join(dir, "activity.json");
      const r = runHeartbeatWithAncestry({
        payload: { hook_event_name: "UserPromptSubmit" },
        activityPath,
        mode: "nested",
      });
      expect(r.code).toBe(0);
      expect(r.written).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  linuxOnly("no tmux on PATH at all: fails closed (no write), never crashes, never blocks", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-notmux-"));
    try {
      const activityPath = join(dir, "activity.json");
      const r = runHeartbeatWithAncestry({
        payload: { hook_event_name: "UserPromptSubmit" },
        activityPath,
        mode: "no-tmux",
      });
      expect(r.code).toBe(0);
      expect(r.stderr.trim()).toBe("");
      expect(r.written).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #221 (PR3b), Task 6 — studio-bringup.sh's own settings.json wiring
// for the activity-heartbeat hook. Extracted and RUN (not just string-
// matched) the same way this file's own extractHeredoc/extractShellFunc
// helpers extract and run other self-contained fragments — the block is
// bounded by its own `>>> activity-heartbeat-settings-merge >>>` /
// `<<<` markers (studio-bringup.sh's own established idiom, see the
// tmux-render-options block for the precedent), so this test exercises the
// ACTUAL shipped bytes, not a re-typed copy of them.
// ---------------------------------------------------------------------------
function extractMarkedBlock(src: string, marker: string): string {
  const open = `# >>> ${marker} >>>`;
  const close = `# <<< ${marker} <<<`;
  const openAt = src.indexOf(open);
  if (openAt === -1) throw new Error(`opening marker for ${marker} not found`);
  const bodyStart = src.indexOf("\n", openAt);
  if (bodyStart === -1) throw new Error(`marker ${marker} has no body`);
  const closeAt = src.indexOf(close, bodyStart);
  if (closeAt === -1) throw new Error(`closing marker for ${marker} not found`);
  return src.slice(bodyStart + 1, closeAt);
}

describe("activity-heartbeat hook — studio-bringup.sh settings.json wiring (issue #221, PR3b)", () => {
  const MERGE_BLOCK = extractMarkedBlock(BRINGUP, "activity-heartbeat-settings-merge");

  function runMerge(home: string) {
    return runSnippet({ script: MERGE_BLOCK, shell: "bash", env: { HOME: home } });
  }

  function readSettings(home: string): { hooks?: Record<string, unknown[]> } {
    return JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  }

  test("appends activity-heartbeat.sh to all four hook-event arrays", () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-bringup-home-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      const r = runMerge(home);
      expect(r.code).toBe(0);
      const cfg = readSettings(home);
      for (const evt of ["SessionStart", "UserPromptSubmit", "Stop", "Notification"]) {
        expect(cfg.hooks?.[evt]).toBeDefined();
        expect(JSON.stringify(cfg.hooks?.[evt])).toContain("activity-heartbeat.sh");
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("never replaces session-reemit's own existing SessionStart entry — appends alongside it", () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-bringup-home-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(
        join(home, ".claude", "settings.json"),
        JSON.stringify({
          hooks: { SessionStart: [{ hooks: [{ type: "command", command: "$HOME/.claude/hooks/session-reemit.sh" }] }] },
        }),
      );
      const r = runMerge(home);
      expect(r.code).toBe(0);
      const cfg = readSettings(home);
      const sessionStart = JSON.stringify(cfg.hooks?.SessionStart);
      expect(sessionStart).toContain("session-reemit.sh");
      expect(sessionStart).toContain("activity-heartbeat.sh");
      expect(cfg.hooks?.SessionStart).toHaveLength(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a second run (re-provision) does not accumulate duplicate entries", () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-bringup-home-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      runMerge(home);
      const r2 = runMerge(home);
      expect(r2.code).toBe(0);
      const cfg = readSettings(home);
      for (const evt of ["SessionStart", "UserPromptSubmit", "Stop", "Notification"]) {
        const ownEntries = (cfg.hooks?.[evt] ?? []).filter((e) => JSON.stringify(e).includes("activity-heartbeat.sh"));
        expect(ownEntries).toHaveLength(1);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the installed command is FAIL OPEN — guarded exec, unconditional exit 0, never the fail-closed 'exit 2' shape lead-gate/completion-gate use", () => {
    expect(MERGE_BLOCK).not.toContain("exit 2");
    expect(MERGE_BLOCK).toContain('[ -x \\"$S\\" ] && exec \\"$S\\"; ');
    expect(MERGE_BLOCK).toContain("exit 0");
  });

  test("installed unconditionally — not gated on STUDIO_LEAD_DISALLOWED or STUDIO_COMPLETION_GATE", () => {
    // The block itself must never reference either gating variable — this
    // is what proves it installs for EVERY studio (maestro included), the
    // same "not gated on whether the studio writes code" shape
    // session-reemit's own installation already uses.
    expect(MERGE_BLOCK).not.toContain("STUDIO_LEAD_DISALLOWED");
    expect(MERGE_BLOCK).not.toContain("STUDIO_COMPLETION_GATE");
  });
});

test("activity-heartbeat.sh is copied from the blueprint, single source of truth, same guard/warn posture as the other hooks", () => {
  expect(BRINGUP).toContain("/opt/blueprint/gates/activity-heartbeat.sh");
  expect(BRINGUP).toContain("~/.claude/hooks/activity-heartbeat.sh");
});

test("no PreCompact hook is registered", () => {
  // Compaction is a session-open event. A PreCompact hook fires INSIDE the
  // compaction the lead is already losing context to, and cannot inject.
  //
  // Scoped to the settings-merge block itself (review, Minor): a whole-file
  // `BRINGUP.not.toContain` broke the moment ANY comment anywhere in this
  // 1000+ line script mentioned the word "PreCompact" for context (e.g.
  // explaining why one was not used here) -- a wording change, not a
  // regression in what actually gets registered.
  const settingsBlockStart = BRINGUP.indexOf('pre = cfg.setdefault("hooks", {}).setdefault("PreToolUse", [])');
  expect(settingsBlockStart).toBeGreaterThan(-1);
  const settingsBlockEnd = BRINGUP.indexOf("json.dump(cfg, f, indent=2)", settingsBlockStart);
  expect(settingsBlockEnd).toBeGreaterThan(settingsBlockStart);
  expect(BRINGUP.slice(settingsBlockStart, settingsBlockEnd)).not.toContain("PreCompact");
});

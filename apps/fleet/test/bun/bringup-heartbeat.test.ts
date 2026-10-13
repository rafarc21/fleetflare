import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRINGUP, runSnippet } from "./exec-snippet";

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
  linuxOnly("UserPromptSubmit writes working (#221)", () => {
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
  linuxOnly("UserPromptSubmit on a BSD-style date (no %N, no gdate): degrades to a valid whole-second stamp, never a malformed 3N string (#221)", () => {
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

  linuxOnly("Stop writes idle (#221)", () => {
    const r = heartbeat({ hook_event_name: "Stop" });
    expect(r.code).toBe(0);
    expect(r.written).toMatchObject({ state: "idle" });
  });

  linuxOnly("Notification with notification_type permission_prompt writes waiting-question (#221)", () => {
    const r = heartbeat({ hook_event_name: "Notification", notification_type: "permission_prompt" });
    expect(r.code).toBe(0);
    expect(r.written).toMatchObject({ state: "waiting-question" });
  });

  linuxOnly("Notification with notification_type elicitation_dialog writes waiting-question (#221)", () => {
    const r = heartbeat({ hook_event_name: "Notification", notification_type: "elicitation_dialog" });
    expect(r.written).toMatchObject({ state: "waiting-question" });
  });

  linuxOnly("Notification with notification_type idle_prompt writes idle (#221)", () => {
    const r = heartbeat({ hook_event_name: "Notification", notification_type: "idle_prompt" });
    expect(r.written).toMatchObject({ state: "idle" });
  });

  linuxOnly("Notification with no notification_type but a permission-shaped message falls back to waiting-question (#221)", () => {
    const r = heartbeat({ hook_event_name: "Notification", message: "Claude needs your permission to use Bash" });
    expect(r.written).toMatchObject({ state: "waiting-question" });
  });

  linuxOnly("Notification with no notification_type but a 'waiting for your input' message falls back to idle (#221)", () => {
    const r = heartbeat({ hook_event_name: "Notification", message: "Claude is waiting for your input" });
    expect(r.written).toMatchObject({ state: "idle" });
  });

  linuxOnly("Notification with an unrecognised type and no matching message text writes nothing, still exit 0 (#221)", () => {
    const r = heartbeat({ hook_event_name: "Notification", notification_type: "something_else", message: "hi" });
    expect(r.code).toBe(0);
    expect(r.written).toBeUndefined();
  });

  linuxOnly("SessionStart writes NOTHING — a deliberate scope cut, see the script's own header (#221)", () => {
    const r = heartbeat({ hook_event_name: "SessionStart", source: "startup" });
    expect(r.code).toBe(0);
    expect(r.written).toBeUndefined();
  });

  linuxOnly("an unrecognised event writes nothing, still exit 0 (#221)", () => {
    const r = heartbeat({ hook_event_name: "SomeFutureEvent" });
    expect(r.code).toBe(0);
    expect(r.written).toBeUndefined();
  });
});

describe("activity-heartbeat hook — silent, always exit 0 (never blocks a turn)", () => {
  linuxOnly("malformed stdin: exit 0, nothing written, no stderr noise (#221)", () => {
    const r = heartbeat(undefined, { rawStdin: "not json" });
    expect(r.code).toBe(0);
    expect(r.written).toBeUndefined();
    expect(r.stderr.trim()).toBe("");
    expect(r.stdout.trim()).toBe("");
  });

  linuxOnly("empty stdin: exit 0, nothing written (#221)", () => {
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
  linuxOnly("MUTANT PROOF (c): an unwritable target path still exits 0, never propagates the write failure (#221)", () => {
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
  linuxOnly("MUTANT PROOF (item 3): an unwritable tmp file (name too long) never leaks a redirection error to real stderr (#221)", () => {
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
  linuxOnly("no .tmp file is left behind after a successful write (#221)", () => {
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
  linuxOnly("MUTANT PROOF (d): a Stop fired from the LEAD's own top-level session overwrites the heartbeat (#221)", () => {
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
  linuxOnly("MUTANT PROOF (d): a Stop fired from a NESTED claude -p subprocess never overwrites the lead's own heartbeat (#221)", () => {
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

  linuxOnly("a nested claude -p is refused even with NOTHING already written — a blanket identity rule, not just overwrite protection (#221)", () => {
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

  linuxOnly("no tmux on PATH at all: fails closed (no write), never crashes, never blocks (#221)", () => {
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

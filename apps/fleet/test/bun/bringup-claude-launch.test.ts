import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractShellFunc, runSnippet } from "./exec-snippet";

// Issue #54, measured 2026-09-23 on `acme-os--web-studio` after an image
// rollout replaced its container:
//   - `/root/.claude/projects/-workspace-acme-os/` existed and held ONLY
//     `memory/`. Bring-up's guard tested the DIRECTORY, so it passed
//     `--continue`; claude printed "No conversation found to continue" twice
//     and EXITED, leaving a `running` container with a dead lead.
//   - bring-up `send-keys` the launch line and returned without ever looking
//     at the pane again, so provision reported success over a dead studio.
// Both halves are executed here against the REAL function bodies studio
// containers run, extracted verbatim out of container/studio-bringup.sh.
const BRINGUP = readFileSync(join(import.meta.dir, "../../container/studio-bringup.sh"), "utf8");

const HAS_CONVERSATION = () => extractShellFunc(BRINGUP, "claude_has_conversation");
const PROJECT_DIR = () => extractShellFunc(BRINGUP, "claude_project_dir");
// Issue #67 put the hardened probe (`claude_pane_field`) under
// `claude_pane_command`, so the pair has to be extracted together or the
// liveness functions below call an undefined shell function.
const PANE_FIELD = () => extractShellFunc(BRINGUP, "claude_pane_field");
const PANE_COMMAND = () => `${PANE_FIELD()}\n${extractShellFunc(BRINGUP, "claude_pane_command")}`;
const LAUNCH_LANDED = () => extractShellFunc(BRINGUP, "claude_launch_landed");

const REPO_DIR = "/workspace/acme-os";
// claude stores each conversation under ~/.claude/projects/<cwd with every
// non-alphanumeric character replaced by `-`> (the layout src/studio/burn.ts
// already parses: `.claude/projects/<escaped-cwd>/<session-uuid>.jsonl`).
const SLUG = "-workspace-acme-os";

/** A HOME whose `.claude/projects` tree the caller shapes per test. */
function fakeHome(shape: (projects: string) => void): string {
  const home = mkdtempSync(join(tmpdir(), "fleet-launch-home-"));
  const projects = join(home, ".claude", "projects");
  mkdirSync(projects, { recursive: true });
  shape(projects);
  return home;
}

/** Runs the real guard and prints what the launch argv would carry. */
function continueFlag(home: string): string {
  const r = runSnippet({
    shell: "bash",
    env: { HOME: home },
    script:
      `${PROJECT_DIR()}\n${HAS_CONVERSATION()}\n` +
      `claude_args=()\n` +
      `if claude_has_conversation ${JSON.stringify(REPO_DIR)}; then claude_args+=(--continue); fi\n` +
      `printf '%s\\n' "\${claude_args[@]:-}"\n`,
  });
  expect(r.parentAlive).toBe(true);
  return r.stdout.trim();
}

describe("studio-bringup.sh claude_has_conversation — what counts as a resumable conversation (issue #54)", () => {
  test("a project dir holding ONLY memory/ is not a conversation — no --continue", () => {
    const home = fakeHome((projects) => mkdirSync(join(projects, SLUG, "memory"), { recursive: true }));
    try {
      expect(continueFlag(home)).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a project dir holding a session .jsonl IS a conversation — keeps --continue", () => {
    const home = fakeHome((projects) => {
      mkdirSync(join(projects, SLUG), { recursive: true });
      writeFileSync(join(projects, SLUG, "f0e1d2c3-4b5a-6978-8a9b-0c1d2e3f4a5b.jsonl"), '{"type":"user"}\n');
    });
    try {
      expect(continueFlag(home)).toBe("--continue");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a session .jsonl buried inside memory/ does not count — memory is restored independently of any conversation", () => {
    const home = fakeHome((projects) => {
      mkdirSync(join(projects, SLUG, "memory"), { recursive: true });
      writeFileSync(join(projects, SLUG, "memory", "notes.jsonl"), "{}\n");
    });
    try {
      expect(continueFlag(home)).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a conversation belonging to a DIFFERENT cwd does not count — the guard stays scoped to the launch cwd", () => {
    const home = fakeHome((projects) => {
      mkdirSync(join(projects, "-workspace"), { recursive: true });
      writeFileSync(join(projects, "-workspace", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"), "{}\n");
    });
    try {
      expect(continueFlag(home)).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("no ~/.claude/projects at all is not a conversation", () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-launch-home-"));
    try {
      expect(continueFlag(home)).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// --- the second half: an immediate claude exit must not read as success -----

interface FakeTmux {
  bin: string;
  calls: () => string[];
  cleanup: () => void;
}

/**
 * A `tmux` on PATH that answers `pane_current_command` from a scripted queue
 * (one line per call, last line repeating once exhausted) and records every
 * argv it is handed. Recording is what lets the invisibility rule be
 * asserted rather than assumed: a liveness probe must never select, switch or
 * attach a window — an operator already lost an hour to a probe that left
 * window 1 active and made a healthy studio look dead.
 */
function fakeTmux(responses: string[]): FakeTmux {
  const dir = mkdtempSync(join(tmpdir(), "fleet-fake-tmux-"));
  const queue = join(dir, "queue");
  const log = join(dir, "calls");
  writeFileSync(queue, `${responses.join("\n")}\n`);
  writeFileSync(log, "");
  writeFileSync(
    join(dir, "tmux"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      `resp="$(head -n 1 ${JSON.stringify(queue)})"`,
      `if [ "$(wc -l < ${JSON.stringify(queue)})" -gt 1 ]; then`,
      `  tail -n +2 ${JSON.stringify(queue)} > ${JSON.stringify(`${queue}.tmp`)}`,
      `  mv ${JSON.stringify(`${queue}.tmp`)} ${JSON.stringify(queue)}`,
      "fi",
      // Issue #67 hardened the probe: it asks for
      // `#{session_name}:#{window_name} #{pane_current_command}` and DISCARDS
      // any answer that does not name studio:claude, so a tmux with no such
      // window can no longer answer about a different one. The fake answers
      // in that shape -- a bare command name is now, correctly, no answer at
      // all.
      'printf \'studio:claude %s\\n\' "$resp"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    bin: dir,
    calls: () => readFileSync(log, "utf8").split("\n").filter((l) => l !== ""),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runLaunchLanded(tmux: FakeTmux) {
  return runSnippet({
    shell: "bash",
    env: {
      PATH: `${tmux.bin}:${process.env.PATH ?? ""}`,
      // Both knobs are deliberate test seams, exactly like FLEET_WORKSPACE in
      // the same script: production never sets them, so the defaults in the
      // function body ARE the production values.
      CLAUDE_ALIVE_TRIES: "2",
      CLAUDE_SETTLE_SECONDS: "0",
    },
    script:
      `${PANE_COMMAND()}\n${LAUNCH_LANDED()}\n` +
      `if claude_launch_landed; then echo LANDED; else echo NOT_LANDED; fi\n`,
  });
}

describe("studio-bringup.sh claude_launch_landed — an immediate claude exit is never a successful bring-up (issue #54)", () => {
  test("claude up, and still up after the settle, lands", () => {
    const tmux = fakeTmux(["claude"]);
    try {
      const r = runLaunchLanded(tmux);
      expect(r.stdout).toContain("LANDED");
      expect(r.stderr).toBe("");
    } finally {
      tmux.cleanup();
    }
  });

  test("claude launched and then EXITED within the settle window does not land, and says so", () => {
    const tmux = fakeTmux(["claude", "bash"]);
    try {
      const r = runLaunchLanded(tmux);
      expect(r.stdout).toContain("NOT_LANDED");
      expect(r.stderr).toContain("claude exited");
      expect(r.stderr).toContain("pane runs: bash");
    } finally {
      tmux.cleanup();
    }
  });

  // The cost asymmetry that shapes this: a missed dead lead costs one more
  // provision cycle, a FALSE dead lead costs an operator an hour chasing a
  // healthy studio (this fleet has paid that three times). "bash" is the
  // script's own exact signal for "nothing is running in the pane" — the
  // same one the relaunch decision keys on — so only "bash" may be read as
  // claude having exited. Anything else means some process still owns the
  // pane, e.g. a SessionStart hook or a git subprocess seconds into startup.
  test("a pane running something other than bash after the settle is not a dead lead", () => {
    const tmux = fakeTmux(["claude", "git"]);
    try {
      const r = runLaunchLanded(tmux);
      expect(r.stdout).toContain("LANDED");
      expect(r.stderr).toBe("");
    } finally {
      tmux.cleanup();
    }
  });

  test("claude never coming up at all does not land, and names what the pane runs instead", () => {
    const tmux = fakeTmux(["bash"]);
    try {
      const r = runLaunchLanded(tmux);
      expect(r.stdout).toContain("NOT_LANDED");
      expect(r.stderr).toContain("claude is not running in tmux studio:claude");
      expect(r.stderr).toContain("pane runs: bash");
    } finally {
      tmux.cleanup();
    }
  });

  test("INVISIBLE: addresses the pane by name and never selects, switches or attaches a window", () => {
    const tmux = fakeTmux(["claude", "bash"]);
    try {
      runLaunchLanded(tmux);
      const calls = tmux.calls();
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        // Issue #67: the format now carries the window's own identity so the
        // answer can be checked against it. The INVISIBLE property this test
        // exists for is untouched -- still one read-only display-message,
        // still addressed by name, still no select/switch/attach.
        expect(call).toBe(
          "display-message -p -t studio:claude #{session_name}:#{window_name} #{pane_current_command}",
        );
      }
    } finally {
      tmux.cleanup();
    }
  });
});

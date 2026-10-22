// #1259 round 5 fix 2 — `defaultIsClaudeForeground` (wired as
// `defaultOrcaDeps().isClaudeForeground`), replacing round 4's lsof-based
// implementation entirely. The operator's own measured fix recipe: a tty
// captured at launch (`localLaunchCommand`, fix 1) resolved via
// `ps -o tpgid= -t <tty>` then `ps -o comm= -p <tpgid>` — no lsof directory
// walk, no title, no screen text.
//
// Two lanes:
//  - pure fake-based unit tests for the file-read and fail-closed shape (no
//    tty file, an empty one, a tty with no live process behind it).
//  - ONE real-process test, gated on tmux/ps being on PATH (same convention
//    test/bun/pane-probe-lead-scope.test.ts already uses for its own
//    real-tmux suite) — spawns a genuine tmux pane running a process whose
//    kernel `comm` is literally "claude" (a real FILE named `claude`,
//    symlinked to `bash`, never `exec -a`: MEASURED directly in this sandbox
//    that `exec -a claude <bin>` only renames argv[0], never the kernel's own
//    `comm` field `ps -o comm=` reads — see pane-probe-lead-scope.test.ts's
//    own header for the identical lesson learned the hard way there), writes
//    the pane's own tty to `.fleet/lead.tty` exactly the way
//    `localLaunchCommand` does, then proves `defaultIsClaudeForeground`
//    reads true while the pane is alive and false once it is killed.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultOrcaDeps } from "../../cli/orca-workspace";

function isClaudeForeground(worktreePath: string): Promise<boolean> {
  const fn = defaultOrcaDeps().isClaudeForeground;
  if (!fn) throw new Error("defaultOrcaDeps must always wire isClaudeForeground");
  return fn(worktreePath);
}

describe("defaultIsClaudeForeground — fake-based, no real process needed", () => {
  test("no .fleet/lead.tty file at all reads false (a worktree whose lead predates this capture, or whose `tty` call failed)", async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "fleet-liveness-no-tty-"));
    try {
      expect(await isClaudeForeground(worktreePath)).toBe(false);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  test("an empty lead.tty file (tty itself failed, 2>/dev/null swallowed it) reads false", async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "fleet-liveness-empty-tty-"));
    try {
      mkdirSync(join(worktreePath, ".fleet"), { recursive: true });
      writeFileSync(join(worktreePath, ".fleet", "lead.tty"), "\n");
      expect(await isClaudeForeground(worktreePath)).toBe(false);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  test("a lead.tty file naming a tty that does not exist reads false (ps -t errors, caught, fail closed)", async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "fleet-liveness-bogus-tty-"));
    try {
      mkdirSync(join(worktreePath, ".fleet"), { recursive: true });
      writeFileSync(join(worktreePath, ".fleet", "lead.tty"), "/dev/pts/999999\n");
      expect(await isClaudeForeground(worktreePath)).toBe(false);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });
});

const hasTmux = Bun.which("tmux") !== null;
const hasPs = Bun.which("ps") !== null;
const hasBash = Bun.which("bash") !== null;

describe.skipIf(!hasTmux || !hasPs || !hasBash)(
  "defaultIsClaudeForeground against a real tmux pane + ps (#1259 round 5 mandatory real-process proof)",
  () => {
    test("reads true while a genuinely running claude-named process holds the captured tty's foreground, false once it is killed", async () => {
      const dir = mkdtempSync(join(tmpdir(), "fleet-liveness-real-"));
      const worktreePath = mkdtempSync(join(tmpdir(), "fleet-liveness-real-wt-"));
      const session = "fleet-liveness-real-test";
      try {
        const bin = join(dir, "bin");
        mkdirSync(bin, { recursive: true });
        const bash = Bun.which("bash")!;
        // A real FILE named `claude` — the kernel's `comm` field (what `ps -o
        // comm=` reads) tracks the pathname passed to execve, basename only,
        // never dereferenced through a symlink and never affected by argv[0]
        // renaming. See this file's own header.
        symlinkSync(bash, join(bin, "claude"));
        mkdirSync(join(worktreePath, ".fleet"), { recursive: true });
        const ttyFile = join(worktreePath, ".fleet", "lead.tty");

        const sockDir = join(dir, "sock");
        mkdirSync(sockDir, { recursive: true, mode: 0o700 });
        const sock = join(sockDir, "default");
        // PATH is set on the SPAWNED process's own env (same convention
        // test/bun/pane-probe-lead-scope.test.ts's own `isolatedTmuxEnv`
        // uses), never reassigned inline inside the pane's command string —
        // a single-quoted `PATH='...:$PATH'` inline would never expand
        // `$PATH` at all (single quotes suppress expansion), silently
        // dropping the rest of PATH and breaking even `sleep`.
        const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
        const sh = (cmd: string) => Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, timeout: 15_000, stdout: "pipe", stderr: "pipe" });

        // The pane's own command mirrors `localLaunchCommand`'s own prefix
        // exactly: capture this pane's tty to lead.tty BEFORE the
        // claude-named process starts, then `exec` into it (so the
        // claude-named process stays the pty's own foreground process group
        // leader — no extra fork in between). `-c 'sleep 300 & wait'`
        // backgrounds the actual sleep and waits on it rather than ending in
        // a bare trailing external command, which would let bash tail-call
        // exec-replace itself into `sleep` and lose the `claude` comm —
        // the same fix pane-probe-lead-scope.test.ts's own header documents.
        const res = sh(
          `tmux -S ${sock} new-session -d -s ${session} ` +
          `"tty > '${ttyFile}' 2>/dev/null; exec claude -c 'sleep 300 & wait'"`,
        );
        expect(res.exitCode).toBe(0);

        // Give tmux a moment to fork+exec the pane and for `tty` to have
        // written the file before the first read.
        let tty = "";
        for (let i = 0; i < 40; i++) {
          try {
            tty = readFileSync(ttyFile, "utf8").trim();
          } catch {
            // not written yet
          }
          if (tty !== "") break;
          Bun.sleepSync(100);
        }
        expect(tty).not.toBe("");

        expect(await isClaudeForeground(worktreePath)).toBe(true);

        sh(`tmux -S ${sock} kill-session -t ${session}`);
        Bun.sleepSync(300);

        expect(await isClaudeForeground(worktreePath)).toBe(false);
      } finally {
        Bun.spawnSync({ cmd: ["sh", "-c", `tmux -S ${join(dir, "sock", "default")} kill-session -t ${session} 2>/dev/null || true`] });
        rmSync(dir, { recursive: true, force: true });
        rmSync(worktreePath, { recursive: true, force: true });
      }
    });
  },
);

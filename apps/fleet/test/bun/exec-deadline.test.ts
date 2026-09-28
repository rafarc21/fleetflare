import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withKillDeadline } from "../../src/studio/exec-deadline";
import { credentialWriteCmd, tokenEnv } from "../../src/studio/credentials";
import { spawn } from "node:child_process";
import { requireTools } from "./require-tool";

/**
 * Issue #104: runs the REAL emitted wrapper through a real shell, the way the
 * container's session shell runs it. A string assertion cannot prove that
 * `timeout -k` actually kills a hung child — or that the quoting survives.
 *
 * GNU coreutils `timeout` is in the studio image (Ubuntu) and on CI (Linux).
 * macOS ships none; there the suite skips rather than lie about a pass —
 * unless this IS the pinned localci image (issue #356), where `timeout` is
 * supposed to be guaranteed and a skip would hide a real regression instead.
 */
const LANE = requireTools("timeout", "withKillDeadline's real-shell suite");

/** Runs `cmd` the way the container's session shell does: as a line in a
 *  parent bash that reports `$?`. On the SIGKILL path `timeout` kills its own
 *  process group — itself included — so only a parent shell sees 137. */
function run(cmd: string) {
  const started = Date.now();
  const r = spawnSync("bash", ["-c", `${cmd}\nexit $?`], { encoding: "utf8", timeout: 30_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - started };
}

/** Running, not merely unreaped: a killed child whose parent died is
 *  reparented, and a PID 1 that never reaps (bun, in a bare container)
 *  leaves it a zombie — `kill(pid, 0)` still succeeds on one. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return true;
  }
}

/** Every process's argv, as `ps -eo args` would print it — read straight
 *  from /proc, so it needs no procps in a slim image. */
function processTable(): string {
  const rows: string[] = [];
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      rows.push(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" "));
    } catch {
      // exited between readdir and read
    }
  }
  return rows.join("\n");
}

LANE("withKillDeadline against a real shell", () => {
  test("a command within budget runs untouched, quotes and all", () => {
    const r = run(withKillDeadline(`printf '%s|%s' 'a b' "it's"`, 5_000));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("a b|it's");
  });

  test("a hung command is stopped at its deadline and reports 124", () => {
    const r = run(withKillDeadline("sleep 60", 1_000));
    expect(r.code).toBe(124);
    expect(r.ms).toBeLessThan(5_000);
  });

  test("a command that ignores SIGTERM is SIGKILLed after the grace", () => {
    const r = run(withKillDeadline("trap '' TERM; while :; do sleep 1; done", 1_000));
    expect(r.code).toBe(137);
    expect(r.ms).toBeLessThan(10_000);
  }, 15_000);

  test("the hung command's own children die with it, so the session is free again", () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-deadline-"));
    try {
      const pidFile = join(dir, "child.pid");
      const r = run(withKillDeadline(`sleep 60 & echo $! > ${pidFile}; wait`, 1_000));
      expect(r.code).toBe(124);
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(pid).toBeGreaterThan(0);
      // Give the kernel a beat to reap.
      spawnSync("sleep", ["0.2"]);
      expect(running(pid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a token handed over in env never appears in the process table, even mid-run (#110 review)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-deadline-tok-"));
    const token = "ghs_PSLEAKCANARY0123456789";
    try {
      // The real credential write, rooted in a temp HOME, then held open so
      // `ps` can look while the wrapper is still alive.
      const cmd = credentialWriteCmd().replaceAll("/workspace/", `${dir}/`) + "; sleep 2";
      const child = spawn("bash", ["-c", `${withKillDeadline(cmd, 10_000)}\nexit $?`], {
        env: { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: join(dir, ".gitconfig"), ...tokenEnv(token) },
      });
      await new Promise((r) => setTimeout(r, 800));
      const ps = processTable();
      await new Promise((r) => child.on("exit", r));
      expect(ps).toContain("timeout -k");
      expect(ps).not.toContain(token);
      expect(readFileSync(join(dir, ".git-credentials"), "utf8")).toContain(token);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

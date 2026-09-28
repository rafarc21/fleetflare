import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Issue #267 — localci-daemon.sh: every poll, each open PR whose head sha
 * carries no local-ci/fleet-check status gets one localci.sh run, serially.
 * install/uninstall manage the launchd agent; install --dry-run prints the
 * plist and touches nothing (the maestro approves the real install).
 */
const DAEMON = resolve(import.meta.dir, "../../scripts/localci/localci-daemon.sh");

let root: string;
let calls: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "localci-daemon-"));
  calls = join(root, "calls.log");
  writeFileSync(calls, "");
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "home"));
  // gh: five open PRs, one per status case the daemon distinguishes.
  const gh = join(root, "bin", "gh");
  writeFileSync(
    gh,
    `#!/bin/bash
echo "gh $*" >> "${calls}"
# The daemon asks for "<state> <age-seconds>" of local-ci/fleet-check.
case "$*" in
  "pr list"*) echo '11 aaa'; echo '12 bbb'; echo '13 ccc'; echo '14 ddd'; echo '15 eee' ;;
  *commits/aaa/status*) echo '' ;;
  *commits/bbb/status*) echo 'success 10' ;;
  *commits/ccc/status*) echo 'error 4000' ;;
  *commits/ddd/status*) echo 'error 10' ;;
  *commits/eee/status*) echo 'pending 10' ;;
esac`,
  );
  const fake = join(root, "localci.sh");
  writeFileSync(fake, `#!/bin/bash\necho "localci $*" >> "${calls}"\nexit \${STUB_LOCALCI_EXIT:-0}\n`);
  for (const f of [gh, fake]) chmodSync(f, 0o755);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** pid → ppid for every process: /proc on Linux (the lane image has no ps), ps on macOS. */
function parents(): Map<number, number> {
  const m = new Map<number, number>();
  if (existsSync("/proc/self/stat")) {
    for (const d of readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        m.set(Number(d), Number(readFileSync(`/proc/${d}/stat`, "utf8").split(") ")[1].split(" ")[1]));
      } catch {}
    }
  } else {
    for (const line of Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="]).stdout.toString().split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid) m.set(pid, ppid);
    }
  }
  return m;
}

/** pid and all its descendants. */
function tree(pid: number): number[] {
  const m = parents();
  const out = [pid];
  for (let i = 0; i < out.length; i++) for (const [c, pp] of m) if (pp === out[i]) out.push(c);
  return out;
}

/** Live, non-zombie. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z";
  } catch {
    return !Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim().startsWith("Z");
  }
}

/**
 * #291.3: stop a spawned `run` daemon — bash → lockf → bash. Returns what is
 * still alive of its tree afterwards (must be nothing): killing only the
 * outer pid orphaned the other two, polling forever (5 pairs found live
 * 2026-09-25).
 */
function stop(p: { pid: number; kill(sig?: string | number): void }): number[] {
  const all = tree(p.pid);
  for (const pid of all) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  Bun.sleepSync(300);
  return all.filter(alive);
}

function env(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    TMUX: "",
    HOME: join(root, "home"),
    PATH: `${root}/bin:${process.env.PATH}`,
    LOCALCI_GH_REPO: "o/r",
    LOCALCI_SCRIPT: join(root, "localci.sh"),
    LOCALCI_REPO_DIR: root,
  };
}

function daemon(...args: string[]) {
  const p = Bun.spawnSync(["bash", DAEMON, ...args], { env: env() });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("localci-daemon.sh", () => {
  test("once: runs heads with no status, and an error status older than the backoff; skips the rest", () => {
    expect(daemon("once").code).toBe(0);
    const runs = readFileSync(calls, "utf8").split("\n").filter((l) => l.startsWith("localci"));
    // 11 no status · 13 error 4000s old (> 1800s backoff). Skipped: 12 success,
    // 14 fresh error, 15 pending (a live run, or one the next start sweeps).
    expect(runs).toEqual(["localci 11", "localci 13"]);
  });

  test("run: LOCALCI_POLL has a 30s floor — a typo never hammers the GitHub API", async () => {
    const p = Bun.spawn(["bash", DAEMON, "run"], { env: { ...env(), LOCALCI_POLL: "1" }, stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(3_500);
    expect(stop(p)).toEqual([]);
    const polls = readFileSync(calls, "utf8").split("\n").filter((l) => l.startsWith("gh pr list"));
    expect(polls).toHaveLength(1);
  });

  test("run: a second instance exits at once, the first keeps polling", async () => {
    const first = Bun.spawn(["bash", DAEMON, "run"], { env: env(), stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(1_000);
    const t0 = Date.now();
    const second = Bun.spawnSync(["bash", DAEMON, "run"], { env: env(), timeout: 10_000 });
    expect(stop(first)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(second.exitCode).toBe(0);
    expect(second.stderr.toString() + second.stdout.toString()).toContain("already running");
  });

  test("once --dry-run names what it would run and runs nothing", () => {
    const r = daemon("once", "--dry-run");
    expect(r.out).toContain("would run #11");
    expect(readFileSync(calls, "utf8")).not.toContain("localci 11");
  });

  // #291.2: a second instance exits 0 ("already running"); KeepAlive=true
  // relaunched it every ThrottleInterval forever. Restart only on failure.
  test("plist KeepAlive restarts only a non-zero exit, never a clean 'already running'", () => {
    const r = daemon("install", "--dry-run");
    expect(r.out.replace(/\s+/g, "")).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
  });

  // Found at the first live install, 2026-09-25: node lives only under nvm,
  // launchd's PATH had none, `vitest` (#!/usr/bin/env node) fell back to Bun
  // and every PR got a false red "vitest 0/0 · vitest lane exit 1".
  test("install bakes node's directory into the plist PATH — vitest needs node, not Bun", () => {
    const nodebin = join(root, "nvm", "bin");
    mkdirSync(nodebin, { recursive: true });
    writeFileSync(join(nodebin, "node"), "#!/bin/sh\n");
    chmodSync(join(nodebin, "node"), 0o755);
    const p = Bun.spawnSync(["bash", DAEMON, "install", "--dry-run"], {
      env: { ...env(), PATH: `${nodebin}:${env().PATH}` },
    });
    const path = p.stdout.toString().match(/<key>PATH<\/key><string>([^<]*)</)?.[1] ?? "";
    expect(path.split(":")).toContain(nodebin);
  });

  test("the daemon log records localci.sh's real exit code", () => {
    const p = Bun.spawnSync(["bash", DAEMON, "once"], { env: { ...env(), STUB_LOCALCI_EXIT: "3" } });
    expect(p.stdout.toString()).toContain("done #11 exit=3");
  });

  test("install --dry-run prints a launchd plist pointing at the daemon, and writes nothing", () => {
    const r = daemon("install", "--dry-run");
    expect(r.code).toBe(0);
    expect(r.out).toContain("<key>Label</key>");
    expect(r.out).toContain(DAEMON);
    expect(r.out).toContain("Library/Logs/fleetflare-localci/daemon.log");
    expect(existsSync(join(root, "home", "Library", "LaunchAgents"))).toBe(false);
  });

  test("an unknown verb is a usage error", () => {
    expect(daemon("bogus").code).toBe(2);
  });
});

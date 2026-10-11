// container/memguard.ts — victim selection, memory source and escalation,
// against FIXTURE /proc and cgroup trees (issue #169).
//
// The selection fn tests moved to memguard-guard.test.ts (issue #324) — the
// pure fns are now an internal seam behind createGuard; this file keeps the
// /proc adapters, the log format and the redaction parity.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatLogLine,
  readMemory,
  readProcs,
  redact,
  resolveLeadParentPid,
  trimLog,
  type Proc,
} from "../../container/memguard";
import { redactSecrets } from "../../src/studio/redact";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "memguard-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface FixtureProc {
  pid: number;
  comm: string;
  argv: string[];
  rssMiB: number;
  adj?: number;
  start?: number;
  ppid?: number;
}

/** Write a /proc-shaped tree: <root>/<pid>/{comm,cmdline,status,stat,oom_score_adj}. */
function procTree(procs: FixtureProc[]): string {
  const root = tmp();
  for (const p of procs) {
    const d = join(root, String(p.pid));
    mkdirSync(d);
    writeFileSync(join(d, "comm"), `${p.comm}\n`);
    writeFileSync(join(d, "cmdline"), p.argv.length ? p.argv.join("\0") + "\0" : "");
    writeFileSync(join(d, "status"), `Name:\t${p.comm}\nVmRSS:\t${p.rssMiB * 1024} kB\n`);
    // Field 4 is ppid, field 22 starttime. The comm deliberately may carry
    // spaces and a ')' -- the parser must split on the LAST ')'.
    const fields = ["S", String(p.ppid ?? 1), ...Array(17).fill("0"), String(p.start ?? 1000 + p.pid)];
    writeFileSync(join(d, "stat"), `${p.pid} (${p.comm}) ${fields.join(" ")}\n`);
    writeFileSync(join(d, "oom_score_adj"), `${p.adj ?? 0}\n`);
  }
  // Non-pid entries a real /proc carries; the reader must skip them.
  mkdirSync(join(root, "self"));
  writeFileSync(join(root, "meminfo"), "MemTotal: 1 kB\n");
  return root;
}

describe("readProcs", () => {
  test("parses pid, ppid, comm, argv, rss, adj and starttime; skips non-pid entries and kernel threads", () => {
    const root = procTree([
      { pid: 42, comm: "weird ) name", argv: ["x", "y"], rssMiB: 3, adj: -5, start: 777, ppid: 9 },
      { pid: 43, comm: "kthreadd", argv: [], rssMiB: 0 },
    ]);
    const procs = readProcs(root);
    expect(procs).toHaveLength(1);
    expect(procs[0]).toMatchObject({ pid: 42, ppid: 9, comm: "weird ) name", argv: ["x", "y"], rssKiB: 3 * 1024, adj: -5, start: 777 });
  });

  test("a pid that vanishes mid-scan is skipped, not thrown", () => {
    const root = procTree([{ pid: 44, comm: "a", argv: ["a"], rssMiB: 1 }]);
    mkdirSync(join(root, "45")); // a directory with no files: the process exited
    expect(readProcs(root).map((p) => p.pid)).toEqual([44]);
  });
});

describe("readMemory", () => {
  function meminfo(root: string, totalMiB: number, availMiB: number) {
    writeFileSync(
      join(root, "meminfo"),
      `MemTotal:       ${totalMiB * 1024} kB\nMemFree:          1 kB\nMemAvailable:   ${availMiB * 1024} kB\n`,
    );
  }
  const MiB = 1024 * 1024;
  function cgroup(root: string, maxMiB: number, currentMiB: number, inactiveMiB: number) {
    writeFileSync(join(root, "memory.max"), `${maxMiB * MiB}\n`);
    writeFileSync(join(root, "memory.current"), `${currentMiB * MiB}\n`);
    writeFileSync(join(root, "memory.stat"), `anon ${currentMiB * MiB}\ninactive_file ${inactiveMiB * MiB}\nactive_file 0\n`);
  }

  test("uses /proc/meminfo when the cgroup is unlimited (CF VM: memory.max=max)", () => {
    const proc = tmp();
    const cg = tmp();
    meminfo(proc, 11930, 700);
    writeFileSync(join(cg, "memory.max"), "max\n");
    writeFileSync(join(cg, "memory.current"), "123\n");
    expect(readMemory(proc, cg)).toEqual({ availMiB: 700, totalMiB: 11930, source: "meminfo" });
  });

  test("uses /proc/meminfo when there is no cgroup memory controller file at all", () => {
    const proc = tmp();
    meminfo(proc, 5800, 300);
    expect(readMemory(proc, tmp())).toEqual({ availMiB: 300, totalMiB: 5800, source: "meminfo" });
  });

  test("uses cgroup v2 max - current + inactive_file when limited (docker --memory)", () => {
    const proc = tmp();
    const cg = tmp();
    meminfo(proc, 64000, 60000); // the host's view: plenty free, and wrong for this cgroup
    cgroup(cg, 1024, 1000, 40);
    expect(readMemory(proc, cg)).toEqual({ availMiB: 64, totalMiB: 1024, source: "cgroup" });
  });

  test("limited cgroup inside a starved host: available is the SMALLER of the two", () => {
    const proc = tmp();
    const cg = tmp();
    meminfo(proc, 64000, 20);
    cgroup(cg, 1024, 500, 0);
    expect(readMemory(proc, cg)).toEqual({ availMiB: 20, totalMiB: 1024, source: "cgroup" });
  });
});

describe("formatLogLine", () => {
  const victim: Proc = {
    pid: 700,
    ppid: 200,
    comm: "node",
    argv: ["node", "/w/node_modules/.bin/vite", "build", "x".repeat(300)],
    rssKiB: 2100 * 1024,
    adj: 500,
    start: 1,
  };
  const m = { availMiB: 640, totalMiB: 11930, source: "meminfo" as const };

  test("one line: ISO ts, signal, pid, comm, rss MiB, avail MiB, cmdline head", () => {
    const line = formatLogLine(new Date("2026-09-24T18:45:00Z"), "SIGTERM", victim, m);
    expect(line).toStartWith(
      "2026-09-24T18:45:00.000Z SIGTERM pid=700 comm=node rss_mib=2100 avail_mib=640 total_mib=11930 source=meminfo cmd=node /w/node_modules/.bin/vite build x",
    );
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(400);
  });

  test("the cmd field is redacted: no token body survives", () => {
    const line = formatLogLine(new Date(0), "SIGKILL", {
      ...victim,
      argv: ["tailscale", "up", "--authkey=tskey-auth-kXyZ12CNTRL-abcdefGHIJ2345", "--hostname=x"],
    }, m);
    expect(line).not.toContain("kXyZ12CNTRL");
    expect(line).toContain("«redacted»");
  });
});

describe("redact — the same shapes src/studio/redact.ts covers", () => {
  const SPECIMENS = [
    "git clone https://x-access-token:ghs_AbC123deadbeefZZ@github.com/rafarc21/fleetflare.git failed",
    "remote: Invalid credentials github_pat_11ABCDEFG0aBcDeFgHiJk_lMnOpQrStUvWxYz0123456789",
    "classic token ghp_0123456789abcdefGHIJ and oauth gho_zzzz1111 and user ghu_qqqq2222 and refresh ghr_wwww3333",
    "tailscale up --authkey=tskey-auth-kXyZ12CNTRL-abcdefGHIJ2345 --hostname=acme-os--release-studio",
    "ANTHROPIC error with sk-ant-oat01-AbCd_eF-gHiJkLmNoP0123456789 in the message",
    "spawn auth fsp_0123456789abcdef rejected",
    "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' https://api.github.com",
  ].join("\n");

  test("agrees with redactSecrets, shape for shape", () => {
    expect(redact(SPECIMENS)).toBe(redactSecrets(SPECIMENS));
    expect(redact(SPECIMENS)).not.toBe(SPECIMENS);
  });
});

describe("trimLog", () => {
  test("keeps only the last N lines; a short or missing file is left alone", () => {
    const d = tmp();
    const p = join(d, "memguard.log");
    writeFileSync(p, Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n") + "\n");
    trimLog(p, 4000);
    const lines = readFileSync(p, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(4000);
    expect(lines[0]).toBe("line 1000");
    expect(lines[3999]).toBe("line 4999");
    trimLog(p, 4000);
    expect(readFileSync(p, "utf8").trimEnd().split("\n")).toHaveLength(4000);
    expect(() => trimLog(join(d, "nope.log"), 4000)).not.toThrow();
  });
});

describe("resolveLeadParentPid — #238, tmux display-message for the pane shell's pid", () => {
  test("parses the numeric pid from a successful display-message", () => {
    const run = () => ({ status: 0, stdout: "4242\n" });
    expect(resolveLeadParentPid(run)).toBe(4242);
  });

  test("a non-zero exit (tmux missing, socket/session/window not up yet) resolves null", () => {
    const run = () => ({ status: 1, stdout: "" });
    expect(resolveLeadParentPid(run)).toBeNull();
  });

  test("non-numeric stdout resolves null rather than throwing", () => {
    const run = () => ({ status: 0, stdout: "no server running on socket\n" });
    expect(resolveLeadParentPid(run)).toBeNull();
  });

  test("a run function that throws (spawnSync timeout, ENOENT) resolves null, never throws", () => {
    const run = () => {
      throw new Error("boom");
    };
    expect(() => resolveLeadParentPid(run)).not.toThrow();
    expect(resolveLeadParentPid(run)).toBeNull();
  });

  test("calls tmux with the exact fleet-studio socket and studio:claude pane-pid idiom", () => {
    const seen: { args: string[] | null } = { args: null };
    const run = (args: string[]) => {
      seen.args = args;
      return { status: 0, stdout: "1\n" };
    };
    resolveLeadParentPid(run);
    expect(seen.args).toEqual(["-L", "fleet-studio", "display-message", "-p", "-t", "studio:claude", "#{pane_pid}"]);
  });
});

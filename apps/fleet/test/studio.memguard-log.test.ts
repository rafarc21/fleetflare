// Issue #311 — Worker-side parser for container/memguard.ts's own on-disk
// kill log (`${FLEET_WORKSPACE:-/workspace}/.fleet/memguard.log`, one line
// per kill via memguard.ts's `formatLogLine`). This file does NOT touch
// container/memguard.ts — it reads the ALREADY-SHIPPED log format
// (`memguard-select.test.ts`'s own `formatLogLine` test pins the exact
// shape this regex parses). See docs/superpowers/specs/2026-09-24-row-
// tells-truth-design.md, "PR3 addendum (issue #311)".
import { describe, it, expect } from "vitest";
import { parseMemguardKillLines } from "../src/studio/memguard-log";

describe("parseMemguardKillLines (issue #311)", () => {
  it("parses a real formatLogLine-shaped SIGTERM line", () => {
    const line =
      "2026-09-24T18:45:00.000Z SIGTERM pid=700 comm=node rss_mib=2100 avail_mib=640 total_mib=11930 source=meminfo cmd=node /w/node_modules/.bin/vite build x";
    expect(parseMemguardKillLines(line)).toEqual([
      {
        at: "2026-09-24T18:45:00.000Z",
        signal: "SIGTERM",
        pid: 700,
        comm: "node",
        rssMib: 2100,
        availMib: 640,
        totalMib: 11930,
        source: "meminfo",
        cmd: "node /w/node_modules/.bin/vite build x",
      },
    ]);
  });

  it("parses a SIGKILL/cgroup line", () => {
    const line =
      "2026-09-25T09:12:03.500Z SIGKILL pid=42 comm=vitest rss_mib=612 avail_mib=88 total_mib=11930 source=cgroup cmd=vitest run --pool=threads";
    const [entry] = parseMemguardKillLines(line);
    expect(entry.signal).toBe("SIGKILL");
    expect(entry.source).toBe("cgroup");
    expect(entry.cmd).toBe("vitest run --pool=threads");
  });

  it("parses multiple lines, one entry per kill, in order", () => {
    const text = [
      "2026-09-25T09:00:00.000Z SIGTERM pid=1 comm=a rss_mib=1 avail_mib=1 total_mib=1 source=meminfo cmd=a",
      "2026-09-25T09:00:05.000Z SIGKILL pid=1 comm=a rss_mib=1 avail_mib=1 total_mib=1 source=meminfo cmd=a",
    ].join("\n");
    const entries = parseMemguardKillLines(text);
    expect(entries).toHaveLength(2);
    expect(entries[0].signal).toBe("SIGTERM");
    expect(entries[1].signal).toBe("SIGKILL");
  });

  it("skips NO_VICTIM/START lines and blank lines — never throws on non-kill lines", () => {
    const text = [
      "2026-09-25T09:00:00.000Z START pid=9 term_pct=6 kill_pct=3 grace_ms=5000 settle_ms=1000 recover_mib=64 min_victim_mib=64 interval_ms=500",
      "",
      "2026-09-25T09:00:10.000Z NO_VICTIM avail_mib=50 total_mib=11930 source=cgroup",
      "2026-09-25T09:00:20.000Z SIGTERM pid=2 comm=b rss_mib=2 avail_mib=2 total_mib=2 source=meminfo cmd=b",
    ].join("\n");
    expect(() => parseMemguardKillLines(text)).not.toThrow();
    const entries = parseMemguardKillLines(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].pid).toBe(2);
  });

  it("empty input yields an empty array, never a throw", () => {
    expect(parseMemguardKillLines("")).toEqual([]);
  });

  it("a cmd field already redacted by memguard.ts is passed through verbatim — no re-redaction", () => {
    const line =
      "2026-09-25T09:00:00.000Z SIGKILL pid=3 comm=tailscale rss_mib=3 avail_mib=3 total_mib=3 source=meminfo cmd=tailscale up --authkey=«redacted» --hostname=x";
    const [entry] = parseMemguardKillLines(line);
    expect(entry.cmd).toBe("tailscale up --authkey=«redacted» --hostname=x");
  });
});

// Issue #311 — a pure, Worker-side parser for container/memguard.ts's own
// on-disk kill log (default path `${FLEET_WORKSPACE:-/workspace}/.fleet/
// memguard.log`, issue #169). This file is the ONLY thing #311 adds that
// reads memguard's output; it never writes to the log, and it does not
// touch container/memguard.ts at all — that file's `formatLogLine` already
// writes one line per kill in a fixed, already-shipped, already-tested shape
// (test/bun/memguard-select.test.ts's own `formatLogLine` describe block
// pins the exact text this regex parses):
//
//   <ISO> <SIGTERM|SIGKILL> pid=<n> comm=<name> rss_mib=<n> avail_mib=<n>
//   total_mib=<n> source=<cgroup|meminfo> cmd=<redacted argv, <=200 chars>
//
// `cmd` is already redacted and truncated by memguard.ts's own `redact()`
// before it ever reaches disk — this file passes it through verbatim, never
// re-redacting or re-truncating (see the design addendum, "Ask 1").
//
// See docs/superpowers/specs/2026-09-24-row-tells-truth-design.md, "PR3
// addendum (issue #311)".

export type MemguardSignal = "SIGTERM" | "SIGKILL";
export type MemguardMemorySource = "cgroup" | "meminfo";

export interface MemguardKillLogEntry {
  /** The log line's own ISO timestamp — memguard.ts's own clock, not this
   *  Worker's. Never re-stamped with an observation time here. */
  at: string;
  signal: MemguardSignal;
  pid: number;
  comm: string;
  rssMib: number;
  availMib: number;
  totalMib: number;
  source: MemguardMemorySource;
  /** Already redacted+truncated by memguard.ts's own `redact()`/200-char cut
   *  — verbatim, not reprocessed here. */
  cmd: string;
}

// Anchored start-to-end of a single trimmed line — a NO_VICTIM or START line
// (memguard.ts's own other two log-line shapes) simply does not match this
// shape at all and is silently skipped, the same "not every line is a kill"
// tolerance `trimLog`'s own log format allows for. `cmd=(.*)$` reads
// everything from `cmd=` to the end of the line, since argv can itself
// contain spaces and is always the LAST field memguard.ts ever prints.
const KILL_LINE =
  /^(\S+) (SIGTERM|SIGKILL) pid=(\d+) comm=(\S+) rss_mib=(\d+) avail_mib=(\d+) total_mib=(\d+) source=(cgroup|meminfo) cmd=(.*)$/;

/**
 * Parses zero or more memguard.ts `formatLogLine` lines out of `text` (a raw
 * tail of the log file, one line per kill/NO_VICTIM/START event, `\n`-joined
 * — see transcript.ts's `SECTION_MEMGUARD`, the section this feeds). Lines
 * that are not a kill line (NO_VICTIM, START, a blank line from a trailing
 * newline) are silently skipped, never thrown on — this is read from a live
 * log an operator may be tailing at the exact moment a line is half-written,
 * and MUST degrade to "skip this line" rather than fail the whole ship tick
 * (the same "never throw into the caller's own tick path" rule
 * `parsePaneSection` already follows for its own malformed-input case).
 */
export function parseMemguardKillLines(text: string): MemguardKillLogEntry[] {
  const out: MemguardKillLogEntry[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const m = KILL_LINE.exec(line);
    if (!m) continue;
    out.push({
      at: m[1],
      signal: m[2] as MemguardSignal,
      pid: Number(m[3]),
      comm: m[4],
      rssMib: Number(m[5]),
      availMib: Number(m[6]),
      totalMib: Number(m[7]),
      source: m[8] as MemguardMemorySource,
      cmd: m[9],
    });
  }
  return out;
}

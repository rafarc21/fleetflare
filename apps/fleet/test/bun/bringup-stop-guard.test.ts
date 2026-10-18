import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRINGUP, extractRegion, runSnippet } from "./exec-snippet";

// Issue #1131: an outside writer can leave ~/.claude/settings.json with a
// non-list Stop (an object, a string, null). The settings-merge python then
// does stop[:] on it -> TypeError -> python3 exit 1 -> set -e aborts bring-up,
// settings lost. Each region below must fail OPEN: a non-list Stop is logged,
// reset to [], and the hook registers normally, exit 0. Extracted and RUN
// (not string-matched), same convention as the lead-gate/heartbeat
// settings-merge tests.
//
// Issue #1190: the atomic write used to drop a 0600 settings.json to 0644
// (open(tmp, "w") under umask 022). Each region must keep 0600 in -> 0600 out.

const NON_LIST_STOPS = [
  ["an object", {}],
  ["a string", "not-a-list"],
  ["null", null],
] as const;

function freshHome(settings: unknown, mode?: number): string {
  const home = mkdtempSync(join(tmpdir(), "fleet-stop-guard-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ hooks: { Stop: settings } }),
    mode === undefined ? {} : { mode },
  );
  return home;
}

function readSettings(home: string): { hooks?: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
}

function settingsMode(home: string): number {
  return statSync(join(home, ".claude", "settings.json")).mode & 0o777;
}

describe.each(NON_LIST_STOPS)("a non-list Stop (%s) fails open, not closed", (_label, stopValue) => {
  test("lead-gate region: lead-gate still registers, Stop reset and registered, exit 0", () => {
    const home = freshHome(stopValue);
    try {
      const region = extractRegion(BRINGUP, "lead-gate-settings-merge");
      const res = runSnippet({ script: region, shell: "bash", env: { HOME: home } });
      expect(res.code).toBe(0);
      const cfg = readSettings(home);
      expect(JSON.stringify(cfg.hooks?.PreToolUse)).toContain("lead-gate.sh");
      expect(JSON.stringify(cfg.hooks?.Stop)).toContain("oss-lead-continue.sh");
      expect(res.stderr).toContain("Stop not a list");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("heartbeat region: other events still register, Stop reset and registered, exit 0", () => {
    const home = freshHome(stopValue);
    try {
      const region = extractRegion(BRINGUP, "activity-heartbeat-settings-merge");
      const res = runSnippet({ script: region, shell: "bash", env: { HOME: home } });
      expect(res.code).toBe(0);
      const cfg = readSettings(home);
      for (const evt of ["SessionStart", "UserPromptSubmit", "Notification", "Stop"]) {
        expect(JSON.stringify(cfg.hooks?.[evt])).toContain("activity-heartbeat.sh");
      }
      expect(res.stderr).toContain("Stop not a list");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("completion-gate region: Stop reset and registered, exit 0", () => {
    const home = freshHome(stopValue);
    try {
      const region = extractRegion(BRINGUP, "completion-gate-settings-merge");
      const res = runSnippet({ script: region, shell: "bash", env: { HOME: home } });
      expect(res.code).toBe(0);
      const cfg = readSettings(home);
      expect(JSON.stringify(cfg.hooks?.Stop)).toContain("completion-gate.sh");
      expect(res.stderr).toContain("Stop not a list");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("a non-list Stop logs the old value", () => {
  test("lead-gate region logs the serialized old string Stop", () => {
    const home = freshHome("not-a-list");
    try {
      const region = extractRegion(BRINGUP, "lead-gate-settings-merge");
      const res = runSnippet({ script: region, shell: "bash", env: { HOME: home } });
      expect(res.code).toBe(0);
      expect(res.stderr).toContain('"not-a-list"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("settings.json keeps 0600 through the atomic write (issue #1190)", () => {
  const REGIONS: string[] = [
    "lead-gate-settings-merge",
    "activity-heartbeat-settings-merge",
    "completion-gate-settings-merge",
  ];

  test.each(REGIONS)("%s: 0600 in -> 0600 out", (region) => {
    const home = freshHome([], 0o600);
    try {
      const res = runSnippet({ script: extractRegion(BRINGUP, region), shell: "bash", env: { HOME: home } });
      expect(res.code).toBe(0);
      expect(settingsMode(home)).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
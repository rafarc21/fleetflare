import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRINGUP, extractRegion, runSnippet } from "./exec-snippet";

// Issue #1131: an outside writer can leave ~/.claude/settings.json with a
// non-list Stop (an object, a string, null). The settings-merge python then
// does stop[:] on it -> TypeError -> python3 exit 1 -> set -e aborts bring-up,
// settings lost. Each region below must fail OPEN: a non-list Stop leaves
// settings untouched, exit 0, and the OTHER hooks the region installs still
// land. Extracted and RUN (not string-matched), same convention as the
// lead-gate/heartbeat settings-merge tests.

const NON_LIST_STOPS = [
  ["an object", {}],
  ["a string", "not-a-list"],
  ["null", null],
] as const;

function freshHome(settings: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "fleet-stop-guard-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: settings } }));
  return home;
}

function readSettings(home: string): { hooks?: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
}

describe.each(NON_LIST_STOPS)("a non-list Stop (%s) fails open, not closed", (_label, stopValue) => {
  test("lead-gate region: lead-gate still registers, Stop left untouched, valid JSON, exit 0", () => {
    const home = freshHome(stopValue);
    try {
      const region = extractRegion(BRINGUP, "lead-gate-settings-merge");
      const res = runSnippet({ script: region, shell: "bash", env: { HOME: home } });
      expect(res.code).toBe(0);
      const cfg = readSettings(home);
      expect(JSON.stringify(cfg.hooks?.PreToolUse)).toContain("lead-gate.sh");
      expect(cfg.hooks?.Stop).toEqual(stopValue);
      expect(res.stderr).toContain("Stop not a list");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("heartbeat region: other events still register, Stop left untouched, exit 0", () => {
    const home = freshHome(stopValue);
    try {
      const region = extractRegion(BRINGUP, "activity-heartbeat-settings-merge");
      const res = runSnippet({ script: region, shell: "bash", env: { HOME: home } });
      expect(res.code).toBe(0);
      const cfg = readSettings(home);
      for (const evt of ["SessionStart", "UserPromptSubmit", "Notification"]) {
        expect(JSON.stringify(cfg.hooks?.[evt])).toContain("activity-heartbeat.sh");
      }
      expect(cfg.hooks?.Stop).toEqual(stopValue);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("completion-gate region: Stop left untouched, valid JSON, exit 0", () => {
    const home = freshHome(stopValue);
    try {
      const region = extractRegion(BRINGUP, "completion-gate-settings-merge");
      const res = runSnippet({ script: region, shell: "bash", env: { HOME: home } });
      expect(res.code).toBe(0);
      const cfg = readSettings(home);
      expect(cfg.hooks?.Stop).toEqual(stopValue);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
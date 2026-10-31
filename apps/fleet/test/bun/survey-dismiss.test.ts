import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnippet } from "./exec-snippet";
import { surveyDismissCmd } from "../../src/studio/wake";
import { SURVEY_OVERLAY_PANE, SURVEY_AND_LIMIT_PANE, RECOVERED_IDLE_PANE } from "../fixtures/survey-panes";

// Issue #1391. Real-shell lane, same pattern as test/bun/usage-limit-dismiss.test.ts's
// dismissModalCmd harness: a vitest test cannot ask a shell what surveyDismissCmd's
// own command actually does, and nothing that types into this pane may be trusted on
// reasoned-about behaviour alone. The hard guard — a survey `0` must NEVER be sent
// while a limit/upgrade/spend modal is on screen — is the one rule this lane exists
// to prove against a real `grep -E`.

interface FakeTmux {
  bin: string;
  calls: () => string[];
  cleanup: () => void;
}

function fakeTmux(pane: string): FakeTmux {
  const dir = mkdtempSync(join(tmpdir(), "fleet-fake-tmux-survey-"));
  const log = join(dir, "calls");
  const paneFile = join(dir, "pane");
  writeFileSync(log, "");
  writeFileSync(paneFile, pane);
  writeFileSync(
    join(dir, "tmux"),
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = -L ]; then [ "$3" = has-session ] && exit 1; shift 2; fi',
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      'case "$1" in',
      `  capture-pane) cat ${JSON.stringify(paneFile)} ;;`,
      "esac",
      "exit 0",
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

function runWith(tmux: FakeTmux, script: string) {
  return runSnippet({ shell: "bash", env: { PATH: `${tmux.bin}:${process.env.PATH ?? ""}` }, script });
}

describe("surveyDismissCmd — the dismissal, run for real", () => {
  test("a survey overlay: sends EXACTLY `0` (-l, no Enter), and never Escape or a bare digit", () => {
    const tmux = fakeTmux(SURVEY_OVERLAY_PANE);
    try {
      const r = runWith(tmux, surveyDismissCmd());
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("__FLEET_SURVEY__ dismissed");
      const sendKeys = tmux.calls().filter((c) => c.startsWith("send-keys"));
      expect(sendKeys).toEqual(["send-keys -t studio:claude -l 0"]);
    } finally {
      tmux.cleanup();
    }
  });

  test("a survey AND a V1 limit modal on screen: sends NOTHING, and reports the limit guard", () => {
    const tmux = fakeTmux(SURVEY_AND_LIMIT_PANE);
    try {
      const r = runWith(tmux, surveyDismissCmd());
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("__FLEET_SURVEY__ limit-modal");
      expect(tmux.calls().filter((c) => c.startsWith("send-keys"))).toEqual([]);
    } finally {
      tmux.cleanup();
    }
  });

  test("an idle pane: sends NOTHING, and reports no survey", () => {
    const tmux = fakeTmux(RECOVERED_IDLE_PANE);
    try {
      const r = runWith(tmux, surveyDismissCmd());
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("__FLEET_SURVEY__ no-survey");
      expect(tmux.calls().filter((c) => c.startsWith("send-keys"))).toEqual([]);
    } finally {
      tmux.cleanup();
    }
  });

  test("never selects a window, switches a client or attaches", () => {
    const tmux = fakeTmux(SURVEY_OVERLAY_PANE);
    try {
      runWith(tmux, surveyDismissCmd());
      for (const c of tmux.calls()) {
        for (const forbidden of ["select-window", "select-pane", "switch-client", "attach-session"]) {
          expect(c).not.toContain(forbidden);
        }
      }
    } finally {
      tmux.cleanup();
    }
  });
});
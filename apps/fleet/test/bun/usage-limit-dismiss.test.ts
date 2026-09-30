import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnippet } from "./exec-snippet";
import { dismissModalCmd } from "../../src/studio/failover";
import { V1_STOP_AND_WAIT_PANE, V3_ADD_FUNDS_PANE, RULE_PROMPT } from "../fixtures/rate-limit-panes";

// Issue #109. Real-shell lane, same pattern as
// test/bun/claude-account-switch.test.ts's fakeTmux/session-setup harness for
// accountSwitchCmd: a vitest test cannot ask a shell what dismissModalCmd's
// own command actually does, and this file's own header explains why nothing
// that types into this pane may be trusted on reasoned-about behaviour alone.

interface FakeTmux {
  bin: string;
  calls: () => string[];
  cleanup: () => void;
}

/**
 * A `tmux` on PATH that answers `capture-pane`/`send-keys` and RECORDS every
 * argv it is handed — the same invisibility discipline
 * claude-account-switch.test.ts's own fakeTmux pins: a probe or a dismissal
 * must never select, switch or attach a window.
 */
function fakeTmux(pane: string): FakeTmux {
  const dir = mkdtempSync(join(tmpdir(), "fleet-fake-tmux-dismiss-"));
  const log = join(dir, "calls");
  const paneFile = join(dir, "pane");
  writeFileSync(log, "");
  writeFileSync(paneFile, pane);
  writeFileSync(
    join(dir, "tmux"),
    [
      "#!/usr/bin/env bash",
      // Issue #117: an OLD-image container has no private socket — strip
      // `-L <socket>` so the recorded argv is the subcommand, same as
      // claude-account-switch.test.ts's own fake.
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

/** An idle lead at its input box: no modal anywhere on screen. */
const IDLE_PANE = ["⏺ Done.", "", ...RULE_PROMPT].join("\n");

describe("dismissModalCmd — the dismissal, run for real", () => {
  for (const [name, pane] of [["V1", V1_STOP_AND_WAIT_PANE], ["V3", V3_ADD_FUNDS_PANE]] as const) {
    test(`sends Escape and ONLY Escape when the ${name} select-modal pane is showing`, () => {
      const tmux = fakeTmux(pane);
      try {
        const r = runWith(tmux, dismissModalCmd());
        expect(r.code).toBe(0);
        const sendKeys = tmux.calls().filter((c) => c.startsWith("send-keys"));
        expect(sendKeys).toEqual(["send-keys -t studio:claude Escape"]);
      } finally {
        tmux.cleanup();
      }
    });
  }

  test("sends NOTHING — no send-keys call at all — when the pane shows an idle prompt", () => {
    const tmux = fakeTmux(IDLE_PANE);
    try {
      const r = runWith(tmux, dismissModalCmd());
      expect(r.code).toBe(0);
      expect(tmux.calls().filter((c) => c.startsWith("send-keys"))).toEqual([]);
    } finally {
      tmux.cleanup();
    }
  });

  test("never selects a window, switches a client or attaches", () => {
    const tmux = fakeTmux(V1_STOP_AND_WAIT_PANE);
    try {
      runWith(tmux, dismissModalCmd());
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

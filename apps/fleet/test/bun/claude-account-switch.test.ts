import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnippet } from "./exec-snippet";
import {
  accountSwitchCmd, detectRateLimitModal, paneCaptureCmd, PANE_QUIESCE_SECONDS,
} from "../../src/studio/failover";
import { tokenEnv } from "../../src/studio/credentials";
import { formatTable } from "../../cli/fleet";
import type { StudioStatus } from "../../src/studio/types";
import {
  NOT_DETECTED, NOT_DETECTED_106, V1_STOP_AND_WAIT_PANE, V2_SESSION_LIMIT_RULE_PANE,
  WEEKLY_LIMIT_PANE, MONTHLY_SPEND_WRAPPED_PANE, OUT_OF_CREDITS_PANE,
} from "../fixtures/rate-limit-panes";

// Issue #53. The vitest lane proves what the command STRINGS say; this lane
// runs them, in a real shell, against a fake tmux — the same reason
// test/bun/wake-cmd.test.ts and test/bun/blueprint-credential.test.ts exist
// (a Worker test cannot ask a shell what a command actually does, and two
// earlier fixes in this repo were written against reasoned-about behaviour
// and were both wrong).

const TOKEN_2 = "sk-ant-oat01-" + "b".repeat(40);
const ACCOUNT = { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: TOKEN_2 };

const MODAL_PANE = [
  "⏺ Read(docs/release.md)",
  "  ⎿  Read 42 lines",
  "╭──────────────────────────────────────────────────╮",
  "│ You've hit your org's monthly spend limit        │",
  "│ Run /rate-limit-options to see what you can do.  │",
  "│ ❯ 1. Upgrade your plan                           │",
  "╰──────────────────────────────────────────────────╯",
].join("\n");

interface FakeTmux {
  bin: string;
  calls: () => string[];
  /** What `tmux source-file -` read on stdin (#110 review: the token's route). */
  sourced: () => string;
  sentKeys: () => string;
  cleanup: () => void;
}

/**
 * A `tmux` on PATH that answers the three subcommands this feature uses and
 * RECORDS every argv it is handed. Recording is what lets the fleet's
 * invisibility rule be asserted rather than assumed: a pane probe must never
 * select, switch or attach a window — an operator already lost an hour to a
 * probe that left a window active and made a healthy studio look dead.
 *
 * `sleep` is faked in the same directory so the two-observation probe's real
 * PANE_QUIESCE_SECONDS gap costs the test nothing, and so the gap itself can
 * be asserted on.
 */
function fakeTmux(pane: string): FakeTmux {
  const dir = mkdtempSync(join(tmpdir(), "fleet-fake-tmux-"));
  const log = join(dir, "calls");
  const paneFile = join(dir, "pane");
  const sent = join(dir, "sent-keys");
  const sourced = join(dir, "sourced");
  writeFileSync(sourced, "");
  writeFileSync(log, "");
  writeFileSync(sent, "");
  writeFileSync(paneFile, pane);
  writeFileSync(
    join(dir, "tmux"),
    [
      "#!/usr/bin/env bash",
      // Issue #117: an OLD-image container — no private `fleet-studio` socket,
      // so the builder's probe fails and every call lands on this default
      // server. Strip `-L <socket>` so the recorded argv is the subcommand.
      'if [ "$1" = -L ]; then [ "$3" = has-session ] && exit 1; shift 2; fi',
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      'case "$1" in',
      `  capture-pane) cat ${JSON.stringify(paneFile)} ;;`,
      "  display-message) printf '%s\\n' bash ;;",
      `  show-environment) printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\\n' ${JSON.stringify(TOKEN_2)} ;;`,
      // `tmux send-keys -t studio:claude -- <line> Enter`: $5 is the line.
      `  send-keys) printf '%s\\n' "$5" >> ${JSON.stringify(sent)} ;;`,
      `  source-file) cat >> ${JSON.stringify(sourced)} ;;`,
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "sleep"),
    ["#!/usr/bin/env bash", `printf 'sleep %s\\n' "$1" >> ${JSON.stringify(log)}`, "exit 0", ""].join("\n"),
    { mode: 0o755 },
  );
  return {
    bin: dir,
    calls: () => readFileSync(log, "utf8").split("\n").filter((l) => l !== ""),
    sentKeys: () => readFileSync(sent, "utf8"),
    sourced: () => readFileSync(sourced, "utf8"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runWith(tmux: FakeTmux, script: string, env: Record<string, string> = {}) {
  return runSnippet({
    shell: "bash",
    env: { PATH: `${tmux.bin}:${process.env.PATH ?? ""}`, ...env },
    script,
  });
}

describe("paneCaptureCmd — the probe, run for real", () => {
  test("its output is exactly what detectRateLimitModal parses a modal out of", () => {
    const tmux = fakeTmux(MODAL_PANE);
    try {
      const r = runWith(tmux, paneCaptureCmd());
      expect(r.code).toBe(0);
      const verdict = detectRateLimitModal(r.stdout);
      expect(verdict.kind).toBe("modal");
    } finally {
      tmux.cleanup();
    }
  });

  test("takes two observations PANE_QUIESCE_SECONDS apart and touches nothing else", () => {
    const tmux = fakeTmux(MODAL_PANE);
    try {
      runWith(tmux, paneCaptureCmd());
      const calls = tmux.calls();
      expect(calls.filter((c) => c.startsWith("capture-pane"))).toEqual([
        "capture-pane -p -t studio:claude", "capture-pane -p -t studio:claude",
      ]);
      expect(calls).toContain(`sleep ${PANE_QUIESCE_SECONDS}`);
      for (const c of calls) {
        for (const forbidden of ["select-window", "select-pane", "switch-client", "attach-session", "kill-"]) {
          expect(c).not.toContain(forbidden);
        }
      }
    } finally {
      tmux.cleanup();
    }
  });

  // Issue #101: the two real 2026-09-24 panes, through the real probe. V1 is
  // the verbatim capture with no headline; V2 has no option list.
  for (const [name, pane] of [["V1", V1_STOP_AND_WAIT_PANE], ["V2", V2_SESSION_LIMIT_RULE_PANE]] as const) {
    test(`the ${name} session-limit pane seen in production parses as a modal`, () => {
      const tmux = fakeTmux(pane);
      try {
        expect(detectRateLimitModal(runWith(tmux, paneCaptureCmd()).stdout).kind).toBe("modal");
      } finally {
        tmux.cleanup();
      }
    });
  }

  // PR #102 review: an idle lead whose own output quotes the V2 block, through
  // the real probe, is a lead at its prompt — not an exhausted account.
  test("an idle lead quoting the session-limit lines parses as working", () => {
    const tmux = fakeTmux(NOT_DETECTED["(b) V2's two lines quoted in a report"]);
    try {
      expect(detectRateLimitModal(runWith(tmux, paneCaptureCmd()).stdout).kind).toBe("working");
    } finally {
      tmux.cleanup();
    }
  });

  // Issue #106: the added wordings through the real probe, live before their
  // reset, and the quoted-copy negatives staying idle.
  const BEFORE_RESETS = new Date("2026-09-09T09:49:00Z");
  for (const [name, pane] of [
    ["weekly", WEEKLY_LIMIT_PANE], ["wrapped monthly spend", MONTHLY_SPEND_WRAPPED_PANE],
    ["out of credits", OUT_OF_CREDITS_PANE],
  ] as const) {
    test(`the ${name} limit block parses as a modal`, () => {
      const tmux = fakeTmux(pane);
      try {
        expect(detectRateLimitModal(runWith(tmux, paneCaptureCmd()).stdout, BEFORE_RESETS).kind).toBe("modal");
      } finally {
        tmux.cleanup();
      }
    });
  }

  for (const [name, pane] of Object.entries(NOT_DETECTED_106)) {
    test(`an idle lead, ${name}, parses as working`, () => {
      const tmux = fakeTmux(pane);
      try {
        expect(detectRateLimitModal(runWith(tmux, paneCaptureCmd()).stdout, BEFORE_RESETS).kind).toBe("working");
      } finally {
        tmux.cleanup();
      }
    });
  }

  test("a pane that is not a modal parses as working, not as a probe failure", () => {
    const tmux = fakeTmux("⏺ Waiting on 3 subagents.\n│ > ");
    try {
      expect(detectRateLimitModal(runWith(tmux, paneCaptureCmd()).stdout).kind).toBe("working");
    } finally {
      tmux.cleanup();
    }
  });
});

describe("accountSwitchCmd — the switch, run for real", () => {
  test("sets the session environment, kills the pane's process, and types one line", () => {
    const tmux = fakeTmux(MODAL_PANE);
    try {
      const r = runWith(tmux, accountSwitchCmd(), tokenEnv(ACCOUNT.token));
      expect(r.code).toBe(0);
      expect(r.parentAlive).toBe(true);
      const calls = tmux.calls();
      // #110 review: the token reaches tmux on stdin, never in any argv.
      expect(tmux.sourced()).toBe(`set-environment -t studio CLAUDE_CODE_OAUTH_TOKEN '${TOKEN_2}'\n`);
      expect(calls).toContain("source-file -");
      for (const c of calls) expect(c).not.toContain(TOKEN_2);
      expect(calls).toContain("respawn-pane -k -t studio:claude");
      // #90: C-c clears readline, then the one adopt line.
      const sendKeys = calls.filter((c) => c.startsWith("send-keys"));
      expect(sendKeys).toHaveLength(2);
      expect(sendKeys[0]).toBe("send-keys -t studio:claude C-c");
      expect(calls.indexOf(sendKeys[0])).toBeGreaterThan(calls.indexOf("respawn-pane -k -t studio:claude"));
    } finally {
      tmux.cleanup();
    }
  });

  test("the token is NEVER typed into the pane — the pane reads it back out of tmux", () => {
    const tmux = fakeTmux(MODAL_PANE);
    try {
      runWith(tmux, accountSwitchCmd(), tokenEnv(ACCOUNT.token));
      // Everything typed into this window is echoed in the pane, mirrored by
      // bring-up's pipe-pane into /workspace/.transcript/claude.log and
      // shipped to R2 — a token in that text would be in an archive forever.
      expect(tmux.sentKeys()).not.toContain(TOKEN_2);
      expect(tmux.sentKeys()).toContain("show-environment");
    } finally {
      tmux.cleanup();
    }
  });

  test("the line it types really does put the new token in the shell's own environment", () => {
    const tmux = fakeTmux(MODAL_PANE);
    try {
      runWith(tmux, accountSwitchCmd(), tokenEnv(ACCOUNT.token));
      const adopt = tmux.sentKeys().trim();
      // Exactly what the pane's bash will execute, executed.
      const r = runWith(tmux, `${adopt}\nprintf '%s\\n' "$CLAUDE_CODE_OAUTH_TOKEN"\n`);
      expect(r.stdout).toContain(TOKEN_2);
    } finally {
      tmux.cleanup();
    }
  });

  test("never answers the modal and never makes a window active", () => {
    const tmux = fakeTmux(MODAL_PANE);
    try {
      runWith(tmux, accountSwitchCmd(), tokenEnv(ACCOUNT.token));
      for (const c of tmux.calls()) {
        for (const forbidden of ["select-window", "select-pane", "switch-client", "attach-session"]) {
          expect(c).not.toContain(forbidden);
        }
      }
      // The ONLY keys sent are C-c (#90, after the respawn, into a bash) and
      // the adopt line plus Enter — no option number, no arrow key. The
      // highlighted modal option sits one line from "Upgrade your plan", and
      // a wrong Enter costs money.
      const sendKeys = tmux.calls().filter((c) => c.startsWith("send-keys"));
      expect(sendKeys).toHaveLength(2);
      expect(sendKeys[0]).toBe("send-keys -t studio:claude C-c");
      expect(sendKeys[1].endsWith(" Enter")).toBe(true);
      for (const k of sendKeys) {
        expect(k).not.toContain(" Up");
        expect(k).not.toContain(" Down");
      }
    } finally {
      tmux.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// The operator's own view: `fleet ls`.
// ---------------------------------------------------------------------------
function row(overrides: Partial<StudioStatus>): StudioStatus {
  return {
    id: "fleetflare--release-studio", state: "running", tailscaleHost: null, lastRefresh: null,
    error: null, lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null,
    repoSlug: null, ...overrides,
  };
}

describe("fleet ls — which account a studio is on", () => {
  test("shows an ACCOUNT column naming the account, so a switch is visible", () => {
    const out = formatTable([row({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" })]);
    expect(out).toContain("ACCOUNT");
    expect(out).toContain("CLAUDE_CODE_OAUTH_TOKEN_2");
  });

  test("a studio that never switched reads as the first account, never as blank", () => {
    expect(formatTable([row({})])).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("never prints a token", () => {
    const out = formatTable([row({ claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_2" })]);
    expect(out).not.toContain("sk-ant-");
  });
});

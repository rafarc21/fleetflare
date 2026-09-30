import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnippet } from "./exec-snippet";
import { wakeCmd } from "../../src/studio/wake";
import { accountSwitchCmd } from "../../src/studio/failover";
import { tokenEnv } from "../../src/studio/credentials";
import {
  RULE_PROMPT, V1_STOP_AND_WAIT_PANE, ORG_SPEND_LIMIT_PANE,
} from "../fixtures/rate-limit-panes";
import { REAL_PERMISSION_PROMPT_TAIL_PANE, REAL_PERMISSION_PROMPT_UNKNOWN_FOOTER_PANE } from "../fixtures/activity-panes";

// Issue #136. Gate 3 was check-then-act: the Worker read the screen, then a
// SEPARATE exec typed text, slept 1s and pressed Enter. A modal drawn in
// between (a second wake's Enter raising it, on an exhausted account) got the
// Enter — on the #53 org modal that selects "❯ 1. Upgrade your plan". This
// lane runs the REAL emitted wake command in a real shell against a fake tmux
// whose pane can change the moment text is typed.

const IDLE = RULE_PROMPT.join("\n");

interface FakeTmux {
  bin: string;
  calls: () => string[];
  cleanup: () => void;
}

/**
 * A `tmux` on PATH. `capture-pane` prints the pane file; `send-keys -l`
 * (the typed text) swaps in `afterType` when given — the modal appearing
 * between the check and the Enter. `display-message` answers `paneCmd`.
 *
 * Issue #249 round-2 item 3: with `echo`, the fake now also models the SUBMIT.
 * It used to draw the typed text back as `❯ <text>` and then leave it there
 * forever, so the pane after Enter was indistinguishable from a prompt that
 * never submitted — which is precisely the state `wakeCmd`'s new submit
 * confirmation reports as `unconfirmed`. `send-keys … Enter` therefore restores
 * the pane as it was before the type, exactly as claude clears its composer on a
 * real submit. The `-l` case is matched FIRST, so a prompt containing the word
 * `Enter` is still typed as text and never mistaken for the submit.
 */
function fakeTmux(
  pane: string,
  opts: {
    afterType?: string; paneCmd?: string; captureFails?: boolean; echo?: boolean; grepExit?: number;
    /** Issue #249 item 3: the Enter is DELIVERED but the TUI does not take
     *  it as a submit, so the draft stays in the composer — exactly the state
     *  `send-keys` exiting 0 used to be reported as `sent`. */
    submitFails?: boolean;
  } = {},
): FakeTmux {
  const dir = mkdtempSync(join(tmpdir(), "fleet-wake-guard-"));
  const log = join(dir, "calls");
  const paneFile = join(dir, "pane");
  const afterFile = join(dir, "after");
  /** Issue #249 item 3: the pane as it was BEFORE the type, restored on Enter. */
  const beforeTypeFile = join(dir, "before-type");
  writeFileSync(log, "");
  writeFileSync(paneFile, pane);
  if (opts.afterType !== undefined) writeFileSync(afterFile, opts.afterType);
  writeFileSync(
    join(dir, "tmux"),
    [
      "#!/usr/bin/env bash",
      // #117: the Worker reaches tmux through __ff_tmux, which probes
      // `-L fleet-studio has-session` then calls `tmux -L fleet-studio …`.
      // Answer the probe, then strip the socket so one fake serves both.
      'if [ "$1" = -L ]; then shift 2; fi',
      '[ "$1" = has-session ] && exit 0',
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      'case "$1" in',
      opts.captureFails
        ? "  capture-pane) echo \"can't find window: claude\" >&2; exit 1 ;;"
        : `  capture-pane) cat ${JSON.stringify(paneFile)} ;;`,
      `  display-message) printf '%s\\n' ${JSON.stringify(opts.paneCmd ?? "bash")} ;;`,
      `  send-keys) case " $* " in *" -l "*) [ -f ${JSON.stringify(afterFile)} ] && cp ${JSON.stringify(afterFile)} ${JSON.stringify(paneFile)};` +
        (opts.echo
          ? ` cp ${JSON.stringify(paneFile)} ${JSON.stringify(beforeTypeFile)}; printf '❯ %s\\n' "$6" >> ${JSON.stringify(paneFile)};`
          : "") + " ;;",
      // Issue #249 item 3: the Enter SUBMITS — the composer clears, exactly as
      // claude's does. Without this the fake could only ever express "the draft
      // is still sitting there".
      opts.echo && !opts.submitFails
        ? `    *" Enter "*) [ -f ${JSON.stringify(beforeTypeFile)} ] && cp ${JSON.stringify(beforeTypeFile)} ${JSON.stringify(paneFile)} ;;`
        : "",
      "  esac ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(join(dir, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  // A grep that errors (exit 2) — the scan must read that as UNREADABLE.
  if (opts.grepExit !== undefined) {
    writeFileSync(join(dir, "grep"), `#!/usr/bin/env bash\ncat >/dev/null\nexit ${opts.grepExit}\n`, { mode: 0o755 });
  }
  writeFileSync(join(dir, "seq"), "#!/usr/bin/env bash\nfor i in 1 2 3; do echo $i; done\n", { mode: 0o755 });
  return {
    bin: dir,
    calls: () => readFileSync(log, "utf8").split("\n").filter((l) => l !== ""),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function run(tmux: FakeTmux, script: string, env: Record<string, string> = {}) {
  // Sourced: sbExec runs in a long-lived session shell, so the command must
  // never `exit` it.
  // LC_ALL=C (#141 review): the container's session shell may run in the C
  // locale, where `│?` binds `?` to the last BYTE of `│`. The patterns must
  // hold there.
  return runSnippet({
    shell: "bash", sourced: true,
    env: { PATH: `${tmux.bin}:${process.env.PATH ?? ""}`, LC_ALL: "C", ...env }, script,
  });
}

const enters = (calls: string[]) => calls.filter((c) => c.startsWith("send-keys") && c.endsWith(" Enter"));
const typed = (calls: string[]) => calls.filter((c) => c.startsWith("send-keys") && c.includes(" -l "));

describe("wakeCmd — the guard runs INSIDE the one exec (#136)", () => {
  test("an idle pane: types, then submits", () => {
    const t = fakeTmux(IDLE);
    try {
      const r = run(t, wakeCmd("WAKE sweep 3"));
      expect(r.parentAlive).toBe(true);
      expect(typed(t.calls())).toHaveLength(1);
      expect(enters(t.calls())).toHaveLength(1);
      expect(r.stdout).toContain("__FLEET_WAKE__ sent");
    } finally { t.cleanup(); }
  });

  for (const [name, modal] of [["V1", V1_STOP_AND_WAIT_PANE], ["#53 org", ORG_SPEND_LIMIT_PANE]] as const) {
    test(`a ${name} modal drawn AFTER the check, before the Enter: no Enter`, () => {
      const t = fakeTmux(IDLE, { afterType: modal });
      try {
        const r = run(t, wakeCmd("WAKE TASK ASSIGNED #2"));
        expect(r.parentAlive).toBe(true);
        expect(typed(t.calls())).toHaveLength(1);
        expect(enters(t.calls())).toEqual([]);
        expect(t.calls().filter((c) => c.startsWith("send-keys") && !c.includes(" -l "))).toEqual([]);
        expect(r.stdout).toContain("__FLEET_WAKE__ refused-after modal");
      } finally { t.cleanup(); }
    });
  }

  const UNSEEN: [string, string][] = [
    ["status row under the modal footer", `${V1_STOP_AND_WAIT_PANE}\n  ⏵⏵ bypass permissions on · 1 background task`],
    ["boxed V1", [
      "╭──────────────────────────────────────────────╮",
      "│ What do you want to do?                      │",
      "│ ❯ 1. Stop and wait for limit to reset        │",
      "│   2. Upgrade your plan                       │",
      "│ Enter to confirm · Esc to cancel             │",
      "╰──────────────────────────────────────────────╯",
    ].join("\n")],
    // #144: an ordinary permission prompt ("Do you want to proceed? / ❯ 1.
    // Yes / 2. No") draws a DIFFERENT footer than the limit modal's own — the
    // real emitted shell command's `grep -E` must refuse on it too, not just
    // the pure-JS scan (studio.wake-race.test.ts).
    ["permission prompt (not the limit modal's footer)", REAL_PERMISSION_PROMPT_TAIL_PANE],
    // #146: a footer #144 has never seen — the in-container `grep -E` guard
    // must refuse on the modal's OPENER (the ▔ rule, "Do you want to
    // proceed?") alone, independent of the footer's exact wording.
    ["permission prompt with an unknown/reworded footer (#146)", REAL_PERMISSION_PROMPT_UNKNOWN_FOOTER_PANE],
  ];
  for (const [name, pane] of UNSEEN) {
    test(`an unseen modal shape (${name}) on screen: nothing typed at all`, () => {
      const t = fakeTmux(pane);
      try {
        const r = run(t, wakeCmd("WAKE"));
        expect(t.calls().filter((c) => c.startsWith("send-keys"))).toEqual([]);
        expect(r.stdout).toContain("__FLEET_WAKE__ refused-before modal");
      } finally { t.cleanup(); }
    });
  }

  test("an unreadable pane: nothing typed, and the exec fails", () => {
    const t = fakeTmux(IDLE, { captureFails: true });
    try {
      const r = run(t, wakeCmd("WAKE"));
      expect(r.parentAlive).toBe(true);
      expect(t.calls().filter((c) => c.startsWith("send-keys"))).toEqual([]);
      expect(r.code).not.toBe(0);
    } finally { t.cleanup(); }
  });
});

describe("accountSwitchCmd — a pane that never returns to bash (#136 B)", () => {
  test("the wait timing out FAILS the chain: the adopt line is never typed", () => {
    const t = fakeTmux(IDLE, { paneCmd: "claude" });
    try {
      const r = run(t, accountSwitchCmd(), tokenEnv("sk-ant-oat01-" + "b".repeat(40)));
      expect(r.parentAlive).toBe(true);
      expect(r.code).not.toBe(0);
      expect(t.calls().filter((c) => c.startsWith("send-keys"))).toEqual([]);
    } finally { t.cleanup(); }
  });
});

// --- #141 review: anchor on modal ROWS, fail closed -------------------------

describe("wakeCmd — the loose scan anchors on modal ROWS (#141 review)", () => {
  for (const ghost of ["❯ What do you want to do next?", "❯ 1. Upgrade deps"]) {
    test(`an idle composer showing ghost text ${JSON.stringify(ghost)}: the wake lands`, () => {
      const t = fakeTmux([...RULE_PROMPT.slice(0, 1), ghost, ...RULE_PROMPT.slice(2)].join("\n"));
      try {
        const r = run(t, wakeCmd("WAKE"));
        expect(r.stdout).toContain("__FLEET_WAKE__ sent");
        expect(enters(t.calls())).toHaveLength(1);
      } finally { t.cleanup(); }
    });
  }

  test("an echoing composer and a prompt quoting '2. Upgrade your plan': Enter sent, and the next wake lands too", () => {
    const t = fakeTmux(IDLE, { echo: true });
    try {
      const first = run(t, wakeCmd("WAKE TASK #2 \"retry: 2. Upgrade your plan\""));
      expect(first.stdout).toContain("__FLEET_WAKE__ sent");
      const second = run(t, wakeCmd("WAKE sweep 3"));
      expect(second.stdout).toContain("__FLEET_WAKE__ sent");
      expect(enters(t.calls())).toHaveLength(2);
    } finally { t.cleanup(); }
  });

  // Issue #249 round-2 item 3, in the ONE lane that runs the real emitted shell
  // against a pane that can lie: the Enter is delivered, `send-keys` exits 0,
  // and the composer still holds the prompt. Before this review item that was
  // `__FLEET_WAKE__ sent`, and every caller wrote its at-most-once dedup marker
  // on it.
  test("an Enter the TUI does not accept: ONE retry Enter, then `unconfirmed`, never `sent`", () => {
    const t = fakeTmux(IDLE, { echo: true, submitFails: true });
    try {
      const r = run(t, wakeCmd("WAKE TASK ASSIGNED #249"));
      expect(r.stdout).not.toContain("__FLEET_WAKE__ sent");
      expect(r.stdout).toContain("__FLEET_WAKE__ unconfirmed still-drafted");
      // Exactly TWO: the submit, and the one bare retry. Never a loop.
      expect(enters(t.calls())).toHaveLength(2);
      expect(typed(t.calls())).toHaveLength(1);
    } finally { t.cleanup(); }
  });

  test("a submit the TUI DOES accept still reports `sent`, with no second Enter", () => {
    // The counterpart, so the pin above cannot be satisfied by a check that
    // simply never confirms anything.
    const t = fakeTmux(IDLE, { echo: true });
    try {
      const r = run(t, wakeCmd("WAKE TASK ASSIGNED #249"));
      expect(r.stdout).toContain("__FLEET_WAKE__ sent");
      expect(enters(t.calls())).toHaveLength(1);
    } finally { t.cleanup(); }
  });

  test("a grep that errors (exit 2) over a V1 pane: unreadable, nothing typed", () => {
    const t = fakeTmux(V1_STOP_AND_WAIT_PANE, { grepExit: 2 });
    try {
      const r = run(t, wakeCmd("WAKE"));
      expect(t.calls().filter((c) => c.startsWith("send-keys"))).toEqual([]);
      expect(r.code).not.toBe(0);
    } finally { t.cleanup(); }
  });

  test("V1 with its cursor at column 0: refused, nothing typed", () => {
    const pane = V1_STOP_AND_WAIT_PANE.replace("   ❯ 1. Stop and wait for limit to reset", "❯ 1. Stop and wait for limit to reset");
    expect(pane).not.toBe(V1_STOP_AND_WAIT_PANE);
    const t = fakeTmux(pane);
    try {
      const r = run(t, wakeCmd("WAKE"));
      expect(t.calls().filter((c) => c.startsWith("send-keys"))).toEqual([]);
      expect(r.stdout).toContain("__FLEET_WAKE__ refused-before modal");
    } finally { t.cleanup(); }
  });
});

// --- PR #144: the ERE anchors are load-bearing in the C locale too ----------
//
// Mutants N1 (ROW_LEAD = ROW_TAIL = "") and N8 (a cursor accepted without a
// border) left every test green. The Worker half is pinned in
// test/studio.wake-race.test.ts; this is the SAME row set through the real
// `grep -E` the container runs, which is the side that actually decides
// whether keystrokes happen.

describe("wakeCmd — the loose scan's row anchors hold under grep -E (#144)", () => {
  const composer = (row: string) => [...RULE_PROMPT.slice(0, 1), row, ...RULE_PROMPT.slice(2)].join("\n");

  // N1: the phrase is real, but MID-row. The echoing composer draws the wake's
  // OWN text back as `❯ <text>`, so scan 2 (after typing, before Enter) reads
  // it — under N1 the Enter is withheld and the wake never lands.
  const MID_ROW: [string, string][] = [
    ["the footer phrase", "WAKE #77 retry — pane said Enter to confirm · Esc to cancel"],
    ["/rate-limit-options", "WAKE: see /rate-limit-options for what the account can still do"],
    ["a #53 headline", "WAKE: yesterday You've hit your usage limit was on screen; it is gone now"],
    ["the permission-prompt footer (#144)",
      "WAKE #144 retry — pane said Esc to cancel · Tab to amend · ctrl+e to explain, so nothing was typed"],
    ["the ▔ rule (#146)", "WAKE #146 retry — pane showed a row of ▔▔▔ characters, so nothing was typed"],
  ];
  for (const [name, prompt] of MID_ROW) {
    test(`an echoing composer and a prompt carrying ${name} mid-row: Enter sent, and the next wake lands`, () => {
      const t = fakeTmux(IDLE, { echo: true });
      try {
        const first = run(t, wakeCmd(prompt));
        expect(first.stdout).toContain("__FLEET_WAKE__ sent");
        const second = run(t, wakeCmd("WAKE sweep 3"));
        expect(second.stdout).toContain("__FLEET_WAKE__ sent");
        expect(enters(t.calls())).toHaveLength(2);
      } finally { t.cleanup(); }
    });
  }

  // N8: the SAME rows as ghost suggestions — a cursor at column 0, no border.
  for (const ghost of [
    "❯ Enter to confirm · Esc to cancel",
    "❯ /rate-limit-options",
    "❯ Run /rate-limit-options to see what you can do.",
    "❯ You've hit your usage limit",
    "❯ Esc to cancel · Tab to amend · ctrl+e to explain",
    "❯ ▔▔▔▔▔▔▔▔",
  ]) {
    test(`a ghost suggestion ${JSON.stringify(ghost)}: the wake lands`, () => {
      const t = fakeTmux(composer(ghost));
      try {
        const r = run(t, wakeCmd("WAKE"));
        expect(r.stdout).toContain("__FLEET_WAKE__ sent");
        expect(enters(t.calls())).toHaveLength(1);
      } finally { t.cleanup(); }
    });
  }

  // The counterpart: the same phrases AS whole rows still refuse, so the pins
  // above cannot be satisfied by a scan that matches nothing at all.
  for (const row of [
    "  Enter to confirm · Esc to cancel",
    "│ Run /rate-limit-options to see what you can do.              │",
    "│ ❯ You've hit your usage limit                                │",
    "  Esc to cancel · Tab to amend · ctrl+e to explain",
  ]) {
    test(`the whole row ${JSON.stringify(row.trim())} is still a modal row: nothing typed`, () => {
      const t = fakeTmux(composer(row));
      try {
        const r = run(t, wakeCmd("WAKE"));
        expect(t.calls().filter((c) => c.startsWith("send-keys"))).toEqual([]);
        expect(r.stdout).toContain("__FLEET_WAKE__ refused-before modal");
      } finally { t.cleanup(); }
    });
  }
});

describe("accountSwitchCmd — #90's C-c re-check stops the chain (#141 review)", () => {
  test("pane reads bash for the wait, then something else at the C-c re-check: no C-c, no adopt line", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-switch-recheck-"));
    const log = join(dir, "calls");
    const n = join(dir, "n");
    writeFileSync(log, "");
    writeFileSync(n, "0");
    writeFileSync(join(dir, "tmux"), [
      "#!/usr/bin/env bash",
      'if [ "$1" = -L ]; then shift 2; fi',
      '[ "$1" = has-session ] && exit 0',
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      // First display-message (the wait) answers bash; every later one, claude.
      `if [ "$1" = display-message ]; then c=$(cat ${JSON.stringify(n)}); echo $((c+1)) > ${JSON.stringify(n)}; ` +
        `if [ "$c" = 0 ]; then echo bash; else echo claude; fi; fi`,
      "exit 0", "",
    ].join("\n"), { mode: 0o755 });
    writeFileSync(join(dir, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    try {
      const r = runSnippet({
        shell: "bash", sourced: true,
        env: { PATH: `${dir}:${process.env.PATH ?? ""}`, LC_ALL: "C", ...tokenEnv("sk-ant-oat01-" + "b".repeat(40)) },
        script: accountSwitchCmd(),
      });
      expect(r.parentAlive).toBe(true);
      expect(r.code).not.toBe(0);
      const calls = readFileSync(log, "utf8").split("\n").filter((l) => l !== "");
      expect(calls.filter((c) => c.startsWith("send-keys"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

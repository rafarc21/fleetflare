import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submitCheckCmd, submitFragment, SUBMIT_HINT_TEXT } from "../../src/studio/wake";

/**
 * Issue #249 round-2 review, item 3 — the post-Enter SUBMIT CONFIRMATION,
 * executed as REAL shell against a REAL tmux server.
 *
 * `wakeCmd`'s own vitest block (test/studio.wake.test.ts) asserts the emitted
 * source text, which is what catches a mutation that deletes the check. It
 * cannot tell a correct `grep`/`tail` pipeline from one a shell tears apart, and
 * this pipeline has to survive a multibyte `❯`, a C-locale `grep -E`, box
 * borders and a `grep -n` line number fed through POSIX parameter expansion. So
 * this lane runs it: `submitCheckCmd(prompt)` builds the check from the SAME
 * `submitCheck`/`submitFragment` pair `wakeCmd` builds it from, and prints
 * `SUBMIT <code>` — 0 the typed text is gone from the box (the wake landed),
 * 1 still drafted, 2 unreadable.
 *
 * TMUX/TMUX_PANE are stripped for test/bun/wake-cmd.test.ts's own MEASURED
 * reason: with `$TMUX` set, tmux targets the CURRENT server and ignores
 * TMUX_TMPDIR, and the session/window names here are the real ones
 * (`studio:claude`) — three studio leads died that way over two days.
 */
function isolatedTmuxEnv(dir: string): Record<string, string | undefined> {
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = process.env;
  return { ...rest, TMUX_TMPDIR: dir };
}

/** The prompt every fixture below is "about" — a real survival re-brief's own
 *  first line, so the fragment under test is the fragment production uses. */
const PROMPT = "What survived, fleetflare--pilot: - Task branches: none";

/** Renders `rows` into a real `studio:claude` pane and runs the submit check
 *  against it, answering the code the check printed. */
function checkAgainstPane(rows: string[], prompt = PROMPT): number {
  const dir = mkdtempSync(join(tmpdir(), "fleet-submit-"));
  const env = isolatedTmuxEnv(dir);
  const sh = (cmd: string) =>
    Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, stdout: "pipe", stderr: "pipe", timeout: 15000 });
  try {
    // `printf` the fixture then hold the pane open, so capture-pane sees it.
    // One `printf '%s\n'` with single-quoted rows: the box-drawing and cursor
    // characters have to reach the pane as the exact bytes claude draws.
    const quoted = rows.map((r) => `'${r.replace(/'/g, `'\\''`)}'`).join(" ");
    sh(`tmux new-session -d -x 200 -y 30 -s studio -n claude ${JSON.stringify(`printf '%s\\n' ${quoted}; sleep 30`)}`);
    const r = sh(submitCheckCmd(prompt));
    const m = r.stdout.toString().match(/SUBMIT (\d+)/);
    if (!m) throw new Error(`no SUBMIT verdict: ${r.stdout.toString()} ${r.stderr.toString()}`);
    return Number(m[1]);
  } finally {
    sh("tmux kill-server 2>/dev/null || true");
    rmSync(dir, { recursive: true, force: true });
  }
}

/** claude's own frame around whatever the input box holds. */
const framed = (box: string[]) => [
  "✻ Cooked for 36m 35s",
  "─".repeat(120),
  ...box,
  "─".repeat(120),
  "  ⏵⏵ bypass permissions on · ← for agents",
];

describe("the submit check, against a real tmux pane", () => {
  test("an EMPTY input box reads SUBMITTED", () => {
    // Measured shape of a real empty composer (test/fixtures/rate-limit-panes.ts's
    // REAL_WEEKLY_DATED_PANE): the row is `❯` and nothing else.
    expect(checkAgainstPane(framed(["❯"]))).toBe(0);
  });

  test("OUR prompt still sitting in the box reads NOT submitted", () => {
    // The state the whole review item exists for: Enter was pressed, the text
    // is still there, and the old code called that `sent`.
    expect(checkAgainstPane(framed([`❯ ${PROMPT}`]))).toBe(1);
  });

  test("a WRAPPED draft is caught by its continuation rows too", () => {
    // A long prompt fills the box over several rows; the fragment is on the
    // first, which is why the check reads from the composer row DOWNWARD.
    expect(checkAgainstPane(framed([`❯ ${PROMPT}`, "  - Open PRs: none - Session: resumed"]))).toBe(1);
  });

  test("SOMEONE ELSE'S draft is not ours: the box holds text, the wake still landed", () => {
    // The question is "is the text THIS WAKE typed still in the box", not "is
    // the box empty" — a lead that started typing its own message after our
    // prompt was accepted has not lost anything.
    expect(checkAgainstPane(framed(["❯ hmm, let me look at that myself"]))).toBe(0);
  });

  test("claude's GHOST SUGGESTIONS in an empty box do NOT read as a draft", () => {
    // Measured and pinned in test/bun/wake-guard.test.ts (PR #144's N8 rows):
    // claude draws these INSIDE an empty composer, and a wake must still land.
    // An emptiness test would have reported every such wake as a failure.
    for (const ghost of [
      "❯ What do you want to do next?",
      "❯ 1. Upgrade deps",
      "❯ Run /rate-limit-options to see what you can do.",
    ]) {
      expect(checkAgainstPane(framed([ghost]))).toBe(0);
    }
  });

  test("claude's own hints do NOT read as a draft", () => {
    // `Press up to edit queued messages` appears on exactly the submit this
    // check is confirming; reading it as a draft would report a landed wake as
    // a failure and (with #249's retry behind it) duplicate the brief.
    for (const hint of SUBMIT_HINT_TEXT) {
      expect(checkAgainstPane(framed([`❯ ${hint}`]))).toBe(0);
    }
    expect(checkAgainstPane(framed(["❯", `  ${SUBMIT_HINT_TEXT.join("  ")}`]))).toBe(0);
  });

  test("a BOXED cursor is read the same way, empty or drafted", () => {
    // The `(│[[:space:]]*)?` group, and the reason it is a group rather than a
    // `│?`: in the C locale that `?` would bind to the last BYTE of `│`.
    expect(checkAgainstPane(framed(["│ ❯                                                    │"]))).toBe(0);
    expect(checkAgainstPane(framed([`│ ❯ ${PROMPT} │`]))).toBe(1);
  });

  test("the transcript's ECHO of a submitted prompt does not read as a draft", () => {
    // claude replays the user's message above the box. A whole-pane search for
    // the text would call every landed wake a draft; reading from the LAST
    // composer row downward is what makes the echo invisible to the check.
    expect(checkAgainstPane([
      `> ${PROMPT}`,
      "⏺ Reading the task branches now.",
      ...framed(["❯"]),
    ])).toBe(0);
  });

  test("a pane with NO composer row at all is UNREADABLE, never `submitted`", () => {
    // FAIL CLOSED: an unreadable box must not be reported as a landed wake.
    // This is also the shape test/bun/wake-cmd.test.ts's `cat` pane has.
    expect(checkAgainstPane(["$ some bash prompt", "no claude here"])).toBe(2);
  });

  test("the fragment is the wake's own leading slice, not the whole prompt", () => {
    expect(submitFragment(PROMPT)).toBe("What survived, f");
    // Long enough that nothing else claude draws collides with it: a pane
    // holding only the fragment's FIRST WORD is not our draft.
    expect(checkAgainstPane(framed(["❯ What"]))).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wakeCmd } from "../../src/studio/wake";

/**
 * Executes the REAL emitted wake command against a REAL tmux server, in a
 * throwaway TMUX_TMPDIR so it can never touch the operator's own sessions.
 * The window under test runs `cat > out`, so whatever the emitted command
 * types — and only what Enter actually submits — lands in a file we can read.
 *
 * This is the lane that proves quoting: a source-text assertion cannot tell
 * a correctly-escaped prompt from one that a shell would tear apart.
 */
/**
 * An env whose tmux can ONLY reach the throwaway server under `dir`.
 *
 * `TMUX_TMPDIR` alone is not isolation. When `TMUX` is set -- i.e. this test
 * runs INSIDE a tmux session, which is exactly where a studio lead runs it --
 * tmux targets the CURRENT server named in `$TMUX` and ignores TMUX_TMPDIR.
 * The session/window names here are the real ones (`studio:claude`), so this
 * suite then typed its fixtures into the live claude window and its
 * `kill-server` killed the studio outright. MEASURED 2026-09-18: a sentinel
 * server with those names died when this file ran inside it; three studio
 * leads died this way over two days. Stripping TMUX/TMUX_PANE makes tmux fall
 * back to TMUX_TMPDIR, i.e. the throwaway server, wherever the test runs.
 */
function isolatedTmuxEnv(dir: string): Record<string, string | undefined> {
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = process.env;
  return { ...rest, TMUX_TMPDIR: dir };
}

function sendIntoRealTmux(prompt: string): { out: string; code: number; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-wake-"));
  const outFile = join(dir, "out");
  const env = isolatedTmuxEnv(dir);
  const sh = (cmd: string) =>
    Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, stdout: "pipe", stderr: "pipe", timeout: 15000 });
  try {
    // Same session/window names bring-up creates (container/studio-bringup.sh).
    sh(`tmux new-session -d -s studio -n claude ${JSON.stringify(`cat > ${outFile}`)}`);
    const r = sh(wakeCmd(prompt));
    // `cat` only flushes the line once Enter submits it; give it a beat.
    Bun.spawnSync({ cmd: ["sh", "-c", "sleep 1"] });
    const out = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
    return { out, code: r.exitCode ?? -1, stderr: r.stderr.toString() };
  } finally {
    sh("tmux kill-server 2>/dev/null || true");
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("wakeCmd, executed against a real tmux", () => {
  test("delivers the prompt verbatim and submits it", () => {
    const r = sendIntoRealTmux("WAKE sweep 3");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toBe("WAKE sweep 3\n");
  });

  test("survives shell metacharacters a digest really carries", () => {
    // Apostrophes, $, backticks, semicolons and quotes all appear in real
    // GitHub titles. An unescaped one is a command injection, not a typo.
    const nasty = `it's $HOME \`id\`; "quoted" | & > <`;
    const r = sendIntoRealTmux(nasty);
    expect(r.stderr).toBe("");
    expect(r.out).toBe(nasty + "\n");
  });

  test("a missing target window fails loudly instead of silently", () => {
    // A LIVE tmux server with the wrong window -- the real shape of the
    // failure (container restarted, bring-up never made `claude`). Not "no
    // tmux at all", which any host without tmux installed also produces.
    const dir = mkdtempSync(join(tmpdir(), "fleet-wake-"));
    const env = isolatedTmuxEnv(dir);
    const sh = (cmd: string) =>
      Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, stdout: "pipe", stderr: "pipe", timeout: 15000 });
    try {
      sh("tmux new-session -d -s studio -n shell 'sleep 30'");
      const r = sh(wakeCmd("nobody home"));
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr.toString()).toMatch(/can.t find (window|pane|session)/i);
    } finally {
      sh("tmux kill-server 2>/dev/null || true");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a multi-line prompt submits ONCE, not once per line", () => {
    // A literal newline is a SUBMIT in the claude TUI. Unflattened, the first
    // line would become a whole turn and the rest would be left dangling.
    const r = sendIntoRealTmux("WAKE sweep 3\nSTUDIOS: none\nNEXT: report");
    expect(r.out).toBe("WAKE sweep 3 STUDIOS: none NEXT: report\n");
  });
});

/**
 * Maestro review, PR #302 round 2 — `clearDraftFirst`, over a REAL tmux pane
 * carrying an unsubmitted draft: text typed with NO Enter, sitting in the
 * pty's own line-edit buffer exactly the way a prior wake's typed-but-
 * unconfirmed prompt would (wake.ts's `wakeCmd` doc comment, steps 6-8). The
 * window still runs `cat > out`, so what reaches the file is only what a
 * terminating Enter actually flushes — a draft alone never appears there,
 * which is why the two-typing setup below needs the CONTROL case to prove the
 * concatenation is real and not an artifact of the harness.
 */
describe("wakeCmd clearDraftFirst, executed against a real tmux", () => {
  function draftThenWake(clearDraftFirst: boolean): { out: string; code: number; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), "fleet-wake-"));
    const outFile = join(dir, "out");
    const env = isolatedTmuxEnv(dir);
    const sh = (cmd: string) =>
      Bun.spawnSync({ cmd: ["sh", "-c", cmd], env, stdout: "pipe", stderr: "pipe", timeout: 15000 });
    try {
      sh(`tmux new-session -d -s studio -n claude ${JSON.stringify(`cat > ${outFile}`)}`);
      // A stuck draft: typed, no Enter — the same state an earlier wake's
      // `unconfirmed still-drafted` verdict leaves the pane in.
      sh(`tmux send-keys -t studio:claude -l -- ${JSON.stringify("SURVIVAL BRIEF: old attempt")}`);
      const r = sh(wakeCmd("SURVIVAL BRIEF: retry", clearDraftFirst));
      Bun.spawnSync({ cmd: ["sh", "-c", "sleep 1"] });
      const out = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
      return { out, code: r.exitCode ?? -1, stderr: r.stderr.toString() };
    } finally {
      sh("tmux kill-server 2>/dev/null || true");
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("false (default): a stuck draft runs together with the new prompt into one doubled line", () => {
    const r = draftThenWake(false);
    expect(r.out).toBe("SURVIVAL BRIEF: old attemptSURVIVAL BRIEF: retry\n");
  });

  test("true: C-u clears the stuck draft first, so only the new prompt lands", () => {
    const r = draftThenWake(true);
    expect(r.out).toBe("SURVIVAL BRIEF: retry\n");
  });
});

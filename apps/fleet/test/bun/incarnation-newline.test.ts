// Board issue #85, maestro correction #2's own explicit ask: a token written
// with NO trailing newline glues onto the next section marker in the ship
// tick's stdout stream, silently vanishing the chunk section every tick,
// fleet-wide. This is a real-shell round trip proving BOTH halves are fixed
// together — Task 3's writeIncarnationCmd (trailing newline) and this task's
// shipTickCmd read fragment (captured into a shell variable before being
// echoed, never a bare `cat FILE || echo ''` piped straight into stdout).
// Same throwaway-tmpdir convention test/bun/inspect-cmd.test.ts already
// established — no tmux needed here, this is plain file I/O.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeIncarnationCmd } from "../../src/studio/observed";
// Wire-format contract (issue #275): the real builder is private now, so the
// real-shell round trip below runs the test-owned wire-format copy — same
// command text, pinned against the real one byte-for-byte by
// test/bun/transcript-wire-equivalence.test.ts (see
// transcript-wire-format.ts's header for the drift contract).
import { shipTickCmdWire as shipTickCmd, SECTION_INCARNATION, SECTION_CHUNK } from "./transcript-wire-format";

/** Same isolation this repo's own real-tmux suites (test/bun/pane-probe.ts,
 *  test/bun/wake-cmd.test.ts) already establish: `TMUX_TMPDIR` alone is NOT
 *  isolation — a shell that already has `$TMUX` set (running inside a live
 *  tmux session) ignores `TMUX_TMPDIR` entirely and addresses whatever
 *  server `$TMUX` names, which is exactly how this feature's own lead was
 *  measured to die from an insufficiently-isolated test run. Both must be
 *  stripped, never just one. */
function isolatedTmuxEnv(dir: string): Record<string, string | undefined> {
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = process.env;
  return { ...rest, TMUX_TMPDIR: dir };
}

describe("incarnation file round-trip through a real shell (issue #85, maestro correction #2)", () => {
  test("a token written with writeIncarnationCmd, read back via shipTickCmd's own read fragment, never glues onto the next section", () => {
    // Hermetic: `shipTickCmd` also references TRANSCRIPT_LOG_PATH/
    // TRANSCRIPT_BOOT_ID_PATH under `/workspace/.transcript/`, so every
    // `/workspace/` prefix is redirected into this throwaway root — same
    // convention test/bun/inspect-cmd.test.ts's own `withStudio` helper
    // establishes — so this test's outcome never depends on whatever
    // happens to exist at the real `/workspace` on the machine running it.
    const dir = mkdtempSync(join(tmpdir(), "fleet-incarnation-"));
    try {
      const transcriptDir = join(dir, ".transcript");
      mkdirSync(transcriptDir, { recursive: true });
      writeFileSync(join(transcriptDir, "claude.log"), "hello from the pane\n");

      const incarnationPath = join(dir, "incarnation");
      const writeCmd = writeIncarnationCmd("11111111-2222-3333-4444-555555555555").replaceAll("/workspace/.fleet/incarnation", incarnationPath);
      const write = Bun.spawnSync({ cmd: ["sh", "-c", writeCmd], stdout: "pipe", stderr: "pipe" });
      expect(write.exitCode).toBe(0);

      const tickCmd = shipTickCmd(0, undefined)
        .replaceAll("/workspace/.fleet/incarnation", incarnationPath)
        .replaceAll("/workspace/.transcript/", `${transcriptDir}/`);
      const read = Bun.spawnSync({ cmd: ["sh", "-c", tickCmd], stdout: "pipe", stderr: "pipe" });
      expect(read.exitCode).toBe(0);
      const stdout = read.stdout.toString();
      const lines = stdout.split("\n");
      const incIdx = lines.indexOf(SECTION_INCARNATION);
      expect(incIdx).toBeGreaterThan(-1);
      // The line RIGHT AFTER the marker is the token, ALONE — never glued to
      // the next section's marker.
      expect(lines[incIdx + 1]).toBe("11111111-2222-3333-4444-555555555555");
      // The chunk section still shows up, on its OWN line — a genuinely
      // separate array entry, not merged into the token's line.
      const chunkIdx = lines.indexOf(SECTION_CHUNK);
      expect(chunkIdx).toBeGreaterThan(incIdx + 1);
      expect(lines[chunkIdx]).toBe(SECTION_CHUNK); // exact line, nothing glued onto it
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a token written with NO trailing newline (the pre-fix shape) DOES glue onto the next marker — proves the fix is load-bearing, not a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-incarnation-glue-"));
    try {
      const incarnationPath = join(dir, "incarnation");
      // Deliberately the OLD buggy write shape: no trailing newline.
      const badWriteCmd = `mkdir -p ${dir} && printf '%s' '11111111-2222-3333-4444-555555555555' > ${incarnationPath}`;
      const write = Bun.spawnSync({ cmd: ["sh", "-c", badWriteCmd], stdout: "pipe", stderr: "pipe" });
      expect(write.exitCode).toBe(0);

      // Simulate the OLD buggy read: bare cat piped straight into stdout,
      // immediately followed by the next section's echo — exactly what
      // shipTickCmd no longer does.
      const buggyReadCmd =
        `echo '${SECTION_INCARNATION}'; cat ${incarnationPath} 2>/dev/null || echo ''; echo '${SECTION_CHUNK}'`;
      const read = Bun.spawnSync({ cmd: ["sh", "-c", buggyReadCmd], stdout: "pipe", stderr: "pipe" });
      const lines = read.stdout.toString().split("\n");
      const incIdx = lines.indexOf(SECTION_INCARNATION);
      // The bug: the token and the next marker share ONE line — the exact
      // marker line search fails to find SECTION_CHUNK on its own line.
      expect(lines[incIdx + 1]).toBe(`11111111-2222-3333-4444-555555555555${SECTION_CHUNK}`);
      expect(lines.indexOf(SECTION_CHUNK)).toBe(-1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // [CI-RELAY] Board issue #85 review, BLOCKER 1 follow-up: the adoption
  // shipTickCmd variant, run in a REAL shell — the exact reproduction of the
  // fleet-wide "adoption tick is a bash syntax error" bug this same review
  // round fixed (transcript.ts's shipTickCmd glued paneLeadProbeCmd()'s
  // trailing `echo` onto its own next `if [` with no separator). Unlike this
  // file's other two tests (plain file I/O, no tmux at all), the
  // adoption-token path embeds `paneLeadProbeCmd()`, which itself calls
  // `tmux display -p -t studio:claude ...` — so this test DOES touch tmux,
  // even with `TMUX`/`TMUX_PANE` stripped and `TMUX_TMPDIR` pointed at a
  // throwaway, server-less directory (the same isolation this repo's other
  // real-tmux suites use): `tmux display` never STARTS a server on a miss,
  // it just fails fast against a socket that does not exist, `2>/dev/null`
  // swallows the message, and the script continues — the graceful-failure
  // path `paneLeadProbeCmd`'s own doc comment already relies on. That
  // reasoning is sound on paper, but this container's own maestro measured
  // its lead dying TWICE in one day from tmux-adjacent test execution — a
  // concrete signal that "isolated on paper" has not been reliable enough
  // here to trust blind. Tagged [CI-RELAY]: written and left for the CI
  // relay to run and confirm, not run by hand in this session.
  test("[CI-RELAY] the adoption-token shipTickCmd variant runs clean end to end: exit 0, token intact, chunk marker present", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-incarnation-adopt-"));
    try {
      const transcriptDir = join(dir, ".transcript");
      mkdirSync(transcriptDir, { recursive: true });
      writeFileSync(join(transcriptDir, "claude.log"), "hello from the pane\n");

      const incarnationPath = join(dir, "incarnation");
      const token = "11111111-2222-3333-4444-555555555555";
      const tickCmd = shipTickCmd(0, undefined, token)
        .replaceAll("/workspace/.fleet/incarnation", incarnationPath)
        .replaceAll("/workspace/.transcript/", `${transcriptDir}/`);
      const env = isolatedTmuxEnv(dir);
      const read = Bun.spawnSync({ cmd: ["bash", "-c", tickCmd], env, stdout: "pipe", stderr: "pipe" });
      expect(read.stderr.toString()).toBe("");
      expect(read.exitCode).toBe(0);

      const stdout = read.stdout.toString();
      const lines = stdout.split("\n");
      const incIdx = lines.indexOf(SECTION_INCARNATION);
      expect(incIdx).toBeGreaterThan(-1);
      // The token line is exactly the token, alone — never glued to the
      // pane-probe section (SESSION_FOUND) that immediately follows it.
      expect(lines[incIdx + 1]).toBe(token);
      // The chunk marker survives on its OWN line — the fix's whole point:
      // before it, `echoif [...` swallowed this marker (and everything past
      // it) into one unparseable bareword, exit 2, no CHUNK section at all.
      const chunkIdx = lines.indexOf(SECTION_CHUNK);
      expect(chunkIdx).toBeGreaterThan(incIdx);
      expect(lines[chunkIdx]).toBe(SECTION_CHUNK);

      // The incarnation FILE itself, on disk: exactly `token\n` — a trailing
      // newline, never glued to anything else on the same line.
      expect(readFileSync(incarnationPath, "utf8")).toBe(`${token}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

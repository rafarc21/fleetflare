// Board issue #85 review (BLOCKER 1): `bash -n` never executes anything — it
// only parses — so it is safe to run against EVERY shell command string this
// feature's src/studio/ builds, with no tmux server, no container, nothing.
// That is exactly what a real bring-up/tick DOES run these strings through
// (`sh -c "$cmd"` inside the container), and a plain string-concatenation bug
// (two fragments glued together with no separator — reproduced here) is
// invisible to any test that only inspects substrings, but fails `bash -n`
// immediately and deterministically.
//
// Reproduces the exact fleet-wide bug: `shipTickCmd`'s adoption-token path
// string-concatenates `paneLeadProbeCmd()`'s return value (observed.ts,
// ending `...; fi; echo` — no trailing separator) directly onto its own next
// fragment (`if [ "$FLEET_SIZE" -ge 0 ]; then ...`), producing the single
// bareword `echoif` and a syntax error on EVERY running studio's first tick
// after deploy (none has `observed` yet, so the adoption path fires on all of
// them at once).
import { describe, expect, test } from "bun:test";
import {
  writeIncarnationCmd, readFileLineCmd, paneLeadProbeCmd, bringupObservationCmd,
} from "../../src/studio/observed";
// shipTickCmd/rotateCmd aliases: the real builders are private now (issue
// #275) — these names bind to the test-owned wire-format copies in
// ./transcript-wire-format.ts, kept equal to the real builder byte-for-byte
// by test/bun/transcript-wire-equivalence.test.ts (see that file's header
// for the drift contract), so the bash -n test bodies below stay unchanged.
import { shipTickCmdWire as shipTickCmd, rotateCmdWire as rotateCmd } from "./transcript-wire-format";
import { inspectCmd } from "../../src/studio/inspect";

/** `bash -n` parses `cmd` and exits 0 iff it is syntactically valid — it
 *  NEVER runs a single line of it (no exec, no tmux, no filesystem write),
 *  which is what makes this safe to call on every command string below,
 *  including ones that embed a real `tmux ...`/`__ff_tmux ...` call. */
function assertBashSyntaxOk(label: string, cmd: string): void {
  const r = Bun.spawnSync({ cmd: ["bash", "-n", "-c", cmd], stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    throw new Error(`${label}: bash -n failed (exit ${r.exitCode})\n${r.stderr.toString()}\n--- cmd ---\n${cmd}`);
  }
  expect(r.exitCode).toBe(0);
}

describe("every src/studio/ command-builder produces syntactically valid shell (issue #85 review, BLOCKER 1)", () => {
  test("observed.ts: writeIncarnationCmd", () => {
    assertBashSyntaxOk("writeIncarnationCmd", writeIncarnationCmd("11111111-2222-3333-4444-555555555555"));
  });

  test("observed.ts: readFileLineCmd", () => {
    assertBashSyntaxOk("readFileLineCmd", readFileLineCmd("/workspace/.fleet/incarnation"));
  });

  test("observed.ts: paneLeadProbeCmd, standalone", () => {
    assertBashSyntaxOk("paneLeadProbeCmd", paneLeadProbeCmd());
  });

  test("observed.ts: bringupObservationCmd (embeds paneLeadProbeCmd as its LAST fragment)", () => {
    assertBashSyntaxOk("bringupObservationCmd", bringupObservationCmd("11111111-2222-3333-4444-555555555555"));
  });

  test("transcript.ts: shipTickCmd, no-token (steady-state) form", () => {
    assertBashSyntaxOk("shipTickCmd(no token)", shipTickCmd(0, undefined));
  });

  test("transcript.ts: shipTickCmd, no-token form with a stored boot id", () => {
    assertBashSyntaxOk("shipTickCmd(no token, bootId)", shipTickCmd(128, "some-boot-id"));
  });

  // THE reproduction: adoptionToken supplied embeds paneLeadProbeCmd()'s
  // output into the MIDDLE of shipTickCmd's own larger command, immediately
  // followed by `if [ "$FLEET_SIZE" -ge 0 ]; then ...` — exactly the glue
  // point the review identified (transcript.ts:318, observed.ts:241).
  test("transcript.ts: shipTickCmd, WITH an adoption token — reproduces the fleet-wide adoption-tick syntax error", () => {
    assertBashSyntaxOk(
      "shipTickCmd(with adoption token)",
      shipTickCmd(0, undefined, "11111111-2222-3333-4444-555555555555"),
    );
  });

  test("transcript.ts: shipTickCmd, WITH an adoption token AND a stored boot id", () => {
    assertBashSyntaxOk(
      "shipTickCmd(with adoption token, bootId)",
      shipTickCmd(4096, "some-boot-id", "11111111-2222-3333-4444-555555555555"),
    );
  });

  test("transcript.ts: rotateCmd", () => {
    assertBashSyntaxOk("rotateCmd", rotateCmd(1024));
  });

  test("inspect.ts: inspectCmd", () => {
    assertBashSyntaxOk("inspectCmd", inspectCmd("some-org/some-repo"));
  });

  test("inspect.ts: inspectCmd with a non-default tail line count", () => {
    assertBashSyntaxOk("inspectCmd(tailLines)", inspectCmd("some-org/some-repo", 120));
  });
});

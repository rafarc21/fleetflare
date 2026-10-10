// Issue #275 review round 1, Standards finding 1: the wire-format copy in
// ./transcript-wire-format.ts is the bash -n net's owned spec — but NOTHING
// tied it to the real builder, so a #85-class glue edit to the private
// src/studio/transcript.ts shipTickCmd would pass every gate while the copy
// kept asserting the old shape. This is the drift contract made executable:
// the REAL tick's sent command (captured via a fake exec on the still-
// exported shipTranscriptTick) must equal the copy byte-for-byte across the
// parameter matrix. Fails red in EITHER direction — builder drifts away from
// the copy, or the copy drifts away from the builder.
import { describe, expect, test } from "bun:test";
import { shipTranscriptTick, type ShipDeps, type TranscriptStorage } from "../../src/studio/transcript";
import { shipTickCmdWire, rotateCmdWire } from "./transcript-wire-format";

// Wire-format literals — the section markers, pinned as literals the same way
// test/studio.transcript.test.ts's own wire-format block pins them: markers
// are protocol, not implementation. These feed the fake stdout below, never
// an assert on the builder (that is the byte-for-byte expect's job), and the
// tick's own parser still has to FIND them, so a renamed marker fails here
// too, as a parse-shaped failure rather than a string diff.
const SECTION_BOOTID = "---FLEET-BOOTID---";
const SECTION_STAT = "---FLEET-STAT---";
const SECTION_INCARNATION = "---FLEET-INCARNATION---";
const SECTION_CHUNK = "---FLEET-CHUNK---";
const SECTION_TAIL = "---FLEET-TAIL---";

/**
 * Capturing fake `ShipDeps.exec`: records every command sent, answers the
 * tick. The tick stdout mirrors the REAL command's own section-emission rule
 * — CHUNK/TAIL sections exist only when the stat line parses to a finite,
 * non-negative size (the command's own `if [ "$FLEET_SIZE" -ge 0 ]` guard) —
 * because the tick THROWS on a file-present tick whose stdout lacks a TAIL
 * section (`transcript hot-tail read failed`) before it ever reaches the
 * rotate gate. Everything else (PANE, MEMGUARD, ACTIVITY_HOOK, the adoption
 * probe's own sections) is deliberately absent: every section parser in
 * src/studio/transcript.ts treats an absent marker as `undefined`, never a
 * throw.
 */
function captureDeps(sent: string[], opts: { stat?: string } = {}): Pick<ShipDeps, "exec"> {
  return {
    exec: async (cmd: string) => {
      sent.push(cmd);
      if (cmd.startsWith("FLEET_FRESH_BOOT_ID=")) {
        // Minimal well-formed tick stdout: no boot-id file, no incarnation
        // file; the stat line opts the caller controls.
        const stat = opts.stat ?? "-1";
        const lines = [
          SECTION_BOOTID, "",
          SECTION_STAT, stat,
          SECTION_INCARNATION, "",
        ];
        const size = Number.parseInt(stat, 10);
        if (Number.isFinite(size) && size >= 0) {
          lines.push(SECTION_CHUNK, "", SECTION_TAIL, ""); // caught up: no chunk bytes, empty hot-tail
        }
        return { code: 0, stdout: lines.join("\n"), stderr: "" };
      }
      return { code: 0, stdout: "ROTATED", stderr: "" };
    },
  };
}

/**
 * Minimal TranscriptStorage fake — an in-memory Map behind the keyed-overload
 * port, `get`/`put` cast once each the same way the vitest suite's own fake
 * (test/studio.transcript.test.ts) already does. Nothing here asserts on
 * writes: this suite's only object of study is the COMMAND the tick sends.
 */
function fakeStorage(
  seed: { manifest?: { seq: number; offset: number; date: string }; bootId?: string } = {},
): TranscriptStorage {
  const map = new Map<string, unknown>();
  if (seed.manifest) map.set("transcriptManifest", seed.manifest);
  if (seed.bootId !== undefined) map.set("transcriptBootId", seed.bootId);
  return {
    get: (async (key: string) => map.get(key)) as TranscriptStorage["get"],
    put: (async () => {}) as TranscriptStorage["put"],
  };
}

describe("wire-format copy tracks the real builder byte-for-byte (issue #275 review, F1)", () => {
  // Matrix over the builder's whole parameter space: steady-state, stored
  // boot-id, adoption token, adoption + stored boot-id — the same cases
  // cmd-syntax.test.ts bash -n's, now pinned against the REAL tick's exec.
  const cases: { label: string; offset: number; bootId?: string; token?: string }[] = [
    { label: "steady-state", offset: 0 },
    { label: "stored boot-id", offset: 128, bootId: "some-boot-id" },
    { label: "adoption token", offset: 0, token: "11111111-2222-3333-4444-555555555555" },
    { label: "adoption + stored boot-id", offset: 4096, bootId: "some-boot-id", token: "11111111-2222-3333-4444-555555555555" },
  ];

  for (const c of cases) {
    test(`shipTickCmd: ${c.label} — the sent command equals shipTickCmdWire(${c.offset}, ${c.bootId === undefined ? "undefined" : JSON.stringify(c.bootId)}${c.token === undefined ? "" : ", <token>"}) byte-for-byte`, async () => {
      const sent: string[] = [];
      const storage = fakeStorage({
        manifest: { seq: 0, offset: c.offset, date: "2026-10-10" },
        ...(c.bootId !== undefined ? { bootId: c.bootId } : {}),
      });
      await shipTranscriptTick(
        { ...captureDeps(sent), r2Put: async () => {}, now: () => new Date("2026-10-10T12:00:00.000Z") },
        storage, "websites--pilot", c.token,
      );
      expect(sent).toHaveLength(1); // no-file tick: one exec, no rotate
      expect(sent[0]).toBe(shipTickCmdWire(c.offset, c.bootId, c.token));
    });
  }

  test("rotateCmd: the rotation exec equals rotateCmdWire(<shippedSize>) byte-for-byte", async () => {
    // A rotate only fires on a file-present, fully-caught-up, over-threshold
    // tick — drive one with a size/manifest pair that clears both gates:
    // size == offset == ROTATION_THRESHOLD_BYTES (64 MiB; shouldRotate is
    // >=), zero chunk bytes, so nextManifest.offset stays == size and the
    // rotate gate's `nextManifest.offset >= size` holds with nothing shipped.
    const sent: string[] = [];
    const storage = fakeStorage({ manifest: { seq: 5, offset: 67_108_864, date: "2026-10-10" } });
    await shipTranscriptTick(
      { ...captureDeps(sent, { stat: "67108864" }), r2Put: async () => {}, now: () => new Date("2026-10-10T12:00:00.000Z") },
      storage, "websites--pilot",
    );
    expect(sent).toHaveLength(2); // tick exec + rotate exec
    expect(sent[1]).toBe(rotateCmdWire(67_108_864));
  });
});

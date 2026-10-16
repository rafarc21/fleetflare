// Task #496 (sweep 11, finding F8): direct per-branch coverage of
// parseReapState, reached through the exported reapDeps().loadState() seam —
// d41495f dropped the function's export, and loadState is the call site that
// turns its null into the kept-aside rename + throw. No Bun.serve and no
// network: loadState only reads the state file.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapDeps } from "../../cli/fleet";
import { emptyReapState } from "../../cli/reap";
import type { OrcaDeps } from "../../cli/orca-workspace";

const REPO = "example-org/acmeclient";

// Hermetic OrcaDeps, same shape as fleet-reap-wiring.test.ts's NOT_UNDER_ORCA:
// terminal env, any orca call is a failure, the lock runs fn straight through.
const NO_ORCA: OrcaDeps = {
  env: { TERM_PROGRAM: "Apple_Terminal" },
  hasBinary: () => "orca",
  registry: { get: () => undefined, set: async () => {} },
  log: () => {},
  run: async () => { throw new Error("no orca call expected"); },
  lock: (_id, fn) => fn(),
};

// Port 1 is unroutable: loadState never fetches, so nothing can ever go out.
const creds = { workerUrl: "http://127.0.0.1:1/", accessClientId: "", accessClientSecret: "" };

describe("reapDeps().loadState — parseReapState per-branch coverage (#496)", () => {
  // Every case pins one parseReapState null-return: the corrupt file is kept
  // aside byte-for-byte (never silently overwritten) and loadState throws.
  describe("untrusted shape: kept aside + corrupt-or-wrong-shape throw", () => {
    const cases: [name: string, raw: string][] = [
      // :2392 typeof parsed !== "object" — each JSON scalar shape.
      ["number scalar", "42"],
      ["string scalar", '"str"'],
      ["boolean scalar", "true"],
      ["JSON null", "null"],
      // :2392 Array.isArray — a JSON array is not a state object.
      ["array", "[1,2]"],
      // :2395 backoffUntil present but not a string map.
      ["backoffUntil not a string map", '{"backoffUntil":5}'],
      // :2396 stallAlarmAt present but not a string map.
      ["stallAlarmAt not a string map", '{"stallAlarmAt":{"a":1}}'],
      // :2397 boardRows present but not a count map.
      ["boardRows not a count map", '{"boardRows":{"x":"y"}}'],
      // :2398 refusals present but not a count map: negative (integer >= 0)...
      ["refusals negative count", '{"refusals":{"x":-1}}'],
      // ...and non-integer — both trip isCountMap's per-value check.
      ["refusals non-integer count", '{"refusals":{"x":1.5}}'],
    ];
    for (const [name, raw] of cases) {
      test(`${name} -> throws, one corrupt-* aside with the exact bytes`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "reap-"));
        const statePath = join(dir, "reap-state.json");
        writeFileSync(statePath, raw);
        await expect(reapDeps(creds, REPO, statePath, () => {}, NO_ORCA).loadState())
          .rejects.toThrow(/corrupt or the wrong shape/);
        const aside = readdirSync(dir).filter((f) => f.startsWith("reap-state.json.corrupt-"));
        expect(aside.length).toBe(1);
        expect(readFileSync(join(dir, aside[0]!), "utf8")).toBe(raw);
        expect(existsSync(statePath)).toBe(false);
      });
    }
  });

  // Every case pins an accept-side branch: absent, partial or unknown keys all
  // parse, and the file on disk stays exactly as written.
  describe("trusted shape: state returned, file untouched", () => {
    const cases: [name: string, raw: string, expected: () => ReturnType<typeof emptyReapState>][] = [
      // No keys at all -> the empty state.
      ["empty object", "{}", () => emptyReapState()],
      // :2395 backoffUntil kept, the other three absent -> empty (the sweep's
      // valid-partial case).
      ["backoffUntil only", '{"backoffUntil":{"acmeclient--pilot":"2026-10-13T00:00:00.000Z"}}',
        () => ({ ...emptyReapState(), backoffUntil: { "acmeclient--pilot": "2026-10-13T00:00:00.000Z" } })],
      // :2397 and :2398 together: two maps kept, two absent.
      ["boardRows and refusals", '{"boardRows":{"example-org/acmeclient":3},"refusals":{"acmeclient--pilot":2}}',
        () => ({ ...emptyReapState(), boardRows: { "example-org/acmeclient": 3 }, refusals: { "acmeclient--pilot": 2 } })],
      // --nudge's budget (issue #1098) is kept, or a restart would wake a lead again.
      ["nudge records", '{"nudgedAt":{"acmeclient--pilot":"2026-10-16T10:00:00.000Z"},"taskNudges":{"7":["2026-10-16T10:00:00.000Z"]}}',
        () => ({ ...emptyReapState(), nudgedAt: { "acmeclient--pilot": "2026-10-16T10:00:00.000Z" }, taskNudges: { "7": ["2026-10-16T10:00:00.000Z"] } })],
      // Unknown keys are silently dropped, not a corruption.
      ["unknown key dropped", '{"unknown":1}', () => emptyReapState()],
    ];
    for (const [name, raw, expected] of cases) {
      test(`${name} -> resolves, no aside, bytes unchanged`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "reap-"));
        const statePath = join(dir, "reap-state.json");
        writeFileSync(statePath, raw);
        expect(await reapDeps(creds, REPO, statePath, () => {}, NO_ORCA).loadState()).toEqual(expected());
        expect(readdirSync(dir).filter((f) => f.startsWith("reap-state.json.corrupt-"))).toEqual([]);
        expect(readFileSync(statePath, "utf8")).toBe(raw);
      });
    }
  });
});

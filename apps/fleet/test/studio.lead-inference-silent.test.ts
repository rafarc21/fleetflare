// apps/fleet/test/studio.lead-inference-silent.test.ts
//
// Issue #1142, item 2 (issue #911 ask): a router-led (glm/kimi/deepseek) row
// whose lead reads "working" but made ZERO router calls in the INFER window is
// silent — READY must say so. Pure rule only; the table wiring is pinned in
// test/bun/cli.fleet-ls-infer.test.ts.
import { describe, it, expect } from "vitest";
import { isLeadInferenceSilent } from "../cli/infer-format";
import type { StudioStatus } from "../src/studio/types";

const NOW = "2026-10-16T15:30:00.000Z";
const working = (partial: Partial<StudioStatus> = {}): StudioStatus =>
  ({
    id: "acme-app--web-studio", state: "running", leadType: "glm",
    observed: { activity: { state: "working", since: NOW, anchored: true, observedAt: NOW } },
    ...partial,
  } as unknown as StudioStatus);

describe("isLeadInferenceSilent (#1142 item 2)", () => {
  it("a working router-led row with a known map and no entry (0 calls) is silent", () => {
    expect(isLeadInferenceSilent(working(), undefined, true)).toBe(true);
  });

  it("a working router-led row with a 0-call entry is silent", () => {
    expect(isLeadInferenceSilent(working(), { calls: 0, ok: 0 }, true)).toBe(true);
  });

  it("no usage map at all (route unavailable) is never silent: absence there is no data, not 0", () => {
    expect(isLeadInferenceSilent(working(), undefined, false)).toBe(false);
  });

  it("any router call in the window clears it", () => {
    expect(isLeadInferenceSilent(working(), { calls: 1, ok: 1 }, true)).toBe(false);
  });

  it("a Claude-led row is never silent", () => {
    expect(isLeadInferenceSilent(working({ leadType: "claude" }), undefined, true)).toBe(false);
  });

  it("an idle router-led row is not silent: only a lead that claims to be working", () => {
    const idle = working({
      observed: { activity: { state: "idle", since: NOW, anchored: true, observedAt: NOW } } as unknown as StudioStatus["observed"],
    });
    expect(isLeadInferenceSilent(idle, undefined, true)).toBe(false);
  });
});

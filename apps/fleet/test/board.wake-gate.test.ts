import { describe, it, expect, vi } from "vitest";
import { wakeStudioFor, type WakeRefusals } from "../src/board/wake-gate";
import type { AssignWakeDeps } from "../src/board/assign-wake";

// Issue #263: the one gate behind wakeOnAssign and wakeOnComment. Wording and
// digest are caller inputs; every rule below is the gate's own.

const STUDIO = "fleetflare--web-studio";
const REPO = "acme/widgets";
const DIGEST = "WAKE SOMETHING #1";
const REFUSE: WakeRefusals = {
  unregistered: "UNREGISTERED",
  stopped: "STOPPED",
  repoMismatch: (repoSlug) => `MISMATCH ${repoSlug}`,
};

function deps(overrides: Partial<AssignWakeDeps> = {}): AssignWakeDeps {
  return {
    studioState: vi.fn(async () => ({ state: "running", repoSlug: null })),
    wake: vi.fn(async () => ({ ok: true })),
    resolveCanonicalRepo: vi.fn(async (slug: string) => slug),
    ...overrides,
  };
}

const gate = (d: AssignWakeDeps) => wakeStudioFor(d, STUDIO, { repo: REPO, digest: DIGEST, refuse: REFUSE });

describe("wakeStudioFor", () => {
  it("wakes a running studio once with its digest; repoSlug null fails open", async () => {
    const d = deps();
    expect(await gate(d)).toEqual({ woke: true, digest: DIGEST });
    expect(d.wake).toHaveBeenCalledExactlyOnceWith(STUDIO, DIGEST);
    expect(d.resolveCanonicalRepo).not.toHaveBeenCalled();
  });

  it("registry read throws → the error's own message, no wake", async () => {
    const d = deps({ studioState: vi.fn(async () => { throw new Error("D1 unavailable"); }) });
    expect(await gate(d)).toEqual({ woke: false, reason: "D1 unavailable" });
    expect(d.wake).not.toHaveBeenCalled();
  });

  it("no registry row → the caller's unregistered wording, no wake", async () => {
    const d = deps({ studioState: vi.fn(async () => null) });
    expect(await gate(d)).toEqual({ woke: false, reason: "UNREGISTERED" });
    expect(d.wake).not.toHaveBeenCalled();
  });

  it("stopped → the caller's stopped wording, no wake", async () => {
    const d = deps({ studioState: vi.fn(async () => ({ state: "stopped", repoSlug: REPO })) });
    expect(await gate(d)).toEqual({ woke: false, reason: "STOPPED" });
    expect(d.wake).not.toHaveBeenCalled();
  });

  it("repo different → the caller's mismatch wording, no wake", async () => {
    const d = deps({ studioState: vi.fn(async () => ({ state: "running", repoSlug: "acme/other" })) });
    expect(await gate(d)).toEqual({ woke: false, reason: "MISMATCH acme/other" });
    expect(d.wake).not.toHaveBeenCalled();
  });

  it("canonical lookup fails → mismatch wording plus the fail-closed suffix, no wake", async () => {
    const d = deps({
      studioState: vi.fn(async () => ({ state: "running", repoSlug: "acme/other" })),
      resolveCanonicalRepo: vi.fn(async () => { throw new Error("token mint failed"); }),
    });
    expect(await gate(d)).toEqual({
      woke: false,
      reason: "MISMATCH acme/other (canonical-name lookup failed — refusing the wake to be safe)",
    });
    expect(d.wake).not.toHaveBeenCalled();
  });

  it("wake throws or is non-ok → the waker's own words, or a stated fallback", async () => {
    const threw = deps({ wake: vi.fn(async () => { throw new Error("DO unreachable"); }) });
    expect(await gate(threw)).toEqual({ woke: false, reason: "DO unreachable" });
    const refused = deps({ wake: vi.fn(async () => ({ ok: false, error: "refused: pane busy" })) });
    expect(await gate(refused)).toEqual({ woke: false, reason: "refused: pane busy" });
    const silent = deps({ wake: vi.fn(async () => ({ ok: false })) });
    expect(await gate(silent)).toEqual({ woke: false, reason: "wake failed for an unstated reason" });
  });
});

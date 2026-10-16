// #1082 (refs #715): the per-PR gate run pointer on the real D1 binding
// (migration 0007, gate_pr_head). A new head sha reads the PR's previous run
// here to end it; the pointer is overwritten by every new run.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { d1RunIndex } from "../src/gate/auto-run-env";

describe("d1RunIndex: the latest gate run per PR", () => {
  it("a PR with no recorded run has no latest run", async () => {
    expect(await d1RunIndex(env.DB).latest("acme/index-empty", 1)).toBeNull();
  });

  it("record then latest returns the recorded head sha and run id", async () => {
    const index = d1RunIndex(env.DB);
    await index.record("acme/index-one", 3, { headSha: "a".repeat(40), runId: "gate-run-a" });
    expect(await index.latest("acme/index-one", 3)).toMatchObject({ headSha: "a".repeat(40), runId: "gate-run-a" });
  });

  it("a later record replaces the earlier pointer for the same PR", async () => {
    const index = d1RunIndex(env.DB);
    await index.record("acme/index-two", 4, { headSha: "a".repeat(40), runId: "gate-run-a" });
    await index.record("acme/index-two", 4, { headSha: "b".repeat(40), runId: "gate-run-b" });
    expect(await index.latest("acme/index-two", 4)).toMatchObject({ headSha: "b".repeat(40), runId: "gate-run-b" });
  });

  it("keeps PRs apart by number, and repos apart by name", async () => {
    const index = d1RunIndex(env.DB);
    await index.record("acme/index-three", 5, { headSha: "a".repeat(40), runId: "gate-run-five" });
    expect(await index.latest("acme/index-three", 6)).toBeNull();
    expect(await index.latest("acme/index-other", 5)).toBeNull();
  });

  it("matches the repo case-insensitively, like the gate config does", async () => {
    const index = d1RunIndex(env.DB);
    await index.record("Acme/Index-Case", 7, { headSha: "a".repeat(40), runId: "gate-run-case" });
    expect(await index.latest("acme/index-case", 7)).toMatchObject({ headSha: "a".repeat(40), runId: "gate-run-case" });
  });
});

describe("d1RunIndex: the infra handoff and the progress stamp are single conditional writes (#1135)", () => {
  it("handOff moves the pointer only while it still names the first run", async () => {
    const index = d1RunIndex(env.DB);
    await index.record("acme/handoff-one", 8, { headSha: "a".repeat(40), runId: "gate-run-first" });
    expect(await index.handOff("acme/handoff-one", 8, "gate-run-first", { headSha: "a".repeat(40), runId: "rerun-first", progressedAt: 9 }))
      .toBe(true);
    expect(await index.latest("acme/handoff-one", 8)).toMatchObject({ runId: "rerun-first", progressedAt: 9 });
  });

  it("handOff is refused once a newer push replaced the pointer: the newer run keeps it", async () => {
    const index = d1RunIndex(env.DB);
    await index.record("acme/handoff-two", 9, { headSha: "b".repeat(40), runId: "gate-run-newer" });
    expect(await index.handOff("acme/handoff-two", 9, "gate-run-first", { headSha: "a".repeat(40), runId: "rerun-first" }))
      .toBe(false);
    expect(await index.latest("acme/handoff-two", 9)).toMatchObject({ headSha: "b".repeat(40), runId: "gate-run-newer" });
  });

  it("progress stamps only the pointed run; a superseded run's progress changes nothing", async () => {
    const index = d1RunIndex(env.DB);
    await index.record("acme/progress-one", 10, { headSha: "a".repeat(40), runId: "gate-run-live", progressedAt: 1 });
    await index.progress("acme/progress-one", 10, "gate-run-live", 50);
    expect(await index.latest("acme/progress-one", 10)).toMatchObject({ runId: "gate-run-live", progressedAt: 50 });
    await index.progress("acme/progress-one", 10, "gate-run-gone", 99);
    expect(await index.latest("acme/progress-one", 10)).toMatchObject({ runId: "gate-run-live", progressedAt: 50 });
  });
});

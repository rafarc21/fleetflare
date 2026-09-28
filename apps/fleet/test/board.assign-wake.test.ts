import { describe, it, expect, vi } from "vitest";
import { assignDigest, wakeOnAssign, checkAssignRepo, type AssignWakeDeps } from "../src/board/assign-wake";

// Board issue #41, half one — the edge from "task assigned to studio X" to
// "wake studio X", whatever X's role is. Pure over two ports, so every rule
// below is proven with no DO, no registry and no container.

const STUDIO = "fleetflare--release-studio";
const TASK = { number: 42, title: "Assigning a task wakes nothing", repo: "acme/widgets" };

function deps(overrides: Partial<AssignWakeDeps> = {}): AssignWakeDeps {
  return {
    studioState: vi.fn(async () => ({ state: "running", repoSlug: null })),
    wake: vi.fn(async () => ({ ok: true })),
    // Identity by default: no rename in play, so `sameRepoSlug`'s raw
    // case-insensitive compare decides every existing test here exactly as
    // it did before issue #284 round 2 added this port.
    resolveCanonicalRepo: vi.fn(async (slug: string) => slug),
    ...overrides,
  };
}

describe("assignDigest — a pointer, never a copy", () => {
  it("carries the issue number and title and tells the lead where to read it", () => {
    const digest = assignDigest(TASK);
    expect(digest).toContain("#42");
    expect(digest).toContain("Assigning a task wakes nothing");
    expect(digest).toContain("fleet task show 42");
  });

  it("is ONE line — a newline in the claude TUI submits the turn", () => {
    // A title cannot hold a newline on GitHub, but a digest that could ever
    // produce one would arrive as two half-prompts.
    expect(assignDigest({ number: 7, title: "first\nsecond\r\n  third " })).not.toMatch(/[\r\n]/);
  });

  it("carries no brief body at all — the lead reads the issue itself", () => {
    expect(assignDigest({ number: 42, title: "t" }).length).toBeLessThan(200);
  });

  // Board issue #158's spec gap: the --why text an operator types on a
  // same-studio re-assign never reached the digest. Additive-only — absent
  // `why` must never change a single byte of today's output.
  it("is byte-identical to today's output when `why` is absent", () => {
    expect(assignDigest(TASK)).toBe(
      `WAKE TASK ASSIGNED #${TASK.number} "${TASK.title}" | read it: fleet task show ${TASK.number}`,
    );
    expect(assignDigest(TASK, null)).toBe(assignDigest(TASK));
    expect(assignDigest(TASK, undefined)).toBe(assignDigest(TASK));
  });

  it("inserts the why text before `| read it:`, when given", () => {
    const digest = assignDigest(TASK, "please look at the flaky test first");
    expect(digest).toContain(' | why: please look at the flaky test first | read it:');
  });

  it("collapses a multi-line why into ONE line, capped at 160 characters", () => {
    const why = "line one\nline two\r\n   line three   " + "x".repeat(200);
    const digest = assignDigest(TASK, why);
    expect(digest).not.toMatch(/[\r\n]/);
    const match = /\| why: (.*) \| read it:/.exec(digest);
    expect(match).not.toBeNull();
    expect(match![1].length).toBeLessThanOrEqual(160);
  });
});

describe("wakeOnAssign", () => {
  it("wakes a RUNNING non-maestro studio exactly once, carrying that issue number", async () => {
    const d = deps();
    const report = await wakeOnAssign(d, STUDIO, TASK);
    expect(report).toEqual({ woke: true, digest: assignDigest(TASK) });
    expect(d.wake).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.wake).mock.calls[0][0]).toBe(STUDIO);
    expect(vi.mocked(d.wake).mock.calls[0][1]).toContain("#42");
  });

  it("issues NO wake to a stopped studio and reports why", async () => {
    const d = deps({ studioState: vi.fn(async () => ({ state: "stopped", repoSlug: null })) });
    const report = await wakeOnAssign(d, STUDIO, TASK);
    expect(d.wake).not.toHaveBeenCalled();
    expect(report.woke).toBe(false);
    if (!report.woke) {
      expect(report.reason).toContain("stopped");
      expect(report.reason).toContain(STUDIO);
      expect(report.reason).toContain("costs money");
      // The reason must promise what bring-up ACTUALLY does now (delivers the
      // task on bring-up via deliverAssignedTaskOnBringup), not merely that
      // the task is "waiting on its board" with no mechanism to reach it.
      expect(report.reason).toContain("task is delivered on bring-up");
      expect(report.reason).not.toContain("is waiting on its board");
    }
  });

  it("issues NO wake to a studio the registry has never heard of — idFromName would mint a phantom DO", async () => {
    // Board #40/#49's failure mode: a wake delivered to a Durable Object
    // nothing else uses succeeds, supervises nothing, and is silent.
    const d = deps({ studioState: vi.fn(async () => null) });
    const report = await wakeOnAssign(d, STUDIO, TASK);
    expect(d.wake).not.toHaveBeenCalled();
    expect(report.woke).toBe(false);
    if (!report.woke) expect(report.reason).toContain("not in the fleet registry");
  });

  it("reports a refused wake in the waker's own words rather than rewriting them", async () => {
    const d = deps({ wake: vi.fn(async () => ({ ok: false, error: "refused: studio is stopped" })) });
    const report = await wakeOnAssign(d, STUDIO, TASK);
    expect(report.woke).toBe(false);
    if (!report.woke) expect(report.reason).toBe("refused: studio is stopped");
  });

  it("is total — a thrown RPC is a reported failure, never an exception into the assign path", async () => {
    const d = deps({ wake: vi.fn(async () => { throw new Error("DO unreachable"); }) });
    const report = await wakeOnAssign(d, STUDIO, TASK);
    expect(report.woke).toBe(false);
    if (!report.woke) expect(report.reason).toContain("DO unreachable");
  });

  it("board #158: threads `why` into the digest it actually sends to the studio", async () => {
    const d = deps();
    const report = await wakeOnAssign(d, STUDIO, TASK, "wake up, please check the PR");
    expect(report).toEqual({ woke: true, digest: assignDigest(TASK, "wake up, please check the PR") });
    expect(vi.mocked(d.wake).mock.calls[0][1]).toContain("wake up, please check the PR");
  });

  it("is total when the registry read itself throws", async () => {
    const d = deps({ studioState: vi.fn(async () => { throw new Error("D1 unavailable"); }) });
    const report = await wakeOnAssign(d, STUDIO, TASK);
    expect(d.wake).not.toHaveBeenCalled();
    expect(report.woke).toBe(false);
    if (!report.woke) expect(report.reason).toContain("D1 unavailable");
  });
});

// Issue #278: a wake into a studio provisioned for a DIFFERENT repo used to
// go out anyway — the studio's own DO then resolved the woken task NUMBER
// against ITS OWN repo (a task number is only unique within one repo), got a
// 404 from `fleet task show <n>`, and the lead correctly refused. The CLI
// still reported "woke the studio" as if the dispatch had worked. This is
// the up-front refusal that replaces that wasted round trip.
describe("wakeOnAssign — refuses a wake into a studio for a different repo (issue #278)", () => {
  it("refuses when the studio's own repoSlug differs from the task's repo, naming both, and never calls wake", async () => {
    const d = deps({ studioState: vi.fn(async () => ({ state: "running", repoSlug: "acme/other" })) });
    const report = await wakeOnAssign(d, STUDIO, TASK);
    expect(d.wake).not.toHaveBeenCalled();
    expect(report.woke).toBe(false);
    if (!report.woke) {
      expect(report.reason).toContain(STUDIO);
      expect(report.reason).toContain("acme/other");
      expect(report.reason).toContain(TASK.repo);
    }
  });

  it("the repo compare is case-insensitive, same convention as github/api.ts's sameRepo helpers", async () => {
    const d = deps({ studioState: vi.fn(async () => ({ state: "running", repoSlug: TASK.repo.toUpperCase() })) });
    const report = await wakeOnAssign(d, STUDIO, TASK);
    expect(d.wake).toHaveBeenCalledTimes(1);
    expect(report.woke).toBe(true);
  });

  it("wakes normally when the studio's repoSlug matches the task's repo — unchanged existing behavior", async () => {
    const d = deps({ studioState: vi.fn(async () => ({ state: "running", repoSlug: TASK.repo })) });
    const report = await wakeOnAssign(d, STUDIO, TASK);
    expect(d.wake).toHaveBeenCalledTimes(1);
    expect(report).toEqual({ woke: true, digest: assignDigest(TASK) });
  });

  it("fails OPEN when repoSlug is null — a pre-feature studio with no recorded repo, unchanged from today", async () => {
    const d = deps({ studioState: vi.fn(async () => ({ state: "running", repoSlug: null })) });
    const report = await wakeOnAssign(d, STUDIO, TASK);
    expect(d.wake).toHaveBeenCalledTimes(1);
    expect(report.woke).toBe(true);
  });

  // Issue #284 round 2 (issue #268's own fix, reused): a naive
  // `.toLowerCase() !==` compare FALSE-REFUSES after a GitHub rename or
  // ownership transfer, since the studio's own recorded `repoSlug` goes
  // stale the moment the repo moves and nothing re-writes it. Live example
  // this closes: `acme-org/acme-os` transferred to `acme-hq/acme-os` —
  // GitHub's own API still resolves both to the same repo.
  it("issue #268's canonical-name match: a studio recorded against the repo's OLD name still matches its current one after a rename/transfer", async () => {
    const RENAMED_TASK = { ...TASK, repo: "acme-hq/acme-os" };
    const resolveCanonicalRepo = vi.fn(async (slug: string) =>
      slug === "acme-org/acme-os" ? "acme-hq/acme-os" : slug);
    const d = deps({
      studioState: vi.fn(async () => ({ state: "running", repoSlug: "acme-org/acme-os" })),
      resolveCanonicalRepo,
    });
    const report = await wakeOnAssign(d, STUDIO, RENAMED_TASK);
    expect(resolveCanonicalRepo).toHaveBeenCalledWith("acme-org/acme-os");
    expect(d.wake).toHaveBeenCalledTimes(1);
    expect(report.woke).toBe(true);
  });

  it("still refuses a genuinely different repo even once GitHub's canonical name for the stale slug is known", async () => {
    const resolveCanonicalRepo = vi.fn(async (slug: string) =>
      slug === "acme-org/acme-os" ? "acme-hq/acme-os" : slug);
    const d = deps({
      studioState: vi.fn(async () => ({ state: "running", repoSlug: "acme-org/acme-os" })),
      resolveCanonicalRepo,
    });
    // TASK.repo ("acme/widgets") is neither the stale slug nor its canonical
    // name -- a real mismatch, not a rename.
    const report = await wakeOnAssign(d, STUDIO, TASK);
    expect(d.wake).not.toHaveBeenCalled();
    expect(report.woke).toBe(false);
  });
});

// Issue #295, bug 1: the round-2 fix above (issue #284) resolved only the
// STUDIO's recorded slug (`a`) to canonical, never the TASK's own repo (`b`).
// A studio recorded against a repo's NEW canonical name, checked against a
// task filed with the OLD stale name (a leftover git remote or `--repo`
// flag), never matched: resolving `a` (already canonical) leaves it
// unchanged, and that still doesn't equal raw `b`. Reverse of the #284
// fixture on purpose — same rename, opposite side stale.
describe("issue #295 bug 1: reverse rename — studio holds the NEW name, task carries the OLD one", () => {
  const RENAMED_TASK = { ...TASK, repo: "acme-org/acme-os" };
  function reverseRenameCanonical() {
    return vi.fn(async (slug: string) => (slug === "acme-org/acme-os" ? "acme-hq/acme-os" : slug));
  }

  it("wakeOnAssign wakes — was a false refusal before #284 and a false 409 after it", async () => {
    const resolveCanonicalRepo = reverseRenameCanonical();
    const d = deps({
      studioState: vi.fn(async () => ({ state: "running", repoSlug: "acme-hq/acme-os" })),
      resolveCanonicalRepo,
    });
    const report = await wakeOnAssign(d, STUDIO, RENAMED_TASK);
    expect(resolveCanonicalRepo).toHaveBeenCalledWith("acme-org/acme-os");
    expect(d.wake).toHaveBeenCalledTimes(1);
    expect(report.woke).toBe(true);
  });

  it("checkAssignRepo lets the write through — was a hard 409 before this fix", async () => {
    const resolveCanonicalRepo = reverseRenameCanonical();
    const d = deps({
      studioState: vi.fn(async () => ({ state: "running", repoSlug: "acme-hq/acme-os" })),
      resolveCanonicalRepo,
    });
    const check = await checkAssignRepo(d, STUDIO, RENAMED_TASK.repo);
    expect(check.ok).toBe(true);
  });
});

// Issue #295, bug 2: a `resolveCanonicalRepo` throw (token/network failure)
// used to collapse into "different repo" for BOTH callers. The write-gate
// (`checkAssignRepo`) must fail OPEN — a lookup hiccup should never block a
// label write — while the wake-gate (`wakeOnAssign`) must keep failing
// CLOSED, since a wake into the wrong studio is the expensive mistake.
describe("issue #295 bug 2: a canonical-lookup failure allows the write but still refuses the wake", () => {
  const REPO_SLUG = "acme/foo";
  const TASK_REPO = "acme/bar"; // raw slugs genuinely differ, so a lookup is actually needed to decide

  function throwingCanonical() {
    return vi.fn(async () => {
      throw new Error("GitHub token expired");
    });
  }

  it("checkAssignRepo returns {ok:true} with a warning surfaced in the return value", async () => {
    const d = deps({
      studioState: vi.fn(async () => ({ state: "running", repoSlug: REPO_SLUG })),
      resolveCanonicalRepo: throwingCanonical(),
    });
    const check = await checkAssignRepo(d, STUDIO, TASK_REPO);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.warning).toBeTruthy();
      expect(check.warning).toContain(REPO_SLUG);
      expect(check.warning).toContain(TASK_REPO);
    }
  });

  it("wakeOnAssign still refuses the wake under the exact same lookup failure — fail closed", async () => {
    const d = deps({
      studioState: vi.fn(async () => ({ state: "running", repoSlug: REPO_SLUG })),
      resolveCanonicalRepo: throwingCanonical(),
    });
    const report = await wakeOnAssign(d, STUDIO, { ...TASK, repo: TASK_REPO });
    expect(d.wake).not.toHaveBeenCalled();
    expect(report.woke).toBe(false);
  });
});

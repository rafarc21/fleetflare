import { describe, it, expect, vi } from "vitest";
import { commentDigest, qualifiesForCommentWake, wakeOnComment } from "../src/board/comment-wake";
import { doneRecordComment } from "../src/studio/do";
import type { AssignWakeDeps } from "../src/board/assign-wake";

// Board issue #236's wake edge, and issue #284 round 2's own addition to it:
// a repo-mismatch check, reusing issue #268's canonical-nameWithOwner match
// (github/wake-events.ts's sameRepoSlug) rather than a naive lowercase-only
// compare. Pure over the same AssignWakeDeps port assign-wake.ts's own tests
// use, so every rule below is proven with no DO, no registry and no
// container.

const STUDIO = "fleetflare--web-studio";
const TASK = { number: 231, title: "unblock me", repo: "acme-org/websites" };
const COMMENT_URL = "https://github.com/acme-org/websites/issues/231#issuecomment-1";

function deps(overrides: Partial<AssignWakeDeps> = {}): AssignWakeDeps {
  return {
    studioState: vi.fn(async () => ({ state: "running", repoSlug: null })),
    wake: vi.fn(async () => ({ ok: true })),
    // Identity by default: no rename in play, so `sameRepoSlug`'s raw
    // case-insensitive compare decides.
    resolveCanonicalRepo: vi.fn(async (slug: string) => slug),
    ...overrides,
  };
}

describe("wakeOnComment", () => {
  it("wakes a RUNNING assignee exactly once, carrying the comment URL", async () => {
    const d = deps();
    const report = await wakeOnComment(d, STUDIO, TASK, COMMENT_URL);
    expect(report).toEqual({ woke: true, digest: commentDigest(TASK, COMMENT_URL) });
    expect(d.wake).toHaveBeenCalledTimes(1);
  });

  it("issues no wake to a stopped studio and reports why", async () => {
    const d = deps({ studioState: vi.fn(async () => ({ state: "stopped", repoSlug: null })) });
    const report = await wakeOnComment(d, STUDIO, TASK, COMMENT_URL);
    expect(d.wake).not.toHaveBeenCalled();
    expect(report.woke).toBe(false);
  });

  it("issues no wake to a studio the registry has never heard of", async () => {
    const d = deps({ studioState: vi.fn(async () => null) });
    const report = await wakeOnComment(d, STUDIO, TASK, COMMENT_URL);
    expect(d.wake).not.toHaveBeenCalled();
    expect(report.woke).toBe(false);
  });
});

// Issue #284 round 2: comment-wake had NO repo-slug validation at all before
// this fix -- a stale, hand-edited, or legacy cross-repo `studio:` label on
// an issue could wake the wrong studio via a comment trigger indefinitely,
// bypassing the protection assign-wake.ts already has at assignment time.
describe("wakeOnComment -- refuses a wake into a studio for a different repo (issue #284 round 2)", () => {
  it("refuses when the assignee's own repoSlug differs from the comment's repo, naming both, and never calls wake", async () => {
    const d = deps({ studioState: vi.fn(async () => ({ state: "running", repoSlug: "acme/other" })) });
    const report = await wakeOnComment(d, STUDIO, TASK, COMMENT_URL);
    expect(d.wake).not.toHaveBeenCalled();
    expect(report.woke).toBe(false);
    if (!report.woke) {
      expect(report.reason).toContain(STUDIO);
      expect(report.reason).toContain("acme/other");
      expect(report.reason).toContain(TASK.repo);
    }
  });

  it("wakes normally when the assignee's repoSlug matches the comment's own repo -- the common case", async () => {
    const d = deps({ studioState: vi.fn(async () => ({ state: "running", repoSlug: TASK.repo })) });
    const report = await wakeOnComment(d, STUDIO, TASK, COMMENT_URL);
    expect(d.wake).toHaveBeenCalledTimes(1);
    expect(report.woke).toBe(true);
  });

  it("the repo compare is case-insensitive", async () => {
    const d = deps({ studioState: vi.fn(async () => ({ state: "running", repoSlug: TASK.repo.toUpperCase() })) });
    const report = await wakeOnComment(d, STUDIO, TASK, COMMENT_URL);
    expect(d.wake).toHaveBeenCalledTimes(1);
    expect(report.woke).toBe(true);
  });

  it("fails OPEN when repoSlug is null -- a pre-feature studio with no recorded repo", async () => {
    const d = deps({ studioState: vi.fn(async () => ({ state: "running", repoSlug: null })) });
    const report = await wakeOnComment(d, STUDIO, TASK, COMMENT_URL);
    expect(d.wake).toHaveBeenCalledTimes(1);
    expect(report.woke).toBe(true);
  });

  // Issue #268's canonical-name match, reused (not re-derived): a naive
  // `.toLowerCase() !==` compare here would FALSE-REFUSE every comment on
  // this task forever, once the repo it names has been renamed or
  // transferred -- unlike a one-shot assignment mismatch, a comment trigger
  // fires repeatedly, so this failure mode is the more persistent one.
  it("matches across a rename/transfer -- the assignee's repoSlug is the OLD name, GitHub's canonical name for it is the comment's repo", async () => {
    const RENAMED_TASK = { ...TASK, repo: "acme-hq/acme-os" };
    const resolveCanonicalRepo = vi.fn(async (slug: string) =>
      slug === "acme-org/acme-os" ? "acme-hq/acme-os" : slug);
    const d = deps({
      studioState: vi.fn(async () => ({ state: "running", repoSlug: "acme-org/acme-os" })),
      resolveCanonicalRepo,
    });
    const report = await wakeOnComment(d, STUDIO, RENAMED_TASK, COMMENT_URL);
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
    const report = await wakeOnComment(d, STUDIO, TASK, COMMENT_URL);
    expect(d.wake).not.toHaveBeenCalled();
    expect(report.woke).toBe(false);
  });
});

// Issue #295 bug 1: reverse of the rename fixture above -- the assignee's
// OWN recorded repoSlug is already the NEW canonical name, and the comment's
// task carries the OLD stale one (a leftover git remote / --repo flag).
// Resolving only the assignee's side (the round-2 fix's own gap) never
// resolves the stale side back to canonical, so this used to false-refuse.
describe("wakeOnComment -- issue #295 bug 1: reverse rename (studio holds the NEW name)", () => {
  it("wakes when the studio's repoSlug is already canonical and the comment's task carries the old name", async () => {
    const RENAMED_TASK = { ...TASK, repo: "acme-org/acme-os" };
    const resolveCanonicalRepo = vi.fn(async (slug: string) =>
      slug === "acme-org/acme-os" ? "acme-hq/acme-os" : slug);
    const d = deps({
      studioState: vi.fn(async () => ({ state: "running", repoSlug: "acme-hq/acme-os" })),
      resolveCanonicalRepo,
    });
    const report = await wakeOnComment(d, STUDIO, RENAMED_TASK, COMMENT_URL);
    expect(resolveCanonicalRepo).toHaveBeenCalledWith("acme-org/acme-os");
    expect(d.wake).toHaveBeenCalledTimes(1);
    expect(report.woke).toBe(true);
  });
});

// Issue #295 bug 2: a canonical-lookup failure must keep refusing the wake
// here too -- wakes fail CLOSED always, only the write-gate (checkAssignRepo,
// in assign-wake.ts) fails open.
describe("wakeOnComment -- issue #295 bug 2: a canonical-lookup failure still refuses the wake", () => {
  it("refuses the wake when resolveCanonicalRepo throws for a genuinely undetermined repo pair", async () => {
    const d = deps({
      studioState: vi.fn(async () => ({ state: "running", repoSlug: "acme/foo" })),
      resolveCanonicalRepo: vi.fn(async () => { throw new Error("GitHub token expired"); }),
    });
    const report = await wakeOnComment(d, STUDIO, { ...TASK, repo: "acme/bar" }, COMMENT_URL);
    expect(d.wake).not.toHaveBeenCalled();
    expect(report.woke).toBe(false);
  });
});

// #363 review round 2: a completion record posted on its task (FLEET_OPS_REPO
// unset) is the fleet filing paperwork, never an answer. On a token-auth repo
// its author is a human login, so the [bot] filter does not catch it.
describe("a completion-record comment never wakes the task's studio", () => {
  it("excluded even on an input_required task, from a non-bot author", () => {
    expect(qualifiesForCommentWake("input_required", doneRecordComment("websites--pilot", "{}"), "rafarc21")).toBe(false);
  });
});

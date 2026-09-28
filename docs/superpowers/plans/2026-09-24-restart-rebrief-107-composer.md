# Restart re-brief composer (#107) Implementation Plan

> **Superseded (2026-09-24 review fix):** Task 2/Step 3's original
> implementation below (plain-array `taskBranches`/`openPrs`, silent
> exclusion of a 0-ahead branch, `"none on file"` for an unknown snapshot)
> was rewritten to fix the review's core complaint -- the composer could not
> tell "not checked" from "nothing there." See the spec's PR4a/PR4b sections
> and `apps/fleet/src/studio/survival-brief.ts` for the current shape
> (`Checked<T>` sections, never a silently dropped task or PR). This plan
> doc is left as-written for history; do not follow Task 2 literally.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure function that composes a "what survived" text block (task branches on origin, open PRs, last session-snapshot age) for a restarted lead — the composition only, not its delivery.

**Architecture:** One new pure, dependency-free module (`apps/fleet/src/studio/survival-brief.ts`) taking plain data and returning a formatted string. No I/O, no wiring into any wake/bring-up path in this PR.

**Tech Stack:** TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-24-row-tells-truth-design.md` (this plan implements its new "PR4a" addendum section, added by Task 1 below).

## Global Constraints

- Worker + CLI only. Zero changes under `apps/fleet/container/`.
- A branch counts as "surviving" only when it has commits ahead of main — never merely existing on origin (the fleet's own `#98` push-discipline rule: "count commits, never refs", an empty-but-pushed branch must never read as success/survival).
- No delivery wiring in this PR — that depends on `#85` PR1 (session verdict, `Observed.lastSnapshotAt`) and `#99` (modal gate) merging to main first.
- Push after the first RED commit and every commit after (fleet-wide house rule, `#98`/`#111`).

---

## Task 1: Spec addendum

**Files:**
- Modify: `docs/superpowers/specs/2026-09-24-row-tells-truth-design.md`

Insert a new `## PR4 — a restarted lead learns what survived (#107)` section immediately AFTER the existing `## PR3 — activity states` section ends and BEFORE the `## Out of scope` heading (read the file first to find that exact boundary — it's between PR3's last bullet list and the `## Out of scope` heading).

Insert exactly this text (adjust only if the surrounding doc's own heading level/style differs from what's shown — match the file's existing markdown conventions for spacing):

```markdown
## PR4 — a restarted lead learns what survived (#107)

Measured 2026-09-24 by the BETA coordinator: after a recycle,
`demosite-life--release-studio`'s lead pushed a real commit 6 minutes after a
re-brief that named its surviving branches (`fix-796-t6-error-surface`,
13:38:11Z). Three earlier recycle rounds on the same studio lost everything;
round 4 recovered in minutes once told what was still on origin. The
expensive part of a recovery was never the container — it was the lead not
knowing what survived. Studio clones are shallow and single-branch
(fleet-cockpit's own note: "rescue branch invisible to the next container"),
so a fresh lead cannot even see its own pushed branches without being told.

Today every coordinator does this re-brief by hand, reading `git log
origin/main..origin/<branch>` and the board by eye. This spec section covers
the composition only (PR4a); delivery is PR4b, below.

### PR4a — the composer (this PR)

The PURE composition: given a studio's assigned task branches, open PRs, and
last session-snapshot age, produce the "what survived" text block. No I/O, no
delivery, no wiring into any wake/bring-up path.

`apps/fleet/src/studio/survival-brief.ts`:

```ts
export interface SurvivalTaskBranch {
  taskNumber: number;
  taskTitle: string;
  branch: string;
  commitsAheadOfMain: number;
  lastCommitAt: string | null;
}

export interface SurvivalOpenPr {
  number: number;
  title: string;
  branch: string;
}

export interface SurvivalInput {
  studioId: string;
  taskBranches: SurvivalTaskBranch[];
  openPrs: SurvivalOpenPr[];
  lastSnapshotAgeS: number | null;
  now: string;
}

export function composeSurvivalBrief(input: SurvivalInput): string;
```

Design decisions:
- A branch with 0 commits ahead of main is excluded entirely — same
  discipline the fleet's own `#98` push-rule already encodes elsewhere in
  this repo ("count commits, never refs"; an empty-but-pushed branch must
  never read as survived work). A future caller supplies
  `commitsAheadOfMain` from `git log origin/main..origin/<branch> --oneline
  | wc -l`, never from a ref-existence check.
- Every age is computed from a stored ISO timestamp at composition time (the
  `now` parameter) — same Principle 1 PR1 already established: the reader
  computes age, nothing stores a pre-rendered string.
- Fully self-contained. Does not import PR1's `formatAge`/`Observed` types
  (that branch is not merged to main yet, and `cli/readiness-format.ts`
  importing FROM `src/studio/` — never the other way — is this codebase's
  established direction; see that file's own header comment). Its own tiny
  age-bucketing helper duplicates a few lines of `formatAge`'s logic; once
  `#85` PR1 merges, consolidating the two is a one-line follow-up, not a
  blocker for this PR.
- Empty input (no live task branches, no open PRs, no known snapshot)
  composes to `""` — the empty string is itself the signal that there is
  nothing worth re-briefing about; a future caller (PR4b) decides whether to
  skip delivery entirely on an empty result.

### PR4b — delivery (future, blocked, not in this PR)

On every bring-up that follows a detected replacement (recycle, heal,
rollout-detected replacement — i.e. `#85` PR1's `via` field reading anything
but a routine restart with a `resumed` verdict), the Worker composes this
block from live data (assigned board tasks' branches, checked via `git log
origin/main..origin/<branch>`, counting commits never refs; open PRs for
those tasks; `Observed.lastSnapshotAt`) and delivers it:
- through the existing gated wake path only (reuses `#99`'s modal-detection
  gate — never deliver into a pane showing any modal);
- never on a lead that resumed its session with `--continue` AND is
  mid-task (do not interrupt live work to tell it what already survived).

Depends on `#85` PR1 (replacement detection + session verdict — supplies
`via`/`lastSnapshotAt`) and `#99` (modal gate) merging to main, and needs its
own RED tests once those land.
```

- [ ] **Step 1: Write the addendum**

Insert the block above at the location described.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-09-24-row-tells-truth-design.md
git commit -m "docs(spec): PR4 addendum -- restart re-brief composer (#107)"
```

---

## Task 2: The composer, TDD

**Files:**
- Create: `apps/fleet/src/studio/survival-brief.ts`
- Test: `apps/fleet/test/studio.survival-brief.test.ts`

**Interfaces:**
- Produces: `SurvivalTaskBranch`, `SurvivalOpenPr`, `SurvivalInput`, `composeSurvivalBrief(input: SurvivalInput): string` — all from `apps/fleet/src/studio/survival-brief.ts`. No other task in this repo consumes these yet (PR4b, a future PR, will).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/fleet/test/studio.survival-brief.test.ts
import { describe, it, expect } from "vitest";
import { composeSurvivalBrief, type SurvivalInput } from "../src/studio/survival-brief";

const NOW = "2026-09-24T14:00:00.000Z";

function baseInput(overrides: Partial<SurvivalInput> = {}): SurvivalInput {
  return {
    studioId: "demosite-life--release-studio",
    taskBranches: [],
    openPrs: [],
    lastSnapshotAgeS: null,
    now: NOW,
    ...overrides,
  };
}

describe("composeSurvivalBrief (issue #107)", () => {
  it("everything empty: no task branches, no open PRs, no snapshot -> empty string", () => {
    expect(composeSurvivalBrief(baseInput())).toBe("");
  });

  it("a task branch with commits ahead is listed, age computed from lastCommitAt", () => {
    const input = baseInput({
      taskBranches: [{
        taskNumber: 796, taskTitle: "error surface", branch: "fix-796-t6-error-surface",
        commitsAheadOfMain: 3, lastCommitAt: "2026-09-24T13:54:00.000Z",
      }],
    });
    expect(composeSurvivalBrief(input)).toBe(
      "What survived, demosite-life--release-studio:\n" +
      "- Task #796 \"error surface\": fix-796-t6-error-surface — 3 commits ahead of main, last 6m ago\n" +
      "- Last session snapshot: none on file",
    );
  });

  it("a branch with ZERO commits ahead of main is excluded entirely -- an empty-but-pushed branch must never read as survived (same discipline as the fleet's own push-verification rule: count commits, never refs)", () => {
    const input = baseInput({
      taskBranches: [{
        taskNumber: 100, taskTitle: "nothing pushed yet", branch: "fix-100-stub",
        commitsAheadOfMain: 0, lastCommitAt: null,
      }],
    });
    expect(composeSurvivalBrief(input)).toBe("");
  });

  it("singular commit word for exactly 1 commit ahead", () => {
    const input = baseInput({
      taskBranches: [{
        taskNumber: 1, taskTitle: "x", branch: "fix-1-x",
        commitsAheadOfMain: 1, lastCommitAt: "2026-09-24T13:59:00.000Z",
      }],
    });
    expect(composeSurvivalBrief(input)).toContain("1 commit ahead of main");
  });

  it("multiple task branches sort by task number ascending, regardless of input order", () => {
    const input = baseInput({
      taskBranches: [
        { taskNumber: 90, taskTitle: "later", branch: "fix-90", commitsAheadOfMain: 1, lastCommitAt: "2026-09-24T13:59:00.000Z" },
        { taskNumber: 12, taskTitle: "earlier", branch: "fix-12", commitsAheadOfMain: 2, lastCommitAt: "2026-09-24T13:59:00.000Z" },
      ],
    });
    const out = composeSurvivalBrief(input);
    expect(out.indexOf("#12")).toBeLessThan(out.indexOf("#90"));
  });

  it("open PRs are listed, sorted by number ascending", () => {
    const input = baseInput({
      openPrs: [
        { number: 121, title: "row tells the truth", branch: "worktree-row-tells-truth-85-pr1" },
        { number: 55, title: "earlier pr", branch: "fix-55" },
      ],
    });
    const out = composeSurvivalBrief(input);
    expect(out).toContain("- Open PR #55: earlier pr (fix-55)");
    expect(out).toContain("- Open PR #121: row tells the truth (worktree-row-tells-truth-85-pr1)");
    expect(out.indexOf("#55")).toBeLessThan(out.indexOf("#121"));
  });

  it("a known snapshot age renders as an age, not the literal null", () => {
    const input = baseInput({ lastSnapshotAgeS: 180 });
    expect(composeSurvivalBrief(input)).toBe(
      "What survived, demosite-life--release-studio:\n- Last session snapshot: 3m ago",
    );
  });

  it("no snapshot known renders 'none on file', never a bare null or undefined", () => {
    const input = baseInput({
      taskBranches: [{ taskNumber: 5, taskTitle: "t", branch: "b", commitsAheadOfMain: 1, lastCommitAt: null }],
    });
    const out = composeSurvivalBrief(input);
    expect(out).toContain("- Last session snapshot: none on file");
    expect(out).not.toContain("null");
    expect(out).not.toContain("undefined");
  });

  it("lastCommitAt null on a branch that DOES have commits ahead (e.g. the git log lookup failed) renders 'unknown', never crashes", () => {
    const input = baseInput({
      taskBranches: [{ taskNumber: 5, taskTitle: "t", branch: "b", commitsAheadOfMain: 2, lastCommitAt: null }],
    });
    expect(composeSurvivalBrief(input)).toContain("last unknown");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/fleet && bun x vitest run test/studio.survival-brief.test.ts`
Expected: FAIL — `../src/studio/survival-brief` does not exist.

- [ ] **Step 3: Implement**

```ts
// apps/fleet/src/studio/survival-brief.ts

/**
 * Board issue #107 -- a restarted lead's re-brief, composed. Measured
 * 2026-09-24: a lead told what survived (its task branches still on origin)
 * recovered in 6 minutes; three earlier rounds without that re-brief lost
 * everything. This module is the PURE composition only -- no I/O, no
 * delivery. See docs/superpowers/specs/2026-09-24-row-tells-truth-design.md's
 * "PR4a" section for the full design, including why this stays
 * self-contained rather than importing PR1's formatAge (that branch is not
 * merged to main yet).
 */

export interface SurvivalTaskBranch {
  taskNumber: number;
  taskTitle: string;
  branch: string;
  /** From `git log origin/main..origin/<branch> --oneline | wc -l` -- NEVER
   *  a ref-existence check. Issue #98's own lesson: an empty-but-pushed
   *  branch must never read as survived work. */
  commitsAheadOfMain: number;
  lastCommitAt: string | null;
}

export interface SurvivalOpenPr {
  number: number;
  title: string;
  branch: string;
}

export interface SurvivalInput {
  studioId: string;
  taskBranches: SurvivalTaskBranch[];
  openPrs: SurvivalOpenPr[];
  lastSnapshotAgeS: number | null;
  /** ISO timestamp -- ages are computed from this, never pre-rendered and
   *  stored (Principle 1, same as PR1's Observed record). */
  now: string;
}

function formatSurvivalAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s >= 86400 && s % 86400 === 0) return `${s / 86400}d`;
  if (s >= 3600 && s % 3600 === 0) return `${s / 3600}h`;
  if (s < 86400) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function ageFrom(iso: string, now: string): number {
  const at = Date.parse(iso);
  const nowMs = Date.parse(now);
  return Number.isNaN(at) || Number.isNaN(nowMs) ? 0 : Math.max(0, Math.floor((nowMs - at) / 1000));
}

export function composeSurvivalBrief(input: SurvivalInput): string {
  const liveBranches = input.taskBranches.filter((b) => b.commitsAheadOfMain > 0);
  const hasSnapshot = input.lastSnapshotAgeS !== null;
  if (liveBranches.length === 0 && input.openPrs.length === 0 && !hasSnapshot) return "";

  const lines: string[] = [`What survived, ${input.studioId}:`];

  for (const b of liveBranches.slice().sort((a, c) => a.taskNumber - c.taskNumber)) {
    const commitWord = b.commitsAheadOfMain === 1 ? "commit" : "commits";
    const lastCommit = b.lastCommitAt === null ? "unknown" : `${formatSurvivalAge(ageFrom(b.lastCommitAt, input.now))} ago`;
    lines.push(
      `- Task #${b.taskNumber} "${b.taskTitle}": ${b.branch} — ${b.commitsAheadOfMain} ${commitWord} ahead of main, last ${lastCommit}`,
    );
  }

  for (const pr of input.openPrs.slice().sort((a, c) => a.number - c.number)) {
    lines.push(`- Open PR #${pr.number}: ${pr.title} (${pr.branch})`);
  }

  lines.push(
    hasSnapshot
      ? `- Last session snapshot: ${formatSurvivalAge(input.lastSnapshotAgeS as number)} ago`
      : "- Last session snapshot: none on file",
  );

  return lines.join("\n");
}
```

- [ ] **Step 4: Run to verify passing**

Run: `cd apps/fleet && bun x vitest run test/studio.survival-brief.test.ts`
Expected: PASS, all 9 tests.

- [ ] **Step 5: Full suite**

Run: `cd apps/fleet && bun run check && bun x vitest run`
Expected: PASS, no regressions (this is a brand-new, self-contained file with no other consumers yet, so nothing else should be affected).

- [ ] **Step 6: Commit**

```bash
git add apps/fleet/src/studio/survival-brief.ts apps/fleet/test/studio.survival-brief.test.ts
git commit -m "feat(studio): compose a restarted lead's 'what survived' re-brief -- pure function, no delivery yet (#107)"
```

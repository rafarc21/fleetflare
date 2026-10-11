# Plan — #402 S5-F4 repo-segment refusal fold (4 sites, 1 wording)

Refs https://github.com/rafarc21/fleetflare/issues/402 (parent sweep #394, finding F4). Tier GLM-OK, bounded ~25-line refactor, two-way door (error text only).

## Problem

One refusal concept — "this repo cannot name a studio: its short name is not a valid id segment (lowercase alphanumerics joined by single hyphens; dots and underscores fold to hyphens)" — typed four times:

- src/studio/repo.ts:161 (studioIdIn, canonical wording)
- src/studio/repo.ts:315 (resolveWorkRepo 400; the 500 twin above it is a DIFFERENT case — misconfiguration — and stays hand-rolled)
- cli/ff.ts:481 (pre-flight fail())
- cli/fleet.ts:782-786 (resolveTabsScope badSegment) — wording DRIFTED: omits the quoted "${short}"

## Change

1. New export in src/studio/repo.ts, next to repoIdSegment:

   export function refuseBadSegment(slug: string, short: string): string {
     return `repo "${slug}" cannot name a studio: "${short}" is not a valid id segment ` +
       "(lowercase alphanumerics joined by single hyphens; dots and underscores fold to hyphens)";
   }

   One doc comment naming it the canonical refusal builder; policy (400/500/CLI exit) stays at each site.

2. RED first: golden test in test/studio.repo.test.ts pinning refuseBadSegment("o/-weird", "-weird") to the exact literal (toBe, full string). Watch it fail on the missing export, commit.

3. GREEN: add helper; three src/cli sites build from it, same prefixes/exits as today. Tabs's message gains the quoted short name (the deliberate fold, two-way door). Commit.

4. Test updates in the same PR: recon found ZERO tests pin tabs's refusal wording (fleet-tabs-scope.test.ts:333 pins only ok:false + listStudios untouched) — the task's "two expectations" do not exist as pins. So ADD one: extend that test to toMatch the new canonical string, locking the fold. PR body states this discrepancy vs task text.

## Boundaries

- No shortOf(slug) helper — split stays at call sites (4 of them, each already correct).
- Tests targeted: vitest test/studio.repo.test.ts; bun test test/bun/fleet-tabs-scope.test.ts. Full suites belong to CI.
- Heavy gates: none beyond `bun run check` + `bun run english-check` at the end, one at a time.
- Steps: 2-3 (RED commit, GREEN+fold commit, test-pin commit). Review, record, PR handled by lead.

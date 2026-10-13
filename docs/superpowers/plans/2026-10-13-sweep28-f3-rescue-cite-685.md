# Sweep 28 F3 — rescue.ts stale plan-doc cite (issue #685)

Task: https://github.com/rafarc21/fleetflare/issues/685
Findings doc (sweep 28): https://github.com/rafarc21/fleetflare/blob/main/docs/maintainability/2026-10-13-stale-comments-sweep-28.md

## Problem

`apps/fleet/src/studio/rescue.ts:2314` cites `docs/plans/2026-10-03-feat-208-wip-sync.md`.
That path never existed at the repo root. The plan doc actually lives at
`apps/fleet/docs/plans/2026-10-03-feat-208-wip-sync.md`. Every other src citation of a
docs tree resolves at the root; this is the one citing the apps/fleet docs tree under a
root-relative path.

## Fix

Comment-only, one line: rewrite the cite to the real path
`apps/fleet/docs/plans/2026-10-03-feat-208-wip-sync.md`. No code change, no behavior change.

## Verification

1. `test -f apps/fleet/docs/plans/2026-10-03-feat-208-wip-sync.md` — the cited file
   exists (RED before: cite points at a path that never existed; GREEN after: cite names
   a real file).
2. `grep -rn "docs/plans/2026-10-03-feat-208-wip-sync" apps/fleet/src` — exactly one
   hit, and it is now prefixed `apps/fleet/`.
3. `bun run english-check` (from apps/fleet) — clean.
4. `bun run check` (from apps/fleet) — exit 0; comment edit cannot break it, this proves
   no accidental code change.

## Scope guard

Fix the comment only. If the surrounding code shows a real bug, stop and report instead.

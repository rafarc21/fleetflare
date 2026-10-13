# Plan — S34-F1: complete README `fleet ls` extra-columns list (task #770, refs #734)

One-paragraph-edit task. Sweep-34 finding 1 (docs/maintainability/2026-10-13-cli-docs-drift-sweep-34.md) : the README parenthetical at README.md:150-152 names only 6 of the 12 extra columns the real table has. CLI truth is apps/fleet/cli/fleet.ts:398 — 16 headers: ID, REPO, STATE, RST, WIP, PRS, READY, SESSION, ACTIVITY, CHECKED, ROW, ACCOUNT, HOST, BURN, REFRESHED, ERROR. The README sample block above the parenthetical shows ID, STATE, READY, BURN, so the extras to name are the remaining 12: REPO, RST, WIP, PRS, SESSION, ACTIVITY, CHECKED, ROW, ACCOUNT, HOST, REFRESHED, ERROR. Four carry operational meaning and were the finding's point: WIP (board #208, wip-sync age), PRS (#332, open PRs), CHECKED (verdict age), REFRESHED.

Fix: replace the parenthetical at README.md:150-152 with the issue's exact text (names all 12, one line, no per-column glossary — `fleet help` is the reference). No code changes.

## Steps

1. Plan doc (this file).
2. README.md parenthetical replacement (the only content change).
3. Gates: `bun run english-check`, `bun run test-lies-check` (both from apps/fleet, run one at a time).
4. PR: doc-only, two-way door, closes #770.

## Verification

- README.md:150 lists all 12 extras matching apps/fleet/cli/fleet.ts:398 headers minus the 4 shown in the sample block.
- `cd apps/fleet && bun run english-check` — clean
- `cd apps/fleet && bun run test-lies-check` — 0 tautological, 0 source-reading, 0 own-module-mock

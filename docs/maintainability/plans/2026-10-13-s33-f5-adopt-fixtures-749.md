# Plan — S33-F5 adopt-fixture dedupe (refs #749)

Full-set pair byte-identical: bun/studio-adopt.test.ts:23-53 and
bun/worktree-session-adopt.test.ts:21-49 — REPO/ROOT_KEY/WT_KEY/WT_ID/ROOT_ID/
CLI/SDK/TEAMMATE consts + projects()/session(). Partial copy (3 shared consts):
bun/bringup-session-adopt.test.ts:32-34. Divergent (different fixture repo):
bun/bringup-fresh-session.test.ts — stays local, untouched.

Change: new bun/helpers/adopt-fixtures.ts exporting the shared consts and
projects()/session(); the three files import them. Both full-set files keep
REPO/WT_KEY/WT_ID/CLI/SDK/TEAMMATE/ROOT_KEY/ROOT_ID spelled identically, so
one export set serves both. No behavior change; no src/ or container/ edits.

Tricky bit: projects()/session() close over a mutable per-test `home` created
in beforeEach. Helper API: `setAdoptHome(dir)` sets the closure home, called
first line of each suite's beforeEach; ~70 existing call sites stay untouched.

Verify: bun test on the three touched files, green. Then english-check.

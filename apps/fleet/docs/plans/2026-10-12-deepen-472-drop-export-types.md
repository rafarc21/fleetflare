# Plan — drop `export` on 68 self-file-only types (refs #472, parent #428)

Sweep-9 finding F7, GLM-OK representative batch. 68 exported
types/interfaces/consts (35 files) have zero references outside their
defining file (re-grepped across src, cli, test, test-integration,
scripts, page, container on this branch). CLAUDE-ONLY entries (do.ts,
write-proxy, failover, deploy, creds) are excluded — other lane.

Line numbers below are CURRENT on this branch (13 drifted vs the issue
text: github/api.ts, destroy-outcome.ts, recycle-outcome.ts, burn.ts,
memory/compact.ts).

## Change

Drop ONLY the `export` keyword. Symbol, body, in-file uses stay.
`AiRunError` (class) and `PROMOTION_CITATIONS` (const) same rule.
One commit per file-group, pushed after first commit.

- board: board.ts:716 AssignMode, :964 BoardRepoDeps, :587 TerminalCloseOutcome; brief.ts:75; envelope.ts:36; api.ts:382, :439; verify.ts:22, :24, :88, :202; close-action.ts:28, :40; path-overlap.ts:50
- github: api.ts:713 CommitPull, :1161 BatchedCommitAnswer, :375 RepoFileChange; promote-close.ts:56, :290, :349
- studio: ff.ts:95, :407, :412; onboard.ts:29, :35; registry.ts:370; ids.ts:57, :152; repo.ts:135, :228; sweep.ts:60; frames.ts:16; memguard-log.ts:20, :21; burn.ts:1773
- cli: destroy-outcome.ts:78, :101, :106; recycle-outcome.ts:132, :137; orca-workspace.ts:89, :981, :1128; junior.ts:171, :203; inspect-request.ts:17; context-salvage.ts:22
- junior: authz.ts:98; usage.ts:19, :83, :90; gate.ts:26
- agents/registry.ts:11; llm/anthropic-route.ts:163; llm/translate.ts:356, :626
- directus: types.ts:74, :90; schema.ts:44; schema-apply.ts:43; portal.ts:105
- memory/compact.ts:38, :56, :68, :182, :192, :215, :223

## TDD / verification (one heavy gate at a time, flock /tmp/fleet-gate.lock)

No new tests — compile-time-only change. RED proof impossible (no
runtime failure); type-safety net IS the check:

1. After edits: per-symbol `grep -rlw <sym>` across apps/fleet → defining file only.
2. `cd apps/fleet && bun run check` (5 tsconfigs) exit 0 — catches any missed import.
3. `bun run english-check` exit 0.
4. Targeted vitest suites from issue #472 (board, github, ff, cli, junior, directus, memory, translate).

## Bounds

- 68 one-word edits, 35 files, one PR. Two-way door (re-add `export` trivially).
- Siblings #470/#471 parallel: touch ONLY the 68 symbols above.
- No behavior change; types stay, bodies stay.

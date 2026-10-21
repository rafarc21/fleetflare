# Plan — #1259: local studio parity follow-ups (#1248)

## Objective

Close the remaining local-vs-container studio gaps, refs #1248 / PR #1257. Seven items,
one commit per item, one test per item, TDD (RED then GREEN). Fail closed everywhere.

## Items (commit each separately)

1. **Hooks parity** — `cli/orca-workspace.ts` `materializeLocalLead` writes only the lead-gate.
   Add session-reemit (SessionStart), install-marker (PostToolUse), activity-heartbeat
   (SessionStart+UserPromptSubmit+Stop+Notification), completion-gate (Stop, only when members
   write code). Copy each script from `gates/` into the worktree `.claude/hooks/`, chmod 0755,
   and merge the matching settings.json hook entry, same fail-open/fail-closed shape the container
   uses (completion-gate fail-closed; the others fail-open). The local-spawn route must carry a
   `completionGate` boolean (from `writesCode(members)`).

2. **Local wake** — a local row has no container, so the assign wake hits the DO's
   "never provisioned" refusal. Detect `host:"local"` in the wake path and wake by Orca terminal
   instead. New CLI-side path: after the Worker reports the local-wake refusal, the CLI resolves
   the studio's Orca attach terminal handle and runs `orca terminal send --terminal <handle> --text
   <digest> --enter`. Fail closed: no handle / not running Orca / no binary -> report the refusal.

3. **Container-only verbs refuse local rows** — `routes.ts` wires `refuseLocalRow` to the missing
   verbs: status, provisioned, rescue, inspect, wake, ws/terminal, terminal, paste,
   clear-session-guard. (check/provision/restart/recycle already guarded.) resume is not a route
   segment — see item 7.

4. **Origin check fail-closed** — `cli/fleet.ts` `spawnLocalStudio`: `resolveCloneOriginSlug` null
   (no GitHub origin) currently skips the mismatch check. Change to refuse: a local studio cannot be
   built from a clone with no GitHub origin naming the target repo.

5. **Tracked .claude/settings.json** — `.git/info/exclude` cannot cover a repo-tracked file. The
   materialized lead's settings.json must NOT clobber a repo-tracked one: write to
   `.claude/settings.local.json` (which Claude Code merges) when `.claude/settings.json` is already
   tracked, and add `.claude/settings.local.json` to `LOCAL_EXCLUDE_LINES`.

6. **No-upstream = unsynced (data-loss guard)** — `cli/fleet.ts` `gitAheadCount` returns 0 on a
   non-zero exit (no upstream), so `--force --discard-unsynced` can remove unpushed commits. Treat
   no-upstream as unsynced: signal "unknown/ahead" so the teardown keeps the worktree. TEST FIRST.

7. **Local resume** — a stopped local id cannot respawn (runSpawn's "studio exists" 409; no local
   resume path). Add a local resume: the operator `provision`/resume of a stopped local row
   re-materializes the Orca worktree + launch command rather than dispatching to a container DO.

## Tests (TDD, targeted only)

- 1: orca-workspace local materialization test — settings.json carries all four new hook entries;
  completion-gate present only when completionGate true.
- 2: wake wiring test — local row reports a local-wake outcome, never a container RPC.
- 3: studio.local-route.test.ts — each of the 9 verbs 409s a local row without a DO call.
- 4: local-git-helpers / spawn test — no-origin clone refused.
- 5: orca-workspace test — tracked settings.json => settings.local.json written + excluded.
- 6: local-git-helpers.test.ts — no-upstream reads as unsynced (RED first).
- 7: local spawn/resume test — stopped local row resumes via re-materialize, not a DO call.

## Verification

`bun run test` on touched files only. Full suite runs on the gate. One heavy gate at a time.

## Boundaries

apps/fleet only: `cli/orca-workspace.ts`, `cli/fleet.ts`, `cli/ff.ts`, `src/studio/routes.ts`,
`src/studio/spawn.ts`, `src/studio/local-spawn.ts`, `src/board/wake-{gate,deps}.ts`,
`src/studio/studio-blueprint.ts`, tests named above, this plan doc. NO container/ changes.
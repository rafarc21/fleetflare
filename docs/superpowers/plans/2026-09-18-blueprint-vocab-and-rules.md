# Blueprint Vocab and Rules

**Problem (board issue #10):** the operator decided three vocabulary/rule changes on
2026-09-18, already in his local `~/.claude/CLAUDE.md`, not yet reaching
cloud studios. Three fixes, one PR.

## 1. org.json dead `cto` edges

`fleet/blueprint/org.json` had two dead references to a `cto` role/studio
that does not exist (renamed to `maestro`, commit `99469f5`, well before
today):

- `"cto": ["release", "qa", "dev"]` — a top-level edges key whose targets
  (`release`, `qa`, `dev`) have no role/studio file anywhere under
  `fleet/blueprint/roles/` (`pilot.md`, `scratch.md` only) or
  `fleet/blueprint/studios/` (`maestro/`, `web-studio/`, `release-studio/`
  only). Deleted entirely.
- `"cto"` inside `operator`'s own target array — same reason, same fix.
  `operator`'s array becomes `["pilot", "scratch", "maestro", "web-studio",
  "release-studio"]`.

**Rename decision (operator -> cto), rejected.** "CTO" is the operator's vocabulary
for the human role; internally it stays `operator` — `OPERATOR_ID =
"operator"` (`src/studio/spawn.ts`) is load-bearing through
`resolveSpawnParent`/`maySpawn`, and `src/studio/types.ts` references it too.
Both files sit outside this task's boundary. A full rename buys a purely
terminological win at the cost of touching files outside boundary and
risking `maySpawn` exactly as the issue text itself warns against. Kept
`operator` as the stable internal edge/role id. Vocabulary mapping
documented in prose instead: "CTO = the operator, the human — internally still the
`operator` role/edge in org.json and spawn code," landed in this doc and, in
this file's own prose, `fleet/blueprint/studios/maestro/studio.md`.

`apps/fleet/src/studio/org.ts` checked and left untouched: `parseOrgJson`
validates `edges`/`gates` as generic `Record<string, string[]>` with zero
hardcoded knowledge of any specific key name (`requireRoleMap` iterates
`Object.entries`). Removing the dead `cto` key needs no code change there.

Tests updated (all three previously asserted the dead `cto` shape):

- `test/studio.org.test.ts` — "the real shipped org.json parses cleanly"
  dropped its `org.edges.cto` assertion (kept `gates.merge`). The
  operator/pilot/scratch maySpawn test dropped `maySpawn(org, "operator",
  "cto")` (was `true`, now correctly `false`/gone) and kept pilot/scratch/
  release assertions, retitled to drop "cto" from its own name.
- `test/studio.blueprint.test.ts` — the `org.edges.operator` `toEqual`
  assertion dropped `"cto"` from the expected array.

Tests confirmed NOT touched (surveyed each before concluding): all of
`test/studio.spawn.test.ts`'s `"cto"` references use `fakeBlueprintFetch()`'s
own synthetic default org fixture, never `env.TEST_ORG_JSON` (except two
blocks testing `"release"`/`"scratch"` against the real org, unaffected
either way). `test/studio.provision.test.ts`'s `FAKE_MAESTRO_MD` and
`test/studio.studio-blueprint.test.ts`'s generic fixtures are synthetic,
never read the real files.

Left alone, on purpose: `src/studio/blueprint.ts:447`'s
`role.name === "cto" ? "max" : ""` in `roleBringupEnv`'s `ROLE_EFFORT` is
genuinely dead (no role is ever named `cto`) but touching it is scope creep
beyond this task's four numbered items — not requested, not done.

## 2. Maestro subagents-by-output rule

`fleet/blueprint/studios/maestro/studio.md` said "Solo. No members, nothing
to dispatch." Replaced with the real rule: Maestro may dispatch a subagent
when its OUTPUT informs or administers (status checks, PR/CI checks, backlog
grooming, closing an issue, research, drafting a brief, spinning up a worker
studio) — never when the output IS the deliverable. "Never implement" stays
exactly as strict as before.

Two guardrails stated as policy in the same paragraph:

- The wake/sweep monitor loop stays armed in Maestro's OWN session only,
  never inside a dispatched subagent — a subagent that itself waited/polled
  could silently miss or duplicate a wake.
- The lead-gate proxy-implementation hole, stated honestly as a CURRENT
  OPEN LIMITATION, not fixed by this PR (below).

**The danger, real and open, not closed by this PR.** The lead-gate hook
(`container/studio-bringup.sh`, `~/.claude/hooks/lead-gate.sh`) tells a
lead's own tool call apart from a dispatched member's SOLELY by whether the
payload carries `agent_id`/`agent_type` — present means exempt from the
write-block, for every studio, unconditionally. A subagent Maestro
dispatches carries `agent_id` and is therefore exempt from the write-block
today, meaning Maestro could implement BY PROXY through a subagent — exactly
what "Maestro never implements" exists to prevent. The new subagents-by-
output rule does not fix this; it is a real, currently-open hole, said so in
the studio.md text itself, not just here.

**Proposed guard, documented not built this PR.** Maestro's own studio.md
has always declared zero members (`skills:`/roster empty) — "no members,
nothing to dispatch" was literally, structurally true. So any Edit/Write
call carrying `agent_id`/`agent_type` INSIDE a Maestro session is, by
construction, always a subagent Maestro itself spawned; there is no other
kind of "member" it could ever have. The guard: Maestro's own materialized
lead-gate.sh variant should not exempt on `agent_id`/`agent_type` presence
at all — block Edit/Write unconditionally for every caller in a Maestro
session, lead or subagent alike, since Maestro legitimately never needs a
subagent to touch a file. Would need a role-conditional bring-up flag
(mirroring how `STUDIO_LEAD_DISALLOWED`/`STUDIO_COMPLETION_GATE` already get
set per-role) threaded through `container/studio-bringup.sh`'s
materialization of the lead-gate hook.

**Why not built this PR, checked before deciding, not assumed:** the env var
that would need a role-conditional variant, `STUDIO_LEAD_DISALLOWED`, is set
in `apps/fleet/src/studio/studio-blueprint.ts` (`STUDIO_LEAD_DISALLOWED:
"Edit Write NotebookEdit Bash(write-forms)"`), not in
`apps/fleet/src/studio/blueprint.ts` — the only blueprint file in this
task's boundary. Threading the flag would require touching
`studio-blueprint.ts`, outside boundary, and likely `provision.ts`/`do.ts`
too (explicitly forbidden, task item #9). Beyond the boundary problem, the
hook itself is pinned by 111 exact-source assertions in
`test/studio.session.test.ts` alone (`src()).toContain`/`toBe` against the
literal python string) plus more in `test/bun/bringup-hooks.test.ts` — a
single-quoted bash string carrying inline python, where any edit risks
touching quoting/escaping across the whole heredoc. Genuinely not a small,
low-risk diff under this task's boundary and time budget. Filed as a
follow-up board task instead (see below) so a future focused session builds
and tests the guard properly, with its own TDD pass against that pinned
surface.

## 3. URL completo rule in HOUSE_RULES

`src/studio/blueprint.ts`'s `HOUSE_RULES` array is prose-shape rules every
studio prompt gets unconditionally. Added one bullet, matching the existing
list's voice: every link in a message to the operator must be an absolute URL
(`https://host/path`), never a bare slug or path fragment — the exact
incident cited in the issue: a real Acme maestro wrote `/c/acme--2026-09-18`
instead of `https://review-worker.demosite.workers.dev/c/acme--2026-09-18`.
For PRs/issues, the full GitHub URL IS the link; `#number` is allowed only
as a trailing label alongside it, never as the link itself.

`test/houserules.prompt.test.ts` checked first: its assertions read
`` `${HOUSE_RULES}` `` live off the export, not a hardcoded copy, so the new
bullet does not break them — confirmed by running the suite, not assumed.

## 4. Byte-identity discipline

Baseline, unmodified `main`, before touching anything:

- `bun run test -- studio.org.test.ts studio.blueprint.test.ts`: 2 files, 114
  tests, all pass.
- `bun run test` (full vitest lane): 74 files, 1789 tests, all pass.
- `bun run bun-test`: 111 tests, 0 fail.

After implementing items 1-3: re-ran the same three commands. Only the three
tests explicitly identified in item 1 changed shape (edited, not broken);
`houserules.prompt.test.ts` stayed green reading the live export. No other
test changed outcome in either direction — full diff shown in the PR
report, not re-baselined blindly.

## Boundary

Touched: `fleet/blueprint/org.json`, `fleet/blueprint/studios/maestro/studio.md`,
`src/studio/blueprint.ts`, their tests, this plan doc, `.fleet/done.json`.
Did not touch `src/studio/org.ts` (checked, not needed — see item 1),
`container/studio-bringup.sh` (checked, deferred — see item 2),
`src/studio/spawn.ts`, `src/studio/types.ts`, `cli/orca-workspace.ts`,
`skills/`, `.github/`, `src/github/`, `src/board/`,
`src/studio/provision.ts`/`destroy.ts`/`do.ts`. Never ran
`container/studio-bringup.sh` or anything it emits. No deploy.

## Verification plan

From `apps/fleet/`: `bun run check`, `bun run test`, `bun run bun-test`.
`git log --oneline | grep 3072ae6` confirms the wake-cmd tmux-kill fix is on
this branch before running `bun run bun-test` (branched from current
`main`).

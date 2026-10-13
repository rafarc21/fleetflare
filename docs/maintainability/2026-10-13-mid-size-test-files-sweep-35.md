# Mid-size test files sweep 35 — apps/fleet/test (2026-10-13)

Ref #735. Analysis only, read-only, no code changed, no splits
performed. Thirty-fifth maintainability sweep; scope
`apps/fleet/test/**` only (vitest root + test/bun). Lens: test FILES
600-800 lines inclusive (sweep 26 covered >800). Census at origin/main
`5b7a234` by `wc -l`: **19 files in the band**; the top 15 by size are
findings below, the remaining 4 are listed as context (cap is 15, they
wait for a later sweep). 136,333 total test lines in scope.

**Tier rule (from #539):** GLM-OK = none of auth, secrets, credentials,
rescue, failover, accounts routing, deploy. CLAUDE-ONLY = touches any of
those. NOTE: the DOC is one batch; the SPLIT work each finding proposes
inherits the lane of the file it splits. Lane marks below are for the
SPLIT, not this doc.

**Shared-setup census:** of the 19 files, only these import shared
helpers/fixtures today: bun/session-tar-budget (`test/bun/exec-snippet`
runSnippet), bun/bringup-heartbeat (BRINGUP + runSnippet from
exec-snippet), bun/fleet-reap (fixtures/rate-limit-panes
REAL_WEBSTUDIO_PANE + fixtures/activity-panes
WORKING_GLYPH_DOT_FOOTER_ESC_PANE), studio.destroy
(fixtures/destroy-refusals), bun/test-lies-check (reads
scripts/test-lies-check.ts as the module under test), claude-swap
(fixtures/cswap-list), studio.failover-214 (fixtures/rate-limit-panes
V1/V3/ORG_SPEND), bun/pane-probe-lead (V2_SESSION_LIMIT_PANE),
studio.wake-gate (fixtures/rate-limit-panes + helpers/do-storage
fakeStorage), studio.failover-real-panes (fixtures/rate-limit-panes).
The rest carry in-file fakes — the seam question for every split is
"which in-file helpers does each half need", answered per finding.
Existing extract targets if a split wants them:
`test/helpers/{bringup-pins, datetime, do-storage, fake-namespace, http,
studio-row}.ts`, `test/bun/helpers/{credentials, poll, shell}.ts`,
`test/bun/exec-snippet.ts`,
`test/fixtures/{rate-limit-panes, activity-panes, destroy-refusals,
cswap-list}.ts`.

## Method

`find apps/fleet/test -name '*.test.ts' | xargs wc -l | sort -rn`, band
600-800 inclusive. 19 hits. Top 15 read in full or in structural part:
top-level `describe(`/`suite(` blocks mapped with grep; describe-less or
single-suite bun files mapped by their flat `test(` lists. Proposed
split names follow the existing convention `<module>.<aspect>.test.ts`,
one seam per finding, halves sized by the line ranges measured.

## Findings

| # | file | lines | proposed split (halves) | lane |
|--:|---|---:|---|---|
| 1 | test/bun/memguard-select.test.ts | 782 | memguard-select-core + memguard-select-loop | GLM-OK |
| 2 | test/bun/orca-ensure.test.ts | 776 | orca-ensure-verbs + orca-ensure-reconcile | GLM-OK |
| 3 | test/bun/session-tar-budget.test.ts | 771 | tar-budget-30d + tar-budget-resume | CLAUDE-ONLY |
| 4 | test/github.auth.test.ts | 746 | auth-mint + auth-reach | CLAUDE-ONLY |
| 5 | test/bun/bringup-heartbeat.test.ts | 731 | bringup-reemit + bringup-heartbeat-core | GLM-OK |
| 6 | test/bun/llm-translate.test.ts | 719 | llm-translate-request + llm-translate-stream | GLM-OK |
| 7 | test/bun/fleet-reap.test.ts | 712 | reap-guards + reap-alarm | CLAUDE-ONLY |
| 8 | test/studio.destroy.test.ts | 710 | destroy-sync + destroy-run | CLAUDE-ONLY |
| 9 | test/studio.blueprint.test.ts | 705 | blueprint-parse + blueprint-brief | GLM-OK |
| 10 | test/bun/test-lies-check.test.ts | 698 | test-lies-detectors + test-lies-repo | GLM-OK |
| 11 | test/claude-swap.test.ts | 689 | cswap-join + cswap-pick | GLM-OK |
| 12 | test/github.promote-close.test.ts | 687 | promote-close-resolve + promote-close-keywords | GLM-OK |
| 13 | test/studio.failover-214.test.ts | 672 | failover-214-clear + failover-214-vetoes | CLAUDE-ONLY |
| 14 | test/bun/pane-probe-lead.test.ts | 657 | pane-probe-lead-identity + pane-probe-lead-scope | GLM-OK |
| 15 | test/studio.wake-gate.test.ts | 633 | wake-gate-race + wake-delivery | CLAUDE-ONLY |

### F1. test/bun/memguard-select.test.ts — 782 lines, 15 describes, 68 tests — GLM-OK

- **Lines:** 782, bun lane, 15 describes over src/studio/memguard.
- **Seams:**
  - `:97-465` — pure selection: isProtected, protectedSet ancestors,
    readProcs, pickVictim, adjPlan (the oom_score_adj trap), adjScan
    incremental pass, readMemory.
  - `:466-782` — loop + lead: decide escalation, step (gate + decide
    tick), nextTickMs, formatLogLine, redact agreement with
    src/studio/redact, trimLog, resolveLeadParentPid (#238 tmux
    display-message), refreshLeadParentPid (#270 round 2 stale-pid
    clear).
- **Proposed split:** `test/bun/memguard-select-core.test.ts` (:97-465)
  and `test/bun/memguard-select-loop.test.ts` (:466-782).
- **Shared setup:** in-file proc-tree fixtures (tmp /proc-shaped dirs
  via mkdirSync/writeFileSync), run fakes, SPECIMENS redact corpus.
  Both halves need the proc-tree builders; the loop half adds the
  escalation clock fixtures. No helper imports today.
- **Why GLM-OK:** redact describes compare shapes against
  src/studio/redact's redactSecrets with inert specimen strings —
  memguard's logging, not secrets handling.

### F2. test/bun/orca-ensure.test.ts — 776 lines, 7 describes, 42 tests — GLM-OK

- **Lines:** 776, bun lane, 7 describes. This file is itself a sweep-26
  split product (of orca-workspace.test.ts, PR #714) — a second cut
  goes along the reconcile seam.
- **Seams:**
  - `:212-377` — ensure core: name derivation, orcaPresent,
    ensureStudioWorkspace's five hard requirements.
  - `:378-776` — verbs/reconcile: duplicate terminals reconcile, fleet
    tabs reconcile verb, #216 preview/plan, process-level exit code +
    dotted repo.
- **Proposed split:** `test/bun/orca-ensure-verbs.test.ts` (:212-377)
  and `test/bun/orca-ensure-reconcile.test.ts` (:378-776).
- **Shared setup:** in-file fake() orca builder, ok(), memoryLock(),
  memoryRegistry(), worktrees()/terminals() result fixtures, TEST_TITLE
  (all carried over from the orca-workspace split). Both halves need
  fake() + fixtures.

### F3. test/bun/session-tar-budget.test.ts — 771 lines, 1 lane suite, 14 tests — CLAUDE-ONLY

- **Lines:** 771, real-shell lane (GNU find -printf + stat -c), ONE
  gnuLane-gated suite ("tarAndStatCmd — subagent raw-byte budget
  (#202)", :274) wrapping 14 flat tests; no inner describes.
- **Seams:** preamble `:1-273` carries the gnuLane() guard, fixture
  builders (writeSession/writeSubagent/transcript/assistantLine) and
  the runTar helpers; tests inside the suite split by topic —
  budget/size behavior vs restore/resume behavior.
- **Proposed split:** `test/bun/tar-budget-30d.test.ts` (budget/size
  tests) and `test/bun/tar-budget-resume.test.ts` (restore/resume
  tests). Both halves need the gnuLane preamble + builders verbatim
  (sweep-26 hazard 1).
- **Shared setup:** gnuLane guard, tmp home/sync fixture builders,
  runSnippet from test/bun/exec-snippet.
- **Why CLAUDE-ONLY:** the file exercises tarAndStatCmd from
  src/studio/session-sync — the session-archive plumbing that
  rescue-push and session sync ride; rescue proximity.

### F4. test/github.auth.test.ts — 746 lines, 18 describes, 69 tests — CLAUDE-ONLY

- **Lines:** 746, vitest, 18 describes over src/github/auth.
- **Seams:**
  - `:186-517` — mint: mintRepoToken (incl #331 App-scopes-to-caller's
    repo), PR #339 canonical-name 422 retry, memoised repoTokenMinter;
    plus resolveRepoAuthKind default path.
  - `:502-746` — reach: tokenEnvName owner→secret-name contract,
    per-owner token resolution, reachRepo provider paths (token and
    App), remedy naming, per-owner installation-id paths.
- **Proposed split:** `test/github.auth-mint.test.ts` and
  `test/github.auth-reach.test.ts`. tokenEnvName (:502-518) belongs to
  the reach half; the cut tolerates the small :502-517 overlap by
  moving that describe whole.
- **Shared setup:** vitest Env fakes, fetch mocks, REPO/OWNER consts.
  Both halves need the fetch mock harness.
- **Why CLAUDE-ONLY:** the file's entire subject is token minting,
  per-owner secrets and installation auth — auth/tokens/secrets,
  squarely tier-list.

### F5. test/bun/bringup-heartbeat.test.ts — 731 lines, 6 describes + 2 flat tests — GLM-OK

- **Lines:** 731, bun lane, 6 describes + 2 flat pins. Sweep-26 split
  product (of bringup-hooks.test.ts, PR #724) — a second cut.
- **Seams:**
  - `:24-330` — session re-emit hook.
  - `:331-731` — activity-heartbeat hook: event→state map,
    silent/exit-0, atomic write, lead-only (#221 round 2),
    studio-bringup.sh settings.json wiring (#221 PR3b) + the two flat
    pins (blueprint copy single source; no PreCompact registered).
- **Proposed split:** `test/bun/bringup-reemit.test.ts` (:24-330) and
  `test/bun/bringup-heartbeat-core.test.ts` (:331-731).
- **Shared setup:** BRINGUP + runSnippet from test/bun/exec-snippet,
  REEMIT/ACTIVITY_HEARTBEAT gate-source reads, mkdtemp'd repo
  fixtures. Reemit half needs its own runners; heartbeat half needs
  heartbeat() + AncestryMode.

### F6. test/bun/llm-translate.test.ts — 719 lines, 13 describes, 53 tests — GLM-OK

- **Lines:** 719, bun lane, 13 describes over the LLM translation layer
  (anthropicRequestToOpenAI / openAIResponseToAnthropic / streaming).
- **Seams:**
  - `:31-390` — request + response mapping: text, GLM_MIN_MAX_TOKENS
    floor, pool model override, tools, tool_use/tool_result round
    trip, text back, tool_calls back.
  - `:391-719` — errors + streaming: classifyAiError, streamErrorFrame,
    parseSseDataLine, prelude + chunk application + close, #284 (a)
    closeStreamOrError, #284 (b) parseStreamErrorChunk.
- **Proposed split:** `test/bun/llm-translate-request.test.ts` (:31-390)
  and `test/bun/llm-translate-stream.test.ts` (:391-719).
- **Shared setup:** in-file request/response JSON builders; the stream
  half adds SSE line fixtures. No shared helper imports.
- **Why GLM-OK:** "tokens" here are LLM max-token counts, never
  credentials.

### F7. test/bun/fleet-reap.test.ts — 712 lines, 14 describes, 67 tests — CLAUDE-ONLY

- **Lines:** 712, bun lane, 14 describes over cli/reap.ts's runReap
  core (issue #53).
- **Seams:**
  - runReap guards `:149-651` + `:683-712` — running-turn veto, open-task
    stall alarm, task-filed-between-list-and-destroy race, F1 bounded
    gap, F2/F3 live pane chrome, F4/F5 scope and state, board read
    failure/floor, rescue failure 409 backoff, dry-run, registry
    derived each poll, destroy racing another destroy (:683-712, after
    the parsers).
  - parsers/alarm `:652-682` — formatIdleAlarm (the fleet ls line, :652),
    parseIdleDuration (:672).
- **Proposed split:** `test/bun/reap-guards.test.ts` (the runReap
  describes) and `test/bun/reap-alarm.test.ts` (formatIdleAlarm +
  parseIdleDuration).
- **Shared setup:** the World/fake() deps factory (rescue/destroy/
  inspect/listBoard/studioTasks injections), studio()/activity()
  builders, REAL_WEBSTUDIO_PANE + WORKING_GLYPH_DOT_FOOTER_ESC_PANE
  fixtures (already shared). Guards half needs fake() wholesale; alarm
  half needs only the pane fixtures.
- **Why CLAUDE-ONLY:** ReapDeps includes a rescue dep and the happy
  path's contract is rescue-before-destroy ordering (25 rescue
  mentions) — rescue is tier-list and central to this file's guards.

### F8. test/studio.destroy.test.ts — 710 lines, 5 describes — CLAUDE-ONLY

- **Lines:** 710, vitest, 5 describes over destroyWithSync + runDestroy
  (src/studio/destroy.ts) and the guard.discardUnsynced interplay
  (#210).
- **Seams:**
  - `:96-449` — destroyWithSync: fakeSyncDeps with
    rescuePushCmd/RESCUE_FAILED_PREFIX plumbing, tar/harvest/aside
    steps, refusal texts.
  - `:450-710` — runDestroy + reviews: route-level force param (#210
    open-task gate must not leak into guard.discardUnsynced), unshipped
    aside named on the row (PR #46), refusal fixtures matching the
    Worker's own text.
- **Proposed split:** `test/studio.destroy-sync.test.ts` (:96-449) and
  `test/studio.destroy-run.test.ts` (:450-710).
- **Shared setup:** fakeSyncDeps() factory (imports rescuePushCmd,
  RESCUE_CLEAN, RESCUE_FAILED_PREFIX, harvestRecordCmd,
  HARVEST_NO_RECORD, doneRecordsListCmd), probeRefusal +
  rescueUnconfirmedRefusal from fixtures/destroy-refusals. Sync half
  needs fakeSyncDeps; run half needs the refusal fixtures + route
  mocks.
- **Why CLAUDE-ONLY:** rescue-push is wired through every
  destroyWithSync test (35 rescue mentions) — tier-list.

### F9. test/studio.blueprint.test.ts — 705 lines, 12 describes, 62 tests — GLM-OK

- **Lines:** 705, vitest (cloudflare:test env), 12 describes over
  blueprint parsing (parseRoleFile, parseFleetJson, assertRoleInFleet,
  roleBringupEnv, appendBrief/appendHouseRules).
- **Seams:**
  - `:47-409` — parse: parseRoleFile, optional role fields
    (may_spawn/instance_type/keep_alive, effort, mcp #276),
    parseFleetJson, assertRoleInFleet.
  - `:410-705` — env/brief: roleBringupEnv (+ROLE_EFFORT), the real
    shipped blueprint files parse cleanly (:488-608), appendBrief
    (P4a-2), HOUSE_RULES neutral default (#330) + operator overlay.
- **Proposed split:** `test/studio.blueprint-parse.test.ts` (:47-409)
  and `test/studio.blueprint-brief.test.ts` (:410-705) — roleBringupEnv
  goes with the brief half.
- **Shared setup:** cloudflare:test env, decodePrompt b64 helper,
  in-file role JSON/markdown fixtures, real blueprint file reads. Parse
  half needs the JSON fixtures; brief half needs the real-file reads +
  house-rules fixtures.
- **Why GLM-OK:** blueprint parsing and brief assembly; no tier
  subject.

### F10. test/bun/test-lies-check.test.ts — 698 lines, 7 describes, 42 tests — GLM-OK

- **Lines:** 698, bun lane, 7 describes over scripts/test-lies-check.ts
  — the repo's own test-quality gate.
- **Seams:**
  - `:45-374` — detectors: findTautologies, findSourceReading,
    findOwnModuleMocks, formatFinding.
  - `:375-698` — repo + CLI: "the repository itself" scan, the CLI
    exit code (#174 failing-gate contract), quote/escape/bracket-depth
    walking (#323 characterization).
- **Proposed split:** `test/bun/test-lies-detectors.test.ts` (:45-374)
  and `test/bun/test-lies-repo.test.ts` (:375-698).
- **Shared setup:** mkdtemp'd temp-repo builders (synthetic .ts files
  via writeFileSync), detector imports. Detectors half needs the
  temp-repo builder; repo half needs the repo-root scan + exit-code
  child-process harness.
- **Why GLM-OK:** quality tooling, no tier subject.

### F11. test/claude-swap.test.ts — 689 lines, 5 describes, 54 tests — GLM-OK

- **Lines:** 689, vitest, 5 describes over src/studio/claude-swap.
- **Seams:**
  - `:21-611` — join: joinAccountsToCswap, decideAccountSync, real
    cswap shape tolerance (maestro real-probe #240).
  - `:612-689` — usage + pick: usageMaxPct/toUsageHeadroom scoped-window
    fold-in (#238), pickHeadroomAccount.
- **Proposed split:** `test/claude-swap-join.test.ts` (:21-611) and
  `test/claude-swap-pick.test.ts` (:612-689).
- **Shared setup:** FleetAccountSlot builders, fixtures/cswap-list
  import (already shared). Join half needs cswap-list + slot builders;
  pick half needs only slot builders.
- **Why GLM-OK:** slots are named CLAUDE_CODE_OAUTH_TOKEN* as inert
  fixtures — account-slot bookkeeping, not credentials handling, and
  decideAccountSync has no routing behavior (it maps cswap output to
  slots); "accounts routing" in the tier list meant failover's account
  selection, per sweep-26 precedent.

### F12. test/github.promote-close.test.ts — 687 lines, 5 describes, 40 tests — GLM-OK

- **Lines:** 687, vitest, 5 describes over the github promote/close
  pipeline.
- **Seams:**
  - `:23-396` — resolve: resolveIssuesForPushCommits (commit→PR→issue
    path), resolveIssuesFromEnvelopeArtifacts (no-closing-keyword
    cross-check), mergeClosable.
  - `:397-687` — keywords: closesIssueByKeyword (#248), batched Path 1
    (#208).
- **Proposed split:** `test/github.promote-close-resolve.test.ts`
  (:23-396) and `test/github.promote-close-keywords.test.ts`
  (:397-687).
- **Shared setup:** vi mocks for the github api module, commit/PR/issue
  fixtures, TimeBudget. Resolve half needs the api mocks; keywords half
  needs keyword-bearing fixture commits.
- **Why GLM-OK:** issue-closing semantics, not auth.

### F13. test/studio.failover-214.test.ts — 672 lines, 7 describes — CLAUDE-ONLY

- **Lines:** 672, vitest, 7 describes over src/studio/failover
  modal/degraded-heal semantics (#214/#232/#241 review cluster).
- **Seams:**
  - `:110-328` — clear: dismissed modal clears degraded on next tick,
    modal still on screen clears nothing, switched-block redraw path
    (#186), stamped clear, FRESH op-lock yield (#85 PR1).
  - `:329-672` — vetoes: LIVE limit block anywhere vetoes the heal
    (#232), 3-option rate-limit modal is a modal and heals nothing
    (#241), the remaining #214-cluster review describes.
- **Proposed split:** `test/studio.failover-214-clear.test.ts`
  (:110-328) and `test/studio.failover-214-vetoes.test.ts` (:329-672).
- **Shared setup:** fake StudioDO/storage (STATUS_KEY,
  StudioStorage), runGatedWake + PANE_PROBE_CMD from src/studio/wake,
  V1_STOP_AND_WAIT_PANE/V3_ADD_FUNDS_PANE/ORG_SPEND_LIMIT_PANE from
  fixtures/rate-limit-panes, fakeCtx/envWith builders. Both halves need
  the pane fixtures + wake mocks.
- **Why CLAUDE-ONLY:** failover is tier-list; every test here drives
  failover's modal state machine.

### F14. test/bun/pane-probe-lead.test.ts — 657 lines, 1 lane suite, 11 flat tests — GLM-OK

- **Lines:** 657, real-tmux lane, ONE describe.skipIf(!isLinux) suite
  (:312) wrapping 11 flat tests; preamble :1-311 carries the 2026-09-24
  incident comment, isolatedTmuxEnv + socketFlag + assertIsolatedEnv
  hard guards, installFakeClaude/startLeadInPane/waitForPane builders.
- **Seams:**
  - `:313-475` — lead identity: member claude -p subprocess never the
    lead, missing studio:claude window answers found:false, per-argv
    --continue detection, no raw argv, lead vs member cwd/argv,
    substring-containment cases (#117-adjacent argv shapes).
  - `:476-657` — scoping: foreign pane/unrelated claude never found
    (:476), foreign lower-pid claude never confuses pid-tree scoping,
    shell-only session found:false, private -L fleet-studio socket
    auto-detection (#117).
- **Proposed split:** `test/bun/pane-probe-lead-identity.test.ts`
  (:313-475) and `test/bun/pane-probe-lead-scope.test.ts` (:476-657).
- **Shared setup:** the isolation machinery is LOAD-BEARING (the
  incident comment records two leads dying when it was weaker) — both
  halves need isolatedTmuxEnv + socketFlag + assertIsolatedEnv +
  installFakeClaude + startLeadInPane + waitForPane verbatim.
  Extraction to test/bun/helpers is a later dedup step; a split copies
  verbatim first.
- **Why GLM-OK:** tmux/proc probing, no tier subject.

### F15. test/studio.wake-gate.test.ts — 633 lines, 13 describes — CLAUDE-ONLY

- **Lines:** 633, vitest, 13 describes over src/studio/wake gating and
  the destroy-race markers (#100 cluster) + bring-up delivery
  (#213/#137).
- **Seams:**
  - `:51-128` + `:474-633` — wake + delivery: wakeStudioWith's real
    body, spawn's notifyMaestro skip-is-info rule (#100 N2),
    deliverAssignedTaskOnBringup.
  - `:129-473` — race: sweepWake first-sighting (#170 D4/D5),
    logWakeOutcome shared logging rule (#100 F5), destroyingMarkerFresh,
    runGatedWake destroy race (#100 F3), runDestroy stop marker (#100
    F3), checkProvisionedGated, StudioDO source pins (#100 F7), marker
    refusal naming (#100 N4), finally-clear, tick side (#100 N5),
    inspect refuses during destroy (#100 N5).
- **Proposed split:** `test/studio.wake-gate-race.test.ts` (:129-473)
  and `test/studio.wake-delivery.test.ts` (:51-128 + :474-633) — the
  delivery half keeps the two bookend ranges.
- **Shared setup:** cloudflare:test env, LIMIT_SIGHTING_KEY/LimitSighting,
  V2_SESSION_LIMIT_PANE fixture, fakeStorage from helpers/do-storage
  (already shared), spawnDeps. Race half needs the marker fixtures +
  doStorage; delivery half needs board mocks + spawnDeps.
- **Why CLAUDE-ONLY:** wake gating is the mechanism failover's
  degraded-heal depends on, and the file exercises the same
  failover-adjacent StudioDO/SightingStorage overloads (:125-133) —
  do.ts failover-tick adjacency, the same ground sweep 26 marked
  studio.burn CLAUDE-ONLY on.

## Context — remaining 4 files in the band (no findings this round)

- studio.fresh-session.test.ts (631, 7 describes) — provisionWithStorage
  fresh-session intents (#28/#37/#100/#115/#231); single-subject file,
  intent-arming vs refusal is a weak seam.
- studio.failover-real-panes.test.ts (628, 16 describes) — real-pane
  failover fix cluster B/C/D + MEMBERS_TICKING_KEY (#221); CLAUDE-ONLY
  territory, review-driven, splits would fragment #-cluster provenance.
- board.api.test.ts (625, 9 describes) — src/board/api per-function
  describes; clean future seam: core verbs (:42-340) vs
  listIssueTexts+toBoardTask (:341-625).
- studio.ff.test.ts (614, 14 describes) — ff CLI decision surface;
  future seam: parseFfArgs + verdicts (:31-571) vs gates/briefs
  (:529-614, overlapping — ffTaskBrief starts :529, state the overlap
  in any future split).

## Split hazards (carried from sweep 26, adapted)

1. **bun lane guards are load-bearing.** session-tar-budget's gnuLane
   (GNU find -printf + stat -c), pane-probe-lead's isLinux +
   isolation machinery, orca-ensure/bringup-heartbeat's inherited
   builders: a split copies the guard preamble verbatim, never
   re-derives it.
2. **In-file fakes are the real shared setup.** World/fake()
   (fleet-reap), fakeSyncDeps (destroy), the builder preambles — a
   split duplicates them in both halves or extracts them; extraction is
   sweep-18's lane, keep the two PRs separate (split first, dedup
   second — never both at once).
3. **mock.module and vi.mock hoisting.** blueprint (cloudflare:test
   env), wake-gate (doStorage) — module state does not survive a file
   boundary; keep each mock with the half that needs it.
4. **File-scoped D1/env state.** blueprint, wake-gate, failover-214 use
   cloudflare:test env — both halves re-seed independently in their
   own beforeEach.
5. **Names of record.** The #NNN in describe titles are board-issue
   provenance — move describes whole, titles verbatim.

# Unused-exports sweep 24 — apps/fleet src+cli (2026-10-12)

Ref #588. Analysis only, read-only, no code changed. Twenty-fourth
maintainability sweep; scope `apps/fleet/src/**` and `apps/fleet/cli/**` minus
`container/`. Line refs = physical lines at `origin/main` `30bceb7`, paths
relative to `apps/fleet/`.

Method: scripted cross-reference of 1691 named exports against an importer map
built over src, cli, test, test-integration, scripts, page, and container
(rule-out only). Every finding below was then hand-re-grepped to rule out
comment mentions, container/'s own local mirrors (container/server.ts
re-declares TaskState/Milestone/GATE_ACTIONS locally — name match ≠ import),
re-export chains, and wrangler-required DO exports.

Sweeps 1-23 (docs/maintainability/*.md) and the open deepen(*) issues they
filed are NOT repeated here. Overlap with one closed sibling is on the record:
sweep-9 (dead-code-sweep-9.md, issues #470-#472) already recorded the export
keyword on several of the same do.ts/provision.ts names and its issues closed
COMPLETED without the keywords being dropped — S24-F10/F11 re-list them
because the export keywords are still in the tree.

**Tier rule (from #429):** GLM-OK = none of auth, secrets, credentials,
rescue, failover, accounts routing, deploy, migrations, write-proxy,
leak-gate. CLAUDE-ONLY = touches any of those.

**Sweep's rule for what counts:** an export is a finding when no file OTHER
THAN its own imports it by name — either at all (zero-importer), or only from
the one test file that exists to test that module (sole-test-importer). An
export whose every mention elsewhere is a comment is still zero-importer.
Exports required by wrangler config (DO classes in src/index.ts) are KEEP with
the reason stated. "Proposed action" says un-export (used inside its own file
— drop the keyword only), delete (dead: no use anywhere), or keep + why.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | src/ratelimit.ts: 4 exports (RateLimitResult, RateLimitKind, checkAndConsumeRateLimit, RateLimitKindSpec) — the module's own public core, imported by nobody; only makeRateLimitKind + parsePositiveInt are | GLM-OK |
| 2 | src/tasks/types.ts: GATE_ACTIONS, isGateAction, TaskState, Milestone, PendingApproval — zero importers; only TaskStatus, GateAction, GATE_LABELS are consumed | GLM-OK |
| 3 | src/board/types.ts: isBacklog + BACKLOG_STALE_MS — zero importers (isBacklog used only by sibling isStaleBacklog in-file; BACKLOG_STALE_MS cross-mentioned in a comment) | GLM-OK |
| 4 | src/llm/anthropic-route.ts: 7 exports (LEAD_STREAM_IDLE_MS_DEFAULT, leadStreamIdleMs, LEAD_AI_MAX_RETRIES, LEAD_AI_RETRY_BASE_MS_DEFAULT, leadAiRetryBaseMs, runAiWithRetry, failureClass) — all used in-file + own test only | GLM-OK |
| 5 | src/llm/ratelimit.ts + src/junior/ratelimit.ts: LeadRateLimitEnv, LeadCountTokensRateLimitEnv, JuniorRateLimitEnv — generic env types referenced only as their own module's makeRateLimitKind type parameter | GLM-OK |
| 6 | src/studio/inspect.ts: 7 exports, all zero-importer (INSPECT_TARGET, INCARNATION_SECTION, BRINGUP_LOG_SECTION, INSPECT_BRINGUP_LOG_LINES, InspectSnapshot, InspectExec, InspectDeps); observed.ts keeps a comment-synced private copy | GLM-OK |
| 7 | src/events/: rules.ts CTO_ID + Decision, log.ts D1PortStatement, schema.ts NewEvent — zero importers; D1Port (imported by close-action.ts) and appendEvent/makeEvent/routeDecision/dedupeKey are the consumed surface | GLM-OK |
| 8 | src/github/: api.ts PullRequestInfo (board.ts mentions it in a comment only), wake-events.ts RepoMatch, app.ts MintTokenOpts used in-file + auth.ts signature re-check | GLM-OK |
| 9 | CLI zero-importer types: cli/poll.ts PollOpts, cli/readiness-format.ts LsJsonRow, cli/recycle-outcome.ts RecycleReport, cli/wip-format.ts WipCheckEntry, cli/input.ts Intercept + CTRL_RBRACKET, cli/orca-workspace.ts OrcaRun + WorkspaceOutcome, cli/junior.ts JuniorPaths | GLM-OK |
| 10 | src/studio/do.ts: 22 zero-importer exports — the DO's whole internal vocabulary (RescueResult, HarvestResult, wipSync, recordWipSyncOnSuccess, RecycleGuard, readinessOf, etc.) exported with no importer; un-export en masse, but file borders the rescue lane; batch also carries 2 rescue-adjacent provision.ts names moved from F11 | CLAUDE-ONLY |
| 11 | src/studio/provision.ts + install-cache.ts: 9 provision.ts names + 11 install-cache.ts names; 2 rescue-adjacent provision names moved to F10's CLAUDE-ONLY batch | GLM-OK |
| 12 | src/studio/task-state.ts: TaskStateResult — zero importers; its siblings TaskStateFetchResult + TaskStateDeps are imported by cli/fleet.ts and the test | GLM-OK |
| 13 | src/studio/wake.ts: LOOSE_LIMIT_PATTERNS, SURVEY_HEADER_PATTERN, surveyOverlayOnScreen — zero importers, fixture mentions are comments | GLM-OK |
| 14 | Sole-test-importer class: 209 exports across 30+ modules imported only by their own module's test (install-cache.ts 22, survival-delivery.ts 18, orca-workspace.ts 11, directus/client.ts 7, agents/do.ts 7, org.ts 7...) — unit-test seams, deliberate; record the class, propose no en-masse change | GLM-OK |
| 15 | src/index.ts: AgentDO, DeployDO, StudioDO, StudioBigDO — zero importers in the graph but REQUIRED by wrangler config class_name bindings (wrangler.test.jsonc); KEEP + the in-file comment already says why | KEEP |

### S24-F1. src/ratelimit.ts — the rate-limit engine's public core, imported by nobody — GLM-OK

- **Files:** `src/ratelimit.ts:34` (`export type RateLimitResult`), `:43` (`export interface RateLimitKind`), `:116` (`export async function checkAndConsumeRateLimit`), `:150` (`export type RateLimitKindSpec`).
- **Grep evidence:** importers of ../ratelimit or ./ratelimit: junior/ratelimit.ts (makeRateLimitKind), llm/ratelimit.ts (makeRateLimitKind), llm/anthropic-route.ts (parsePositiveInt). `checkAndConsumeRateLimit` appears outside its file only in its own doc comment at :62; RateLimitResult/RateLimitKindSpec appear nowhere else; RateLimitKind is referenced by llm/ratelimit.ts only inside a comment (:60 "keeping RateLimitKind's shape unchanged").
- **Proposed action:** un-export `checkAndConsumeRateLimit`, `RateLimitResult`, `RateLimitKindSpec`; KEEP `RateLimitKind` exported only if a test imports it after F1 lands — today nothing does. All four are used inside ratelimit.ts itself (checkAndConsumeRateLimit is the engine makeRateLimitKind delegates to at :178), so this is keyword-drop, not deletion. Risk: none — tsc would catch any hidden importer at build time.

### S24-F2. src/tasks/types.ts — five of eight exports consumed by nothing — GLM-OK

- **Files:** `src/tasks/types.ts:3` (`export const GATE_ACTIONS`), `:7` (`export function isGateAction`), `:19` (`export type TaskState`), `:21` (`export interface Milestone`), `:26` (`export interface PendingApproval`).
- **Grep evidence:** the module's importers are tasks/loop.ts, agents/runtime.ts, approvals/gates.ts, approvals/store.ts, test/tasks.loop.test.ts — each imports ONLY TaskStatus, GateAction, or GATE_LABELS. `isGateAction` is called nowhere (its own body is the only use of GATE_ACTIONS outside the array's declaration). TaskState/Milestone/PendingApproval are used in-file to compose TaskStatus; container/server.ts declares its own local `TaskState`, `Milestone`, `GATE_ACTIONS` mirrors ("Mirrors src/tasks/types.ts's GATE_ACTIONS" — a comment at container/server.ts:53), which is why a name grep alone overcounts.
- **Proposed action:** un-export GATE_ACTIONS, isGateAction, TaskState, Milestone, PendingApproval. isGateAction is a dead export — delete the function entirely if no test pins it (none does).

### S24-F3. src/board/types.ts — isBacklog and BACKLOG_STALE_MS exported for no reader — GLM-OK

- **Files:** `src/board/types.ts:143` (`export function isBacklog`), `:154` (`export const BACKLOG_STALE_MS`).
- **Grep evidence:** isBacklog's only caller is the sibling isStaleBacklog in the same file (:182). BACKLOG_STALE_MS's only out-of-file mention is a doc comment in src/memory/compact.ts:27 ("the same sprint length board/types.ts's BACKLOG_STALE_MS is") — a comment, not an import. BoardTask's state field uses the board's own TaskState, so no hidden dependency.
- **Proposed action:** un-export both; keep the compact.ts comment (it cites the name, and the name stays — only the export keyword goes). Zero behavior change; tsc pins it.

### S24-F4. src/llm/anthropic-route.ts — the whole GLM-lead tuning surface is self-plus-test-only — GLM-OK

- **Files:** `src/llm/anthropic-route.ts:132` (LEAD_STREAM_IDLE_MS_DEFAULT), `:137` (leadStreamIdleMs), `:148` (LEAD_AI_MAX_RETRIES), `:154` (LEAD_AI_RETRY_BASE_MS_DEFAULT), `:158` (leadAiRetryBaseMs), `:170` (runAiWithRetry), `:218` (failureClass).
- **Grep evidence:** all seven are used inside anthropic-route.ts itself (runAiWithRetry at :514, failureClass at :456, leadStreamIdleMs at :561, leadAiRetryBaseMs at :515, LEAD_AI_MAX_RETRIES at :181). The ONLY external import is test/llm.anthropic-route.test.ts; env.ts mentions LEAD_STREAM_IDLE_MS_DEFAULT and LEAD_AI_RETRY_BASE_MS_DEFAULT in the doc comments of the corresponding env vars (:107, :114) — comments, not imports.
- **Proposed action:** KEEP runAiWithRetry, leadStreamIdleMs, leadAiRetryBaseMs, failureClass exported — they are the test's seams for the retry policy and a plausible future consumer surface (they encode the operator's GLM timeouts); un-export the two _DEFAULT constants if the test stops needing them, or keep for the same reason. Minimum honest change: none required; the finding records that the tuning surface is deliberately closed. Proposed: keep + add nothing; listed because the sweep counts exports with zero production importers.

### S24-F5. The three env type parameters — generic aliases consumed only by their own makeRateLimitKind call — GLM-OK

- **Files:** `src/llm/ratelimit.ts:36` (`export type LeadRateLimitEnv`), `:55` (`export type LeadCountTokensRateLimitEnv`), `src/junior/ratelimit.ts:28` (`export type JuniorRateLimitEnv`).
- **Grep evidence:** each appears in exactly two places: its declaration and its own module's `makeRateLimitKind<X>({...})` type parameter (llm/ratelimit.ts:41, :63; junior/ratelimit.ts:33). No file imports any of the three; the modules' consumed exports are the checkAndConsume* functions (junior/route.ts:15, llm/anthropic-route.ts:22).
- **Proposed action:** un-export all three (drop the keyword; the type stays for its own module's generic). One-line each.

### S24-F6. src/studio/inspect.ts — seven internal exports; INSPECT_TARGET's cross-file twin is a comment-synced copy — GLM-OK

- **Files:** `src/studio/inspect.ts:72` (INSPECT_TARGET), `:116` (INCARNATION_SECTION), `:117` (BRINGUP_LOG_SECTION), `:121` (INSPECT_BRINGUP_LOG_LINES), `:182` (InspectSnapshot), `:252` (InspectExec), `:254` (InspectDeps) — all zero-importer.
- **Grep evidence:** grep for each name across src/cli/test/page/scripts returns only inspect.ts itself (and test/studio.inspect.test.ts for the *_DEFAULT_TAIL_LINES/INSPECT_EXEC_MS family, which is NOT part of this finding). observed.ts does NOT import INSPECT_TARGET: observed.ts:811 keeps a private copy — `const LEAD_PANE_TARGET = "studio:claude"` — under a comment ("Matches inspect.ts's own INSPECT_TARGET value") asking the two to stay in sync. The copy is deliberate by design: inspect.ts imports INCARNATION_PATH FROM observed.ts, so importing back would be circular. INSPECT_TARGET has zero importers.
- **Proposed action:** un-export all seven. The sync mechanism between the two marker strings is the comment at observed.ts:811, not an import, so dropping the keyword changes nothing for observed.ts. Keep-verdict fallback: if the reviewer prefers keeping INSPECT_TARGET exported as the canonical copy observed.ts's comment cites, that is defensible; both verdicts are recorded — recommended is un-export with the comment as the sync mechanism.

### S24-F7. src/events/ — the decision types' exports outlived their consumers — GLM-OK

- **Files:** `src/events/rules.ts:3` (`export const CTO_ID`), `:5` (`export type Decision`), `src/events/log.ts:39` (`export interface D1PortStatement`), `src/events/schema.ts:24` (`export interface NewEvent`).
- **Grep evidence:** events/rules importers: tasks/loop.ts (routeDecision), test/events.rules.test.ts (dedupeKey, routeDecision). CTO_ID and Decision are used inside rules.ts only (routeDecision returns Decision; CTO_ID feeds the CTO escalation check). Directus "Decision" hits (schema.ts, types.ts EstateDecision) are a different type in a different module. D1Port's sibling D1PortStatement is referenced only inside log.ts (D1Port's own signature) — D1Port IS imported (board/close-action.ts:12). NewEvent is used only inside schema.ts (appendEvent/makeEvent take it).
- **Proposed action:** un-export CTO_ID, Decision, D1PortStatement, NewEvent. Keep appendEvent, D1Port, makeEvent, routeDecision, dedupeKey — the actual consumed surface.

### S24-F8. src/github/ — one comment-mentioned type, one orphan, one in-family seam — GLM-OK

- **Files:** `src/github/api.ts:907` (`export interface PullRequestInfo`), `src/github/wake-events.ts:105` (`export interface RepoMatch`), `src/github/app.ts:79` (`export interface MintTokenOpts`).
- **Grep evidence:** PullRequestInfo's only out-of-file mention is a comment in src/board/board.ts:67 ("Narrowed from github/api.ts's PullRequestInfo") — board.ts defines its own narrower type. RepoMatch appears nowhere outside wake-events.ts. MintTokenOpts IS imported by src/github/auth.ts:58 and used in mintRepoToken's signature :329 — false positive from the first pass, corrected here: MintTokenOpts is USED, not a finding; kept in the table so the correction is on the record.
- **Proposed action:** un-export PullRequestInfo and RepoMatch; MintTokenOpts keep. (Auth-adjacent modules were read for rule-out only — github/app.ts is the token-mint lane's edge, so any change there belongs to the CLAUDE-ONLY lane; this finding's un-export targets api.ts and wake-events.ts only, both GLM-safe.)

### S24-F9. CLI display types exported with no importer — GLM-OK

- **Files:** cli/poll.ts:5 (PollOpts), cli/readiness-format.ts:458 (LsJsonRow), cli/recycle-outcome.ts:86 (RecycleReport), cli/wip-format.ts:58 (WipCheckEntry), cli/input.ts:14 (CTRL_RBRACKET) + `:17` (Intercept), cli/orca-workspace.ts:113 (OrcaRun) + `:167` (WorkspaceOutcome), cli/junior.ts:20 (JuniorPaths).
- **Grep evidence:** each name greps to its own file only. cli/fleet.ts imports from these modules — but classifyInput/CTRL_V (input), reapTerminalAll/TerminalPage (reap-terminal), formatMemoryTable/MemoryFileRow (memory-format), sweepAllPages/SweepPage (junior-sweep) — never the finding's names. Intercept is the return type of the IMPORTED classifyInput, so callers see the type without importing it: the export is a convenience nobody took.
- **Proposed action:** un-export all nine. All are used in-file (PollOpts in pollLoop's signature, RecycleReport in recycle's render, WipCheckEntry in wip-format's rows, OrcaRun/WorkspaceOutcome in orca's deps/results, JuniorPaths in junior's own helpers, CTRL_RBRACKET/Intercept in classifyInput). Zero behavior change.

### S24-F10. src/studio/do.ts — 22 zero-importer exports, one file — CLAUDE-ONLY

- **Files:** `src/studio/do.ts` — the finding's spread: :642 RescuePushKind, :655 RescueResult, :819 wipSync, :867 recordWipSyncOnSuccess, :910 WipLastCheckResult, :1185 HarvestResult, :1325 ArchiveResult, :1347 DoneRecordArchiveDeps, :1508 DONE_RECORD_COMMENT_MAX_CHARS, :1653 RecycleGuard, :2101 readinessOf, :2154 START_REFUSED_CODE, :2203 startRefusedResponse, :2212 limitSightingIn, :2218 switchedBlockIn, :2264 recordDeliveredTask, :2719 HealDecision, :3698 LastStopStorage, :3852 readFleetAccountBurn, :4273 refuseUnlessJuniorEnabled, :4505 glmAnthropicBaseUrl, :4590 SpawnTokenStorage, :5159 STALE_BACKGROUND_SHELL_NUDGE_PROMPT (line numbers from the first pass; re-pin before any fix). Plus the 2 rescue-adjacent provision.ts names moved here from F11: `src/studio/provision.ts:1005` (REMOTE_BRANCHES_LIST_FILE), `:1030` (RESCUE_DISCOVERY_TIMEOUT_SECONDS).
- **Grep evidence:** importer map over src/cli/test/scripts/page finds no file importing any of these from ./do or ../studio/do. Correction from the PR-614 review, on the record: the first pass wrongly listed :631 RESCUE_MARKERS_ONLY (a re-export — do.ts:631-634 re-exports it from ./rescue, the class this sweep's method excludes) and :1207 CommitLearningFile, :1217 ResolveMemoryRepo, :1368 DoneRecordHashStorage — those three ARE imported: src/studio/destroy.ts:50 imports all three from ./do and uses them at destroy.ts:147,148,311,452,453; tests import them too (test/studio.session.test.ts, test/studio.observation.test.ts), so they are not zero-importer and are out of this finding. do.ts's actual src importers are env.ts, src/index.ts, destroy.ts (NOT routes.ts, survival-delivery.ts — those were the first pass's error) — they pull DO classes, a handful of names, and the trio above, none of the finding's list. The export keywords are fossils of do.ts's monolith era (pre-split), when the names were shared with modules that have since been extracted with their own copies.
- **Proposed action:** CLAUDE-ONLY — do.ts sits in the rescue/failover-adjacent lane (RecycleGuard, rescue push paths, and now the two rescue-discovery provision.ts constants), so the en-masse un-export belongs to a task with the lane's guardrails, not a GLM batch. Filed as one deepen issue for a Claude-led pass; mechanical (drop keywords, run tsc), but large enough to deserve its own review.

### S24-F11. src/studio/provision.ts + install-cache.ts — the same fossil class, GLM-safe side; 7 provision.ts names + 11 install-cache.ts names — GLM-OK

- **Files:** `src/studio/provision.ts` — :466 KEEP_ALIVE_KEY, :883 guardedCloneCmd, :1359 verifyBringupLanded, :1566 TAILNET_DOWN_PATH, :1772 OpsHouseRulesOutcome, :3135 SessionAdoption, :3257 freshSessionNoteFor. `src/studio/install-cache.ts` — :203 INSTALL_CACHE_KEEP_GENERATIONS, :740 INSTALL_COMPLETE_MARKER, :1328 R2PresignEnv, :1352 INSTALL_CACHE_URL_TTL_SECONDS, :1452 InstallCacheRestoreOutcome, :1461 InstallCacheDirRestoreResult, :1475 InstallCacheRestoreResult, :1852 InstallCacheFailureRecord, :2001 InstallCacheSaveOutcome, :2005 InstallCacheDirSaveResult, :2013 InstallCacheSaveResult.
- **Grep evidence:** zero importers for every name (importer map + hand grep). install-cache.ts's own test imports a DIFFERENT family (the test-only names — finding F14), not these. Correction from the PR-614 review: the first pass claimed "no rescue/auth adjacency in provision's listed names" — false. REMOTE_BRANCHES_LIST_FILE (:1005) and RESCUE_DISCOVERY_TIMEOUT_SECONDS (:1030) are consumed only by provision.ts's own rescue-discovery command builder (discoverRescueRefsCmd, :1032 — they are its default parameters), and sweep-9 already ruled this pair CLAUDE-ONLY (rescue scripts). They are NOT in this finding's list anymore.
- **Proposed action:** un-export the seven non-rescue provision.ts names as GLM-OK — mechanical keyword drops, tsc-verifiable, no rescue/auth adjacency in them; the two rescue-adjacent names (REMOTE_BRANCHES_LIST_FILE, RESCUE_DISCOVERY_TIMEOUT_SECONDS) move to the CLAUDE-ONLY batch with F10. install-cache.ts is pure install-cache mechanics.

### S24-F12. src/studio/task-state.ts — TaskStateResult orphaned by its own consumers — GLM-OK

- **Files:** `src/studio/task-state.ts:38` (`export type TaskStateResult`).
- **Grep evidence:** the module's importers: cli/fleet.ts:37 and test/studio.task-state.test.ts:2 — both import runTaskStateTransition + TaskStateFetchResult (+ TaskStateDeps in the test). TaskStateResult is used in-file (:69, runTaskStateTransition's return type) but never imported: consumers let the return type flow from the function signature.
- **Proposed action:** un-export. One keyword.

### S24-F13. src/studio/wake.ts — three exports whose only outside mentions are comments — GLM-OK

- **Files:** `src/studio/wake.ts:135` (LOOSE_LIMIT_PATTERNS), `:204` (SURVEY_HEADER_PATTERN), `:224` (surveyOverlayOnScreen).
- **Grep evidence:** grep across src/cli/test finds the names inside wake.ts only, plus comments: test/fixtures/survey-panes.ts:22 and test/bun/wake-guard.test.ts:351,355 cite them in prose ("`surveyOverlayOnScreen`'s own doc comment", "the container-side SURVEY_HEADER_PATTERN wraps..."). wake.ts's real importers (webhook.ts, assign-wake.ts, wake-gate.ts, failover.ts, survival-delivery.ts, sweep.ts, do.ts, routes.ts) import WakeOutcome, WakeExec, logWakeOutcome, runGatedWake, singleFlightWake — none of the three.
- **Proposed action:** un-export all three; used in-file (LOOSE_LIMIT_PATTERNS → LOOSE_JS :149, SURVEY_HEADER_PATTERN → the survey probe, surveyOverlayOnScreen → the detector).

### S24-F14. The sole-test-importer class — 209 exports across 30+ modules — GLM-OK (record, no action)

- **Files (top of the distribution):** src/studio/install-cache.ts (22 names), src/studio/survival-delivery.ts (18), cli/orca-workspace.ts (11), src/agents/do.ts (7), src/directus/client.ts (7), src/studio/org.ts (7), src/github/api.ts (6), src/studio/ff.ts (6), src/studio/burn.ts (6), src/studio/claude-swap.ts (6) — each name imported only by its module's own test file.
- **Grep evidence:** importer map: for every name, the importer set is exactly {src/<module>, test/<module>.test.ts} (or test/bun/<module>.test.ts). Example: install-cache's repoCheckoutDirName/installCacheKey/... imported by test/install-cache.test.ts alone.
- **Proposed action:** KEEP — deliberate unit-test seams on pure modules (the repo's own test-lies-check enforces that these tests test the module, not mocks). Recording the class because the task asks for it; a future lint (e.g. knip) should be configured to treat these as used, not to flag them.

### S24-F15. src/index.ts DO class re-exports — zero importers, required anyway — KEEP

- **Files:** `src/index.ts:26,29,41` — `export { AgentDO } from "./agents/do"`, `export { DeployDO } from "./deploy/do"`, `export { StudioDO, StudioBigDO } from "./studio/do"`.
- **Grep evidence:** no file imports from src/index.ts; wrangler.test.jsonc binds class_name AgentDO/StudioDO (:61,63) and the migrations list names them (:68,70) — the entry-point export is what makes the binding resolve. The in-file comment at :27-31 already documents the boot-failure mode when this line is missing (Day 1 Task 4).
- **Proposed action:** KEEP, zero change. Listed so a future unused-export tool does not flag it, and because the sweep's method (zero importers) would otherwise report it as a false positive.

## Not filed (counted, no issue)

- The do.ts `export {X} from "./y"` re-export blocks (:190, :239) — re-exports of harvest-record/ship-cadence names for the DO's own graph; counted as re-exports, not findings.
- container/'s local mirrors (TaskState, GATE_ACTIONS, Milestone at container/server.ts:50-62) — deliberate container-side copies with their own comment; not part of src's export surface.
- `__reset*ForTests` exports (org.ts:203, test-creds.ts:110, burn.ts:603) — test-reset hooks by naming convention; same class as F14.
- Approx. 341 further zero-importer exports inside excluded lanes (rescue, failover, auth, accounts routing, deploy, write-proxy, approvals, leak-gate, credentials) — out of scope per the task's EXCLUDE list, counted for the record only.
- 290 further in-scope sole-test-importer names below the top-10 distribution (F14 lists the head) — same class, same keep verdict.

## Counts

15 findings: 12 GLM-OK with proposed un-export actions (F1-F3, F5-F7, F9, F11-F13 + the F14 record + F15 keep), 1 CLAUDE-ONLY (F10, do.ts en-masse pass), 2 keep-with-reason (F4, F15), 1 record-only (F14). F10's count after the PR-614-review corrections: 22 do.ts zero-importer names (25 minus the destroy.ts-imported trio CommitLearningFile/ResolveMemoryRepo/DoneRecordHashStorage and the re-exported RESCUE_MARKERS_ONLY) plus the 2 rescue-adjacent provision.ts names moved in from F11 — a 24-name CLAUDE-ONLY batch. F11 drops to 7 provision.ts + 11 install-cache.ts = 18 names. Filed deepen issues: one per actionable batch — F1, F2, F3, F5, F6, F7, F9, F11, F12, F13 (GLM-OK un-export batches), F10 (CLAUDE-ONLY), F8 (correction-only, no issue needed).

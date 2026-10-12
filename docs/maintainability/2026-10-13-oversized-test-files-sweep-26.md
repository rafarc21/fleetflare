# Oversized test files sweep 26 — apps/fleet/test (2026-10-12)

Ref #635. Analysis only, read-only, no code changed, no splits
performed. Twenty-sixth maintainability sweep; scope
`apps/fleet/test/**` only (vitest root + test/bun). Twenty-sixth
sweep's lens: test FILES, not functions — files over 800 lines, the
seams they could split along (top-level describe blocks grouped by the
module under test), proposed split names, and the shared setup each
half would need. Census at origin/main `f558821` by `wc -l`: **34 files
strictly >800 lines**; the top 15 are findings below, the remaining 19
are listed as context (no findings filed for them this round — cap is
15, they wait for sweep 26b or a later sweep).

**Tier rule (from #539):** GLM-OK = none of auth, secrets, credentials,
rescue, failover, accounts routing, deploy. CLAUDE-ONLY = touches any of
those. NOTE: the DOC is one batch; the SPLIT work each finding proposes
inherits the lane of the file it splits. Lane marks below are for the
SPLIT, not this doc: rescue-push, account-failover, git-wrapper
(credentials), burn (failover seam in its syncSessionTick clusters) are
CLAUDE-ONLY; the rest GLM-OK.

**Shared-setup census:** none of the 15 files import from
`test/helpers` or `test/bun/helpers` except as noted. The real shared
setup each oversized file carries is IN-FILE fakes and fixtures — the
seam question for every split is "which in-file helpers does each half
need", answered per finding. Existing shared helpers available for
extraction if a split wants them: `test/helpers/{bringup-pins, datetime,
do-storage, fake-namespace, http, studio-row}.ts`,
`test/bun/helpers/{credentials, poll, shell}.ts`,
`test/bun/exec-snippet.ts` (BRINGUP source + runSnippet +
extractHeredoc), `test/fixtures/rate-limit-panes.ts`.

## Method

`find apps/fleet/test -name '*.test.ts' | xargs wc -l | sort -rn`,
threshold strictly >800. 34 hits, 134,488 total test lines in scope.
Top 15 by size read in full: top-level `describe(` blocks mapped with
`grep -n '^describe('`; describe-less bun files (orca-workspace,
git-wrapper) mapped by their `// ---` divider comments and
lane-guarded `describe`-aliases; clusters then grouped by the src
module or script each block targets (titles carry it). Proposed split
names follow the existing convention `<module>.<aspect>.test.ts`
(studio.session → studio.session-archive.test.ts etc.), one seam per
finding, halves sized by the line ranges measured.

## Findings

| # | file | lines | proposed split (halves) | lane |
|--:|---|---:|---|---|
| 1 | test/studio.session.test.ts | 5339 | session-archive + session-recycle | GLM-OK |
| 2 | test/bun/rescue-push.test.ts | 4039 | rescue-push-walk + rescue-push-remote | CLAUDE-ONLY |
| 3 | test/studio.routes.test.ts | 3959 | routes-handle + routes-accounts | GLM-OK |
| 4 | test/studio.account-failover.test.ts | 2629 | failover-accounts + failover-run | CLAUDE-ONLY |
| 5 | test/studio.burn.test.ts | 2613 | burn-parse + burn-cursor | CLAUDE-ONLY |
| 6 | test/bun/orca-workspace.test.ts | 2342 | orca-ensure + orca-registry | GLM-OK |
| 7 | test/studio.replacement.test.ts | 2304 | replacement-restart + replacement-restore | GLM-OK |
| 8 | test/bun/git-wrapper.test.ts | 2245 | wrapper-refusals + wrapper-leakgate | CLAUDE-ONLY |
| 9 | test/studio.provision.test.ts | 2205 | provision-rescue + provision-leakgate | GLM-OK |
| 10 | test/studio.survival-delivery.test.ts | 2168 | survival-input + survival-retry | GLM-OK |
| 11 | test/studio.observation-tick.test.ts | 2168 | observation-prologue + observation-tick | GLM-OK |
| 12 | test/bun/install-cache-security.test.ts | 2087 | cache-security-parse + cache-security-disk | GLM-OK |
| 13 | test/board.board.test.ts | 2019 | board-create + board-assign | GLM-OK |
| 14 | test/bun/bringup-hooks.test.ts | 1806 | hooks-leadgate + hooks-heartbeat | GLM-OK |
| 15 | test/github.webhook.test.ts | 1797 | webhook-core + webhook-autoclose | GLM-OK |

### F1. test/studio.session.test.ts — 5339 lines, 57 describes — GLM-OK

- **Lines:** 5339. 57 top-level describes over at least five src
  modules — the largest file in the tree, ~2.5× the runner-up's
  natural size.
- **Seams (line ranges measured):**
  - `:312-961` — tarAndStatCmd/singleReadCmd/splitCmd/partReadCmd shapes
    + `syncSessionTick` (session-sync.ts): 650 lines, 7 describes.
  - `:961-2118` — `syncSessionCycle` + wip-sync plumbing (do.ts):
    1158 lines, 6 describes.
  - `:2118-2907` — restorePlan/runSessionRestore (provision.ts) + the
    container/studio-bringup.sh source-assertion blocks (7 describes,
    `:2253-2861`): 789 lines.
  - `:2907-3240` — restartWithSync + provisionedCheckCmd/rescuePushCmd
    shell shapes (provision.ts + rescue): 333 lines.
  - `:3240-3712` — rescuePush/rescueSnapshot commit+push behavior
    (rescue): 472 lines.
  - `:3467-4069` — harvestLearnings + archiveDoneRecords (do.ts):
    602 lines.
  - `:4069-4984` — recycleWithSync end-to-end + harness expectation
    + Tier-0 completion gate: 915 lines.
  - `:4980-5339` — remaining bringup.sh source assertions + aside
    sessions + per-worktree rescue report: 359 lines.
- **Proposed split (two files, one seam):** the archive half
  `test/studio.session-archive.test.ts` (:312-961 + :2118-2253 + the
  bringup.sh blocks :2253-2907) and the lifecycle half
  `test/studio.session-lifecycle.test.ts` (syncSessionCycle, wip-sync,
  restore, rescue-push, harvest, archive-done, recycle+gate). Simpler
  first cut: split at the do.ts seam — everything touching
  session-sync.ts vs everything touching do.ts/provision.ts.
- **Shared setup:** in-file consts STUDIO_ID, TODAY, TAR_STARTED_AT,
  chunked-b64 helper, fake storage maps; imports `fixedNow, b64` from
  `test/helpers/datetime`, `bringupSrc, expectBrings, expectBringsNot`
  from `test/helpers/bringup-pins`, ORG_SPEND_LIMIT_PANE from
  `test/fixtures/rate-limit-panes`. Both halves need the datetime
  helpers; only the bringup.sh-assertion blocks need bringup-pins.
  The in-file `makeStorage`-shaped fakes (SessionSyncStorage +
  ObservedStorage + InstallCacheSaveStorage maps) would be duplicated
  or extracted to `test/helpers/do-storage.ts` (exists — adoption is
  part of the split work).

### F2. test/bun/rescue-push.test.ts — 4039 lines, 41+ describes — CLAUDE-ONLY

- **Lines:** 4039, real-git lane (bun:test). 41+ describes, nearly all
  `#NNN`-titled review-round regressions of the rescue_one walk.
- **Seams:**
  - `:220-974` — rescue_one walk core: markers, dirty-tree branches,
    per-worktree walk, detached HEAD, one-run idempotence, spaces in
    paths, stashes, removed worktrees, stderr corruption.
  - `:975-1195` — discoverRescueRefsCmd + rescueSnapshotCmd
    (provision.ts + rescue.ts snapshot half).
  - `:1195-1778` — wipSyncCmd + wipSyncProbeCmd lifecycle and budget
    (#208/#231 threads).
  - `:1778-2353` — HOLD/BLOCKER rounds: never-onto-checked-out-branch,
    pre-push-hook survival, per-call-site push budgets (#359/#362/#371).
  - `:2353-2623` — identity/remote configuration (#335, #1).
  - `:3532-4039` — report shape + on-origin reachability checks
    (#39/#49/#58/#80/#233/#241).
- **Proposed split:** `test/bun/rescue-push-walk.test.ts` (walk core +
  report + on-origin: :220-974 + :3532-4039) and
  `test/bun/rescue-push-remote.test.ts` (snapshot/wip-sync/budgets/
  identity/remote: :975-2623 + :1778-2353). Gaps 2623→3532 are
  mid-file helpers.
- **Shared setup:** REAL_GIT_BIN/TIMEOUT_BIN/PERL_BIN lane guards +
  shim dirs (top ~130 lines), mkdtemp'd fixtures per test. Both
  halves need the lane guard preamble + `bun:test` imports; the
  shim-dir builders would move to `test/bun/helpers/shell.ts` (exists)
  or be duplicated (they are ~40 lines).
- **Why CLAUDE-ONLY:** rescue is on the tier list; every describe here
  exercises rescue-push mechanics.

### F3. test/studio.routes.test.ts — 3959 lines, 17 describes — GLM-OK

- **Lines:** 3959. `describe("handleStudio")` alone spans `:425-1680`
  (1255 lines); accounts/sync spans `:2199-3079` (880 lines).
- **Seams:**
  - `:425-1680` — handleStudio core verbs (POST provision, terminal,
    sandbox-api, redactSecrets, dynamic repo, reach).
  - `:1680-2199` — provision env resolution + MAX_STUDIOS + terminal
    fallback + redact.
  - `:2199-3199` — GET accounts + POST accounts/sync + held rows
    (#336).
  - `:3199-3959` — worker-exceptions, brief injection, inspect, wake,
    repair verbs, 409 surfacing.
- **Proposed split:** `test/studio.routes-handle.test.ts`
  (:425-1680 + :1680-2199) and `test/studio.routes-accounts.test.ts`
  (:2199-3959). The first describe carries the handleStudio request
  builder fakes (authModule mock, sandbox fakes); the accounts half
  carries its own account-usage fixtures.
- **Shared setup:** in-file: authModule vi.mock, STUDIO_ID,
  FAKE_ROLE_PROMPT + decodeRolePrompt, sandbox handle fakes
  (sbExec/sbWriteFile/SandboxHandle shapes), recordStudio seeds. Both
  halves need the studio-row seeding; handleStudio half needs the
  sandbox fakes, accounts half needs readFleetAccountUsage/
  writeFleetAccountUsage fixtures. Natural helpers for extraction:
  `test/helpers/studio-row.ts` (exists) + `test/helpers/http.ts`.

### F4. test/studio.account-failover.test.ts — 2629 lines, 34 describes — CLAUDE-ONLY

- **Lines:** 2629. Two modules under test: `src/studio/accounts`
  (account resolution/pick: `:145-642`, ~500 lines) and
  `runAccountFailover` in failover.ts (`:898-2629`, ~1730 lines).
- **Proposed split:** `test/studio.accounts.test.ts` (:145-897 —
  resolveClaudeAccounts, nextClaudeAccount, selectByHeadroom, reset
  timing, pane capture, accountSwitchCmd) and
  `test/studio.failover.test.ts` (:898-2629 — every runAccountFailover
  describe + the syncSessionCycle failover-step block).
- **Shared setup:** in-file envWith()/status() builders, TOKEN_n
  consts, STUDIO_TMUX import. Accounts half needs only the accounts
  imports; failover half needs StudioDO + SessionSyncDeps fakes +
  pane fixtures. No test/helpers imports today; the status() override
  factory is the one both halves want — 10-line duplication or
  extract.
- **Why CLAUDE-ONLY:** accounts routing + failover, both on the tier
  list.

### F5. test/studio.burn.test.ts — 2613 lines, 24 describes — CLAUDE-ONLY

- **Lines:** 2613. Three layers: pure parsing (parseUsageIncrement,
  rollWindow, freshBurn, shouldAlert: `:72-537`), archive parsing
  (readJsonlMembersFromTar, extractJsonlMembers, sessionStats:
  `:537-806`), and the burn CURSOR lifecycle wired into
  syncSessionTick/mirrorBurnToRegistry (`:806-2613` — 1807 lines, 14
  describes, the #154/#258/#309 review-round cluster).
- **Proposed split:** `test/studio.burn-parse.test.ts` (:72-806 — pure
  parsing + archive-format errors) and
  `test/studio.burn-cursor.test.ts` (:806-2613 — cursor identity,
  pruning, size-based prune, legacySeed, registry mirroring).
- **Shared setup:** in-file jsonl line builders (assistantLine,
  userLine, summaryLine) + fixedNow from `test/helpers/datetime`.
  Parse half needs the line builders; cursor half needs those PLUS
  fake StudioStorage maps + recordStudio seeds. Line builders are the
  extract candidate → `test/helpers/` new module (sweep-18 helper
  rule: shared fixture, both halves).
- **Why CLAUDE-ONLY:** the syncSessionTick clusters exercise the
  failover-seamed registry/parking steps (PARKED_AUTO_STOP_HOURS
  family); parse half alone would be GLM-OK but the seam bundles both.

### F6. test/bun/orca-workspace.test.ts — 2342 lines, 0 describes / 143 tests — GLM-OK

- **Lines:** 2342, bun:test, ZERO describes — 143 flat tests organized
  only by `// ---` divider comments (23 dividers). Fakes preamble alone
  is `:44-216` (173 lines).
- **Seams (divider clusters):**
  - `:217-718` — name derivation, orcaPresent, ensureStudioWorkspace
    requirements, duplicate terminals, tabs/plan verbs.
  - `:719-1599` — teardown (removeStudioWorkspace), healing, path
    fallback, multi-instance, registry races, fileLockAt, row titles.
  - `:1600-2342` — fleet ls ROW column (classifyStudioRow/
    readStudioRows, 290 lines), ranking, partial answers,
    openStudioRow/closeStudioRow, findAttachHandle.
- **Proposed split:** `test/bun/orca-ensure.test.ts` (:217-751 —
  ensure + verbs) and `test/bun/orca-registry.test.ts` (:752-2342 —
  teardown, locks, registry, rows). First step of either split:
  wrap clusters in real describes (organization is divider comments
  today).
- **Shared setup:** all in-file: ok(), Fake interface, memoryLock(),
  memoryRegistry(), boardTask(), fake() orca builder,
  worktrees()/terminals() result fixtures, TEST_TITLE; mid-file real-fs
  helpers studio(), tmpWorktree, tmpSalvageRoot, tmpRegistryFile,
  tmpLockDir. Ensure half needs fake()+fixtures; registry half needs
  those PLUS the tmp-fs helpers + the node:os mock. The
  fixtures/fakes preamble is the sweep-18 extraction candidate.

### F7. test/studio.replacement.test.ts — 2304 lines, 20 describes — GLM-OK

- **Lines:** 2304, 20 describes. Two clusters: restart/replace
  machinery (`:186-1333` — runRestart, retry-heal, verdicts,
  incarnation tokens, stale keys, observation exec) and restore/
  keeper sourcing (`:1333-2304` — staged restore, snapshot age,
  keeper-sourced restores, session verdicts).
- **Proposed split:** `test/studio.replacement-restart.test.ts`
  (:186-1332) and `test/studio.replacement-restore.test.ts`
  (:1333-2304).
- **Shared setup:** in-file provision/restart storage fakes + observed
  seeds shared across both halves — a fake storage factory is the
  extract candidate (`test/helpers/do-storage.ts` exists and may
  already fit).

### F8. test/bun/git-wrapper.test.ts — 2245 lines, 19 blocks — CLAUDE-ONLY

- **Lines:** 2245, real-git lane, 19 lane-guarded describes. One
  module under test: the generated git wrapper
  (studioGitSafetyCmd/studioGitWrapperScript), with the leak-gate
  cluster the only seam that leaves it.
- **Seams:**
  - `:294-1706` — wrapper push refusals across all review rounds
    (default branch, probe flags, aliases, plumbing, repair).
  - `:1707-1882` — insteadOf decoys + empty-remote first push.
  - `:1883-2245` — leak gate on every push (363 lines, src/leak-gate).
- **Proposed split:** `test/bun/git-wrapper-refusals.test.ts`
  (:294-1882) and `test/bun/git-wrapper-leakgate.test.ts`
  (:1883-2245).
- **Shared setup:** the `Fixture` builder (own bare origin + clone +
  HOME + bin/ PATH shadow, `:136-293`, 158 lines) + expectRefused*
  assert helpers + afterEach temp-root cleanup. Both halves need
  Fixture wholesale — it is the extract candidate →
  `test/bun/helpers/` (sweep-18 rule). Leak-gate half adds
  writeGate + denylistFileContent fixtures.
- **Why CLAUDE-ONLY:** credentials (STUDIO_PUSH_* constants,
  wrapper install) + leak-gate, both tier-list.

### F9. test/studio.provision.test.ts — 2205 lines, 17 describes — GLM-OK

- **Lines:** 2205. Provision core (`:112-1004` — provisionWithStorage,
  resolveBringupEnv, runProvision repo selection, discoverRescueRefs)
  vs ports/overlays/gates (`:1005-2205` — resolveWorkRepoSlug,
  writeBlueprintCredential, applyStudioGitSafety, verification,
  opsFileFetcher, applyLeakGate, installLeakGatePort, leadType).
- **Proposed split:** `test/studio.provision-core.test.ts`
  (:112-1004) and `test/studio.provision-ports.test.ts`
  (:1005-2205).
- **Shared setup:** beforeEach clearing fleet_state D1 table,
  FAKE_FLEET_JSON/FAKE_ORG_JSON/FAKE_ROLE_MD/FAKE_STUDIO_MD/
  FAKE_MEMBER_*_MD blueprint fixtures, notFound(), fakeStorage()
  Map-backed StudioStorage, REPO_SLUG. Both halves need fakeStorage +
  the FAKE_* blueprint fixtures + a per-test sbExec vi.fn — the
  blueprint fixtures are the extract candidate (sweep-18).
- **Lane note:** the leak-gate describes are in this file but the
  split's lane stays GLM-OK — leak-gate tests assert behavior of the
  gate installer, not gate secrets; if the reviewer disagrees, the
  ports half is the one to re-mark.

### F10. test/studio.survival-delivery.test.ts — 2168 lines, 19 describes — GLM-OK

- **Lines:** 2168, 19 describes over src/studio/survival-delivery.
  Natural gradient: pure gates → input resolution → delivery/retry.
- **Seams:**
  - `:83-1338` — allowlist, busy signals, branch sources,
    resolveSurvivalInput GitHub wiring, matchesTaskNumber, snapshot
    age.
  - `:1339-2168` — deliverSurvivalBriefOnBringup + threading +
    single-flight + pending marker + retry + board outage + tick.
- **Proposed split:** `test/studio.survival-input.test.ts` (:83-1338)
  and `test/studio.survival-retry.test.ts` (:1339-2168).
- **Shared setup:** in-file fakeObserved() Map-backed ObservedStorage,
  session() factory, IDLE_PANE/MIDTURN_PANE (from
  test/fixtures/rate-limit-panes — already shared), captured() marker.
  Input half needs fakeObserved+session+panes; retry half needs those
  PLUS composeSurvivalBrief fakes + wake thunks.

### F11. test/studio.observation-tick.test.ts — 2168 lines, 15 describes — GLM-OK

- **Lines:** 2168, 15 describes. Effectively one module —
  runShipTickWithObservation in do.ts — with incarnationPatch a pure
  prologue (`:128-186`). The tick describes span `:187-2168` (~1980
  lines, no internal seam cleaner than topic).
- **Proposed split:** `test/studio.observation-gates.test.ts`
  (:128-974 — prologue, op-lock, D1 write, heartbeat merge,
  reachability, adoption verdict) and `test/studio.observation-tick.test.ts`
  (kept name, :975-2168 — unreachable rules, degraded resets, activity,
  member alerts, archive, onLeadWorking).
- **Shared setup:** in-file b64Utf8(), SECTION_PANE/MEMGUARD/
  ACTIVITY_HOOK markers, IDLE_PANE/WORKING_PANE, withMemberRow(),
  stdoutWithPane(). Both halves need stdoutWithPane + a fake ShipDeps;
  alert cluster adds withMemberRow; heartbeat cluster adds its
  section builder. stdoutWithPane is the extract candidate.

### F12. test/bun/install-cache-security.test.ts — 2087 lines, 11 blocks — GLM-OK

- **Lines:** 2087, real-shell lane (bash/curl/GNU tar/zstd), 11
  lane-guarded blocks (suite/findSuite/procSuite/unshareSuite aliases).
  One module: src/studio/install-cache.
- **Seams:**
  - `:183-453` — restore-item security + truncated-download
    atomicity.
  - `:454-1294` — injection, bunInstallRunningCmd (fs + /proc),
    path traversal, symlink guard, tombstone, disk-space.
  - `:1295-2087` — streamed SPACE proof (602 lines) + real-full-disk
    ENOSPC (191).
- **Proposed split:** `test/bun/install-cache-security-parse.test.ts`
  (:183-1294) and `test/bun/install-cache-security-disk.test.ts`
  (:1295-2087). The disk half carries its own heavy fixture builders
  in-cluster (already self-contained).
- **Shared setup:** lane guards hasGnuTar/hasZstd, suite alias consts,
  beforeEach mkdtemp base + afterEach rmSync, sh() bash runner with
  raised maxBuffer. All clusters need sh()+base; disk half also needs
  the unshare/mount capability guard. sh()/base are the extract
  candidates → test/bun/helpers/shell.ts (exists).

### F13. test/board.board.test.ts — 2019 lines, 27 describes — GLM-OK

- **Lines:** 2019, 27 describes over src/board/board, function-family
  clusters (createTask, transitionTask, assignment, hooks, studio
  gates, idempotency, label repair, autoStart).
- **Proposed split:** `test/board.create.test.ts` (:60-304 +
  :1653-1746 + :1803-2019 — createTask core, idempotency key,
  continues, autoStart) and `test/board.assign.test.ts` (:305-1652 +
  :1747-1802 — transitionTask, assignment, hooks, revoke, gates,
  briefs, closeTerminal, label repair).
- **Shared setup:** in-file MSG_ID, task() BoardTask factory,
  fakeApi() with ~18 vi.fn methods, brief fixture. Both halves need
  fakeApi + task(); label-repair clusters need throwing api
  overrides. fakeApi/task() are the extract candidates →
  test/helpers/ (sweep-18 rule).

### F14. test/bun/bringup-hooks.test.ts — 1806 lines, 17 describes — GLM-OK

- **Lines:** 1806, 17 describes over FOUR gate scripts: lead-gate.sh,
  completion-gate.sh, session-reemit.sh, activity-heartbeat.sh
  (+studio-bringup.sh wiring pins).
- **Seams:**
  - `:134-1098` — lead gate + completion gate (executed, shape, no-
    STUDIO_ID, maestro mechanics, prose, #361 record handling).
  - `:1099-1405` — session re-emit hook.
  - `:1406-1806` — activity-heartbeat hook (map, silence, atomic
    write, lead-only, settings.json wiring).
- **Proposed split:** `test/bun/bringup-gates.test.ts` (:134-1098)
  and `test/bun/bringup-heartbeat.test.ts` (:1099-1806).
- **Shared setup:** gate-source reads (LEAD_GATE, COMPLETION_GATE,
  REEMIT, ACTIVITY_HEARTBEAT consts), runners leadGate()/
  bakeIsMaestro()/leadGateAsStudio(), makeCheckedOutRepo(),
  writeTaskRecord()/validRecord(), heartbeat()/AncestryMode,
  extractMarkedBlock(), linuxOnly. Gates half needs the repo+record
  helpers; heartbeat half needs its runners + linuxOnly. Only helper
  import today: { BRINGUP, runSnippet } from test/bun/exec-snippet.

### F15. test/github.webhook.test.ts — 1797 lines, 8 describes — GLM-OK

- **Lines:** 1797, 8 describes over src/github/webhook. One describe —
  auto-close on promote — spans `:895-1731` (837 lines) and is the
  file's real mass.
- **Proposed split:** `test/github.webhook-core.test.ts` (:165-894 —
  push path, signature, maestro wake, assignee comment wake,
  stopped-maestro skip) and
  `test/github.webhook-autoclose.test.ts` (:895-1797 — auto-close
  promote + junior authz revoke).
- **Shared setup:** SECRET + HMAC sign(), push() JSON builder,
  wakes/getCalls/rpcCalls harness state, envWithStudio(), fakeCtx() +
  post()/drainLast(), file-level beforeEach (clears approvals/events/
  fleet_state, seeds maestro rows, stubs fetch) + afterEach fetch
  restore. Core half needs the full harness; autoclose half needs it
  PLUS its own githubCalls/issueState nested beforeEach. The harness
  (sign/push/post/envWithStudio) is the extract candidate →
  test/helpers/http.ts (exists) or a new test/helpers/webhook.ts.

## Context — remaining 19 files >800 lines (no findings this round)

studio.cli-args.test.ts (1408), studio.account-launched.test.ts (1392),
studio.transcript.test.ts (1389), studio.activity.test.ts (1319),
llm.anthropic-route.test.ts (1242), bun/deploy-rescue-gate.test.ts
(1051), bun/bringup-claude-relaunch.test.ts (1048), studio.ws.test.ts
(1018), studio.account-by-repo.test.ts (921),
studio.parked-auto-resume.test.ts (895), studio.spawn.test.ts (1721),
studio.refresh.test.ts (1616), cli.fleet.test.ts (1569),
studio.destroy-race.test.ts (1561), studio.backup-guard.test.ts (1522),
board.routes.test.ts (1488), github.api.test.ts (1452),
studio.survival-brief.test.ts (1429), install-cache.test.ts (1796).
Notable shapes for the next round: board.routes.test.ts's first
describe alone spans 853 lines; github.api.test.ts is 32 blocks of
tiny per-function describes (split by function family, no hazards);
studio.spawn.test.ts and cli.fleet.test.ts have clean per-verb seams.

## Split hazards (read before executing any finding)

1. **bun lane guards are load-bearing.** rescue-push (F2),
   git-wrapper (F8), install-cache-security (F12) gate execution on
   REAL_GIT/TIMEOUT_BIN/GNU tar/zstd/unshare availability. A split
   must copy the guard preamble verbatim, not re-derive it.
2. **In-file fakes are the real shared setup.** Almost no file imports
   test/helpers today; each oversized file carries its own fake
   builders (Fixture, fakeApi, fakeStorage, fakeObserved, sh, etc.).
   Splitting duplicates them in both halves or extracts them —
   extraction is sweep-18's helper-dedup lane, keep the two PRs
   separate (split first, dedup second, or vice versa — never both at
   once).
3. **mock.module and vi.mock hoisting.** orca-workspace (F6) mocks
   node:os mid-file; routes (F3) mocks authModule at top; a split must
   keep each mock with the half that needs it — vi.mock/vi.fn module
   state does not survive a file boundary.
4. **File-scoped D1/env state.** provision (F9), webhook (F15),
   session (F1) use cloudflare:test `env` + beforeEach D1 clears.
   Both halves re-seed independently; a beforeEach that stays in only
   one half is a silent state leak into the other.
5. **Names of record.** The `#NNN` in describe titles are board-issue
   provenance (sweep-24 lesson: never strip them in a move). Move
   describes whole, titles verbatim.

# Oversized test files sweep 45 — apps/fleet/test (2026-10-15)

Ref #907. Analysis only, read-only, no code changed, no splits
performed. Forty-fifth maintainability sweep; scope
`apps/fleet/test/**` only (vitest root + test/bun). Lens: test FILES
strictly over 500 lines that sweeps 26 (#635, >800) and 35 (#735,
600-800) did NOT file a split finding for. Excluded by construction:
sweep-26/35 split products (routes-handle/routes-accounts,
replacement-restart/restore, observation-gates/observation-tick,
survival-input/survival-retry, board.create/board.assign,
webhook-core/webhook-autoclose, install-cache-security-parse/disk,
orca-ensure-reconcile, bringup-gates/bringup-heartbeat-core,
claude-swap-join, pane-probe-lead-scope) and every file with an OPEN
split issue (#688, #689, #691, #692, #695, #696, #796, #797, #800,
#801, #806, #808 — all CLAUDE-ONLY, queued, never re-filed). Census at
origin/main `ca73bda` by `wc -l`: 67 files >500 lines; 15 new findings
below, ranked by size, the remainder listed as context (cap is 15).

**Tier rule (from #539):** GLM-OK = none of auth, secrets,
credentials, rescue, failover, accounts routing, deploy. CLAUDE-ONLY =
touches any of those. The DOC is one batch; the SPLIT work each
finding proposes inherits the lane of the file it splits. Lane marks
below are for the SPLIT, not this doc. Precedents applied: spawn-token
fixtures (mint/hash round-trips, fakeStorage SpawnTokenStorage) count
as bookkeeping, not credential handling (#756/#893 treat the row
copies as CLAUDE-ONLY only where a creds.route secret-path fixture
table is in the same batch); rescue-branch NAME parsing is GLM-OK
(sweep-26 F10 survival-delivery), rescue-push VERDICT wiring through
destroy/recycle is CLAUDE-ONLY (sweep-35 F15 wake-gate precedent);
`fleet rescue-gc` argv-only parsing is GLM-OK (claude-swap #804
accounts-slot precedent).

**Shared-setup census:** unchanged from sweep 26/35 — almost no file
imports test/helpers; the seam question per split stays "which
in-file helpers does each half need", answered per finding. Extract
targets if a split wants them: `test/helpers/{bringup-pins, board-api,
datetime, do-storage, fake-namespace, http, studio-row}.ts`,
`test/bun/helpers/{credentials, poll, shell}.ts`,
`test/bun/exec-snippet.ts`, `test/fixtures/{rate-limit-panes,
activity-panes, cswap-list, destroy-refusals}.ts`.

## Method

`find apps/fleet/test -name '*.test.ts' | xargs wc -l | sort -rn`,
threshold strictly >500, minus the sweep-26/35 exclusion list above.
Top 15 by size read in full or in structural part: top-level
`describe(` blocks mapped with `grep -n '^describe('`; describe-less
bun files (rescue-all-scope, bringup-claude-relaunch preamble) mapped
by their flat `test(` lists. Proposed split names follow the existing
convention `<module>.<aspect>.test.ts`, one seam per finding, halves
sized by the line ranges measured.

## Findings

| # | file | lines | proposed split (halves) | lane |
|--:|---|---:|---|---|
| 1 | test/studio.routes-handle.test.ts | 2174 | routes-provision + routes-verbs | CLAUDE-ONLY |
| 2 | test/studio.routes-accounts.test.ts | 2157 | accounts-sync + routes-ops | CLAUDE-ONLY |
| 3 | test/bun/orca-registry.test.ts | 1831 | registry-teardown + registry-rows | GLM-OK |
| 4 | test/install-cache.test.ts | 1796 | cache-cmds + cache-ticks | GLM-OK |
| 5 | test/studio.spawn.test.ts | 1786 | spawn-core + spawn-routes | CLAUDE-ONLY |
| 6 | test/llm.anthropic-route.test.ts | 1759 | anthropic-core + anthropic-stream | GLM-OK |
| 7 | test/studio.refresh.test.ts | 1603 | refresh-credential + refresh-spawn-token | CLAUDE-ONLY |
| 8 | test/studio.destroy-race.test.ts | 1561 | destroy-race-provision + destroy-race-recycle | CLAUDE-ONLY |
| 9 | test/cli.fleet.test.ts | 1560 | readiness-format + fleet-ls | GLM-OK |
| 10 | test/studio.backup-guard.test.ts | 1522 | backup-sync-tick + backup-restore | CLAUDE-ONLY |
| 11 | test/board.routes.test.ts | 1511 | board-routes-core + board-routes-tasks | CLAUDE-ONLY |
| 12 | test/github.api.test.ts | 1461 | api-files + api-queries | GLM-OK |
| 13 | test/studio.cli-args.test.ts | 1435 | cli-args-parse + cli-args-verbs | GLM-OK |
| 14 | test/studio.survival-brief.test.ts | 1429 | brief-compose + brief-invariants | GLM-OK |
| 15 | test/studio.transcript.test.ts | 1379 | transcript-ship + transcript-sections | GLM-OK |

### F1. test/studio.routes-handle.test.ts — 2174 lines, 8 describes — CLAUDE-ONLY

- **Lines:** 2174, sweep-26 F3 split product (of studio.routes.test.ts,
  PR #728) — a second cut. 8 describes.
- **Seams:**
  - `:406-1714` — handleStudio core verbs + provision env resolution +
    MAX_STUDIOS cap + ROLE_EFFORT (5 describes).
  - `:1773-2174` — terminal fallback page, sandbox-api adapter,
    redactSecrets, dynamic repo selection, GET /studio/reach (4
    describes, ~400 lines).
- **Proposed split:** `test/studio.routes-provision.test.ts`
  (:406-1714) and `test/studio.routes-verbs.test.ts` (:1714-2174).
- **Shared setup:** in-file authModule vi.mock, sandbox fakes
  (sbExec/sbWriteFile), fakeStorage (StudioStorage & SpawnTokenStorage
  & SessionSyncStorage), recordStudio seeds. Provision half needs the
  sandbox fakes + fakeStorage wholesale; verbs half needs authModule
  mock + sandbox fakes only.
- **Why CLAUDE-ONLY:** provision half mirrors do.ts's real provision()
  shape including ensureSpawnToken + hashSpawnToken writes — the
  spawn-token mint/hash machinery, plus redactSecrets-verified
  credential scrubbing in the response bodies.

### F2. test/studio.routes-accounts.test.ts — 2157 lines, 9 describes — CLAUDE-ONLY

- **Lines:** 2157, sweep-26 F3 split product (of studio.routes.test.ts,
  PR #728) — a second cut. 9 describes.
- **Seams:**
  - `:397-1431` — accounts read/sync, held rows (#336),
    worker-exceptions count (3 describes, ~1000 lines).
  - `:1431-2157` — brief injection, inspect, wake, repair verbs
    (#96), 409 surfacing (#217) (6 describes, ~730 lines).
- **Proposed split:** `test/studio.accounts-sync.test.ts` (:397-1431)
  and `test/studio.routes-ops.test.ts` (:1431-2157).
- **Shared setup:** fakeStorage (StudioStorage & SpawnTokenStorage &
  SessionSyncStorage), recordStudio seeds, fakeRescueAnswer plumbing
  for recycleWithSync (RESCUE_CLEAN), fetchBlueprintFile githubAware
  mock. Accounts half needs the usage fixtures; ops half needs the
  rescue-push verdict wiring + board mocks.
- **Why CLAUDE-ONLY:** accounts read/sync is accounts-routing
  territory, and the ops half wires rescue-push verdicts
  (RESCUE_CLEAN / UNCONFIRMED) through recycleWithSync and wake.

### F3. test/bun/orca-registry.test.ts — 1831 lines, 5+ describes — GLM-OK

- **Lines:** 1831, sweep-26 F6 split product (of
  bun/orca-workspace.test.ts, PR #714) — a second cut. Describes at
  :230 (removeStudioWorkspace teardown), :402 (#175 healing), :519
  (#193 path fallback), :573 (#297 multi-instance), :632 (#175
  registry races) + divider-delimited flat sections to :1831.
- **Seams:**
  - `:230-631` — teardown + healing + path fallback + multi-instance
    (4 describes, ~400 lines).
  - `:632-1831` — registry races, locks (fileLockAt), row titles,
    fleet ls ROW column, ranking, open/closeStudioRow,
    findAttachHandle (describes + divider clusters, ~1200 lines).
- **Proposed split:** `test/bun/orca-registry-teardown.test.ts`
  (:230-631) and `test/bun/orca-registry-rows.test.ts` (:632-1831).
- **Shared setup:** carried from the orca-workspace split — ok(),
  Fake interface, memoryLock(), memoryRegistry(), fake() orca builder,
  worktrees()/terminals() fixtures, TEST_TITLE; mid-file real-fs
  helpers (studio(), tmpWorktree, tmpRegistryFile, tmpLockDir). Both
  halves need fake() + fixtures; rows half adds the tmp-fs helpers.
- **Why GLM-OK:** registry bookkeeping, locks, row rendering — no
  tier subject. spawnTokenHash appears only as a null field in row
  fixtures.

### F4. test/install-cache.test.ts — 1796 lines, 26 describes — GLM-OK

- **Lines:** 1796, 26 describes over src/studio/install-cache. Never
  covered by sweep 26 (sweep 26 filed the SECURITY split, #699; this
  non-security sibling was context-listed only).
- **Seams:**
  - `:65-630` — parse/pure helpers + restore/save command shapes:
    parseInstallCacheRepos, isInstallCacheRepo, repoCheckoutDirName,
    keysToPrune, normalizeCacheDir, dirSlug, lockHashCmd,
    bunInstallRunningCmd, installCacheRestoreCmd,
    installCacheSaveCmd/parseSaveOutcome, presignR2 (15 describes).
  - `:700-1796` — the run loops + #350 mixed-fleet wiring:
    runInstallCacheRestore, failure parse/backoff, save-lease
    freshness, runInstallCacheSaveTick, mixed-fleet-safe runProvision
    + restartWithStorage (11 describes, ~1100 lines).
- **Proposed split:** `test/install-cache-cmds.test.ts` (:65-630) and
  `test/install-cache-ticks.test.ts` (:700-1796).
- **Shared setup:** in-file env fakes; the R2 presign block carries
  its own FAKE_ENV (fake AWS-shaped keys — fixture values, not real
  credentials). Cmds half needs the parse fixtures; ticks half needs
  fake storage + lease clock fixtures.
- **Why GLM-OK:** cache save/restore plumbing; R2 keys are inert
  fixtures (presign URL shape assertions), never credential handling.

### F5. test/studio.spawn.test.ts — 1786 lines, 19 describes — CLAUDE-ONLY

- **Lines:** 1786, 19 describes over src/studio/spawn + org + do
  interplay. Sweep 26 context-listed spawn.test.ts at 1721 lines; no
  finding was ever filed for it.
- **Seams:**
  - `:190-663` — pure resolution + allocation: isSpawnTokenShaped,
    resolveSpawnParent, resolveSpawnPolicy, resolveMaxStudios,
    MAX_STUDIOS cap, instance allocation (#269), maestro singleton
    (#269 r2), readInstanceRequest (8 describes).
  - `:663-1786` — HTTP routes + wiring: POST /fleet/spawn, POST
    /studio/spawn passthrough, index.ts prefix routing,
    dynamic-repo spawn, {task} brief pickup, {leadType} (#249),
    maestro re-arm, provisionChild role routing (#107),
    getStudioStub, claimStudioId batched rollout (#107 r2) (11
    describes, ~1120 lines).
- **Proposed split:** `test/studio.spawn-core.test.ts` (:190-663) and
  `test/studio.spawn-routes.test.ts` (:663-1786).
- **Shared setup:** fakeStorage (StudioStorage & SpawnTokenStorage),
  storageFor() factory, hashSpawnToken/mintSpawnToken imports from
  src/studio/org, org-cache resets. Core half needs the org imports +
  policy fixtures; routes half needs fakeStorage + recordStudio +
  board mocks.
- **Why CLAUDE-ONLY:** spawn tokens are the file's subject —
  isSpawnTokenShaped pre-hash rejection, ensureSpawnToken
  mint/persist/hash-settle through every route, claimStudioId's
  hash-pairing. The #756/#893 precedent treats the row COPIES as
  bookkeeping, but here mint/hash/reject semantics are the tested
  behavior, not incidental fixtures.

### F6. test/llm.anthropic-route.test.ts — 1759 lines, 10 describes — GLM-OK

- **Lines:** 1759, 10 describes over the GLM-lead anthropic route
  (src/llm/anthropic-route). Sweep-33 listed a sibling row copy;
  sweep 26/35 never filed it.
- **Seams:**
  - `:107-386` — gates + spend controls + non-streaming round trip (3
    describes: auth-framing gates, MAJOR-2 spend caps, translation).
  - `:386-1759` — streaming + retries + countTokens + model pool:
    streaming (:386), idle timeout/failure reasons (#302, :755),
    pre-stream retry + call duration (#335, :1009), runAiWithRetry
    (:1156), countTokens #284 4(b) (:1195), model pool + gateway
    spec (:1345), #767 same-model backoff (:1618) (7 describes).
- **Proposed split:** `test/llm.anthropic-core.test.ts` (:107-386) and
  `test/llm.anthropic-stream.test.ts` (:386-1759).
- **Shared setup:** in-file authed()/good-body builder (Bearer token
  fixtures), env.AI.run fakes, stream-frame builders. Core half needs
  the authed builder; stream half needs it PLUS SSE frame fixtures
  and the retry clock.
- **Why GLM-OK:** "auth" here is the route's own Bearer framing gate
  with inert token strings (the harness asserts a 401 on a malformed
  header) — no secret handling; spend controls are token-COUNT
  budgets, per the sweep-35 F6 llm-translate precedent.

### F7. test/studio.refresh.test.ts — 1603 lines, 13 describes — CLAUDE-ONLY

- **Lines:** 1603, 13 describes over src/studio/refresh (token/cred
  refresh) + spawn-token plumbing in do.ts. Sweep 26 context-listed
  it; no finding ever filed.
- **Seams:**
  - `:122-1121` — credential/token refresh: credentialWriteCmd,
    runRefreshCredential, readTailscaleHost, runRefreshToken,
    refreshWithStorage, provision+credential shape, restart+credential
    r2, studioEnvVars (8 describes).
  - `:1121-1603` — spawn-token plumbing: loadOrMintSpawnToken,
    StudioDO wiring (source-pinned), ensureSpawnToken,
    spawnTokenHash plumbing, interleaved provisions hash-pairing (5
    describes).
- **Proposed split:** `test/studio.refresh-credential.test.ts`
  (:122-1121) and `test/studio.spawn-token.test.ts` (:1121-1603).
- **Shared setup:** fakeStorage + RefreshDeps fakes, gitIdentity
  fixtures, recordStudio seeds. Credential half needs the refresh deps
  + env builders; spawn-token half needs fakeStorage + hashSpawnToken
  + recordStudio.
- **Why CLAUDE-ONLY:** the whole file is token/credential refresh —
  runRefreshToken (GitHub token), runRefreshCredential, git identity
  credentials, writeProxyConfigCmd wiring — plus the spawn-token
  mint/hash half. Tier-list either way.

### F8. test/studio.destroy-race.test.ts — 1561 lines, 27 describes — CLAUDE-ONLY

- **Lines:** 1561, 27 describes — the #62/#129/#174/#213/#240
  destroy-epoch guard matrix (T1-T10, K-*, P-*, P-N* rounds) over
  provision/restart/heal/recycle/refresh vs a landing destroy. Sweep
  26 context-listed it; never filed.
- **Seams:**
  - `:314-731` — T-series: provision/restart/heal/reprovision/recycle
    races + T8 stale-bump + T9 baseline + T10 D1 republish (10
    describes).
  - `:789-1561` — K/P-series + #240 rounds: recycle verdict races,
    refused destroy mid-restart, destroyInFlightCount counter/epoch,
    #213 bring-up delivery vs #174 guard, P-N7/N8 REAL-call pairs
    (17 describes).
- **Proposed split:** `test/studio.destroy-race-provision.test.ts`
  (:314-731) and `test/studio.destroy-race-recycle.test.ts`
  (:789-1561).
- **Shared setup:** the big fakeStudio/exec-sequencing preamble
  (:1-313 — fireOn helpers, opts.respond with RESCUE_CLEAN, row
  seeds), shared VERBATIM in both halves (sweep-26 hazard 1). Both
  halves need the whole harness; only the describe sets move.
- **Why CLAUDE-ONLY:** the harness stubs rescue-push verdicts
  (RESCUE_CLEAN / UNCONFIRMED-refuses) on every runDestroy path, and
  the K-series asserts recycle's rescue-before-destroy ordering.

### F9. test/cli.fleet.test.ts — 1560 lines, 15 describes — GLM-OK

- **Lines:** 1560, 15 describes over cli/fleet.ts + cli/readiness-format
  formatting surface. Sweep 26 context-listed it; never filed.
- **Seams:**
  - `:38-1045` — readiness formatting: fleetTotals, formatReady,
    formatCheckedAt, ageSeconds, formatAge, readyOverride,
    formatSession (+ #513 guards), formatState, formatSessionGuards,
    formatObservedLines, formatSurvivalBriefs, formatDeadAccounts,
    formatActivity (13 describes, ~1000 lines).
  - `:1085-1560` — ls rows + totals: formatActivity tail, lsJsonRows,
    staleness-budget twins (#513) (2-3 describes, ~470 lines).
- **Proposed split:** `test/cli.readiness-format.test.ts`
  (:38-1045) and `test/cli.fleet-ls.test.ts` (:1046-1560).
- **Shared setup:** in-file row fixtures + DEAD_FRAME import (from
  studio.failover-real-panes.test — a named re-export read, fine to
  duplicate); formatDeadAccounts renders CLAUDE_CODE_OAUTH_TOKEN_n
  names as inert fixture strings.
- **Why GLM-OK:** pure CLI formatting; dead-account rendering names
  secret-shaped env var NAMES (fixtures) — the claude-swap #804
  accounts-slot precedent.

### F10. test/studio.backup-guard.test.ts — 1522 lines, 26 describes — CLAUDE-ONLY

- **Lines:** 1522, 26 describes over the session backup/restore guard
  (session-sync + do.ts restore interplay, #94/#120/#140/#228 review
  cluster). Sweep 26 context-listed it; never filed.
- **Seams:**
  - `:210-450` — sessionStats + displaced-key + tick guards (4
    describes).
  - `:450-1012` — runSessionRestore: keeper fallbacks, corrupt-latest,
    decompression failure, hand-off, staleness (8 describes).
  - `:1012-1522` — StudioDO wiring pins + clearSessionGuard (#140) +
    destroyWithSync armed-override consumption (#228) (14 describes).
- **Proposed split:** `test/studio.backup-sync-tick.test.ts`
  (:210-450 + the tick describes :782-1012) and
  `test/studio.backup-restore.test.ts` (:450-781 + :1012-1522).
- **Shared setup:** real gzip'd tar fixtures, fake Storage maps,
  fixedNow from helpers/datetime. Tick half needs the tar builders;
  restore half needs those PLUS keeper fixtures + do.ts source pins.
- **Why CLAUDE-ONLY:** destroyWithSync + clearSessionGuard wiring
  rides the rescue-push verdict plumbing (RESCUE_CLEAN stub at :183)
  — the destroy-guard/rescue seam.

### F11. test/board.routes.test.ts — 1511 lines, 9 describes — CLAUDE-ONLY

- **Lines:** 1511, 9 describes over src/board/routes (handleBoard
  mount). Sweep 26 noted "first describe alone spans 853 lines"; never
  filed.
- **Seams:**
  - `:87-939` — handleBoard core (853 lines: create/assign/state/
    envelope routes + auth gates).
  - `:940-1511` — rescue-gc route (#217), reap route (#55),
    openTaskChecker (#55), studio's-own board (#63), no-registry-row
    create (#81), security-label refusal (#249), RepoReachFetch alias.
- **Proposed split:** `test/board.routes-core.test.ts` (:87-939) and
  `test/board.routes-tasks.test.ts` (:940-1511).
- **Shared setup:** authModule verifyAccess spy, githubAware fakes,
  fakeCtx, seeded env. Core half needs the full harness; tasks half
  needs it PLUS RescueGcPort/ReapPort fakes.
- **Why CLAUDE-ONLY:** junior authz recording (isJuniorAuthorized/
  recordJuniorAuthorization) + auth-module gating in the core half,
  and the rescue-gc route in the tasks half — auth and rescue both
  tier-list.

### F12. test/github.api.test.ts — 1461 lines, 32 describes — GLM-OK

- **Lines:** 1461, 32 tiny per-function describes over src/github/api.
  Sweep 26 noted "split by function family, no hazards"; never filed.
- **Seams:**
  - `:38-502` — file/PR writes: mergePullRequest, fetchRepoFile,
    upsertRepoFile, doneRecordPutter, createRepoFile,
    listInstallationRepos, getDefaultBranch, commitFilesOnNewBranch,
    openPullRequest (8 describes).
  - `:502-1461` — read/exists queries + error shape: listRepoTree,
    listOpenPullNumbers, listAllBranchNames, listPullsForCommit,
    listPullCommits, closeIssue, closingIssuesForPull,
    getPullRequest, commitReachableFromBranch, the 10 exists/compare
    probes, getIssueCloser, pullsWithClosingIssues, pullClaimsIssue,
    repoIsWritable, deleteBranch, compareAhead, 300-char error cut
    (#309 F4), ghRequest merge order (#311 F3) (24 describes).
- **Proposed split:** `test/github.api-files.test.ts` (:38-502) and
  `test/github.api-queries.test.ts` (:502-1461).
- **Shared setup:** in-file respond() fetch mock + ghRequest harness.
  Files half needs the write-path mocks; queries half needs the
  probe matrix + error-shape fixtures.
- **Why GLM-OK:** "Bad credentials" strings are remote 401 response
  fixtures asserted on error propagation, not secret handling; the
  harness passes inert "tok" strings through a mocked fetch.

### F13. test/studio.cli-args.test.ts — 1435 lines, 24 describes — GLM-OK

- **Lines:** 1435, 24 describes over parseCliArgs (cli-args.ts) —
  :9-518 parseCliArgs core + :519-1435 per-verb describes. Sweep 26
  context-listed it; never filed.
- **Seams:**
  - `:9-749` — parseCliArgs core usage/shape + `task` subcommand
    parse (2 big describes, ~740 lines).
  - `:750-1435` — per-verb/help describes: assign P5 §3, task state
    #131, ls --repo #63, new --continues #54, ls --json #70, state
    --from-none #82, reap --terminal #55, reap #8, --studio §5, new
    --repo #278, --template retro #165, help, memory, rescue-gc #217,
    rescue-all #251, reap #53, junior, accounts, accounts hold|clear,
    task-number grammar #565, VERBS help #501 (22 describes).
- **Proposed split:** `test/studio.cli-args-parse.test.ts` (:9-749)
  and `test/studio.cli-args-verbs.test.ts` (:750-1435).
- **Shared setup:** none — pure parse assertions, both halves only
  need the parseCliArgs import. Cleanest split in this sweep.
- **Why GLM-OK:** rescue-gc/rescue-all/reap describes assert ARGV
    parsing only (parseCliArgs(["rescue-gc", "--apply"]) shapes) —
  never rescue mechanics; the #804 accounts-slot precedent. `fleet
  accounts` describes parse argv, not credentials.

### F14. test/studio.survival-brief.test.ts — 1429 lines, 15 describes — GLM-OK

- **Lines:** 1429, 15 describes over composeSurvivalBrief
  (survival-brief.ts) — the (a)-(i) lettered review rounds plus
  mutation-safety and sanitizeBranch. Sweep 26 context-listed it
  (survival-brief.test.ts 1429); never filed.
- **Seams:**
  - `:44-328` — composition basics + Session-line + section-lookup
    behaviors (5 describes).
  - `:329-806` — invariants (c)-(g): one-line-per-task, free-text
    sanitization, caps, mutation safety, (h) full-output, (i) empty
    rule, sanitizeBranch M31/M32 (8 describes).
  - `:621-1429` tail — Session-line fixtures a-e + remaining rounds.
- **Proposed split:** `test/studio.brief-compose.test.ts`
  (:44-328) and `test/studio.brief-invariants.test.ts` (:329-1429).
- **Shared setup:** in-file resolve-input fixtures
  (unclaimedRescueBranches/wip refs as inert branch-name strings),
  NOW/date fixtures. Both halves need the section fixtures.
- **Why GLM-OK:** rescue/wip BRANCH-NAME rendering only — the same
  parsing lane sweep-26 F10 marked survival-input GLM-OK.

### F15. test/studio.transcript.test.ts — 1379 lines, 20 describes — GLM-OK

- **Lines:** 1379, 20 describes over shipTranscriptTick
  (transcript.ts) — command shape, rotation, offsets, binary safety,
  date-roll, hot tail, U+FFFD trim, parser matrix, failure isolation,
  then the SECTION describes (#85 incarnation, #221 pane/heartbeat,
  #311 memguard). Never covered by any sweep (sweep 26 stopped at
  observation/backup clusters).
- **Seams:**
  - `:184-961` — the ship loop: command shape, no-file skip, offset
    math, binary round-trip, rotation + TOCTOU, date-roll, hot tail,
    U+FFFD, parser matrix, failure isolation, manifest retry-safety
    (12 describes).
  - `:961-1379` — section assembly: incarnation section (#85), pane
    section + verdict wiring (#221), hook heartbeat section + wiring
    (PR3b), memguard section + kill wiring (#311) (8 describes).
- **Proposed split:** `test/studio.transcript-ship.test.ts`
  (:184-961) and `test/studio.transcript-sections.test.ts`
  (:961-1379).
- **Shared setup:** sentCmd() helper + manifest/bootId seeds, fake
  ShipDeps, tmp transcript fixtures. Ship half needs the byte/rotation
  fixtures; sections half needs the pane/heartbeat/memguard frame
    builders (fixtures/activity-panes exists for the glyph panes).
- **Why GLM-OK:** zero tier mentions (verified by grep); "token" hits
  are the incarnation-token write, a nonce marker, not a credential.

## Context — remaining files >500 lines, excluded or awaiting a later sweep

Excluded this round (split already done): observation-gates (924,
observation-tick's sweep-26 F11 split — a further cut is possible but
low value), replacement-restart (1321) + replacement-restore (1187)
(S26-F7), survival-input (1301) + survival-retry (946) (S26-F10),
board.create (578) + board.assign (1434) (S26-F13 — assign's second
cut now oversized after the #882 fixture work, wait for its own
sweep), webhook-core (854) + webhook-autoclose (1046) (S26-F15),
install-cache-security-parse (1267) + -disk (931) (S26-F12),
orca-ensure-reconcile (540) (S35-F2), bringup-gates (1079) +
bringup-heartbeat-core (668) (S26-F14), claude-swap-join (616)
(S35-F11), pane-probe-lead-scope (503) (S35-F14),
github.webhook→auth-adjacent files below.
Excluded (open CLAUDE-ONLY split issue already filed, never re-file):
studio.session (5350, #688), bun/rescue-push (4039, #689),
studio.account-failover (2629, #691), studio.burn (2608, #692),
bun/git-wrapper (2245, #695), studio.provision (2200, #696),
bun/session-tar-budget (771, #796), github.auth (746, #797),
bun/fleet-reap (712, #800), studio.destroy (710, #801),
studio.failover-214 (672, #806), studio.wake-gate (633, #808).
CLAUDE-ONLY by subject, this sweep's cap full — candidates for a
future sweep 45b: studio.account-launched (1392 — accounts routing +
failover adjacency), studio.account-by-repo (921 — launchAccountOrRefuse
reroute, accounts routing), studio.parked-auto-resume (895 — rescue-
then-stop), bun/deploy-rescue-gate (1051, deploy), studio.failover-real-panes
(628, failover), studio.rate-limited (598 — runAccountFailover writes),
studio.recycle-guard (595 — rescue-push refusal), bun/rescue-all-scope
(542, rescue), bun/deploy-ops-guard (559, deploy), board.routes-tasks
(F11 tail above once split).
GLM-OK, cap full, candidates for a future sweep 45b:
bun/bringup-claude-relaunch (1048 — one real-tmux harness suite, 32
flat tests; seam = harness-safety describe :692+ vs relaunch rounds),
bun/localci-run (592 — one describe over localci.sh; weak seam),
studio.activity (1340 — readActivityFrame corpus + nextActivity;
seam = frame-parsing :28-499 vs state/next :499-1340),
studio.observation-tick (1313, post-split half — activity/alerts vs
archive/onLeadWorking), studio.ws (1018 — pty lifecycle vs wire
contract; the mock server harness shared verbatim), studio.cli-args
verbs tail, github.webhook-core second cut, studio.org (538 — parse vs
cache: :15-215 vs :215-538), bun/bringup-log (511 — log file contract
vs redaction agreement), bun/gh-wrapper (573 — argv/deny scanning vs
leak-gate/proxy install :449-573; that tail is CLAUDE-ONLY so the file
stays CLAUDE-ONLY as a whole), bun/accounts-cli (563 — accounts sync
CLI; credentials file fixtures via bun/helpers/credentials —
CLAUDE-ONLY), studio.auto-continue (554, GLM-OK — #109/#158/#214 wake
due-ness; single subject, weak seam), index.test.ts (551 — scheduled()
watchdog vs mounts; small), board.assign second cut noted above.

## Split hazards (carried from sweeps 26/35, unchanged)

1. **bun lane guards are load-bearing** — copy guard preambles
   verbatim, never re-derive.
2. **In-file fakes are the real shared setup** — split duplicates or
   extracts; extraction is sweep-18/43's lane, keep split and dedup
   PRs separate.
3. **mock.module/vi.mock hoisting** — authModule mock (routes halves,
   board.routes) stays with the half that needs it; module state does
   not survive a file boundary.
4. **File-scoped D1/env state** — both halves re-seed in their own
   beforeEach; a beforeEach left in one half is a silent state leak.
5. **Names of record** — #NNN in describe titles are board-issue
   provenance; move describes whole, titles verbatim.

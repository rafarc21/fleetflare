# Dead-code sweep 9 — apps/fleet src + cli + test helpers (2026-10-12)

Ref #428. Analysis only, read-only, no code changed. Ninth maintainability sweep; scope `apps/fleet/src/**`, `apps/fleet/cli/**`, and `apps/fleet/test/helpers/**`. Skip `container/` (image changes held).

Sweeps 1-8 (docs/maintainability/2026-10-08-deep-modules-sweep.md, 2026-10-10-deep-modules-sweep-2.md, 2026-10-11-test-sweep-3.md, 2026-10-11-deep-modules-sweep-4.md, 2026-10-11-deep-modules-sweep-5.md, sweep-6 (branch sweep-415-glm-maintainability-6), 2026-10-12-docs-accuracy-sweep-7.md, and the flaky-test sweep 8 (#424)) and the open deepen(*) issues they filed are NOT repeated here. Line refs = physical lines at `origin/main` `c2cc15f`, paths relative to `apps/fleet/`. Re-verified against the current head (`775b979`): every symbol still greps the same; the only moved ref is F5's `readReposFailureComment` (read-repos.ts:191 → :186, five lines hoisted by #437's scanStateTaskKeys).

**Tier rule (from #361):** GLM-OK = none of auth, tokens, rescue, failover, deploy, migrations, credentials. CLAUDE-ONLY = touches any of those.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | `REAP_DEFAULT_IDLE_MS` — dead duplicate const → delete | GLM-OK |
| 2 | `ExecClass` — dead type alias → delete | GLM-OK |
| 3 | `JuniorRateLimitResult` + `LeadRateLimitResult` — dead aliases → delete | GLM-OK |
| 4 | `RescuePushKind` export keyword + `type GitIdentity` re-export in do.ts | CLAUDE-ONLY (rescue + credentials) |
| 5 | Functions exported, used only in their own file → drop `export` | GLM-OK (do.ts + accounts.ts entries CLAUDE-ONLY) |
| 6 | Consts exported, used only in their own file → drop `export` | GLM-OK (rescue-script + auth entries CLAUDE-ONLY) |
| 7 | Types/interfaces exported, used only in their own file → drop `export` (139 self-file-only; doc lists the representative batch) | GLM-OK except as marked |
| 8 | `NsStub` — test-helper type exported, used only in its own file | GLM-OK |

### F1. `REAP_DEFAULT_IDLE_MS` — dead duplicate const, delete entirely — GLM-OK

- **Files:** `cli/reap.ts:62-63` — the doc comment `/** `fleet reap`'s default threshold: long on purpose. `--idle 5m` opts lower. */` plus `export const REAP_DEFAULT_IDLE_MS = 30 * 60_000;`.
- **Evidence:** `grep -rnE "(^|[^A-Za-z0-9_.])REAP_DEFAULT_IDLE_MS([^A-Za-z0-9_]|$)"` over src, cli, test, test-integration, scripts, container, and docs → exactly one hit: the definition line itself. Zero importers anywhere. The default `fleet reap` actually uses is the inline `let idleMs = 30 * 60_000` at `src/studio/cli-args.ts:999` — the const is an unwired duplicate of that literal, and its doc comment still claims to be "the default".
- **Problem:** a const whose only non-definition references are none, whose comment describes a wiring that does not exist — the default lives in cli-args.ts's own inline literal. A future `--idle` default change edits the inline literal and silently leaves the "default" const lying about the threshold.
- **Proposed removal:** delete `cli/reap.ts:62-63` (comment + const). No import breaks; nothing references it.

### F2. `ExecClass` — dead type alias, delete entirely — GLM-OK

- **Files:** `src/studio/sandbox-api.ts:171` — `export type ExecClass = keyof typeof EXEC_CLASSES;`.
- **Evidence:** repo grep for `ExecClass` → only the definition line. Not referenced in its own file, not imported by any test, not used in container/ or scripts/. `EXEC_CLASSES` itself is live: imported and asserted by `test/cli.destroy-outcome.test.ts:7` (used at :166 in the DESTROY_CLIENT_TIMEOUT_MS budget check).
- **Problem:** a derived alias with zero references — the annotation it would carry (`keyof typeof EXEC_CLASSES`) is spelled out at every actual use site (`SbExecOptions` keys) instead.
- **Proposed removal:** delete `src/studio/sandbox-api.ts:171`. `EXEC_CLASSES` stays.

### F3. `JuniorRateLimitResult` + `LeadRateLimitResult` — dead type aliases, delete entirely — GLM-OK

- **Files:** `src/junior/ratelimit.ts:33` (`export type JuniorRateLimitResult = RateLimitResult;`) and `src/llm/ratelimit.ts:41` (`export type LeadRateLimitResult = RateLimitResult;`).
- **Evidence:** repo grep for each name → only its own definition line. The parallel `*RateLimitEnv` aliases ARE used — `JuniorRateLimitEnv` (ratelimit.ts:28) and `LeadRateLimitEnv` (:36) are the generic constraints of their own `makeRateLimitKind<...>` factories (junior :35, lead :43) — keep those.
- **Problem:** two one-line re-aliases of the shared `RateLimitResult` that no caller ever names; the wrappers' return types resolve to the base name everywhere it appears in signatures and tests.
- **Proposed removal:** delete both lines (`src/junior/ratelimit.ts:33`, `src/llm/ratelimit.ts:41`).

### F4. `RescuePushKind` export keyword + `type GitIdentity` re-export in do.ts — CLAUDE-ONLY (rescue + credentials), listed, nothing filed

- **Files:** `src/studio/do.ts:650` (`export type RescuePushKind = "files" | "commits";`) and `do.ts:149` (the credentials re-export line's trailing `, type GitIdentity`).
- **Evidence:** `RescuePushKind` — 8 references, all inside do.ts (the `RescueResult` interface's `kind?`/`pushes` fields at :672/:685/:712/:718, the rescue-push map at :1132, the `RescueAllPush`-adjacent outcome at :8163); the only mention outside do.ts is a comment, `cli/fleet.ts:1981`, which names it while defining its own inline `"files" | "commits"` — not an import. `type GitIdentity` re-export — the bare type name appears only in `src/studio/credentials.ts` (its home: :147, :149, :165, :180, :197) and do.ts itself (:145 the import, :149 the re-export, :269 an interface field); no external file names it. `test/bun/studio-git-identity.test.ts:7` imports the other five names of that re-export line but NOT `GitIdentity` — the export at :149 re-ships it to nobody.
- **Problem:** an export keyword (and a re-export) whose only consumers are in the same file — the module advertises surface no one buys. The comment-only external mention would break silently if the shape changed, since nothing type-checks it.
- **Proposed removal:** drop `export` on `do.ts:650` (the symbol stays; all 8 of its mentions are inside do.ts); remove `, type GitIdentity` from `do.ts:149`. CLAUDE-ONLY — rescue machinery plus credentials origin; the safe mechanical change sits in the DO core.

### F5. Functions exported but used only in their own file — drop `export` keyword, symbol stays — GLM-OK except as marked

- **Files (symbol → defining file:line → in-file call site):**
  - `src/board/comment-wake.ts:88` `isEnvelopeComment` (called :139), `:108` `isBotComment` (called :142)
  - `src/studio/quiescence.ts:56` `isUnfinished` (called :80)
  - `src/studio/recycle-cost.ts:18` `formatSnapshotAge` (called :45)
  - `src/studio/provision.ts:3412` `runGetStatus` (called :4070)
  - `cli/fleet.ts:2346` `parseReapState` (called :2442)
  - `cli/junior.ts:113` `parseSinceArg` (called :229)
  - `cli/orca-workspace.ts:1176` `orcaRunner` (called :1365), `:789` `defaultSalvageDestination` (called :805)
  - `src/studio/do.ts:2211` `startRefusedResponse` (called :5833, :5979), `:2226` `switchedBlockIn` (called :2292, :2307, :8399), `:4281` `refuseUnlessJuniorEnabled` (called :7299, :7585, :7787) — **CLAUDE-ONLY** (do.ts internal rescue/do wiring; a safe mechanical change, but the file is the DO core — list, don't file)
  - `src/studio/gh-wrapper.ts:60` `studioGhWrapperScript` (called :186)
  - `src/studio/accounts.ts:838` `requireAccountMapOn` (called :968) — **CLAUDE-ONLY** (accounts routing)
  - `src/github/read-repos.ts:191` `readReposFailureComment` (called :276)
- **Evidence:** per symbol, grep across all of apps/fleet (src, cli, test, test-integration, scripts, page, container) → the defining file only. None are imported by any test (checked test/, test/bun/, test-integration/).
- **Problem:** an export is interface promise; these fifteen functions are file-private helpers wearing the keyword. A test or sibling module could start importing them, growing the public surface of files that should not have more of it (comment-wake, quiescence, provision).
- **Proposed removal:** drop the `export` keyword on each GLM-OK line — the symbol and its body stay, only the keyword goes. The do.ts and accounts.ts entries are listed CLAUDE-ONLY; they follow the same one-line rule in the Claude lane.

### F6. Consts exported but used only in their own file — drop `export` keyword — GLM-OK except as marked

- **Files:**
  - `src/studio/gh-wrapper.ts:42` `GH_PROXY_VERBS` (used :147), `:51` `GH_BUILTIN_COMMANDS` (:90), `:57` `STUDIO_REAL_GH_PATH` (:61, :183, :203), `:58` `STUDIO_GH_WRAPPER_PATH` (:182, :204)
  - `src/studio/wake.ts:237` `WAKE_VERDICT` (used :423-:428, :540, :560), `:263` `SUBMIT_FRAGMENT_CHARS` (:267)
  - `src/studio/container-watch.ts:13` `WATCH_EVERY_MINUTES` (used :16)
  - `src/github/promote-close.ts:66` `PATH1_BATCH_MIN_BUDGET_MS` (used :178)
  - `cli/reap.ts:65` `REAP_CAPTURE_MAX_AGE_MS` (used :201), `:70` `REAP_REFUSALS_BEFORE_BACKOFF` (used :366)
  - `cli/fleet.ts:496` `OPEN_PRS_TIMEOUT_MS` (used :546, :594), `:2321` `REAP_STATE_PATH` (:2502-:2503), `:2325` `REAP_READ_TIMEOUT_MS` (:2376)
  - `src/studio/provision.ts:1252` `BRINGUP_LOG_TAIL_LINES` (used :1281), `:3124` `SESSION_ADOPT_SCRIPT` (:3182), `:3128` `SESSION_ADOPT_KILL_SECONDS` (:3181); `:1005` `REMOTE_BRANCHES_LIST_FILE` (:1033) and `:1030` `RESCUE_DISCOVERY_TIMEOUT_SECONDS` (:1034) are **CLAUDE-ONLY** (rescue scripts)
  - `src/studio/session-sync.ts:614` `SESSION_ASIDE_GLOB` (used :550, :560, :634)
  - `src/studio/burn.ts:1578` `INFLATE_READ_VIEW` (used :1659)
  - `src/board/routes.ts:319` `RESCUE_GC_DEFAULT_DAYS` (used :333)
  - `src/github/auth.ts:134` `REPO_AUTH_WILDCARD` (used :279) — **CLAUDE-ONLY** (auth)
- **Evidence:** each greps to exactly its defining file (in-file usage as listed).
- **Problem:** same shape as F5: exported constants whose only reader is the declaring module. The wake.ts pair is the sharpest case — `WAKE_VERDICT` is the wire-format magic string of the wake protocol, and it looks importable while actually never being imported by the module that writes it or anything else.
- **Proposed removal:** drop `export` per line. The rescue-script (provision.ts:1005/:1030) and auth (auth.ts:134) entries are CLAUDE-ONLY.

### F7. Types/interfaces exported but used only in their own file — drop `export` keyword — GLM-OK except as marked (full sweep counts 139 self-file-only type exports; the doc lists the representative high-confidence batch)

- **Files (representative batch):**
  - `src/board/board.ts:716` `AssignMode`, `:964` `BoardRepoDeps`, `:587` `TerminalCloseOutcome`
  - `src/board/brief.ts:75` `BriefResult`; `src/board/envelope.ts:36` `EnvelopeResult`; `src/board/api.ts:382` `IssueTexts`, `:439` `ListIssueTextsResult`; `src/board/verify.ts:24` `StepResult`, `:22` `StepVerdict`, `:88` `RefCandidate`, `:202` `GithubUrlCheck`; `src/board/close-action.ts:28` `CloseEvidence`, `:40` `CloseOnPromoteResult`; `src/board/path-overlap.ts:50` `PathOverlap`
  - `src/github/api.ts:697` `CommitPull`, `:1145` `BatchedCommitAnswer`, `:359` `RepoFileChange`; `src/github/promote-close.ts:56` `BatchedCommit`, `:349` `EnvelopePrCandidate`, `:290` `ResolvePushCommitsOptions`
  - `src/studio/ff.ts:95` `FfArgs`, `:407` `TtyEnds`, `:412` `FfAttachGate`
  - `cli/destroy-outcome.ts:77` `DestroyReport`, `:100` `DestroyUrls`, `:105` `DestroyOpts`; `cli/recycle-outcome.ts:131` `RecycleUrls`, `:136` `RecycleOpts`; `cli/orca-workspace.ts:89` `LockBudget`, `:981` `StudioRows`, `:1128` `WorkspacePreview`; `cli/junior.ts:171` `JuniorUsageResult`, `:203` `JuniorStatsDeps`; `cli/inspect-request.ts:17` `InspectRequestResult`; `cli/context-salvage.ts:22` `ContextInventory`
  - `src/junior/authz.ts:98` `JuniorSweepOutcome`; `src/junior/usage.ts:19` `JuniorUsageRow`, `:83` `JuniorUsageAggregateRow`, `:90` `JuniorUsageAggregate`; `src/junior/gate.ts:26` `JuniorGateEnv`
  - `src/studio/onboard.ts:29` `OnboardCheck`, `:35` `OnboardResult`; `src/studio/registry.ts:370` `StudioRowLookup`; `src/studio/ids.ts:57` `StudioId`, `:152` `StudioTarget`; `src/studio/repo.ts:135` `StudioIdResult`, `:228` `WorkRepoRequest`; `src/studio/sweep.ts:60` `SweepResult`; `src/studio/frames.ts:16` `TerminalSize`; `src/studio/memguard-log.ts:20` `MemguardSignal`, `:21` `MemguardMemorySource`; `src/studio/burn.ts:1768` `SessionFileStat`
  - `src/studio/do.ts:1333` `ArchiveResult`, `:1355` `DoneRecordArchiveDeps`, `:2727` `HealDecision`, `:1661` `RecycleGuard` (types), `:1516` `DONE_RECORD_COMMENT_MAX_CHARS` (const) — **CLAUDE-ONLY** (DO core)
  - `src/agents/registry.ts:11` `TelegramConfig`; `src/llm/anthropic-route.ts:163` `AiRunError` (class stays; thrown and checked internally); `src/directus/types.ts:74` `RequirementStatus`, `:90` `DecisionStatus`; `src/directus/schema.ts:44` `FieldType`; `src/directus/schema-apply.ts:43` `ApplyReport`; `src/directus/portal.ts:105` `ClientRequestView`
  - `src/memory/compact.ts:213` `CompactionPlan`, `:68` `MemorySurvey`, `:56` `MemoryFileMeta`, `:180` `MergeOp`, `:221` `PlanResult`, `:190` `PromoteOp`, `:38` `PROMOTION_CITATIONS`; `src/llm/translate.ts:356` `StreamState`, `:626` `StreamCloseResult`
  - `src/write-proxy/pktline.ts:74` `PushCommand`, `src/write-proxy/pack.ts:8` `GitObjectType`, `src/write-proxy/gh-route.ts:26` `GH_OP_BODY_CAP` — **CLAUDE-ONLY** (write-proxy)
  - `src/studio/failover.ts:1965` `DegradedHealDeps`, `:1624` `DegradedRecoveryVerdict`, `:2074` `PendingHealWakeRetryDeps` — **CLAUDE-ONLY** (failover); `src/deploy/do.ts:127` `DeployPollOutcome` — **CLAUDE-ONLY** (deploy)
  - `src/creds/test-creds.ts:185` `CredsOutcome`, `:188` `CredsAudit`, `:190` `CredsDeps`, `:28` `TestCredEntry`, `:35` `TestCredsConfig` — **CLAUDE-ONLY** (credentials)
- **Evidence:** every listed name greps to exactly its defining file (all of apps/fleet's src, cli, test, test-integration, scripts, page, and container checked). The full sweep found 139 type/interface exports with zero references outside their defining file; this doc lists the representative high-confidence batch, and the remaining entries follow the same one-line rule (drop `export`, symbol stays).
- **Problem:** 139 of the 417 exported types/interfaces in scope (33%) have no consumer outside their own file — one in three exports advertises a surface nobody buys. Every one is a standing invitation to a new cross-module dependency the author never sanctioned.
- **Proposed removal:** drop `export` per GLM-OK line. The do.ts, write-proxy, failover, deploy, and creds entries are CLAUDE-ONLY (DO core / write-proxy / failover / deploy / credentials).

### F8. `NsStub` — test-helper type exported, used only in its own file — GLM-OK

- **Files:** `test/helpers/fake-namespace.ts:14` — `export type NsStub = Record<string, unknown> | ((id: string) => Record<string, unknown>);`.
- **Evidence:** repo grep → `fake-namespace.ts:14` (definition), `:20` and `:30` (the signatures of `nsWith`/`envWithNs`, its own functions). All 6 external user suites (13 call sites: grid, burn-window-expiry, fleet-resume, profile, paste, index) import `nsWith`/`envWithNs`; none names `NsStub`.
- **Problem:** a helper type on the test surface that no test uses — the stubs are passed as inline literals, so the alias only ever annotates the helper's own signatures.
- **Proposed removal:** drop `export` on `test/helpers/fake-namespace.ts:14`. Both helper signatures keep the type; no caller changes.

## Checked, clean (for the next sweeper)

1. **No orphan files.** Every .ts under src/, cli/, and test/helpers/ is imported, string-spawned, a bin target, or a vitest setupFiles entry. The two `*.test.ts` files in test/helpers/ (do-storage, fake-namespace) are vitest glob-discovered (`*.test.ts` under test/ via the default include), not import-orphans.
2. **No unreachable branches, no stale TODOs.** `tsc` with unreachable-code analysis (the repo's `check` script runs `tsc --noEmit` per project; `allowUnreachableCode` is not enabled) reported nothing, and a grep for numbered TODO/FIXME comments across src/, cli/, test/helpers/, scripts/, test-integration/ found zero — the only "TODO" strings are inside test fixtures that assert leadGate's behavior on a literal pattern string (`test/bun/bringup-hooks.test.ts:230`) and one comment that says code deliberately does NOT "gate behind a TODO" (`src/ratelimit.ts:65`).

## Counts

8 findings, 7 GLM-OK (F1, F2, F3, F5, F6, F7, F8 — F5/F6/F7 with CLAUDE-ONLY entries carved out of each batch) → one deepen(GLM-OK): S9-Fn issue per related batch. CLAUDE-ONLY records: F4 (rescue + credentials), F5's do.ts/accounts.ts slice, F6's rescue-script/auth entries, F7's do.ts/write-proxy/failover/deploy/creds entries — listed here for the Claude lane, no issue filed by this sweep (maestro files those).

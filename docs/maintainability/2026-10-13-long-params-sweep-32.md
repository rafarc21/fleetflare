# Long-positional-params sweep 32 — apps/fleet src+cli (2026-10-13)

Ref #663. Analysis only, read-only, no code changed. Thirty-second
maintainability sweep; scope `apps/fleet/src/**` and `apps/fleet/cli/**` minus
`container/` and the test dirs. Line refs = physical lines at `origin/main` `b1e5b9c`, paths relative to `apps/fleet/`.

Method: scripted signature scan of every function, method and const-arrow
declaration (comments and template strings stripped before parsing; rest and
destructured params excluded, typed params counted as positional; keywords
like `return` filtered). Hit rule: >5 positional params, or boolean
positional params in a signature of ≥3 positionals. Every candidate then
hand-verified: signature re-read in the file, call sites counted across src,
cli, test and test-integration.

**Tier rule:** GLM-OK = none of auth, secrets, credentials, rescue, failover,
accounts routing, deploy, migrations, write-proxy, leak-gate, approvals.
CLAUDE-ONLY = touches any of those.

**Banned-lane hits (listed here, no findings filed):** src/studio/rescue.ts:463
`rescueSnapshotCmd` (9 positionals), :928 `wipSyncCmd` (11 positionals),
src/deploy/do.ts:147 `pollDeployOnce`, src/write-proxy/mode.ts:65
`writeModeFor`. All CLAUDE-ONLY.

**Sweep's rule for what counts:** a finding is a function/method whose
positional parameter list exceeds 5, or whose call sites pass bare
true/false literals where the argument meaning is not recoverable at the
call site. "Proposed shape" is the options-object that would replace the
trailing params; required params stay positional.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | src/board/routes.ts:825 `handleBoard` — 8 positionals, 6 of them injectable ports with defaults; 95 call-site lines, nearly all pass only `(req, env)` | GLM-OK |
| 2 | src/studio/survival-delivery.ts:654 `resolveSurvivalInput` + :1027 `composeSurvivalDelivery` — 10 positionals each, identical trailing sextuplet; composeSurvivalDelivery is a pure pass-through of all 10 | GLM-OK |
| 3 | src/studio/do.ts:6614 `survivalCompose` (method) — 8 positionals mirroring F2's sextuplet at both call sites (do.ts:6507, :6585) | GLM-OK |
| 4 | src/studio/destroy.ts:441 `runDestroy` — 15 positionals incl. 3 callbacks and `force` boolean; 18 call-site lines where `force` is a bare boolean literal | GLM-OK |
| 5 | src/studio/do.ts:582 `restartWithSync` — 8 positionals, two of them large dep interfaces; 9 call-site lines, prod caller do.ts:7632 passes 5+ | GLM-OK |
| 6 | src/studio/accounts.ts:1074 `launchAccountOrReroute` — 9 positionals, 3 with defaults incl. a burn-read callback; 34 call-site lines | GLM-OK |
| 7 | src/studio/do.ts:8040 `destroyStudio` (method) — 4 boolean positionals `force, discardUnsynced, park, skipOpenTaskGate`; call sites pass bare literals with #210-documented non-substitutability | GLM-OK |
| 8 | src/studio/do.ts:2281 `wakeStudioWith` — 9 positionals incl. `isMaestro` boolean next to an `armSweep` callback; bool at 3rd position reads as data | GLM-OK |
| 9 | src/board/close-action.ts:119 `closeTaskOnPromote` — 6 positionals, 2 destructured; 27 call-site lines | GLM-OK |
| 10 | src/studio/observed.ts:1029 `computeSessionVerdict` — 7 positionals; 14 call-site lines | GLM-OK |
| 11 | src/github/api.ts:154 `createRepoFile` (6 positionals, 10 call sites) + :398 `commitFilesOnNewBranch` (6 positionals, 5 call sites) — token-first pairs | GLM-OK |
| 12 | src/studio/do.ts:1277 `harvestLearnings` + :2738 `decideHeal` — 6 positionals each; 16 and 21 call-site lines | GLM-OK |
| 13 | src/github/read-repos.ts:81 `recordReadReposGrant` (6 positionals, 20 call sites) + src/board/board.ts:530 `repairStateless` (6 positionals, 1 call site) + src/board/board.ts:1187 `commentStudioEnvelope` (6 positionals, 3 call sites) | GLM-OK |
| 14 | src/studio/accounts.ts:534 `deriveSearchAnchor` (4 positionals incl. `borrowedActive: boolean`) + :581 `selectFreeAccount` (8 positionals incl. `currentOutOfScope: boolean`) — bare-boolean call sites inside failover cascade | GLM-OK |
| 15 | cli/fleet.ts cmd verbs — :1511 `cmdDestroy` (6 positionals, 4 booleans: `force, discardUnsynced, park, strictUnmerged`), :1368 `cmdProvision` (3 booleans: `freshSession, cancelFreshSession, discardSession`), :1441 `cmdRecycle` (`discardUnsynced, freshSession, forceMappedAccount`); cli/ff.ts:161 `spawnStudio` (6 positionals, `task: number|null` and `instance` adjacent read as data), :259 `fileTask` (6 positionals) | GLM-OK |

### S32-F1. src/board/routes.ts:825 — `handleBoard` carries six injectable ports as trailing positionals — GLM-OK

- **Signature** (routes.ts:825): `handleBoard(req: Request, env: Env, api: BoardApi = githubBoardApi(env), reach: RepoReachFetch = githubRepoReach(env), verifyFetch: VerifyFetch = realVerifyFetch(env), reapPort: ReapPort = realReapPort(env), assignWake: AssignWakeDeps = realWakeDeps(env), rescueGcPort: RescueGcPort = realRescueGcPort(env))`.
- **Call-site count:** 95 lines. Production caller is src/index.ts:102, passing only `(req, env)`; every other call is a test injecting 1–5 ports, which forces trailing `undefined` holes (test/board.read-repos.test.ts:72 passes `undefined, undefined, wakeDeps()`).
- **Proposed shape:** `handleBoard(req, env, ports?: { api?, reach?, verifyFetch?, reapPort?, assignWake?, rescueGcPort? })` — defaults still resolve off `env` when absent. Trailing-`undefined` holes disappear; each test names the ports it injects.

### S32-F2. src/studio/survival-delivery.ts:654 + :1027 — the wip sextuplet, ten positionals, twice — GLM-OK

- **Signatures:** `resolveSurvivalInput(sources, tasks, session, now, wipSyncedAt = null, wipBootStamp = null, lastSessionAside = null, lastSessionAsideAt = null, wipSyncedBootStamp = null, asideShip = null)` (survival-delivery.ts:654) and `composeSurvivalDelivery(...)` (survival-delivery.ts:1027) with the identical list — its body is the pure pass-through of all ten to `resolveSurvivalInput` (survival-delivery.ts:1040).
- **Call-site count:** resolveSurvivalInput 42 lines, composeSurvivalDelivery 10 lines.
- **Proposed shape:** both take `(sources, tasks, session, now, wip?: { syncedAt?, bootStamp?, lastAside?, lastAsideAt?, syncedBootStamp?, asideShip? })`. The six are one frozen observed-session snapshot (board issue #208, #231) — they travel as a group or not at all, which is the options-object signature. `composeSurvivalDelivery` keeps its pass-through as a one-liner.

### S32-F3. src/studio/do.ts:6614 — `survivalCompose` mirrors the sextuplet at its own call sites — GLM-OK

- **Signature** (do.ts:6614): `survivalCompose(workRepoSlug, session, wipSyncedAt = null, wipBootStamp = null, lastSessionAside = null, lastSessionAsideAt = null, wipSyncedBootStamp = null, asideShip?)` — 8 positionals, the trailing six identical to S32-F2's sextuplet.
- **Call-site count:** 4 lines, both real call sites in-file (do.ts:6507, do.ts:6585), which forward to composeSurvivalDelivery (do.ts:6668).
- **Proposed shape:** land with S32-F2 — `(workRepoSlug, session, wip?: WipSyncSnapshot)` with the same named fields, so the three functions share one type. One batch, one issue.

### S32-F4. src/studio/destroy.ts:441 — `runDestroy`, fifteen positionals, three callbacks — GLM-OK

- **Signature** (destroy.ts:441): `runDestroy(checkOpenTask, studioId, workRepoSlug, force, syncDeps, storage, idFallback, destroy, recordStudioFn, repo, resolveMemoryRepo, commitFile, guard?, observedStorage?, park = false)` — 15 positionals.
- **Call-site count:** 18 lines (do.ts:8099 prod; the rest test/studio.destroy.test.ts, where the bare `false` for `force` sits between two slugs and reads as data).
- **Proposed shape:** keep `(checkOpenTask, studioId, workRepoSlug, opts)` where `opts` = `{ force?, park?, syncDeps, storage, idFallback, destroy, recordStudioFn, repo, resolveMemoryRepo, commitFile, guard?, observedStorage? }`. Booleans become named fields — `force: true` at a call site cannot be misread.

### S32-F5. src/studio/do.ts:582 — `restartWithSync`, eight positionals — GLM-OK

- **Signature** (do.ts:582): `restartWithSync(provisionDeps, syncDeps, storage, idFallback, fleetRepoSlug, via = "restart", observedStorage?, ctx = NEVER_MOVED_CTX)` — 8 positionals.
- **Call-site count:** 9 lines (do.ts:7632 prod, rest test/studio.session.test.ts).
- **Proposed shape:** `(provisionDeps, syncDeps, storage, idFallback, opts?: { fleetRepoSlug?, via?, observedStorage?, ctx? })` — `fleetRepoSlug` is a fallback with a documented precedence rule, an optional-by-nature param sitting in a required slot.

### S32-F6. src/studio/accounts.ts:1074 — `launchAccountOrReroute`, nine positionals, three defaulted — GLM-OK

- **Signature** (accounts.ts:1074): `launchAccountOrReroute(env, repo, recorded, limits, reserved, now = new Date(), borrowedAccount = null, readBurn = async () => ({}), usage = {})` — 9 positionals.
- **Call-site count:** 34 lines (do.ts:4444 prod passes a multi-line inline burn callback; failover.ts:2617-2680 region calls the sibling tiers; rest tests).
- **Proposed shape:** `(env, repo, recorded, limits, reserved, opts?: { now?, borrowedAccount?, readBurn?, usage? })`. The three defaulted params are one ambient-context group (clock, borrow state, burn telemetry) — the exact shape options objects exist for. Sibling calls in this file (nextClaudeAccount 6 positionals, selectFreeAccount 8 — see S32-F14) can follow in a later batch.

### S32-F7. src/studio/do.ts:8040 — `destroyStudio`, four boolean positionals — GLM-OK

- **Signature** (do.ts:8040): `async destroyStudio(force: boolean, discardUnsynced = false, park = false, skipOpenTaskGate = false)`.
- **Call-site count:** routes.ts destroy route, the CLI, failover.ts's `stopParkedStudio`, and tests — the doc comment at do.ts:8070 records that `skipOpenTaskGate` is deliberately NOT foldable into `force` or `discardUnsynced`, and a bare `destroyStudio(false, true)` at a call site states none of that.
- **Proposed shape:** `destroyStudio(opts: { force?: boolean; discardUnsynced?: boolean; park?: boolean; skipOpenTaskGate?: boolean })` — defaults preserve every existing caller's behavior; the failover caller names the one flag it sets.

### S32-F8. src/studio/do.ts:2281 — `wakeStudioWith`, `isMaestro` between two functions — GLM-OK

- **Signature** (do.ts:2281): `wakeStudioWith(storage, exec, isMaestro: boolean, armSweep, prompt, now = () => new Date(), studioId?)` — 7 positionals, a boolean third.
- **Call-site count:** in-file callers in do.ts (wake/limit-gate paths), plus wake.ts's runWake/runGatedWake run the same `clearDraftFirst` boolean-position pattern (wake.ts:533, :680, :816).
- **Proposed shape:** `(storage, exec, opts: { isMaestro: boolean; armSweep; prompt; now?; studioId? })` — `isMaestro` becomes a named field, no longer a bare literal between an exec port and a callback.

### S32-F9. src/board/close-action.ts:119 — `closeTaskOnPromote`, six positionals — GLM-OK

- **Signature** (close-action.ts:119): `closeTaskOnPromote(db: D1Port, api: BoardApi, repo: string, issueNumber: number, evidence: CloseEvidence, now: number = Date.now())`.
- **Call-site count:** 27 lines (routes.ts:408, github/webhook.ts:414, rest tests).
- **Proposed shape:** `(db, api, repo, issueNumber, evidence, opts?: { now? })` — or fold `now` into an existing options param if one lands. Low urgency: only one optional param, but it crosses the board/github boundary where the `evidence` object already carries the shape.

### S32-F10. src/studio/observed.ts:1029 — `computeSessionVerdict`, seven positionals — GLM-OK

- **Signature** (observed.ts:1029): `computeSessionVerdict(probe, expectedCwd, restore, turnsBefore, snapshotAgeS, at, via)` — 7 positionals.
- **Call-site count:** 14 lines (provision.ts and do.ts ship paths).
- **Proposed shape:** `(probe, opts: { expectedCwd; restore; turnsBefore; snapshotAgeS; at; via })` — or group `at`+`via` (the session-stamp pair every ObservedSession carries) as one small object reused by callers.

### S32-F11. src/github/api.ts — token-first write pairs — GLM-OK

- **Signatures:** `createRepoFile(token, repo, path, content, message, sha?)` (api.ts:154, 10 call-site lines — do.ts:8036 prod, harvest paths, tests) and `commitFilesOnNewBranch(token, repo, base, branch, message, changes)` (api.ts:398, 5 call-site lines — memory/routes.ts:111 adapter, tests).
- **Proposed shape:** `(token, repo, opts: { path; content; message; sha? })` and `(token, repo, opts: { base; branch; message; changes })`. Token and repo stay positional (invariant prefix across this module); the per-call payload becomes one named object. memory/routes.ts:111's adapter shrinks with it.

### S32-F12. src/studio/do.ts:1277 + :2738 — `harvestLearnings`, `decideHeal` — GLM-OK

- **Signatures:** `harvestLearnings(deps, repo, studio, resolveMemoryRepo, commitFile, task)` (do.ts:1277) and `decideHeal(status, readiness, marker, inFlight?, now?, destroyingSince?)` (do.ts:2738).
- **Call-site count:** 16 and 21 lines.
- **Proposed shape:** harvestLearnings `(deps, repo, studio, opts: { resolveMemoryRepo; commitFile; task })` — the memory-repo pair + task travel together from every caller. decideHeal `(status, readiness, opts: { marker; inFlight?; now?; destroyingSince? })`.

### S32-F13. Three six-positionals in board/github — GLM-OK

- **Signatures:** `recordReadReposGrant(db, repo, issueNumber, studioId, repos, now)` (read-repos.ts:81, 20 call-site lines), `repairStateless(api, repo, number, task, observed, to)` (board.ts:530, 1 call site in-file), `commentStudioEnvelope(api, repo, number, raw, msgId, studioId)` (board.ts:1187, 3 call-site lines).
- **Proposed shape:** recordReadReposGrant `(db, repo, opts: { issueNumber; studioId; repos; now })` — the grant is one record, its parts arrive together. repairStateless and commentStudioEnvelope: single-caller/single-purpose — record, propose no change beyond noting their size; a rewrite buys nothing at 1–3 call sites.

### S32-F14. src/studio/accounts.ts:534 + :581 — failover-cascade booleans — GLM-OK

- **Signatures:** `deriveSearchAnchor(accounts, start, current, borrowedActive: boolean)` (accounts.ts:534) and `selectFreeAccount(accounts, anchor, current, currentOutOfScope: boolean, reserved, limits, now, usage = {})` (accounts.ts:581) — the latter 8 positionals.
- **Call-site count:** 5 and 5 lines (accounts.ts:1097-1098, failover.ts:2617-2680 region).
- **Proposed shape:** `deriveSearchAnchor(accounts, opts: { start; current; borrowedActive })` and `selectFreeAccount(accounts, opts: { anchor; current; currentOutOfScope; reserved; limits; now; usage? })`. `selectFreeAccount(accounts, { anchor, current, currentOutOfScope: true, ... })` names the cascade tier at the call site — today the bare `true` between `current` and `reserved` states nothing.

### S32-F15. cli/fleet.ts + cli/ff.ts — cmd verbs with boolean runs — GLM-OK

- **Signatures:** `cmdDestroy(creds, id, force, discardUnsynced, park = false, strictUnmerged = false)` (fleet.ts:1511), `cmdProvision(creds, id, freshSession = false, cancelFreshSession = false, discardSession = false)` (fleet.ts:1368), `cmdRecycle(creds, id, discardUnsynced, freshSession = false, forceMappedAccount = false)` (fleet.ts:1441), `spawnStudio(creds, role, repoSlug, knownId, task, instance)` (ff.ts:161), `fileTask(creds, repoSlug, studioId, task, retryDelaysMs?, sleep?)` (ff.ts:259).
- **Call-site count:** one caller each (their arg-parser dispatch in the same file), plus tests for fileTask.
- **Proposed shape:** cmd verbs already receive parsed flags — group as one options object built from the arg parser: `cmdDestroy(creds, id, flags: { force; discardUnsynced; park?; strictUnmerged? })` etc. `spawnStudio(creds, opts: { role; repoSlug; knownId; task; instance })` — `task` and `instance` adjacent positionals read as data. Lowest urgency in this sweep (single production caller each), highest readability win at the dispatch site.

# Deep-modules design sweep 4 — apps/fleet board/github/junior/llm/cli (2026-10-11)

Ref #361. Analysis only, read-only, no code changed. Fourth maintainability sweep; scope `apps/fleet/src/{board,github,junior,llm}/**` plus the CLI entry surface (`cli/fleet.ts` board verbs, `cli/junior.ts`, `cli/junior-sweep.ts`, `cli/reap-terminal.ts`, `cli/task-new-retry.ts`).

Sweeps 1-2 (docs/maintainability/2026-10-08-deep-modules-sweep.md, 2026-10-10-deep-modules-sweep-2.md) and the open deepen(*) issues they filed are NOT repeated here. Line refs = physical lines at `origin/main` `234a3b1`, paths relative to `apps/fleet/`.

**Tier rule (from #361):** GLM-OK = none of auth, tokens, rescue, failover, deploy, migrations, credentials. CLAUDE-ONLY = touches any of those.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | junior/llm request-gate preamble → one shared `aiRouteGate` | CLAUDE-ONLY (auth) |
| 2 | GitHub Link `rel="next"` parser → one shared `nextPageLink` | GLM-OK |
| 3 | comment-wake first-line predicates → one `firstLine()` | GLM-OK |
| 4 | 4th chunked-base64 copy → one shared bytes module | GLM-OK |
| 5 | fleet_state keyed-prefix scan → one `scanStateKeys` | GLM-OK |
| 6 | junior stats fetch → `FleetClient`-style tagged-result read | GLM-OK |
| 7 | same-repo-nameWithOwner fold in github/api.ts GraphQL readers | GLM-OK |
| 8 | ratelimit kind-wrappers → one `makeRateLimitKind` factory | GLM-OK |
| 9 | assigned-brief walkers → one `assignedOpenTasks` core | GLM-OK |
| 10 | webhook revoke handlers' payload extraction → one parser | CLAUDE-ONLY (authz revoke) |

### F1. Deepen the AI-route request gate: junior/route.ts and llm/anthropic-route.ts each hand-roll the same 4-check preamble — CLAUDE-ONLY (auth, spawn-token validation)

- **Files:** `src/junior/route.ts:100-113` (path check, `FLEET_JUNIOR`/`env.AI` flag, method 405, declared-Content-Length 413) vs `src/llm/anthropic-route.ts:374-389` (identical four checks, extracted into `authenticateGlmLeadRequest` only AFTER #284's review found the verbatim duplication — the llm copy adds only the token + leadType gates). Shared body-read half already exists: `src/http/capped-body.ts`.
- **Problem:** one gate sequence, two homes; the llm copy's own doc comment records that it was born as a verbatim duplicate. A third AI-spending route would copy it again.
- **Proposed change:** hoist the 4-check preamble into one `aiRouteGate(req, path, env, cap)` returning refusal-or-continue; junior's route keeps its own token/board-authz tail, the llm routes keep theirs. CLAUDE-ONLY (auth) — junior's spawn-token validation and both routes' authorization tails sit directly on this sequence.
- **Characterization first:** existing `test/junior.route.test.ts` + `test/llm.anthropic-route.test.ts` refusal cases (wrong path, flag off, GET, oversized declared body) must pass byte-identical.

### F2. Deepen GitHub pagination: two `rel="next"` Link-header parsers → one — GLM-OK

- **Files:** `src/board/api.ts:101-108` (`nextPageUrl`) and `src/github/api.ts:1031-1038` (`parseNextLink`) — same regex `/<([^>]*)>\s*;\s*rel="next"/` (one captures `[^>]*`, the other `[^>]+`), same comma-split loop, same null-on-last-page.
- **Problem:** RFC 8288 Link parsing written twice; a fix to one (e.g. handling quoted or multi-param rel entries) must be remembered in both. Each file's own comments record a pagination bug it hit (board/api.ts:190 #148; github/api.ts:1012-1019 PR #239).
- **Proposed change:** one shared `nextPageLink(header: string | null): string | null` (pure, no Env — place in `src/github/` or a new tiny shared module both tsconfig projects can reach); both callers import it. Behavior-preserving: identical matches on every real GitHub Link header.
- **Characterization first:** golden table: single next entry, multiple entries with next last, no next, no header → same result both before and after.

### F3. Deepen comment-wake predicates: one `firstLine()` under `hasWakeMarker`/`isDoneRecordComment` — GLM-OK

- **Files:** `src/board/comment-wake.ts:51-53` (`hasWakeMarker`), `:63-68` (`isDoneRecordComment`), each opening with its own `(body.split(/\r?\n/)[0] ?? "").trim()`; `src/github/wake-events.ts:246` applies `oneLine().slice()` to the same comment body three lines later.
- **Problem:** the "comment's first line is the marker surface" rule is re-typed per predicate; a fourth marker repeats the split+trim again and can drift on `\r` handling.
- **Proposed change:** one private `firstLine(body)` in comment-wake.ts (or reuse `oneLine` where semantics agree); the two predicates become single-line comparisons. Pure module, no interface change to its callers (`qualifiesForCommentWake` stays the exported surface).
- **Characterization first:** `test/github.webhook.test.ts`'s #236 describe block (marker mid-comment, `/wakeup` non-match) + `test/board.comment-wake.test.ts`'s refusal cases pass unchanged; add one CRLF-body marker case at the fold.

### F4. Delete the 4th copy of the chunked base64 encoder: one shared module — GLM-OK

- **Files:** the same chunked-encode algorithm in four shapes: `src/github/api.ts:195-204` (`base64EncodeUtf8`, TextEncoder-first), `src/studio/blueprint.ts:344-350` (`base64EncodeUtf8`, byte-identical body), `src/studio/sandbox-api.ts:241-246` (`bytesToBase64`, takes `Uint8Array`, no TextEncoder line), `src/studio/gh-wrapper.ts:156-161` (`b64`, one-line loop body). Each copy's comment justifies the duplication as module independence, but the other three sit in studio/, mutually unreachable from github/'s perspective anyway.
- **Problem:** one encoding rule (UTF-8-safe, chunked to avoid call-stack blowup) maintained four times; a bug in the chunk bound must land four times. Sweeps 1-2 never surfaced it.
- **Proposed change:** one `bytesToBase64(s)` in a dependency-free shared module (e.g. `src/base64.ts`, imports nothing — same tsconfig-reachability discipline `github/mint-token-error.ts` and `github/reach.ts` already document); all four call sites import it. The studio/ copies move in the same PR or a follow-up; the github/api.ts copy is the GLM-OK slice.
- **Characterization first:** round-trip table (ASCII, Latin-1, CJK, 100k-char string → no throw, correct decode) on the shared module; `test/bun/cmd-syntax`-style callers unaffected.

### F5. Deepen fleet_state keyed scans: one `scanStateKeys(db, prefix)` behind junior authz sweep and read-repos grants — GLM-OK

- **Files:** `src/junior/authz.ts:116-129` — `SELECT key FROM fleet_state WHERE key LIKE ?` with `${prefix}%`, then `startsWith(prefix)` re-check (LIKE's `_` wildcard) + `/^\d+$/` numeric-suffix parse + sort; `src/github/read-repos.ts:158-179` — same LIKE scan, same `lastIndexOf(":")` split, same numeric-suffix test, same sort. The same keyed `LIKE prefix%` scan shape also appears in `src/studio/registry.ts`'s registry-row scan (~:408) and in `src/ratelimit.ts`'s two prune `DELETE`s (:73-75).
- **Problem:** the "a fleet_state key is `<prefix><repo>:<number>`" grammar is written twice with hand-rolled parse-back; a malformed-key rule change (e.g. repo names containing `_`) must land in both. The junior copy's own comment already documents the LIKE-wildcard trap that a shared module would own once.
- **Proposed change:** one `scanStateTaskKeys(db, prefix)` → `{repo, number}[]` (or per-key parse fn) in `src/state.ts` (already the fleet_state module) or a small sibling; both callers keep their own verbs on top. Pure read, no write-path change.
- **Characterization first:** `test/junior.authz.test.ts` sweep pagination cases + `test/github.read-repos.test.ts` grant listing cases pass unchanged; add a shared-module case for `_` in a repo name (the trap the comment names).

### F6. Deepen `fleet junior stats`'s Worker read: tagged-result fetch instead of inline try/catch — GLM-OK

- **Files:** `cli/junior.ts:181-191` — hand-rolled `fetch(juniorUrl(...))` + `accessHeaders` + `!res.ok` throw + `res.json()` cast, wrapped in a soft-fail try/catch. The board verbs' `boardRequest` (`cli/fleet.ts:1263-1273`) and the task-state fetchers (`cli/fleet.ts:1492-1529`) each re-implement the same dance with different failure policies — sweep-2 F1 already owns the unified `FleetClient`; this is the one remaining CLI read in this sweep's scope outside it.
- **Problem:** this fetch cannot reuse `boardRequest`'s `process.exit` shape — its soft-fail posture (Worker down → local-only line, exit 0) needs a non-exiting tagged result — but it also doesn't share anything with the other non-exiting fetchers.
- **Proposed change (this slice):** give `cmdJuniorStats` a tiny `fetchUsage(creds, sinceMs) → {ok, rows} | {ok:false, error}` helper (injectable for tests), same tagged-result shape `taskStateFetchCurrent` already established; the print/soft-fail policy stays at the command edge. Full `FleetClient` migration stays sweep-2 F1's PR.
- **Characterization first:** `test/bun/junior-stats-cli.test.ts` behavior (Worker ok → merged table; Worker down → local-only line, exit 0) identical.

### F7. Deepen same-repo nameWithOwner matching in github/api.ts GraphQL readers — GLM-OK

- **Files:** `src/github/api.ts:823-826` (`sameRepoIssues` — lowercase known-list membership over `repository.nameWithOwner`), `:885-897` (`getIssueCloser`'s own `known`/`sameRepo` closure, same lowercase-membership logic inline), `:1215-1225` (`pullsWithClosingIssuesForCommits` building the same `names` list then calling `sameRepoIssues` via `closingPage`). All three exist because a task/issue may be named by the caller's slug OR GitHub's canonical case (#252/#265/#268, recorded in three separate comment blocks).
- **Problem:** the "slug-or-canonical, any case" rule lives in 2 shapes + 3 call sites within one file; `getIssueCloser` re-implements it as a closure while the sibling export sits unused 60 lines up.
- **Proposed change:** one private `sameRepoName(known: string[], name: string | undefined): boolean` (or extend `sameRepoIssues`); `getIssueCloser` calls it. No wire change — every function's return shape is unchanged. GLM-OK: pure name matching, no auth.
- **Characterization first:** `test/github.api.test.ts` closer/closing-references cases (same repo after rename, foreign-repo reference dropped, case mismatch) pass unchanged.

### F8. Deepen ratelimit kind-wrappers: one `makeRateLimitKind` factory — GLM-OK

- **Files:** `src/junior/ratelimit.ts:22-40` and `src/llm/ratelimit.ts:21-69` — three wrappers (`checkAndConsumeJuniorRateLimit`, `checkAndConsumeLeadRateLimit`, `checkAndConsumeLeadCountTokensRateLimit`), each the same 4-line `parsePositiveInt` × N + `checkAndConsumeRateLimit(...)` body over `../ratelimit.ts`'s shared core, differing only in prefixes, env names, defaults, and the count_tokens `MAX_SAFE_INTEGER` daily trick.
- **Problem:** the core is already deep (sweep landed #284's hoist); the three wrappers are pass-throughs over it — a future retry or webhook lane copies the wrapper again. The count_tokens wrapper's `MAX_SAFE_INTEGER` inert-daily comment records the one shape the core's contract doesn't express.
- **Proposed change:** a `makeRateLimitKind({ kind, env, perMinuteEnv, perMinuteDefault, dailyCapEnv?, dailyCapDefault? })` in `src/ratelimit.ts`; the three public functions keep their names and signatures (callers unchanged) and become one-line factory calls. Optionally an explicit `daily: false` option replacing the MAX_SAFE_INTEGER trick — behavior-identical either way, chosen in the issue.
- **Characterization first:** `test/junior.ratelimit.test.ts` + `test/llm.ratelimit.test.ts` (bucketing, refusal retryAfterMs, pruning) pass unchanged; add one case per kind via the factory.

### F9. Deepen assigned-brief walkers: one `assignedOpenTasks` core behind `resolveLatestAssignedBrief` and `openTasksNeedingRebrief` — GLM-OK

- **Files:** `src/board/board.ts:1243-1278` vs `:1313-1330` — both: call `listTasks(api, repo, {assignedTo})` in a try/catch that logs `lookup failed for <studioId>@<repo>` and fails open (null / []), then filter `t.open && t.state !== null && <STATE_SET>.includes(t.state)`, then sort `updatedAt` DESC. The two state sets (`LIVE_TASK_STATES` at :1260, `REBRIEF_TASK_STATES` at :1327) are byte-identical values by board.ts:1293's own recorded decision.
- **Problem:** same 5-step dance twice; the fail-open log message differs only in function name; the `#124 review` comment on the sibling `openAssignedTasks` (:1385) already explains why destroy's copy deliberately differs — so the remaining duplication is exactly these two, which share the same posture.
- **Proposed change:** one private `assignedOpenTasks(api, repo, studioId, states) → BoardTaskView[] | null` (null = lookup failed, the fail-open signal); both exported functions keep their signatures and their own digest/render tails on top. `REBRIEF_TASK_STATES` stays exported (it is the named policy decision, board.ts:1280-1293).
- **Characterization first:** `test/board.board.test.ts`'s `resolveLatestAssignedBrief` block (multiple-open-tasks note, fail-open null) + `openTasksNeedingRebrief` block (issue #137 cases) pass unchanged.

### F10. Deepen webhook revoke handlers' payload extraction — CLAUDE-ONLY (junior authz revoke)

- **Files:** `src/github/webhook.ts:106-124` (`revokeJuniorOnIssueEvent`) and `:142-160` (`revokeGlmLeadOnSecurityLabelEvent`) — two `JSON.parse(body)` try/catches each reading `action`/`label?.name`/`issue?.number`/`repository?.full_name` off the same webhook payload shape, both TOTAL-swallow, both feeding a revoke verb.
- **Problem:** one payload grammar parsed twice; a GitHub payload-shape change (or a third revoke trigger) repeats the field extraction and its type guards.
- **Proposed change:** one private `issueEventFields(body): {repo, number, action, label} | null` in webhook.ts; both handlers keep their own policies (which actions/labels revoke). CLAUDE-ONLY: both handlers revoke authorizations — one the junior D1 record, one a glm-lead assignment — the junior-authz security property (studio can never grant/revoke itself) sits on this path.
- **Characterization first:** `test/github.webhook.test.ts`'s #35 revoke cases (labeled terminal, closed, unrelated label → no revoke) pass unchanged.

## Not filed (deferred / noted)

- `cli/fleet.ts`'s `boardRequest` exit-on-fail vs task-state's tagged-result fetchers — deliberate per doc comments; the full `FleetClient` unification is already sweep-2 F1 (CLAUDE-ONLY), open as a filed issue.
- `src/github/webhook.ts`'s `stoppedWakeSkipKey` episode-flag dance (`getFlag`/`setFlag` "1"/"0" at :189-205) — mirrors watchdog.ts's rearm pattern; one shared episode-flag module would serve both, but watchdog.ts is outside this sweep's scope.
- `src/board/routes.ts`'s five per-handler `mint` closures (`githubBoardApi`, `realLeakDeps`, `realPolicyFetch`, `realReapPort`, `realRescueGcPort`); a deliberate "credential never held across requests" rule (each handler's own doc comment says so), not duplication to remove.
- `src/llm/translate.ts` streaming state machine — already deep (sweep landed #298 follow-ups); the file's comment blocks narrating PR #255/maestro-review history are the sweep-1 "comment narrates history" shape but each carries a live measured fact; a comment-tightening pass would churn a hot, freshly-reviewed file for little gain.

## Counts

8 GLM-OK findings (F2, F3, F4, F5, F6, F7, F8, F9) → one deepen issue each. 2 CLAUDE-ONLY (F1, F10) recorded here for the Claude lane, no issue filed by this sweep (maestro files those).

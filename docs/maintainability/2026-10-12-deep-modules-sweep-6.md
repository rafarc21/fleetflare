# Deep-modules design sweep 6 — remaining src/ modules (2026-10-12)

Ref #415. Analysis only, read-only, no code changed. Sixth maintainability sweep; scope `apps/fleet/src/**` EXCEPT board/, github/, junior/, llm/ (sweep 4) and the CLAUDE-ONLY surface (auth, tokens, credentials, write-proxy, rescue, failover, accounts routing, deploy, migrations, leak gate).

Sweeps 1-5 (docs/maintainability/2026-10-08-deep-modules-sweep.md, 2026-10-10-deep-modules-sweep-2.md, 2026-10-11-test-sweep-3.md, 2026-10-11-deep-modules-sweep-4.md, 2026-10-11-deep-modules-sweep-5.md) and the open deepen(*) issues they filed are NOT repeated here. Line refs = physical lines at `origin/main` `ec85d08` (all re-verified against the current head: nothing in scope moved except state.ts's appended scanStateTaskKeys, which shifts no ref below), paths relative to `apps/fleet/`.

**Tier rule (from #361):** GLM-OK = none of auth, tokens, rescue, failover, deploy, migrations, credentials. CLAUDE-ONLY = touches any of those.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | "1"/"0" episode-flag dance (3 homes) → one `state.ts` module | GLM-OK |
| 2 | burn.ts twin FNV loops → one `fnv2` | GLM-OK |
| 3 | burn.ts 2105 lines, two knowledge areas → split tar/gzip reader out | GLM-OK |
| 4 | `Promise.race` + `setTimeout` + `finally clearTimeout` deadline idiom, 2nd TS home → import from a src/ home | GLM-OK |
| 5 | `crypto.randomUUID().slice(0, 8)` shortId spelled 10× → one helper | GLM-OK |
| 6 | rearm counter non-atomic getFlag+setFlag → `incrementCounter` | GLM-OK |
| 7 | profile.ts test-only re-export of container-class triple | GLM-OK |
| 8 | directus client/card const exports used only by tests | GLM-OK |
| 9 | watchdog.ts comment narrates 3 review rounds, not the contract | GLM-OK |
| 10 | repo-slug `owner/name` grammar in 4 hands (ops-repo + rescue + write-proxy already noted by sweep 1; test-creds is the one new home) | CLAUDE-ONLY |

### F1. One episode-flag module behind the three "1"/"0" flag dances — GLM-OK

- **Files:** `src/tasks/watchdog.ts:78-81` (`clearRearm` clears `rearmKey`+`alertedKey` to "0"), `src/index.ts:203-204,220,227` (rearm `attempts` increment + `alertedKey` set "1"), `src/github/webhook.ts:195-197,205` (`stoppedWakeSkipKey` set "1" once per stopped episode, cleared "0" on resume), `src/telegram/webhook.ts:93,102,149` (`"paused"` flag set/cleared/read). All four over `src/state.ts`'s `getFlag`/`setFlag`. Sweep 4's not-filed note (its doc, line 97) already named this exact fold and deferred it because watchdog.ts was out of its scope; this sweep covers it.
- **Problem:** "a fleet_state flag is an episode marker: '1' until the episode ends, then '0'" — one rule, three homes (paused is the degenerate one-episode-per-tap shape). The `paused` and skipKey copies each hand-roll the read-then-set dance with its own subtle once-per-episode wording; a fourth marker repeats it.
- **Proposed change:** one `src/state.ts` (or `src/episode-flag.ts`) helper set: `flagIsSet(db,key)`, `markEpisode(db,key,now)`, `clearEpisode(db,key,now)` — thin named wrappers over getFlag/setFlag; the three sites call them. Wire values stay "1"/"0", keys unchanged. `incrementCounter` stays as-is (F6 handles its own call site).
- **Characterization first:** `test/watchdog.test.ts` + `test/index.test.ts` (rearm/alerted) + `test/telegram.callback.test.ts` (`/pause`/`/resume`/paused-message cases, lines 59-71) + `test/github.webhook.test.ts` stopped-wake-skip cases pass unchanged.

### F2. burn.ts: twin FNV loops → one `fnv2` — GLM-OK

- **Files:** `src/studio/burn.ts:430-438` (`sessionMapKey`) and `:550-558` (`realPathMapKey`) — byte-identical bodies (two 32-bit FNV-1a-style rolls, `Math.imul`, rendered base36), differing only in parameter name; `prefixFingerprint` (:384) runs the same two rolls inline with an `end` bound. All three share `FP_INIT_A/B`, `FP_PRIME_A/B` (:360-363).
- **Problem:** one hash algorithm three shapes in one file; a tweak (e.g. seeding, or a collision fix) lands three times. `realPathMapKey`'s own comment (:444) calls it "the same two-roll FNV-1a-style shape `sessionMapKey` uses".
- **Proposed change:** one private `fnv2(s: string, end?: number): string` (or roll-returning `fnv2Rolls`) at the FP const block; `sessionMapKey`/`realPathMapKey` become one-liners over it, `prefixFingerprint` keeps its fingerprintOf rendering. Pure module-internal fold, no export change, `pathMapKeyImpl`/`__setPathMapKeyForTest` seam untouched.
- **Characterization first:** `test/studio.burn.test.ts` (incl. the `__setPathMapKeyForTest` collision suite at :1640-1678) + `test/studio.session-inflate.test.ts` pass unchanged; the two map keys are byte-stable so no persisted shape changes.

### F3. burn.ts 2105 lines: split the tar/gzip byte-stream reader out — GLM-OK

- **Files:** `src/studio/burn.ts` — two knowledge areas under one roof: (a) usage accounting (`BurnCursor` :48, `resolveOffsets` :800, `parseUsageIncrement` :1047, `rollWindow` :1393, `pruneCursor` :1187) and (b) the gzip→tar→jsonl byte-stream reader (`GUNZIP_SLICE` :1575, `INFLATE_READ_VIEW` :1578, `INFLATE_PROBE` :1582, `inflateSliced` :1596, `walkGzipTar` :1640, TAR parsing `readCString` :1442/`readOctalField` :1449/`TAR_BLOCK` :1440, `readJsonlMembersFromTar` :1489, `extractJsonlMembers` :1559, `sessionStats` :1800, `newestMark` :2046/`poorerThan` :2095/`sameSession` :2076). The accounting half is the reader's other driver: `burnIncrement` (:1929) walks members through `walkGzipTar` itself, so the split moves `burnIncrement`'s pass-1 plumbing with the reader or keeps a small shared seam (extract method + hand it back) — the issue must pick one and state it.
- **Problem:** 2105 lines, 6th-largest src file; a reader bug (a tar edge case, a gzip truncation) sits in the same file as cursor algebra, and `test/studio.session-inflate.test.ts` imports from both halves (via session-sync.ts). Brief's ">1500 lines worth splitting" category; sweep 1 never covered it.
- **Proposed change:** move the byte-stream reader (b) into `src/studio/session-stats.ts` (name negotiable): `SessionFileStat`/`SessionStats`/`SessionMark`, `readJsonlMembersFromTar`, `extractJsonlMembers`, `sessionStats`, `walkGzipTar`+inflate plumbing, `newestMark`, `poorerThan`, `sameSession`, `SessionArchiveFormatError`, plus their TAR/FP internals; burn.ts re-exports the types/`sessionStats`/`newestMark`/`poorerThan` so `session-sync.ts`/`provision.ts`/`do.ts` (and grid.ts/types.ts type-only imports) stay unchanged, or migrate them in the same PR — dev's choice, stated in the issue. Production importers today: session-sync.ts, provision.ts, do.ts (type-only), grid.ts (type-only), types.ts (type-only); archive.ts/destroy.ts reference burn.ts only in comments.
- **Characterization first:** `test/studio.burn.test.ts` + `test/studio.session-inflate.test.ts` + `test/studio.session.test.ts` + `test/bun/session-tar-budget.test.ts` pass unchanged; a new import-cycle check (`session-stats.ts` imports nothing from the accounting half) lands as a test.

### F4. `Promise.race` + `setTimeout` + `finally clearTimeout` deadline idiom — one home in src/ — GLM-OK

- **Files:** `container/ego-browser/process-reap.ts:124` exports `raceWithTimeout(promise, timeoutMs, setTimeoutFn)` — but it RESOLVES on either outcome (a bounded wait for browser.close()), while `src/studio/sandbox-api.ts:219-231` (sbExec's deadline: `new Promise` timer + `Promise.race` + `finally clearTimeout`, rejects with `ExecDeadlineError`) and `src/exceptions.ts:264-284` (insert deadline: same shape, `INSERT_TIMEOUT_MS` :146, rejects) hand-roll the REJECTING variant; `src/exceptions.ts:141-142` cites the idiom by name ("Same `Promise.race` + `setTimeout` idiom as src/studio/sandbox-api.ts's sbExec / src/studio/do.ts's exec deadlines"). `src/studio/do.ts` has three more copies (:1647 containerAnswers probe, :3645 tick deadline, :4931 withExecDeadline, CLAUDE-ONLY ground). `raceWithTimeout`'s HOME is under `container/`, and the image boundary is real: `container/Dockerfile.studio:14` ships `container/ego-browser` into the image but never `apps/fleet/src/` (its tsconfig includes only `container/**/*.ts`), so src/ cannot be its import direction — a src/ helper must be NEW, not re-exported from process-reap.ts; same import-discipline reasoning as `src/base64.ts`'s header ("a shared file here must import nothing").
- **Problem:** the idiom's timer-cleanup rule is written 4× in src/ (2 GLM-OK homes + do.ts's 3), each re-deriving "clearTimeout in finally so a fast path never leaks a timer"; exceptions.ts's comment names the shared shape without a shared home.
- **Proposed change:** one dependency-free `src/race-timeout.ts` exporting BOTH shapes explicitly named for what they do: `raceWithDeadline(promise, timeoutMs, makeTimeoutError, setTimeoutFn = setTimeout)` (rejecting — sbExec + recordWorkerException call it, sbExec's `abandoned`-set side work stays at its call site) and optionally `raceWithTimeout` (resolving, for the bounded-wait shape if do.ts's tick deadline ever migrates). process-reap.ts keeps its own copy (the image boundary forbids the import direction); do.ts's three copies: defer, CLAUDE-ONLY.
- **Characterization first:** `test/exceptions.test.ts` insert-timeout case ("1a: an insert that hangs past the timeout", :125) + `test/studio.exec-deadlines.test.ts` (sbExec deadline cases, :121+) pass unchanged; `test/bun/ego-browser-process-reap.test.ts` (raceWithTimeout's existing users) untouched.

### F5. `crypto.randomUUID().slice(0, 8)` shortId spelled 10× → one helper — GLM-OK

- **Files:** the exact expression at `src/tasks/loop.ts:38` (as `rid()`), `src/telegram/webhook.ts:62,129`, `src/approvals/gates.ts:105,124`, `src/board/close-action.ts:184`, `src/github/webhook.ts:688`, `src/studio/routes.ts:501`, `src/deploy/do.ts:90,170` — every `makeEvent` call site outside loop.ts re-spells it.
- **Problem:** the "event id tail = 8 hex-ish chars" rule is spelled 10 times; the slice bound and the UUID base never travel together anywhere a future call site can import.
- **Proposed change:** one `shortId(): string` in `src/events/schema.ts` next to `makeEvent` (it IS makeEvent's id convention), `export function shortId() { return crypto.randomUUID().slice(0, 8); }`; the 10 sites import it (`rid()` in loop.ts becomes it too). `schema.ts` imports nothing, so all tsconfig projects reach it. Wire values unchanged (same expression).
- **Characterization first:** grep count of the raw expression drops to 1 (inside shortId); no test pins these id strings' shape beyond uniqueness — `test/events.log.test.ts` + `test/events.rules.test.ts` and the webhook/approval/telegram suites pass unchanged.

### F6. index.ts's rearm counter is the non-atomic getFlag-then-setFlag shape incrementCounter exists to replace — GLM-OK

- **Files:** `src/index.ts:203-204` — `Number((await getFlag(env.DB, key)) ?? "0") + 1` then `setFlag(...)` — vs `src/state.ts:42-56` (`incrementCounter`: one-statement atomic `INSERT ... ON CONFLICT ... RETURNING`), whose doc comment (:25-41) documents the exact "N concurrent callers all read the same pre-increment value" race it was built to kill (PR #9 review BLOCKER F1, measured: 20 concurrent calls against a cap of 3 all succeeding). The only other read-then-write flag pair in src/ is F1's episode flags, which are policy, not counters.
- **Problem:** the one remaining counter-shaped flag write in src/ is also the only remaining read-then-write pair; the cron is single-threaded per minute today, but the comment-documented reason incrementCounter exists is the shape, not the current caller count. Low blast radius: the value is only read by `shouldAlert`'s `attempts >= 2`.
- **Proposed change:** `const attempts = await incrementCounter(env.DB, key, now);` — one line, deletes the read-then-write pair. `rearmKey`'s value column stays TEXT ("1", "2", ... — `CAST` round-trips, state.ts:34-40 documents the encoding), `clearRearm` still resets via setFlag "0". Add one watchdog test: two concurrent increments land on 2 (the race the old shape loses).
- **Characterization first:** `test/index.test.ts` (scheduled/stale rearm cases) + `test/watchdog.test.ts` pass; new test pins the atomicity.

### F7. profile.ts's re-export of the container-class triple is test-only — GLM-OK

- **Files:** `src/studio/profile.ts:13-15` — `import { isBigProfileRole, doClassForRole, BIG_PROFILE_ROLES } from "./container-class"` re-exported with a comment (:6-12) saying the re-export exists "only so test/studio.profile.test.ts can exercise it" (routes.ts now imports `realDoClassForRole` instead). `test/studio.profile.test.ts:3` imports the triple from profile.ts.
- **Problem:** a re-export whose own comment declares it dead weight for production — the exact "test-only export" shape sweep 3 culled elsewhere (e.g. #407's WATCH_INTERVAL_MS); production importers of container-class import it directly. Of the three, only `isBigProfileRole` is used inside profile.ts (realDoClassForRole :34); `doClassForRole`/`BIG_PROFILE_ROLES` are re-export-only.
- **Proposed change:** delete the `export {}` line and shrink the import to `isBigProfileRole` (what realDoClassForRole needs); `test/studio.profile.test.ts` imports the triple from `src/studio/container-class` instead. Test-file edit only, no production surface change.
- **Characterization first:** `test/studio.profile.test.ts` passes with the new import path; `bun run check` (all 5 tsconfig projects) clean.

### F8. directus client/card const exports read only by tests — GLM-OK

- **Files:** `src/directus/client.ts:52` (`DIRECTUS_MAX_BYTES`), `:68` (`REQUIREMENTS_PAGE_LIMIT`), `src/directus/card.ts:47` (`CARD_MAX_LINES`), `:56` (`CARD_DECISION_LIMIT`), `:65` (`CARD_DECISION_FETCH_LIMIT`) — no production file outside the two modules imports any of the five (grep-verified); each is used internally by its own module (DIRECTUS_MAX_BYTES at `directusGet` :129-130, REQUIREMENTS_PAGE_LIMIT at `listRequirements` :259-262, the three card caps inside card.ts's render/read paths :154, :231); the tests (`test/directus.client.test.ts:5`, `test/directus.card.test.ts:3`) import them to assert the caps directly. The sixth const, `DIRECTUS_TIMEOUT_MS` (client.ts:62), is the same shape's control case: exported AND prod-used (client.ts:121).
- **Problem:** five exported consts whose only external importer is a test, in two adjacent files whose other same-shape const is genuinely prod-shared — the "interface is test surface" rule (sweep 1) is applied to exactly one const of the family. Interface drift within one file's const block.
- **Proposed change (decision, not a fold):** either (a) un-export the five test-only-externally consts (tests assert behavior: oversized body → the documented throw; over-20-line card → the test's own count) or (b) export the family consistently and keep DIRECTUS_TIMEOUT_MS's real sharing as the reason. Recommend (a) — matches sweep-1's "interface is test surface" rule and #407's precedent; the card line-budget test still counts lines. Dev decides in the issue per repo precedent; either way one consistent rule per file.
- **Characterization first:** `test/directus.client.test.ts` + `test/directus.card.test.ts` + `test/directus.provision.test.ts` pass (with the chosen option's test edits in the same PR).

### F9. watchdog.ts's clearRearm doc comment narrates 3 review rounds, not the contract — GLM-OK

- **Files:** `src/tasks/watchdog.ts:38-77` — `clearRearm`'s doc comment: "Fix round 1 (task 10a review, Important finding)" paragraph, "Final re-review residual" paragraph, "an earlier version cleared only rearmKey" paragraph — ~33 lines narrating what earlier PRs got wrong before the words "Clearing both flags in this one place" (:75) state the actual rule. Same file: `shouldAlert`'s comment (:99-113) leads with a "Carve-out C (final-review fix wave)" history lead. `agents/do.ts`'s `shouldClearRearm` (:114-137) re-narrates the same "fix round 1" story.
- **Problem:** the "comment narrates issue history instead of why" shape from the brief; the operative invariants (clear on completed polls only; clear BOTH flags; alert once per episode) are buried under review-provenance. Sweep 3's #377 established the deprovenance pattern for test titles; this is its src-comment twin.
- **Proposed change:** rewrite the two doc comments to state the contract (what clears, when, why both flags, what happens without the reset) citing at most one issue ref each where the measured fact lives; delete the round-numbering and earlier-version narratives. `agents/do.ts`'s `shouldClearRearm` comment trims its round-1 story to the rule. Comment-only diff, no code change.
- **Characterization first:** `test/watchdog.test.ts` + `test/agents.do.test.ts` pass unchanged (comments only); english-check clean.

### F10. repo-slug `owner/name` grammar in 4 hands — CLAUDE-ONLY (ops-repo/rescue/write-proxy noted by sweep 1)

- **Files:** `const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/` at `src/ops-repo.ts:15`, `src/write-proxy/mode.ts:28`, `src/studio/rescue.ts:35` (`RESCUE_REPO_RE`), `src/creds/test-creds.ts:38` (`SLUG_RE`); each pairs it with its own trim/blank/null/log dance (`resolveOpsRepo` :17-25, `resolveRescueRemote` :39-47, mode.ts's `repoListed` family :41-56, test-creds' slug check :82).
- **Problem:** one grammar, four homes. Sweep 1's deferred list (its doc, line 374) already named this fold — listing `ops-repo.ts`, `studio/rescue.ts`, `write-proxy/mode.ts` (+ memory/store.ts's pure pass-through) — and ruled its GLM-OK slice = ops-repo.ts + memory/store.ts only, rest CLAUDE-ONLY. The one home sweep 1 did not see is `creds/test-creds.ts:38` (credentials ground). Recorded here with that addition.
- **Proposed change:** one `src/repo-slug.ts` `resolveRepoSlug(raw, opts: {label}) → string | null` (regex + trim + blank-null + one logged refusal), imports nothing; ops-repo.ts delegates (GLM-OK slice, matches sweep 1's ruling). write-proxy/rescue/creds copies stay CLAUDE-ONLY — maestro files those, not this sweep.
- **Not filed by this sweep** (lane boundary, per #361's tier rule): CLAUDE-ONLY record only.

## Not filed (deferred / noted)

- `src/studio/do.ts` (8670 lines), provision (4071), failover (3158), rescue (2644), install-cache (2323): CLAUDE-ONLY ground, already partitioned by sweep 1's F1/F4/F6/F7/F8/F13 + deferred list. survival-delivery.ts (1502) similarly (sweep 1 deferred: R2 key layout = one-way on data).
- `src/env.ts` (435 lines): pure Env interface/vocab module, sweep 1's "shallow by number, fine by deletion test" ruling stands.
- telegram/api.ts `sendMessage` not routed through its own `call` helper: deliberate, documented at :95-98 (whitespace-skip + partial-delivery accounting predate the helper).
- `parseDurationS` (member-alerts.ts:99) vs `parseIdleDuration` (cli-args.ts:420): different grammars (h-m-s combo → seconds; single-unit → ms) — not a dup.
- directus test-only exports beyond F8's five (portal.ts's five client-view helpers, schema-apply's four payload helpers): each is a documented seam the module's own header names — portal.ts's header IS its specification, and the fake-Directus harness exercises schema-apply's helpers by design; no production file imports either module. F8 files the one inconsistent case inside a prod-imported module; these two pass the deletion test as-is.
- `src/approvals/gates.ts`'s `step()` post-CAS helper: exactly the right shape already; deploy_staging/deploy_prod branches (:200-201) = deploy ground, untouched.

## Counts

9 GLM-OK findings (F1-F9) → one deepen issue each. 1 CLAUDE-ONLY (F10) recorded here for the Claude lane, no issue filed by this sweep (maestro files those). A CLAUDE-ONLY follow-up is NOT in this sweep's power: F4's do.ts copies and F10's write-proxy/rescue/creds slices belong to the maestro's lane.

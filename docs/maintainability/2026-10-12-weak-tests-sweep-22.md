# Weak test assertions sweep 22 — apps/fleet/test (2026-10-12)

Ref #576. Analysis only, read-only, no code changed. Twenty-second
maintainability sweep: tests that pass but cannot fail for the reason
their title claims — it()/test() blocks with no assertion at all, tests
whose only assertion is toBeDefined/toBeTruthy/not.toThrow on a value
that is always defined, and skipped lanes with no linked issue. Scope:
`apps/fleet/test/**` (test root + test/bun; test/helpers excluded).
Line refs = physical lines at origin/main 8f2399d, paths relative to
apps/fleet/.

Sweeps 1-21 (docs/maintainability/*.md) and the issues they filed are
NOT repeated here. test-lies-check (#164/#174, the CI gate) catches a
DIFFERENT set (tautological const assertions, source-reading tests,
own-module mocks) — this sweep's categories are disjoint from it.

**Tier rule (from #539):** GLM-OK = none of auth, secrets, credentials,
rescue, failover, accounts routing, deploy. CLAUDE-ONLY = touches any of
those.

## Method

Census by a /tmp scanner (paren-depth block extraction over
string/comment-masked copies of all 335 test files; helper-aware —
file-local assertion helpers like bothEngines() count their inner
expects): 8225 it()/test() blocks scanned. Zero-assertion blocks: 6.
Sole-weak-assertion blocks (exactly one expect, and it is
toBeDefined/.toBeTruthy/not.toThrow/.toBeUndefined/toBeGreaterThan):
55. Hard skips (it.skip/xit/it.todo/it.fails): 0 in the whole tree.
Conditional skip lanes (test.skipIf/aliased lane wrappers): 22, of
which 20 carry no issue reference near the block. Every finding below
then read in full, with its src module, before classification; the
whole verified-clean set was judged the same way, not grepped.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | test/bun/fleet-reap.test.ts:447,560,566 — backoff tests assert presence, not the promised 30 minutes | GLM-OK |
| 2 | test/bun/fleet-reap.test.ts:583 — "clears its state entries" checks 1 of 3 state maps | GLM-OK |
| 3 | test/studio.session.test.ts:1236 — a save test whose only proof is that a promise resolved | GLM-OK |
| 4 | test/cli.studio-row.test.ts:77,119 — "throws nothing" loops assert only not.toThrow, never the return value | GLM-OK |
| 5 | never-throws contract tests with no companion positive assertion (exceptions, activity) | GLM-OK |
| 6 | conditional skip lanes with no linked issue (bringup-hooks linuxOnly x19, ego-browser-launch-timeout) | GLM-OK |

### F1. fleet-reap.test.ts:447,560,566 — "back off 30m" asserted as presence only — GLM-OK

- **Site:** three tests whose titles all end "-> back off 30m": "3
  live-read refusals in a row -> back off 30m" (:447), "destroy refused
  (409) -> back off 30m" (:560), "destroy outcome unknown -> back off
  30m" (:566). Each ends in
  `expect(f.saved()!.backoffUntil[PILOT]).toBeDefined()`.
- **Why it can't fail for its claim:** REAP_BACKOFF_MS is 30*60_000
  (cli/reap.ts:57) and the sibling test in the SAME describe,
  "rescue fails -> skip, no destroy, back off 30m" (:552-557), already
  shows the right shape: `Date.parse(...)` toBe NOW + REAP_BACKOFF_MS,
  plus a REAP_BACKOFF_MS 30-minute pin. The three weak ones would pass
  if the backoff were 1 second, or last week's date — anything
  truthy. The 30 in three titles is asserted by zero of them.
- **Proposed:** copy the :556-557 two-line shape into all three:
  `expect(Date.parse(f.saved()!.backoffUntil[PILOT]!)).toBe(NOW.getTime() + REAP_BACKOFF_MS)`. For :447 the saved state comes from the third fake — same assertion applies.

### F2. fleet-reap.test.ts:583 — "a successful destroy clears its state entries" checks backoffUntil only — GLM-OK

- **Site:** "a successful destroy clears its state entries" seeds
  `backoffUntil` and asserts
  `expect(f.saved()!.backoffUntil[PILOT]).toBeUndefined()`.
- **Why it can't fail for its claim:** "entries" is plural —
  cli/reap.ts:412 deletes `state.backoffUntil[s.id]` at the same place
  the OTHER state maps matter; emptyReapState() (:91) has three:
  backoffUntil, stallAlarmAt, refusals. A regression that stops
  clearing stallAlarmAt or refusals after a successful destroy passes
  this test untouched. The sibling "clears its state entries" for the
  whole-map shape already exists at :615-620
  (`backoffUntil).toEqual({})`), so the pattern is in-file.
- **Proposed:** seed stallAlarmAt and refusals entries for PILOT too,
  then assert all three maps' PILOT keys are gone (or the whole maps
  empty, matching :620's toEqual({}) shape).

### F3. studio.session.test.ts:1236 — stale-lease save test: proof = "the promise resolved" — GLM-OK

- **Site:** "a STALE storage-persisted lease ... does NOT block a save"
  hooks storage.put to resolve a promise when an installCacheHash: key
  lands, runs syncSessionCycle, then ends `await hashPersisted;` — the
  whole test body, zero expect calls. Its own comment (:1272-1274)
  says "proven by the hash marker being persisted, not merely that no
  exception was thrown" — but no expect ever checks the marker.
- **Why it can't fail for its claim:** the sibling test one block up
  (:1221-1223) shows the strong shape for the same hook:
  `expect(await storage.get(INSTALL_CACHE_SAVE_LEASE_KEY)).toBe("")`
  plus `expect(guard.inFlight).toBe(false)`. If syncSessionCycle ever
  stops calling storage.put for the hash (e.g. skips the save for a
  different reason — lease judged fresh, guard wedged), this test
  HANGS (await never resolves) or passes vacuously after a timeout
  bump — it never fails with a readable message.
- **Proposed:** after `await hashPersisted`, read the actual key back
  and assert it: `expect(await storage.get(<the installCacheHash key it resolved on>)).not.toBeNull()` (the hook fires on a real key — capture it in the put hook), and assert the lease was re-written/stale-cleared per the sibling's shape. At minimum one expect on persisted state, so the failure is a diff, not a hang.

### F4. cli.studio-row.test.ts:77,119 — "throws nothing on any input shape" loops never check what came back — GLM-OK

- **Site:** two tests loop a case list through
  `expect(() => parseStudioStatus(c)).not.toThrow()` (:77) and
  `parseStudioStatusArray` (:119).
- **Why it can't fail for its claim:** not.toThrow on a pure decoder
  whose contract is "returns null on any invalid shape" proves only
  that no exception escaped. If parseStudioStatus ever started
  returning a garbage object instead of null for the invalid cases in
  the SAME list ({ ...MINIMAL, state: "booting" }, { ...MINIMAL, id:
  42 }, "x", 7, null, undefined, [MINIMAL]), every one of those
  regressions passes. The case lists overlap almost entirely with the
  per-case tests directly above (which DO assert toBeNull) — so the
  loops add only the throw-check, and they read as if they covered the
  return values.
- **Proposed:** assert the return too, inside the loop, per contract:
  for the known-invalid shapes in the list,
  `expect(parseStudioStatus(c)).toBeNull()`; keep not.toThrow as a
  second line if desired. Or drop the loops (the per-case tests above
  already pin null) and keep one true throw-fuzz case.

### F5. never-throws contract tests: swallow proven, correct handling never checked — GLM-OK

- **Site:** recordWorkerException / pruneWorkerExceptions
  (test/exceptions.test.ts:61 "insert itself fails", :355 "delete
  itself fails") and clearActivityState (test/studio.activity.test.ts:690
  "no delete method", :695 "delete itself rejects") all end in a single
  `await expect(...).resolves.toBeUndefined()` (or the same shape with
  not.toThrow). The contract ("best-effort, swallowed, NEVER throws")
  is real — src/exceptions.ts:244-282 catches describeError, insert,
  and ctx.waitUntil separately, each with a console.error.
- **Why it can't fail for its claim:** resolving undefined proves the
  swallow, not the handling. In :61, the insert error is caught and
  console.error'd (src:270-272) — the test never checks the error was
  LOGGED (the one thing the catch does) nor that no row landed. A
  regression that silently drops the record with NO log — the exact
  "silent catch" sweep-13 (#519) fought — passes all four tests.
- **Proposed:** one companion expect per test: spy console.error
  (vi.spyOn(console, "error")) and assert it was called with a message
  naming the failure; and/or assert the D1 fake recorded no insert /
  the activity state stayed unchanged. Keeps the never-throws contract
  AND proves the swallow was the designed one, not a lost one.

### F6. conditional skip lanes with no linked issue — GLM-OK

- **Site:** bringup-hooks.test.ts:1309 `const linuxOnly =
  test.skipIf(process.platform !== "linux")` — 19 linuxOnly(...)
  blocks below (:1408-1470+) assert real behavior but carry no issue
  reference anywhere in their describe (the map they pin traces to
  #221/#370 via COMMENTS two files away, but the skip lane itself
  cites nothing). ego-browser-launch-timeout.test.ts:97
  `test.skipIf(!IS_LINUX)` — the issue (#276) is cited in the file
  header at :6, ~90 lines up, outside any 5-line window a reader or
  tool would trust.
- **Why it matters:** the brief's SKIP category ("skipped tests with no
  linked issue") has no hard it.skip blocks to catch, but a
  conditionally-skipped lane with no visible citation has the same
  failure: on a Mac dev box, all 19 blocks silently do nothing, and
  nothing in the repo says WHY they should run or where the decision
  was made.
- **Proposed:** mechanical: add the issue ref to each lane — a
  trailing `(#221)` in each linuxOnly title in bringup-hooks, and move
  ego-browser-launch-timeout's #276 citation from the file header into
  the skipIf test's own title. No behavior change.

## Verified-clean (recorded, nothing filed)

- **Zero-assertion blocks, intentional (3):** fail-loud environment
  guards that exist to throw — git-wrapper.test.ts:106,
  rescue-push.test.ts:152, install-cache-security.test.ts:1861 (all
  three throw by design, referencing their own issue numbers).
- **Zero-assertion blocks, compile-gates (2):**
  studio.backup-guard.test.ts:1210, studio.exec-deadlines.test.ts:165
  — `@ts-expect-error` blocks whose assertion IS "does not compile";
  they gate `bun run check`, not the test runner. Deliberate,
  documented in-block.
- **Absence-semantics toBeUndefined singles (~30):** blueprint:172/205/
  254/350, transcript:1172/1263/1355, github.api:290/296, github.app:255,
  llm-translate:89, public-config:56, account-limits:56,
  account-launched:150, fresh-session:562, provision:2139/2186,
  refresh:1128/1438, restart-count:124/130, self-heal:286,
  account-failover:1759, failover-real-panes:616/622,
  survival-delivery:1263, burn:1263, process-reap:42/47/58, orca:1209,
  session:2012, account-limits:56. Each asserts the ABSENCE of a field
  whose PRESENT-case sibling sits in the same describe asserting the
  value — the pair is the contract; the absent half cannot be
  strengthened without asserting implementation detail.
- **exec-deadlines.test.ts:85** "gives every class a positive deadline":
  `toBeGreaterThan(0)` is literally the claim; the real budgets are
  pinned to the millisecond by the sibling "keeps the code's own
  existing budgets" test directly below.
- **anthropic-route:1175** (`toBeGreaterThan(10)` on array-content token
  count) and **session-stats-cycle:44** (`toBeGreaterThan(0)` on the
  walker import): both floors ARE the claims (a lower-bound contract);
  strengthening to an exact number would pin token math that must
  track content changes.
- **exceptions.test.ts:105/125/179** (throwing getters, hanging insert,
  throwing waitUntil): :105 and :179 each carry a companion behavioral
  path (the describeError fallback row contract / waitUntil isolation);
  :125's resolves-anyway IS the deadline contract (PR #198's
  acceptance), with the insert-failure row shape asserted in the
  neighbor :61 case's describe. Filed as F5 companions only where the
  swallow is the sole proof (:61, :355, activity:690/695).
- **failover-106:210** (not.toThrow on a pane parser edge): parser edge
  coverage continues below with toMatchObject on decoded output in the
  same describe.
- **burn.test.ts:647** `resolves.toBeDefined` on a valid gzip: the
  describe's siblings assert both error directions (rejects with
  SessionArchiveFormatError); "valid input parses" is the third leg.
- **restart-count:124/130**: log() returning undefined IS "count stays
  unknown" — the claim, read as absence semantics.
- **Hard skips:** none exist anywhere in apps/fleet/test
  (grep-verified: no it.skip/xit/it.todo/it.fails).
- **it.each dynamic titles:** counted once per table (44 across the
  tree); no weak-assertion finding.

## Proposed follow-ups

One issue per batch, `test(GLM-OK): S22-Fn <short>`, refs #576, no
closing keywords:

- **S22-F1** fleet-reap backoff: assert the 30 minutes (copy :556's
  Date.parse shape into :447,:560,:566) (finding 1)
- **S22-F2** fleet-reap:583 clear test: seed + assert all three state
  maps (finding 2)
- **S22-F3** session:1236: assert the persisted hash key after
  hashPersisted resolves (finding 3)
- **S22-F4** cli.studio-row loops: assert the return value (null) for
  invalid shapes, not just not.toThrow (finding 4)
- **S22-F5** never-throws contract tests: companion asserts —
  console.error spy + no-row/state-unchanged (exceptions:61,:355,
  activity:690,:695) (finding 5)
- **S22-F6** cond-skip lanes: add issue refs to bringup-hooks linuxOnly
  titles + ego-browser-launch-timeout skipIf (finding 6)

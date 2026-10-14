# Overclaiming test titles sweep 41 — apps/fleet test (2026-10-14)

Ref #845. Analysis only, read-only, no code changed. Continues S38
(#741) over the files S38 did not touch. Method: machine pass first (awk over
every it()/test() in scope extracting titles carrying never/always/entirely/
exactly whose bodies hold ≤2 assertion-shaped lines — 403 raw candidates),
then hand-read of ~200 full bodies, with the implementation cross-checked for
every confirmed finding.

**Ruled out (verified accurate, no finding):** the bulk of the candidates.
Notably: the memguard "never the lead's pane shell / never the guard's flock
parent" pair (memguard-select.test.ts:219/:224 — each makes the protected
process the largest and asserts the OTHER pid wins, which is the claim),
credentials' wrapper pins (each "never" is a not.toContain/not.toMatch on the
emitted script, the established source-pin pattern), replacement-restart's
"exactly once/never a third" (bringupCount asserted at :242/:315),
observation/member-alerts' not.toHaveBeenCalled families, install-marker-gate's
"never writes the marker" (marker absence asserted per case), localci
summarize's timeout-vs-failure split, survival-input's "never discard" trio
(each asserts the ref kept with lastCommitAt null), claude-swap threshold
edges (boundary fixture + equality assert), and board.close-action's
"opts.now, never a positional" (the marker timestamp is checked against the
passed clock).

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | studio.activity.test.ts:553 — "whenever state is not unknown" proven for one state only | GLM-OK |
| 2 | studio.session.test.ts:2285 — "the ONLY path" backed by a `>= 1` count | GLM-OK |
| 3 | studio.fresh-session.test.ts:417 — "regardless of replacedAt/replacementDetected": one arm exercised | GLM-OK |
| 4 | board.routes.test.ts:784 — "never trigger outbound checks or a comment": only the 405 is asserted | GLM-OK |
| 5 | studio.account-by-repo.test.ts:117 — "true only when": exclusivity proven by siblings, not this body | GLM-OK |

### S41-F1. studio.activity.test.ts — "whenever" from one sample — GLM-OK

- **File:** `studio.activity.test.ts:553` — it("reason is null whenever state is not unknown").
- **Actually asserted:** one call, `{ kind: "working" }` → `reason` null. The
  implementation (src/studio/activity.ts:616) does make reason null for every
  non-unknown state, but the title's "whenever" claims the whole set —
  waiting-question, waiting-members, working, idle, limit — and the body
  samples exactly one. A regression that leaked reason onto one of the other
  states would pass this test untouched.
- **Proposed fix:** loop the frame-verdict kinds (the same `for (const ... of
  [...])` shape the file already uses elsewhere) and assert `reason` null for
  each non-unknown state.

### S41-F2. studio.session.test.ts — "the ONLY path" pinned with a floor, not a pin — GLM-OK

- **File:** `studio.session.test.ts:2285` (assert at :2291) — the untar-atomic
  test's trailing claim: "Nothing else in this file ever writes to
  ~/.claude/projects directly — this mv is the ONLY path a restore takes into
  the real location."
- **Actually asserted:** `bringupSrc().match(/~\/\.claude\/projects/g)?.length`
  `.toBeGreaterThanOrEqual(1)` — a FLOOR. The comment says ONLY, but the
  assertion passes at one, two, or ten occurrences; a future edit adding a
  second direct write site keeps it green. The floor only proves the mv
  survives somewhere in the file.
- **Proposed fix:** pin the count exactly (`toBe(1)` — or count only
  write-shaped occurrences if reads share the path string), or drop the "ONLY
  path" clause from the comment.

### S41-F3. studio.fresh-session.test.ts — "regardless of" with one arm — GLM-OK

- **File:** `studio.fresh-session.test.ts:417` — it("MINOR 9: a MISSING
  SessionMark (never synced yet) is always allowed, regardless of
  replacedAt/replacementDetected").
- **Actually asserted:** one provision with `replacedAt` set (and no mark). The
  refusal gate it pins (src/studio/provision.ts:3746) arms on
  `replacedAt !== null || session.replacementDetected === true` — an OR of two
  arms, and the body exercises only the first. A missing-mark allowance that
  special-cased one arm would still pass.
- **Proposed fix:** add the second variant (mark absent, `replacementDetected:
  true`, replacedAt null) or loop both arming shapes — the doc comment at
  provision.ts:3749 already says "regardless of replacedAt/replacementDetected".

### S41-F4. board.routes.test.ts — "never trigger outbound checks or a comment" without a mock watching — GLM-OK

- **File:** `board.routes.test.ts:784` — it("GETs are not assignment verbs —
  a read can never move a task") sibling at :811 — it("GET is not allowed — a
  read must never trigger outbound checks or a comment").
- **Actually asserted:** `res.status` 405. No `reach`/`createComment` mock
  asserts it was never called, so a refactor that runs the outbound checks
  BEFORE rejecting the method still passes. The S38-precedented fix shape
  exists in the same file's POST tests (fakeApi with vi.fn counters).
- **Proposed fix:** pass a fakeApi whose verbs are `vi.fn()`s and add
  `expect(...).not.toHaveBeenCalled()` for the outbound reads + comment, or
  drop the second clause from the title.

### S41-F5. studio.account-by-repo.test.ts — "true only when" carries the exclusivity in its siblings — GLM-OK

- **File:** `studio.account-by-repo.test.ts:117` — it("true only when the repo
  is a genuine key in the map").
- **Actually asserted:** the positive case alone (`primaryIsMapped(mapped,
  "demosite-life")` → true). The "only when" direction — that non-keys,
  null repos, and absent maps read false — is proven by the three siblings at
  :123/:129/:132, not by this body. As titled, the test promises exclusivity
  it does not itself check (the S38-F4 board.assign shape: claim carried by
  neighborhood rather than the body).
- **Proposed fix:** retitle "is true for a genuine key in the map" (the
  siblings already own the exclusivity), or fold the three negative cases into
  this body's loop.

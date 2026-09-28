# `rescue-all` times out on busy studios — sequential dispatch, no client-side timeout, no progress (board issue #359)

## Measured incident (2026-09-26, before an image deploy)

`fleet rescue-all`: fleetflare's own 3 studios all rescued fine (member
worktrees included). acme-life: `pilot` clean; `pilot--2`, `scratch`,
`web-studio`, `web-studio--2` all FAILED "the operation timed out" — twice
each (two full runs). One run's own error on `web-studio`:
`rescue-snapshot failed: pushed [none], failed [checkout (push), finalize-902
(push)]`. Context: `pilot--2`'s lead was mid a 33-minute turn running a shell
command; `web-studio` had 7 shells running plus members running for over an
hour. A single `rescue-all` over 8 studios ran >15 minutes with NO progress
output (piped through `| tail`, hiding whatever was printed). Operator
workaround: asked each lead to push manually before the deploy.

This is a follow-up to #251/#266 (the same rescue-all feature) — `rescue.ts`,
`do.ts`'s `rescueNow()`, and `cli/fleet.ts`'s `runRescueAll` were re-read in
full before touching anything.

## What was actually verified, not just suspected

**Suspect #1 (board issue's own top suspicion) — "exec session serialized
behind the lead's own shell (#103 class)":** verified NOT the direct
mechanism. `rescue`'s own exec runs on `EXEC_CLASSES.rescue = { sessionId:
"fleet-rescue", timeoutMs: 300_000 }` (sandbox-api.ts) — a NAMED session,
separate from the shared default session every un-classed exec would share.
The lead's own interactive terminal attaches through a COMPLETELY different
mechanism: `sbAttachPty` (sandbox-api.ts) calls `sb.createSession({ id:
STUDIO_SESSION_ID })` (`STUDIO_SESSION_ID = "studio"`) and `proxyTerminal`,
an SDK-level pty/websocket bridge, never `execWithSessionToken`. These are
two structurally different code paths with different session ids — a
literal session-level lock between them does not exist in this code.

What CAN still be true, and is consistent with the measured symptoms: both
sessions run inside the SAME container process (one container per studio),
so genuine CPU/memory contention from "7 shells running plus members for over
an hour" can slow the container's own ability to service a NEW exec, even on
a differently-named session — a resource-contention story, not a
session-serialization one. This fix does not attempt to address container
resource contention (out of scope, no code in this repo controls it); it
addresses the three fixes that ARE actionable from the CLI/Worker side.

## The fix

### 1. Parallel dispatch (`cli/fleet.ts`'s `runRescueAll`)

`for (const s of targets) { await deps.rescueStudio(s.id); ... }` was fully
sequential — a whole run's wall time was the SUM of every studio's own
duration, not the max, which alone explains ">15 min, no progress" for an
8-studio fleet. Replaced with `Promise.allSettled(targets.map(async (s) =>
{...}))` — every studio's rescue attempt runs concurrently; one studio's own
rejection never cancels another's still-running attempt or aborts the whole
batch's settling (why `allSettled`, never a bare `Promise.all`).

### 2. Per-studio client-side timeout

No client-side timeout existed at all — a hung `rescueStudio` call blocked
the whole loop forever (now: blocked only that ONE concurrent branch, but
still forever without this fix), bounded only by whatever the server's own
exec deadline eventually enforced, invisible to the CLI. `rescueWithTimeout`
races `deps.rescueStudio(id)` against a `RESCUE_ALL_STUDIO_TIMEOUT_MS` (360s)
timer via `Promise.race`. A fired timeout produces a `RescueAllOutcome` with
`timedOut: true` and an honest message ("timed out waiting for a response...
— the server may still be running rescue") that never fabricates a
`rescue.ts` step name it never received (a response that never arrived has
no step to name — that distinction from a genuine `RESCUE_FAILED <wt> <step>`
the server DID answer with is the whole point of the separate `timedOut`
field).

**Timeout duration: 360,000ms (6 minutes).** The server's own rescue exec
class (`EXEC_CLASSES.rescue` in sandbox-api.ts) already allows 300s
(`timeoutMs: 300_000`), and `sbExec`'s own `DEADLINE_SLACK_MS` (`
KILL_GRACE_SECONDS * 1000 + 2000` = 7,000ms there) adds up to ~307s as the
Worker's own absolute worst case before it stops waiting on the container's
own exec. 360s gives ~53s of margin over that 307s worst case for real
HTTP/DO-wake overhead on top — comfortably longer than the server's own
deadline (never shorter, which would report a false TIMEOUT for a rescue
that would have genuinely succeeded a few seconds later), but still a
knowable ceiling so one stuck studio cannot hang the whole run past ~6
minutes. Not imported directly from `sandbox-api.ts`: that module pulls in
`@cloudflare/sandbox`'s own workerd-only `proxyTerminal` at load time (its
own header comment explains why), which the CLI binary does not run under —
the value is copied into `cli/fleet.ts` with a comment pointing back at the
source of truth to re-verify if it ever changes.

`cmdRescueAll`'s real fetch additionally carries `AbortSignal.timeout(
timeoutMs)` — the same convention `destroy-outcome.ts`'s `requestDestroy` and
`inspect-request.ts` already use — so a genuinely stalled connection is
actually aborted (freeing the real underlying socket) rather than left
dangling in the background forever. `runRescueAll`'s own generic
`Promise.race` is a separate, redundant guarantee that the per-studio loop
itself never hangs even if that abort somehow didn't fire; both use the same
budget, so in the ordinary case they fire together.

### 3. Progress lines with elapsed time

Each dispatched studio now logs `rescuing  <id>...` the MOMENT it is
dispatched (synchronously, before its own first `await`) — real per-studio
progress even piped through `| tail`, unlike before (nothing printed until
the whole run finished). Every outcome line (`clean`/`rescued`/`FAILED`/
`TIMEOUT`/`skipped`) now also names how long that studio's own attempt took,
e.g. `clean    websites--pilot: nothing to rescue (2.3s)`.

### 4. Reporting WHICH STEP timed out

`rescue.ts`'s `RESCUE_FAILED <wt> <step>` convention (the `checkout
(push)`/`finalize-902 (push)` shape from the measured incident) already
reaches the CLI unchanged via the existing `RescuePushFailedError` message —
confirmed by re-reading `parseRescueExecResult` (do.ts) end to end; no
change needed there. The NEW distinction this fix adds is honesty about the
other case: when the CLIENT-side timeout (item 2) fires before the server
ever responds at all, there is no step name to report — the timeout message
says exactly that ("no response reached the CLI"), never fabricating a step.

### 5. `--no-verify` on `fleet/rescue/*` pushes, never on a real branch push

Rescue's own pushes never carried `--no-verify` (commits do — see C1's own
long-standing comment: "pushes deliberately do NOT [skip hooks] — issue
#259's own push guard has to see them"). A slow or hanging pre-push hook in
the TARGET repo (lefthook, a hook this fleetflare codebase has no control
over) stalls exactly at the push step — matching the measured failure's own
`"... (push)"` step names precisely.

Read every one of the 8 `git push` call sites in `rescue.ts` (both
`rescuePushCmd` and `rescueSnapshotCmd`) to classify each by its own target
shape:

- `rescueSnapshotCmd`: EVERY push target comes from `snapshot_target()`,
  which — in EVERY mode, unconditionally (a HOLD-round fix from PR #312,
  specifically to keep a live studio's own branch untouched) — returns a
  freshly generated `fleet/rescue/...` ref. Every push here now carries
  `--no-verify` unconditionally; there is no real-branch case to protect
  against.
- `rescuePushCmd`'s worktree-member pushes, branch-walk pushes
  (`checkout/<branch>`), and stash-walk pushes (`checkout/stash-N`) are ALSO
  always generated refs — same treatment, unconditional `--no-verify`.
- `rescuePushCmd`'s OWN `rescue_push()` — used by the MAIN checkout's
  dirty-tree and clean-but-ahead branches — is the ONE call site that can
  receive a REAL branch name as `$target` (`rescue_target()`'s own
  branch-vs-default resolution: the checked-out branch's own name, when it
  is not the repo's resolved default). This gets a runtime check so a real
  branch push still goes through #259's own push guard and any repo's own
  pre-push hook exactly as before. The retry (`ftarget`, the non-fast-forward
  fallback) is always a freshly generated ref by construction, so it gets
  unconditional `--no-verify` too.

  **Round 2 fix (fresh review, same day):** the round-1 check —
  `case "$target" in fleet/rescue/*) nv="--no-verify" ;; esac` — inferred
  safety from the resulting STRING's shape, never from which branch of
  `rescue_target()`'s own if/else actually produced it. Git branch names may
  legally contain slashes, so a real, currently-checked-out branch that
  happens to be named e.g. `fleet/rescue/collision` (nothing to do with this
  tool's own generated refs — a coincidental collision) matched the pattern
  anyway and silently got `--no-verify`, bypassing that repo's own pre-push
  hook for a genuine branch push — exactly the failure mode this whole fix
  exists to prevent. Fixed by threading `rescue_target()`'s own provenance
  through explicitly: it now sets `target` AND `target_generated` (1 =
  freshly generated throwaway ref, 0 = the checked-out branch's own real
  name) as a direct side effect at its own branch point — the one place that
  actually KNOWS which case is running — called as a plain statement (never
  `$(...)`, which would run it in a subshell and lose the side effect) so the
  values land in the caller's own already-`local` variables via bash's
  dynamic function-local scoping (verified live). `rescue_push()` takes
  `generated` as an explicit 4th argument and applies `--no-verify` only when
  it is `1`, never re-deriving the answer from `$target`'s own text.

## TDD

RED first for every fix, real-git bun-test convention
(`test/bun/rescue-push.test.ts`) for the push-hook scoping, and the
established fake-`deps` convention (`test/bun/rescue-all-scope.test.ts`) for
the CLI-side fixes.

- **`--no-verify` scoping**: a shared test (parametrized across both
  `rescuePushCmd`/`rescueSnapshotCmd`, the file's own existing `RESCUE_CMDS`
  pattern) — a dirty tree on the DEFAULT branch, with a failing pre-push
  hook installed via `core.hooksPath`, must still push successfully (bypasses
  the hook). RED under the unfixed code (blocked by the hook,
  `RESCUE_FAILED`), GREEN after. A `rescuePushCmd`-only sentinel — a dirty
  tree on a REAL (non-default) feature branch, same failing hook — must
  still report `RESCUE_FAILED checkout push` (hook still honored). This test
  was ALREADY green before the fix (no code skipped hooks anywhere yet); it
  stays green after, and is the anti-mutant guard: manually mutating the
  scoping to `nv="--no-verify"` unconditionally (no `case` check) made this
  exact sentinel go RED (`RESCUE_PUSHED task/feature 1 files` instead of the
  expected `RESCUE_FAILED`) — confirmed live, then reverted. Proves the
  scoping is load-bearing, not accidentally too broad.
- **Parallelism**: 3 fake studios, one (`websites--b`) with a noticeably
  longer `rescueStudio` delay than the other two combined would sequentially
  need to exceed; asserted total wall-clock time stays well under the sum of
  all three delays (RED against the old sequential loop, GREEN after).
- **Per-studio timeout**: a fake `rescueStudio` that never resolves for one
  studio; asserted the OTHER studio still completes and is reported
  correctly, the stuck one is reported as a distinct `TIMEOUT` (never
  `FAILED`), and the timeout message never fabricates a `rescue.ts` step name
  it never received.
- **Progress lines**: asserted a `"rescuing <id>..."` line is logged
  BEFORE that studio's outcome is known (via a manually-controlled pending
  promise, checked after yielding the microtask queue without resolving it)
  — RED against the old code (nothing logged until resolution), GREEN after.
  A second test asserts the resolved outcome line itself names elapsed time.

## Fresh review round 2 (2026-09-26) — provenance-tracked `--no-verify` scoping

Finding 1 (fixed): the round-1 `--no-verify` scoping decided safety from the
push target STRING's shape (`fleet/rescue/*`), not from which branch of
`rescue_target()`'s own logic produced it — a real, non-default branch
literally named `fleet/rescue/collision` matched the pattern by coincidence
and silently bypassed a failing pre-push hook. New RED test in
`test/bun/rescue-push.test.ts` (`#359` describe block): checks out
`fleet/rescue/collision` as a real branch, installs a failing pre-push hook,
confirms the CURRENT code wrongly pushes through (RESCUE_PUSHED). Fixed by
having `rescue_target()` set `target`/`target_generated` directly (plain
statement call, no subshell) instead of only `printf`-ing the target string;
`rescue_push()` now takes `generated` as an explicit argument. Same test now
GREEN (RESCUE_FAILED); the round-1 sentinel (`task/feature`, non-`fleet/
rescue/`-shaped) stays green throughout, unaffected — proving the fix didn't
just special-case the new fixture.

Finding 2 (added, quick given the existing harness): the original progress-
line test only exercised a single target, unable to distinguish genuine
concurrent dispatch from a lucky single-target ordering. Added a two-target
fixture (one instant, one artificially slower) in
`test/bun/rescue-all-scope.test.ts` asserting BOTH `"rescuing <id>..."` lines
precede ANY outcome line. Mutation-verified: temporarily replacing
`Promise.allSettled(targets.map(...))` with a sequential `for`-await loop
made this new test fail (fast target's outcome logged before the slow
target's own "rescuing" line); reverted, confirmed byte-identical diff,
green again.

One pre-existing structural test (`test/studio.session.test.ts`) asserted the
literal `printf '%s' "fleet/rescue/<studio>-<ts>"` shape emitted by
`rescue_target()`'s generated-ref branch; updated to match the new
`target="..."; target_generated=1` assignment shape — mechanical follow-on,
not a behavior change.

## Fresh review round 3 (2026-09-26) — round 2's own timeout fix didn't work, plus 4 smaller items

Finding 1 (most severe, blocking): round 2's `RESCUE_ALL_STUDIO_TIMEOUT_MS`
(360s, deliberately margined over the server's own ~307s worst case) was
**never actually honored** by `cmdRescueAll`'s real `fetch` call. Bun's own
`fetch` implementation carries a HARDCODED, non-configurable ~300s
connection ceiling that `signal: AbortSignal.timeout(360_000)` does not
extend or override — this is a fact about Bun's runtime, not a flaw in the
round-2 timeout DURATION logic itself (300s < 307s < 360s was, and remains,
the correct math). Confirmed live against a real local HTTP server (its own
idle timeout disabled) delaying its response to 305s: a fetch with `signal:
AbortSignal.timeout(310_000)` and no `timeout` field still died at
~300005ms with `TimeoutError`, discarding the real response that would have
landed 5 seconds later. The identical call with `timeout: false` added
waited the full ~305000ms and returned the real response. Net effect before
this fix: any rescue taking anywhere near its own real server-side budget
was reported as an opaque client-side TIMEOUT, hiding the server's real
`RESCUE_FAILED <wt> <step>` (or genuine success) answer, which would have
arrived comfortably inside the intended 360s budget had Bun's own ceiling
not discarded it first.

Fixed by `rescueFetchInit(headers, timeoutMs)` (cli/fleet.ts, new,
exported): builds the real fetch's own init with `timeout: false` added,
which disables Bun's ceiling outright and makes the caller's own `signal`
the sole timeout authority. `timeout` is genuinely undocumented in Bun's own
shipped TypeScript types (`BunFetchRequestInit`, bun-types has no such
field) despite being real, respected runtime behavior. A plain function
(not an inline object literal at the `fetch()` call site) so the extra,
undeclared property passes `bun run check`'s structural typing without a
cast. `test/bun/rescue-all-fetch-timeout.test.ts` proves, fast and against a
REAL (never mocked) local server: (1) `rescueFetchInit` genuinely sets
`timeout: false` (source-level, RED confirmed against the pre-fix code —
`SyntaxError: export not found`); (2) that init object is genuinely usable
against a real slow server; (3) the caller's own `signal` still genuinely
governs abort timing with `timeout: false` set. What this suite does NOT
and cannot directly re-prove at CI speed: the specific ">300s" boundary
claim itself, which needs a real request that would otherwise run past
Bun's ~300s ceiling — literally 5+ minutes per assertion, and a mutation
RED+GREEN of that would cost 10+ minutes in one container. That claim was
verified live, once, exactly as described above, outside the committed
suite.

Finding 2: the timeout report never named which step was blocked, since a
truly opaque client-side timeout has no response to read a step from.
Considered writing the current step to a file inside the container and
reading it back via a follow-up call, but rejected: it needs a brand-new
server route/DO method AND a second client round-trip on the timeout path,
material new surface area for a benefit that mostly evaporates once Finding
1 is fixed (the client will now actually receive the server's own answer,
which already names the step via the existing, unchanged
`RescuePushFailedError`/`RESCUE_FAILED <wt> <step>` path, well within
budget). Instead, fixed at the root: every one of rescue.ts's 8 `git push`
call sites (both `rescuePushCmd` and `rescueSnapshotCmd`) now runs under
`timeout -k KILL_GRACE_SECONDS RESCUE_PUSH_TIMEOUT_SECONDS` (45s, grace
imported from exec-deadline.ts so it stays in sync with the outer exec's
own). A single stalled push (a slow/hanging remote-side hook) now fails
FAST and NAMED — the exact same `RESCUE_FAILED <id> push` line a rejected
push already produces, since a killed push's exit code is simply non-zero
— instead of consuming the server's entire 300s exec budget and having
`isDeadlineExit` discard every already-printed line, including which
target's push was in flight. `pushTimeoutSeconds` is a new, optional 4th
parameter on both command builders (test seam, same convention as `root`).
RED proved live: a `post-receive` hook on the bare origin (not client-side
`pre-push`, which `--no-verify` already skips for every generated ref this
file pushes) sleeping 3s, raced against a 1s `pushTimeoutSeconds`, waited
out the full ~3s and pushed successfully under the unfixed script;
bounded to ~1s and reported `RESCUE_FAILED checkout push` after.

Finding 3: `runRescueAll`'s dispatch had no concurrency cap — every target's
exec/fetch fired at once, unboundedly. Capped at
`RESCUE_ALL_CONCURRENCY_LIMIT` (5) via `runLimited`, a small manual
worker-pool (no library): `limit` workers each pull the next unclaimed
target off a shared cursor until none remain, preserving the same "one
target's own failure never blocks another's" guarantee `Promise.allSettled`
gave the old unbounded version (a `try`/`catch` inside `runLimited`'s own
runner loop). `RescueAllFlags.concurrency` is a new test seam (mirrors
`timeoutMs`); production always uses the default. RED proved live: 8 fake
targets against a `concurrency: 3` test seam measured peak in-flight calls
at 8 under the unbounded dispatch; capped at ≤3 after.

Finding 4: the progress-line comment claimed "even piped through `| tail`" —
false; `tail` buffers and prints nothing until the piped command reaches
EOF, exactly the "no progress" symptom this whole fix exists to close.
Comment corrected to say the fix helps an operator watching the RAW,
unpiped output.

Finding 5 (pre-existing, unrelated to #359, flagged because this PR already
touches the file): `test/bun/rescue-push.test.ts` fails on macOS
specifically because `/var` (`tmpdir()`'s own parent there) is a symlink to
`/private/var`, so the test's own `dir`/`root`/`checkout` paths (spelled
through the symlink) and git's own internally-resolved worktree paths
(canonical spelling) disagree — `rescue.ts`'s `[ "$w" = "${dir}" ]`
main-checkout skip misses its match and walks the main checkout a second
time as if it were its own member worktree. Fixed with a single
`realpathSync(mkdtempSync(...))` in `beforeEach`, applied once before any
path is derived from `dir`. A no-op on Linux (this sandbox's own platform —
verified green here) and cannot be directly reproduced failing in this
environment, but is provably safe on both platforms: `realpath` of an
already-canonical path returns that same path unchanged.

## Verification

- `bun run check` — all 5 tsconfig projects, clean.
- `bun test test/bun/rescue-push.test.ts test/bun/rescue-all-scope.test.ts`
  — 71 pass, 0 fail (52 + 19), no regressions, full new coverage for all
  5 fixes above.
- `bun run test` (full vitest suite) — 129 files / 4422 tests pass, 0 fail.
  One pre-existing structural test (`test/studio.session.test.ts`) asserted
  the exact literal emitted push command; updated to match the new `$nv`
  insertion point (`git -C "$w" push $nv origin ...`) — a mechanical
  follow-on of the `--no-verify` scoping fix, not a behavior change.
- `bun run apps/fleet/scripts/english-check.ts` — clean.

### Round 3 re-verification (2026-09-26)

- `bun run check` — all 5 tsconfig projects, clean, re-run after every round
  3 change.
- `bun test test/bun/rescue-push.test.ts test/bun/rescue-all-scope.test.ts
  test/bun/rescue-all-fetch-timeout.test.ts` — 79 pass, 0 fail (55 + 21 + 3),
  236 expect() calls.
- `bun run test` (full vitest suite) — 129 files / 4422 tests pass, 0 fail,
  no regressions from any of the 5 round-3 fixes.
- `bun run apps/fleet/scripts/english-check.ts` — clean.
- Every RED confirmed live before its own fix: Finding 1's `rescueFetchInit`
  export (SyntaxError pre-fix), Finding 2's per-push timeout (waited out a
  3s hook pre-fix, bounded to ~1s after), Finding 3's concurrency cap (peak
  8 in flight pre-fix, ≤3 after) — each reverted and re-applied live, not
  merely reasoned about.

## Fresh review round 4 (2026-09-26) — a Mac test-fixture blocker, an
unverified rescueFetchInit wiring path, and two smaller test gaps

Blocker 1: round 3's per-push `timeout -k ...` wrapping (rescue.ts, 8 call
sites) is real, correct production behavior on Linux, but the fixture used to
TEST it — `test/bun/rescue-push.test.ts`'s `sh()` helper — hardcodes the
literal command name `timeout`, a GNU coreutils binary macOS does not ship by
that name (BSD userland; `brew install coreutils` installs it as `gtimeout`
instead). This is not a rescue.ts bug (production always runs Linux); it's the
same class of test-fixture gap `test/bun/git-wrapper.test.ts` already solved
for `withKillDeadline`'s own identical hardcoded `timeout` dependency (issue
#310) — 39/55 tests in this file failed on a Mac dev machine with "timeout:
command not found" once round 3 landed. Fixed by applying that SAME
established convention rather than inventing a new one: `TIMEOUT_BIN` resolves
`gtimeout` when `timeout` itself isn't found; `TIMEOUT_SHIM_DIR` threads a
script literally named `timeout` (exec'ing whichever binary was actually
found) onto every fixture's PATH ahead of the inherited one; a loud,
actionable `brew install coreutils` error fires once, up front, if neither
exists — never a silent skip, never 39+ cryptic subprocess failures. Three
pre-existing tests that override `PATH` entirely with their own git/date shim
now compose with the new `BASE_PATH` instead of the raw inherited `PATH`, so
they stay mac-safe too. Verified without real macOS access (this sandbox is
Linux): a standalone script builds a restricted PATH containing only a binary
named `gtimeout` (no `timeout`), confirms `timeout` genuinely fails with
"command not found" without the shim (reproducing the exact reported failure),
confirms the shim script makes it resolve and genuinely bound a real command,
and confirms an empty PATH (neither binary) is detected correctly for the
loud-failure branch.

Blocker 2: `rescueFetchInit`'s own unit tests
(`test/bun/rescue-all-fetch-timeout.test.ts`) proved the FUNCTION sets
`timeout: false`, but nothing proved `cmdRescueAll`'s real fetch call site
(cli/fleet.ts) actually builds its init BY CALLING that function — an inline
object literal there instead (silently dropping `timeout: false`, e.g. a
future edit that didn't know why it mattered) left every existing test green,
since none of them exercised this real fetch call at all (rescue-all-
scope.test.ts's own tests only ever exercise a FAKE `rescueStudio`).
`cmdRescueAll` is now exported (was module-private) so a test can call it
directly with a monkeypatched `globalThis.fetch` and inspect the actual init
object the `/rescue` POST carries — the same "spy on the real dependency, call
the real production function" seam this codebase already uses for `fileTask`
(cli/ff.ts, test/bun/ff-file-task-retry.test.ts), the least invasive of the
two approaches considered (a real slow-server integration test, matching
round 3's own `rescue-all-fetch-timeout.test.ts` pattern, would have needed a
real HTTP server standing in for the Worker too — more moving parts for the
same proof). Bite-proof: temporarily removed `timeout: false` from
`rescueFetchInit`'s own return object — the new test went RED (`init.timeout`
read `undefined`), confirmed alongside the pre-existing direct-call test also
going RED; restored, reconfirmed GREEN.

Item 3 (test gap): round 3's `timeout -k` wrapping landed on 8 call sites, but
only `rescue_push()`'s own FIRST attempt had test coverage proving the
wrapping is load-bearing — removing it from the branch-walk push (N1's
`checkout:$b` push) or the non-fast-forward retry push (N3's `$ftarget`
fallback) left the whole suite green. Added a branch-walk test parametrized
across both `rescuePushCmd` and `rescueSnapshotCmd` (their branch-walk logic
is identical), and a retry-push test scoped to `rescuePushCmd` only, matching
`#263 N3`'s own precedent: `rescueSnapshotCmd`'s `snapshot_target()` always
returns a fresh generated ref for its checkout-mode dirty-tree push, so its
first attempt can never be rejected non-fast-forward the way `rescuePushCmd`'s
own `rescue_push()` can, and no fixture reaches its own retry call site at
all — confirmed live: a parametrized version of the retry test passed for
`rescueSnapshotCmd` even with ITS OWN retry-site wrapping removed, because the
first attempt (still wrapped) already produced the correct `RESCUE_FAILED`
before ever reaching the retry branch the test meant to isolate. Bite-proof:
temporarily removed the `timeout -k` wrapping from all 3 targeted call sites
(both branch-walk sites, the one retry site) — all 3 new tests went RED
(`RESCUE_PUSHED` instead of `RESCUE_FAILED`, having waited out the hook's full
3s); restored, reconfirmed GREEN.

Item 4 (minor): every existing concurrency test passed an explicit
`concurrency` override, proving nothing about the REAL production default
(`cmdRescueAll`'s own dispatch never sets `flags.concurrency`). Added a
hardcoded-literal assertion (`RESCUE_ALL_CONCURRENCY_LIMIT` `toBe(5)`, never
compared to itself — a self-referential `toBe(RESCUE_ALL_CONCURRENCY_LIMIT)`
would be tautological) plus a behavioral check with no `concurrency` override,
so a future drift in the constant's own value is caught directly, not merely
implied by other tests happening to override it. Bite-proof: temporarily
changed `RESCUE_ALL_CONCURRENCY_LIMIT` to 1000 — both assertions went RED
(`toBe(5)` received 1000; `peak` measured 8, all targets dispatched at once,
since 1000 never actually caps 8 targets); restored to 5 (the value was
already correct in this branch's own round-3 code — this item added the
missing test, not a code fix), reconfirmed GREEN.

### Round 4 re-verification (2026-09-26)

- `bun run check` — all 5 tsconfig projects, clean, re-run after every round
  4 change.
- `bun test test/bun/rescue-push.test.ts test/bun/rescue-all-scope.test.ts
  test/bun/rescue-all-fetch-timeout.test.ts` — 84 pass, 0 fail (58 + 23 + 4),
  252 expect() calls.
- `bun run test` (full vitest suite) — 129 files / 4422 tests pass, 0 fail,
  no regressions from any of the round-4 fixes.
- `bun run apps/fleet/scripts/english-check.ts` — clean.
- Every RED confirmed live before its own fix, then reverted and reconfirmed
  GREEN: blocker 2's `timeout: false` removal, item 3's three `timeout -k`
  removals (both branch-walk sites, the one retry site), item 4's
  `RESCUE_ALL_CONCURRENCY_LIMIT` change to 1000. Blocker 1 (the Mac shim) was
  verified via a standalone simulation script, not a real macOS run — this
  sandbox is Linux; see this section's own paragraph above for exactly what
  that simulation did and did not prove.

## Deliberately out of scope

- Container-level CPU/memory contention (suspect #1's residual, non-session
  theory) — no code in this repo controls that; addressed only to the extent
  that parallel dispatch no longer serializes 8 studios' worth of that
  contention behind each other in sequence.
- A dedicated, separate exec session for `rescue-all` specifically distinct
  from teardown's own `rescuePush` — both already share `EXEC_CLASSES.rescue`
  (`sessionId: "fleet-rescue"`) by design (one budget/session per fleet call
  CLASS, not per call SITE — sandbox-api.ts's own doc comment); splitting
  that further was not asked for by the board issue's actual fix list and
  the session-serialization theory it named was not confirmed as the direct
  cause (see "What was actually verified" above).

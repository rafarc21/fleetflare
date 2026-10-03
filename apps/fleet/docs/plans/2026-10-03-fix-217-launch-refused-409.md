# LaunchRefusedError surfaces as an uncaught 500 through provision/restart (issue #217)

## The bug

A repo mapped (`CLAUDE_ACCOUNT_BY_REPO`) to a Claude account whose secret is
unset, or to an account every slot is fleet-wide limited on (#209/#211), makes
do.ts's `launchAccountOrRefuse`/`refuseUnlessMappedAccountLaunchable` throw
`LaunchRefusedError` from INSIDE the StudioDO — "what provision/restart/
recycle throw for an unlaunchable account" (do.ts's own doc comment on the
class, issue #271).

`routes.ts`'s `provision` and `restart` routes caught only one shape of
failure:

```ts
try {
  return Response.json(burnView(await stub.provision(cfg)));
} catch (err) {
  if (threwInsideDurableObject(err)) throw err;   // bare rethrow
  return durableObjectUnreachable("provision", err);
}
```

`threwInsideDurableObject(err)` is `true` for a `LaunchRefusedError` (Workers
RPC tags any error the DO's own code threw `remote: true`) — so the catch's
own `if` branch fires and **rethrows it with nothing above to catch it**.
Cloudflare renders that as an opaque "Worker threw exception" (1101) page,
which says nothing about which side failed or why — the exact field-reported
symptom. `restart` had the identical shape.

`recycle`'s catch was closer, but not correct either:

```ts
const message = errorMessage(err);
if (message.startsWith(RECYCLE_REFUSED_PREFIX)) {
  return new Response(message, { status: 409 });
}
...
return new Response(`recycle failed: ${message}${runtimeFlags(err)}`, { status: 500 });
```

A `LaunchRefusedError`'s message never starts with `RECYCLE_REFUSED_PREFIX`
("recycle refused: "), so it fell through to the generic 500 path — at least a
real `Response`, never a bare throw, but still the wrong status for a known,
named refusal.

## The RPC-survival finding

Workers RPC preserves an error's **message** across the Worker→DO boundary,
never its **class**. Confirmed by how every existing test in this codebase
that simulates an RPC-crossing throw does it:
`Object.assign(new Error(message), { remote: true })` — a plain `Error`,
never the real subclass, even in `studio.account-gate-do.test.ts`, which
exercises `LaunchRefusedError` directly inside the SAME process (no RPC) and
therefore CAN assert `instanceof` there — a route-level test never can.

This is why `recycle`'s own existing fix (`RECYCLE_REFUSED_PREFIX`,
`recycle-cost.ts`) recognises a refusal by a MESSAGE PREFIX rather than
`instanceof` or `.code`. The fix for `LaunchRefusedError` (and, see below,
`StartRefusedError`) follows the identical convention: prepend a prefix in
the exception's own constructor, check for that prefix (not the class, not
`.code`) once it has crossed the RPC boundary and lost everything but its
message.

## The fix

1. **`LAUNCH_REFUSED_PREFIX`** (`src/studio/accounts.ts`) — `"launch refused: "`,
   prepended inside `LaunchRefusedError`'s constructor (`do.ts`). Lives in
   `accounts.ts`, not `do.ts`, for the same reason `account-limits-store.ts`
   exists as its own module (that file's own header): `do.ts` imports
   `"@cloudflare/sandbox"` as a real value, and `routes.ts`'s own header states
   it carries no import of that package, directly or transitively — it must
   never import anything from `do.ts`. `accounts.ts` is already a zero-import
   leaf module both `do.ts` and `routes.ts` import from.

   (Note: the task brief described `RECYCLE_REFUSED_PREFIX` as already
   re-exported from `do.ts` and imported by `routes.ts` from there, and asked
   for `LAUNCH_REFUSED_PREFIX` to follow that exact path. On inspection,
   `routes.ts` actually imports `RECYCLE_REFUSED_PREFIX` directly from
   `recycle-cost.ts`, never through `do.ts` — `do.ts`'s own `export {
   RECYCLE_REFUSED_PREFIX }` re-export exists for OTHER importers, not
   `routes.ts`. Routing `LAUNCH_REFUSED_PREFIX` through `do.ts` into
   `routes.ts` would have been the one change in this fix that broke the
   "`routes.ts` never imports `do.ts`" invariant stated in `routes.ts`'s own
   header and in `account-limits-store.ts`'s header (issue #141). Followed the
   REAL, working pattern instead: a prefix constant in a sandbox-free leaf
   module, imported independently by both files. `do.ts` still re-exports it
   (`export { LAUNCH_REFUSED_PREFIX }`) for convenience, matching the
   `RECYCLE_REFUSED_PREFIX` precedent for every OTHER caller that already
   imports constants from `do.ts`, e.g. this fix's own route-level test.)

2. **`routes.ts`** — a shared `launchOrStartRefusalResponse(err)` helper
   checks `errorMessage(err)` against `LAUNCH_REFUSED_PREFIX` (and
   `START_REFUSED_PREFIX`, see below), returning
   `Response.json({ error: <reason> }, { status: 409 })` or `null`. Called at
   the top of `provision`'s and `restart`'s catch blocks, before the
   `threwInsideDurableObject` rethrow; called in `recycle`'s catch block
   alongside its existing `RECYCLE_REFUSED_PREFIX` check, before it falls
   through to the generic 500 path.

3. **`cli/repair-failure.ts`** — `repairFailureLine` gained a second special
   case, parallel to its existing Cloudflare-HTML-`<title>` extraction: a body
   that parses as JSON with a string `.error` field prints that string instead
   of the raw `{"error":"..."}` blob. Grepped every other `repairFailureLine`
   call site (`check`, `clear-session-guard`, `destroy`, `fleet ls --fresh`,
   the recycle/destroy outcome renderers) — none of them currently return a
   JSON error body, so this is purely additive for them; only provision/
   restart/recycle's new 409 (and recycle's existing 409, which stays plain
   text — see below) exercise it today.

## The `StartRefusedError` investigation

`StartRefusedError` (do.ts, issue #123's start gate) is thrown by the
`startAndWaitForPorts`/`start` SDK-override methods when `refuseStart()`
refuses — either a stopped/destroying row, or (via `accountRefusal()`) a
repo whose recorded account has since become unlaunchable.

**Does it leak uncaught the same way `LaunchRefusedError` does?** Traced each
of the three verbs' own first container-start call:

- **`provision()`** → `provisionUngated` → `if (!this.ctx.container?.running)
  await sbAwaitReady(this)` (do.ts ~6436). This call sits OUTSIDE
  `provisionWithStorage`'s/`runProvision`'s own try/catch (that only wraps the
  LATER `deps.sbExec(BRINGUP_CMD, ...)` phase) — nothing between it and
  `provision()`'s own `allowingStart` wrapper (a bare try/**finally**, no
  catch) intercepts a throw here. **Confirmed leaking, not just
  theoretically**: `studio.destroy-race.test.ts`'s own T6 suite
  ("the first start is refused outright") already asserts
  `h.doObj.provision(cfg())` rejects directly with this error
  (`.rejects.toThrow(/stopped/)`) — i.e. existing, accepted test coverage
  already demonstrates `StartRefusedError` reaching `provision()` uncaught,
  the identical shape #217 found for `LaunchRefusedError`.
- **`restartStudio()`** → `restartUngated`'s own `await sbAwaitReady(this)`
  (do.ts ~6680) has the identical, unwrapped shape — `restartStudio()` is
  just `this.allowingStart((ctx) => this.restartUngated(via, ctx))`, no catch.
  Same leak.
- **`recycle()`** → the pre-provision closure's own `await sbAwaitReady(this)`
  (do.ts ~6983) is different: it runs INSIDE `recycleWithSync`'s own
  try/catch (do.ts ~1498-1544). A throw there is caught, and
  `recycleWithSync` re-throws a NEW `Error` whose message is
  `` `recycle failed before reprovisioning could start: ${message}` `` — a
  message that does **not** carry `START_REFUSED_PREFIX` (it is a substring
  of the new message, not a prefix of it) and is exactly the shape
  `studio.routes.test.ts`'s own pre-existing "an error the DO's own code
  threw (remote) keeps the 500" test already covers. So for `recycle`
  specifically, `StartRefusedError` is already caught upstream and always
  produces a real `Response` (500, not a crash) — no new `routes.ts` case
  needed there.

**Conclusion: fixed for `provision`/`restart` (the two verbs where it
genuinely leaks uncaught, identically to `LaunchRefusedError`), left alone for
`recycle`** (already absorbed into an existing, tested, non-crashing 500
path — a status-code nicety, not the crash bug #217 is about, and out of
scope per the task's own "don't fix a bug that doesn't exist" instruction).

Same fix shape: `START_REFUSED_PREFIX` (`"start refused: "`) added to
`src/studio/rpc-failure.ts` — not `accounts.ts` (wrong domain: this is
issue #123's container-start gate, not account resolution) and not `do.ts`
(same `"@cloudflare/sandbox"` reason as above) — and prepended inside
`StartRefusedError`'s constructor. `rpc-failure.ts` is already imported by
`routes.ts` for `threwInsideDurableObject`/`errorMessage`/
`durableObjectUnreachable`, so this just grows that one import line; `do.ts`
gains one new import (zero architectural cost — it already imports far more)
and re-exports it the same way as `LAUNCH_REFUSED_PREFIX`.

`StartRefusedError.code` (`START_REFUSED_CODE`) is NOT used for this check,
deliberately — per the RPC-survival finding, a custom property does not
reliably survive the boundary either; only `.message` does.

## Compatibility check

Every existing test that asserts on `LaunchRefusedError`/`StartRefusedError`
text does so via `instanceof` (same-process DO tests, unaffected — the class
and its `.code` are untouched) or `toThrow(substring)`/`toMatchObject({code})`
(substring/property checks, which a PREPENDED prefix cannot break). Verified
by running the full affected test set after the fix — see below.

## Test plan

- `test/studio.routes.test.ts`: new describe block,
  "LaunchRefusedError/StartRefusedError surface as 409, not an uncaught 500
  (#217)" — provision/restart/recycle, each fed an RPC-crossing
  `Object.assign(new Error(LAUNCH_REFUSED_PREFIX + "...earliest reset..."),
  { remote: true })` (the exact RPC-crossing simulation convention this file's
  own "repair verbs name the failing side (#96)" suite already uses), plus
  provision/restart fed a `START_REFUSED_PREFIX` refusal. RED (pre-fix):
  verified by stashing the implementation changes and re-running — all 5 new
  cases failed (3 threw/500'd, matching the bug). GREEN (post-fix): all 5
  pass, 409 + `{ error: "<reason>" }` containing "earliest reset"/"is stopped".
- `test/cli.repair-failure.test.ts`: 3 new cases for the JSON-aware branch
  (prints the reason; falls through for a JSON body with no string `.error`;
  unaffected for non-JSON text). RED/GREEN verified the same way.

## Verification

- `npx vitest run test/studio.routes.test.ts test/studio.destroy-race.test.ts
  test/studio.account-gate-do.test.ts test/studio.account-by-repo.test.ts
  test/studio.start-gate.test.ts test/studio.recycle-guard.test.ts
  test/studio.recycle-mapped-rescue-do.test.ts test/studio.session.test.ts
  test/cli.repair-failure.test.ts` — 571 passed, 0 failed.
- `bun run test-lies-check`, `bun run english-check` — both clean.
- `flock /tmp/fleet-gate.lock bun run test` (full suite) and
  `flock /tmp/fleet-gate.lock bun run check` (build + typecheck), run one at a
  time, never in parallel — see the PR/report for their exact output.

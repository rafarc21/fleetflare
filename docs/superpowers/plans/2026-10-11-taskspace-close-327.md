# Task-space close: record owns the close via injected closer (#327)

Source: sweep-2 F12 (`docs/maintainability/2026-10-10-deep-modules-sweep-2.md`
:247-254); refs #259, never closes. GLM-OK: behavior-preserving,
characterization tests at the interface first. Container code
(`apps/fleet/container/ego-browser/`) — the PR merges at an image window.

## Problem

`TaskSpaceRecord.finish(keep)` is a pure receipt extracted for testability;
the risky close ordering (per-label target close → label removal → context
close → registry remove) stays caller-side in daemon.ts:339-352, repeated
differently in page.close (:499-505). `ego-browser-registry.test.ts` cannot
see any of it.

## Solution

- `TaskCloser<TTarget, TContext>` port in registry.ts (`{ closeTarget(t),
  closeContext(c) }`) — injected so registry stays Playwright-free; daemon
  plugs real Page/BrowserContext, tests plug fakes.
- `TaskSpaceRecord.finish(keep, closer)` async: same receipt computation,
  then per closed label closeTarget (errors swallowed — today's
  `.catch(() => {})`) → removeLabel → context close when spaceClosed
  (swallowed).
- `TaskSpaceRecord.closeLabel(label, closer)`: propagates close errors and
  does NOT remove the label on throw (today's page.close order); label
  absent → no-op.
- `Registry.finish(spaceId, keep, closer)`: throws the same
  `ego-browser: no task space <id> (finished, or never created)` error as
  daemon's resolveSpace, delegates to the record, removes the space when
  spaceClosed. Daemon handlers: space.finish → destructure `{retained,
  closed}` (wire shape preserved exactly); page.close → resolveSpace +
  closeLabel one-liner.
- The two error semantics are deliberate and documented: finish is
  best-effort teardown (already-dying pages must not abort the sweep),
  closeLabel is a user-facing close whose failure must be heard.
- `numericId(nameOrId)` private helper de-dups the identical parse at
  lockKey/resolveLocked.
- `resolveTarget(label, (c) => c.newPage())` ×2 stays: the create-lambda
  is daemon's Playwright plug; the shared interface is resolveTarget.

## Tests first (replace, don't layer)

The 3 pure-receipt tests (:227-259) retarget through the new interface:
same receipt asserts + fake-closer close calls. New blocks: keep=none/some/
all (closes, removals, context close, spaceClosed); lazy labels skip
closeTarget; closer rejects → swallowed by finish; closeLabel (present/
absent/rejects-propagates-and-keeps-label); Registry.finish (space removed
only when spaceClosed; unknown id throws resolveSpace's message). RED
first, then GREEN.

## Verification

`bun test test/bun/ego-browser-registry.test.ts` (RED→GREEN), then
`test/bun/ego-browser-rpc.test.ts` + the daemon-side live ego-browser bun
tests that exercise space.finish end-to-end (idle-shutdown suite greps the
`{"retained":[],"closed":["p1"]}` wire shape); flock
`/tmp/fleet-gate.lock bun run check` (`-p container` included) once;
`bun run english-check`.

## Files touched

registry.ts, daemon.ts, test/bun/ego-browser-registry.test.ts, this doc.

## Out of scope

client.ts wire shapes, persistence/idle-shutdown logic, profiles, space
creation (taskSpace), page.* verbs beyond close.

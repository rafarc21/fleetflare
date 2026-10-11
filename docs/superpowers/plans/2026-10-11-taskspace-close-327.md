# Task-space close: record owns the close via injected closer (#327)

Source: sweep-2 F12 (docs/maintainability/2026-10-10-deep-modules-sweep-2.md :247-254);
refs #259, never closes. GLM-OK: behavior-preserving, characterization
tests at the interface first. Container code — the PR merges at an image window.

## Problem
`finish(keep)` is a pure receipt; the risky close ordering (target close →
label removal → context close → registry remove) stays caller-side — daemon.ts's
space.finish and, differently, page.close — out of the registry test's reach.

## Solution
- `TaskCloser` port injected into registry.ts: daemon plugs real
  page.close()/context.close(), tests plug fakes.
- `TaskSpaceRecord.finish(keep, closer)`: same receipt, then closeTarget per
  closed label (errors swallowed) → removeLabel → context close when
  spaceClosed (swallowed).
- `closeLabel(label, closer)`: close errors propagate, the label survives a
  throw (page.close's semantics).
- `Registry.finish(spaceId, keep, closer)`: resolveSpace's "no task space"
  error, record finish, registry removal when spaceClosed — daemon handlers
  one-liners, wire shape `{retained, closed}` byte-preserved.
- `numericId()` de-dups the numeric parse at lockKey/resolveLocked.

## Tests first (replace, don't layer)
The 3 pure-receipt tests retarget through the new interface. New blocks:
keep none/some/all; lazy labels skip closeTarget; rejecting closer
swallowed by finish, propagating out of closeLabel; Registry.finish
removes only when spaceClosed, unknown id throws. RED first, then GREEN.

## Verification
`bun test test/bun/ego-browser-registry.test.ts` RED→GREEN, then the rpc
suite + daemon-side live suites (idle-shutdown greps the exact
`{"retained":[],"closed":["p1"]}` wire shape); flock /tmp/fleet-gate.lock
`bun run check`; english-check.

## Files touched
registry.ts, daemon.ts, test/bun/ego-browser-registry.test.ts, this doc.
Out of scope: client.ts wire shapes, persistence/idle-shutdown, profiles,
space creation (taskSpace), page.* verbs beyond close.

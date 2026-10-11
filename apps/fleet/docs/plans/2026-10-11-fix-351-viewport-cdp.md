# Board #351 — viewport + CDP for the studio ego-browser shim

Status: planned 2026-10-11. Additive Tier-2 slice; no Tier-1 surface changes.

## Problem

Cloud studios cannot take mobile (390px) screenshots. The daemon's Page is a
real Playwright Page — `setViewportSize` exists but no RPC reaches it, and
ego lite's documented `page.cdp(method, params)` is absent (skill doc lists
it under Tier 2 "not built yet"). Evidence in
https://github.com/rafarc21/fleetflare/issues/351.

## Design

1. `page.setViewportSize({width,height})` — direct RPC passthrough to the
   underlying Playwright Page. Cheapest correct answer for mobile shots.
2. `page.cdp(method, params?)` — matches ego lite's documented signature.
   Daemon holds ONE persistent CDPSession per (space, label) in a WeakMap
   keyed by the PwPage object, created via `page.context().newCDPSession(page)`
   on first call. Persistent, NOT per-call: chained CDP state (e.g.
   Emulation.setDeviceMetricsOverride followed by clearDeviceMetricsOverride)
   must land on the same session, and a per-call session would also let
   concurrent calls race session creation for one page.

```
user script          api.ts Page             daemon methods table
p.setViewportSize -> "page.setViewportSize" -> pwPage.setViewportSize
p.cdp(m, params)  -> "page.cdp"            -> cdpSession(pwPage).send(m, params)
```

## Out of scope

CDP event subscription (`session.on`), `task.cdp`, `page.mouse/keyboard`,
dialog APIs. Sessions are never explicitly detached — page close destroys
the target; WeakMap entry dies with the PwPage key.

## Test plan (TDD, bun:test lane under apps/fleet/test/bun/)

- RED first: `ego-browser-viewport-cdp.test.ts` — live browser via
  runEgoBrowser: setViewportSize 390x844 then `p.info()` must report
  viewport {width:390,height:844}; cdp("Runtime.evaluate",
  {expression:"2+3"}) must return {result:{value:5}}; cdp
  Emulation.setDeviceMetricsOverride 390x844 then clearDeviceMetricsOverride
  must both resolve (proves persistent session chaining).
- Fake-call unit tests in same file: api.ts Page.cdp/setViewportSize marshal
  correct RPC method+params (never a function crossing the wire for params).
- Existing suites: ego-browser-smoke, persistence, rpc stay green.

## Files touched

- container/ego-browser/daemon.ts (2 new methods)
- container/ego-browser/api.ts (2 new Page methods)
- skills/ego-browser/SKILL.md (move cdp+setViewportSize from Tier 2 to Tier 1)
- test/bun/ego-browser-viewport-cdp.test.ts (new)
- this plan doc

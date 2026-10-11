---
# Deepen: ego-browser RPC — framing, id correlation, timeout, fail-on-close, dispatch behind rpc.ts (board issue #319)

Issue: https://github.com/rafarc21/fleetflare/issues/319. Tier **GLM-OK**:
behavior-preserving, characterization tests at the interface first, one
module per PR. Refs #259, never closes. Finding F4 in
`docs/maintainability/2026-10-10-deep-modules-sweep-2.md` (lines 167-175).

## Problem

Protocol knowledge split over 3 files:

- `container/ego-browser/rpc.ts`: framing only (`encodeMessage`,
  `MessageFramer`) — shallow (depth 5.9).
- `container/ego-browser/client.ts:147-234`: id correlation (`nextId`,
  `pending` map), per-call timeout, fail-all-pending-on-close, buffer
  decode, cache invalidation.
- `container/ego-browser/daemon.ts:518-562`: dispatch table wiring,
  same buffer-decode line, per-socket framer WeakMap, error wrap.
- Identical buffer-decode line duplicated: `client.ts:185` /
  `daemon.ts:549`.

`test/bun/ego-browser-rpc.test.ts:43-64` re-implements id matching
inside the test (`pendingById` map) — the real correlation code in
client.ts never runs under test. Timeout, close-fails-pending, and
unknown-method paths untested except via live Chromium smoke.

## Interface (after)

`rpc.ts` gains two functions; framing helpers stay exported (both ends
and existing tests use them):

```
createRpcClient(socket): { call(method, params?, timeoutMs?) -> Promise<unknown>, onClosed(cb) }
serveRpc(socket, handlers, opts?): { onClosed(cb) }
```

- `createRpcClient`: owns per-call id assignment, correlation map,
  per-call timer (reject `ego-browser: RPC call "<method>" timed out
  after <ms>ms`), fail-all-pending on socket close/error (`ego-browser:
  daemon connection closed`), response decode via MessageFramer.
  `onClosed(cb)` fires on close/error — client.ts uses it to drop its
  connection cache entry.
- `serveRpc`: owns request decode, per-socket framer, dispatch to
  `handlers[method]`, unknown-method -> `{id, error:{message}}` with
  `ego-browser: unknown RPC method "<method>"`, handler-throw ->
  error response (message preserved), `opts.onDispatch` hook (daemon
  passes its inFlight/idle re-arm) so rpc.ts stays daemon-agnostic.
- Both take a `socket`-shaped object: needs `write(data: string)` and
  event-handler registration. Bun socket handlers are set at connect/
  listen time, so client.ts/daemon.ts construct the object and hand
  rpc.ts the callback slots it must fill — concrete shape decided in
  implementation: `{ write, onMessage, onClose, onError }` fed to a
  per-socket `RpcEndpoint`-like internal, OR Bun.connect/listen
  handlers call into rpc.ts. Keep the seam small: rpc.ts must not
  import Bun.
- Buffer decode (Buffer vs Uint8Array -> utf8) lives once in rpc.ts.
- Defaults: 60000ms call timeout (client.ts's current value).

## Test seam — in-memory duplex pair (CD: replace, don't layer)

`test/bun/ego-browser-rpc.test.ts` grows `makeSocketPair()`: two
in-memory ends, writes on one deliver framed lines to the other's
message handler, close on either fails all pending both sides. No real
Unix socket, no Chromium, deterministic, fake-timer friendly where
practical (per-call timeout tests may use short real ms).

## Steps (TDD)

1. **Characterization RED:** extend `test/bun/ego-browser-rpc.test.ts`
   driving `createRpcClient` + `serveRpc` through `makeSocketPair()`:
   (a) out-of-order responses resolve to own requests (delete the
   `pendingById` re-implementation — real correlation runs now),
   (b) per-call timeout rejects with exact message + late response
   ignored, (c) socket close rejects all pending, (d) unknown method
   rejects with exact message, (e) handler throw rejects with handler
   message, (f) split-chunk framing over pair. RED: new exports absent.
   Commit + push branch.
2. **GREEN in rpc.ts:** implement `createRpcClient` + `serveRpc` +
   shared buffer decode. Tests green. Commit + push.
3. **Rewire (behavior-preserving):** `client.ts` drops
   PendingCall/Connection internals, keeps `call()`/`ensureDaemonAlive()`
   signatures identical (api.ts untouched), uses `createRpcClient` +
   `onClosed` for cache drop. `daemon.ts` drops framers WeakMap +
   dispatch loop + error wrap, uses `serveRpc` with `onDispatch` for
   inFlight/idle. Keep: `daemon connection closed` message,
   `unknown RPC method` message, 60000ms default, null-result encoding,
   framer split behavior. Commit + push.
4. **Gates, one heavy at a time:** `bun test test/bun/ego-browser-rpc.test.ts`,
   then `bun test test/bun/ego-browser-*.test.ts` (smoke runs real
   Chromium — allowed, single), then `tsc --noEmit -p container`, then
   `bun run check` under `flock /tmp/fleet-gate.lock`, then
   `bun run english-check`. Each green before next.
5. **Review + PR** per delivery-standards loop (max 2 rounds), envelope
   on issue, done record `/workspace/.fleet/done/319.json`.

## Boundaries

- Files: `container/ego-browser/rpc.ts`, `client.ts`, `daemon.ts`,
  `test/bun/ego-browser-rpc.test.ts`, this plan doc. Nothing else — no
  `api.ts`, no `wire.ts`, no `registry.ts`, no F5 method-map work (later
  PR, needs F4's pair first per sweep doc).
- Behavior byte-identical: error messages, timeout default, framing,
  null-result encoding, close semantics. The only intended observable
  diff: rpc.ts's export surface grows; test file stops re-implementing
  correlation.
- Container image glob `apps/fleet/container/**` = one-way door per
  `scripts/merge-danger.ts` — PR marked one-way.
- Verifying runs `bun test test/bun/ego-browser-*.test.ts` several
  times + `bun run check` once — heavy gates queued serially, never
  parallel (house rule).

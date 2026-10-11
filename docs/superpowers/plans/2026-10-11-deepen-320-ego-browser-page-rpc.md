# Deepen ego-browser page surface: one typed PageRpc map (issue #320)

Issue: https://github.com/rafarc21/fleetflare/issues/320. Sweep-2 finding S2-F5.
Tier GLM-OK, behavior-preserving. Refs #259, never closes.

## Problem

container/ego-browser writes every RPC name + shape twice: api.ts Page forwards (22 one-line
`this.call("page.X", {spaceId, label, ...})`) and daemon.ts's methods table — same 25 names, hand-written
inline param types, `as never` casts, 21x `resolvePage(...)`; wire.ts holds only 3 shared types. A rename
or param-add on one side silently breaks the other (CD: name + shape kept in sync by hand).

## Change

1. wire.ts declares the one map: `RpcMethods = { "page.goto": {params: {url; opts?}; result: null}, ... }` —
   all 25 method names, typed params + result each; `PageEnvelope = {spaceId: number; label: string}`; key
   helper types. Type-only file stays type-only.
2. api.ts Page keeps every public method + signature (browser scripts depend on them). Bodies become
   `return this.fwd("page.goto", {url, opts})` where `fwd` merges `{spaceId, label}` and types params from
   the map — one forwarder, cast-free at each call site.
3. daemon.ts methods table typed from the same map (`RpcMethods[K]["params"]`); `resolvePage` applied once in
   a shared wrapper that strips the envelope; handler bodies unchanged. taskSpace / listTaskSpaces / space.*
   keys also in the map (result typing for the three space methods), their handlers keep current bodies.

## Coordination

F4 (#319, studio-54, rpc.ts client/daemon ends) is plan-only so far. This PR touches wire.ts/api.ts/daemon
methods table; F4 touches rpc.ts/client.ts/daemon dispatch. Hunk-level disjoint; merge order either way, rebase
trivial; if F4 lands first, this branch rebases.

## Tests (characterization first)

New test/bun/ego-browser-page-rpc.test.ts: per page method (22), a Page call through a recording fake RpcCall
pins the exact method name + params the daemon's dispatcher must see (envelope merged, FnOrString/UrlMatcher
marshaled); a dispatcher-side harness runs the daemon's exported method table over a fake PwPage, asserting
each handler's call lands with the same params the forwarder produced. Marshaling round-trip (api.ts
marshalUrlMatcher ↔ daemon toUrlMatcher) pinned for all three matcher kinds. Existing unimplemented/smoke/
persistence tests stay green.

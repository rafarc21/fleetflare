# ego-browser shim over Playwright (board issue #30)

Status: Tier 1 implementation. Tier 2 explicitly out of scope for this pass
(see "Scope" below). Does NOT touch `container/Dockerfile.studio`,
`skills/ego-browser/`, or `fleet/blueprint/studios/web-studio/studio.md` —
those are a separate follow-up dispatch by design (avoids two agents editing
the same files at once).

## Problem

Every studio brief says "use the `ego-browser` skill, NOT agent-browser" but
no container actually has ego lite (macOS/Windows-only installer, no Linux
path). A real Chrome-for-Testing already sits at `/usr/local/bin/chromium`
(installed by `container/Dockerfile.studio`'s `bun x playwright install
chromium --with-deps` step). This shim makes `ego-browser nodejs` a real,
runnable command backed by `playwright-core` driving that browser, exposing
ego lite's own Tier-1 API contract (comment on issue #30, extracted from the
real skill v2.0.0).

## The hard constraint: process-per-invocation, state must outlive the process

> "Every invocation starts a new Node.js process. Task spaces, tabs, and Page
> labels persist; JavaScript variables do not."

A shim that launches a browser per CLI invocation fails this immediately.
The only correct shape inside a container: a **long-lived daemon** holds the
real Playwright `Browser`/`BrowserContext`/`Page` objects plus a registry
mapping `spaceId` + durable label -> live target, and every `ego-browser
nodejs` invocation is a **thin, short-lived client** that talks to the
daemon over IPC and exits.

## Architecture

```
apps/fleet/container/ego-browser/
  rpc.ts       — newline-delimited JSON-RPC framing, shared by client + daemon
  paths.ts     — resolves EGO_BROWSER_HOME (default /root/.ego-browser) ->
                 {pidfile, socket, log} paths; single source for both sides
  registry.ts  — PURE task-space/label bookkeeping (generic over the target
                 type — no Playwright import), independent of I/O, unit-
                 testable directly
  daemon.ts    — daemon entrypoint: launches playwright-core chromium once
                 (lazily, on first call that needs it), owns one
                 BrowserContext per task space, wraps registry.ts with real
                 Playwright Page objects, serves the socket, dispatches RPC
                 methods (taskSpace, listTaskSpaces, space.pages,
                 space.newPage, space.finish, page.*)
  client.ts    — ensureDaemonAlive() (pidfile + `process.kill(pid,0)` +
                 probe-connect; spawns a fresh daemon via
                 `child_process.spawn(..., {detached:true, stdio:'ignore'})
                 .unref()` and poll-connects on any failure) + call(method,
                 params) over the unix socket
  api.ts       — builds the global surface (taskSpace, listTaskSpaces,
                 TaskSpace, Page) as thin RPC-calling proxies, PLUS the
                 loud-fail stubs (profiles/claimTaskSpace/takeOverTaskSpace/
                 task.userPage/handOff/waitForControl/adopt/release)
  cli.ts       — the `ego-browser` entrypoint: argv parsing (`nodejs -e
                 '<code>'` vs `nodejs <<EOF`), writes the user script to a
                 unique temp .mjs file, installs globals, `await
                 import(pathToFileURL(file).href)`, unlinks in `finally`
```

### Transport: Unix domain socket, newline-delimited JSON-RPC

Request: `{"id": number, "method": string, "params": unknown}\n`
Response: `{"id": number, "result": unknown}\n` or `{"id": number, "error": {"message": string}}\n`

Uses Bun's native `Bun.listen({unix, socket:{...}})` / `Bun.connect({unix,
socket:{...}})` (this project already leans on bun-native APIs — see
`container/fleet-cli.ts`). `rpc.ts` frames both directions identically so
client and daemon share one implementation. Concurrent in-flight requests on
one socket are distinguished by `id` (monotonic counter, `Map<id, {resolve,
reject}>` on the client); the daemon processes requests and may respond out
of order (each response still carries its request's `id`).

### Daemon lifecycle (`client.ts`)

1. Read pidfile. If present, check `process.kill(pid, 0)` succeeds (process
   alive) AND a real socket connect succeeds. Any failure in that chain =>
   clean up the stale pidfile/socket file and spawn fresh.
2. Spawn: `spawn(process.execPath, [daemonPath], {detached: true, stdio:
   'ignore'}).unref()` — `process.execPath` under `bun` is the `bun`
   binary itself, so the daemon runs under the same runtime with no PATH
   assumptions.
3. Poll-connect (short interval, hard timeout) until the socket accepts a
   connection; throws a named, loud error if the daemon never comes up
   rather than hanging or silently no-op'ing.
4. The socket connection is opened once, lazily, and cached for the rest of
   the CLI process's life; every `call()` from that process reuses it and
   is matched back to its own response by `id` (a monotonic counter plus a
   `Map<id, {resolve, reject}>`), never by arrival order — this is what
   lets a script safely fire several calls concurrently (e.g.
   `Promise.all([page1.url(), page2.title()])`) and is exactly what
   `rpc.test.ts`'s "concurrent in-flight requests" case pins.

State lives under `EGO_BROWSER_HOME` (default `/root/.ego-browser`):
`daemon.pid`, `daemon.sock`, `daemon.log`. The env var is overridable
specifically so tests can run fully isolated daemons per test file/process
group without colliding with each other or a real studio's daemon.

### Registry (`registry.ts`) — pure, no Playwright

`Registry<TTarget, TContext>` — generic so it is testable with plain fake
objects, independent of real Playwright types:
- `resolve(nameOrId)`: numeric id (or numeric string) not seen before =>
  create a NEW space using that exact id (this is what makes the
  persistence proof possible — process 2's `taskSpace(<same id>)` must
  resolve to the SAME space, not a fresh auto-id); numeric id already
  present => reuse; non-numeric string => name-based lookup/create with an
  internally auto-incremented id.
- Each space starts with one lazy label, `"p1"` (per contract: "a new space
  starts with managed Page p1"), `target: undefined` until materialized.
- `newPage()`-style auto-labels: `"p2"`, `"p3"`, ... via a per-space counter
  (never reuses a number even if earlier ones were closed).
- `finish({keep})`: pure bookkeeping — `"all"` retains every label; an array
  retains only those labels (rest listed as `closed`); an empty array closes
  everything, and if nothing remains protected, the space itself is
  reported goneAfterFinish so the daemon can tear down the `BrowserContext`
  too. Returns `{retained, closed}` (the "receipt").

`daemon.ts` is the only place that touches real Playwright objects; it
plugs `Page` as `TTarget` and `BrowserContext` as `TContext` into the
generic registry and does the actual `context.newPage()` /
`page.close()` / `context.close()` work alongside the pure bookkeeping.

### Lazy vs eager materialization

- `task.page(label)` (client-side, `api.ts`): builds a `Page` proxy object
  with no RPC call at all — just `{spaceId, label}` captured in closure.
- Any real action on that `Page` (`goto`, `click`, `url`, ...) is an RPC
  call carrying `{spaceId, label, ...}`; the daemon's shared
  `resolvePage(spaceId, label)` helper creates the real `context.newPage()`
  the first time that label is touched, otherwise reuses the tracked one.
- `task.pages()` / `task.newPage()` are RPC calls up front (inherently
  eager, per the brief) — `pages()` materializes every currently-lazy label
  in the space before returning; `newPage()` creates a brand new label AND
  a real page immediately.

### `evaluate` / `waitForFunction`: function marshaling

JSON-RPC only carries JSON. A function argument is converted client-side via
`fn.toString()` and sent as `{code, isFunction: true}`; a plain string
expression is sent as `{code, isFunction: false}`. Daemon-side: if
`isFunction`, reconstruct via `new Function("return (" + code + ")")()` and
call `pwPage.evaluate(fn, arg)`; otherwise pass the raw expression string
straight to `pwPage.evaluate(code)` (Playwright's own string-form). This is
the one deliberately non-obvious wire hop in the whole shim; it is commented
inline at both the client marshal site and the daemon reconstruct site.

`waitForURL`'s `urlMatcher` gets the same functional treatment (function ->
source string) plus a small `RegExp -> {source, flags}` case, since the
contract explicitly allows all three (string glob / RegExp / predicate).

### `page.snapshot()` — reused, not reinvented

playwright-core 1.63.0 (confirmed present in this container's bun cache)
ships a PUBLIC `page.ariaSnapshot({ mode: "ai", ... })` returning the same
ref-annotated (`[ref=e2]`) semantic-snapshot shape `@playwright/mcp`'s own
snapshot tool produces (same underlying accessibility-tree serializer).
`page.snapshot()` is implemented as a thin wrapper around it rather than
reimplementing MCP's snapshot logic:
- `scope: "subtree"` (with `root`): `page.locator("aria-ref=" + root).ariaSnapshot({mode:"ai"})`.
- `scope: "full_page"`: `page.locator("body").ariaSnapshot({mode:"ai"})`.
- `scope: "only_within_viewport"` (default, no `root`): `page.ariaSnapshot({mode:"ai"})`.
- `includeActionMarks` maps to `ariaSnapshot`'s own `boxes: true` (closest
  native lever — bounding boxes are what action highlighting would need).
- `includeStableLocator` is accepted and echoed back in the result envelope
  but not separately implemented — `ariaSnapshot`'s own `[ref=...]` IS the
  stable locator ego lite's contract describes reusing later.

Known, documented limitation: `ariaSnapshot` has no native viewport-vs-
full-page distinction (it walks the accessibility tree, not the rendered
viewport) — both `full_page` and `only_within_viewport` currently return the
same whole-document tree via slightly different code paths. `scope` is
never silently dropped (it is read, branched on, and echoed in the
response), but true viewport-clipping is a possible future refinement, not
attempted here to avoid reimplementing MCP's own clipping heuristics.

## Tier 1 scope (this PR)

Entry points: `taskSpace`, `listTaskSpaces`.
TaskSpace: `spaceId`, `name`, `page(label)`, `pages()`, `newPage()`,
`finish({keep})`.
Page: `label`, `goto`, `reload`, `url`, `title`, `info`, `screenshot`,
`evaluate`, `click`, `dblclick`, `hover`, `fill`, `press`, `focus`,
`selectOption`, `setInputFiles`, `waitForSelector`, `waitForLoadState`,
`waitForURL`, `waitForFunction`, `waitForTimeout`, `close`, `snapshot`.

Loud-fail stubs (throw synchronously, name themselves, never a silent
no-op): `profiles()`, `claimTaskSpace()`, `takeOverTaskSpace()`,
`task.userPage()`, `task.handOff()`, `task.waitForControl()`,
`task.adopt()`, `task.release()`.

## Explicitly out of scope this pass

- Tier 2 (`page.mouse`, `page.keyboard`, `page.cdp`, `page.fetch`,
  `page.events`, dialogs, `Download`, `FileChooser`) — optional per the
  brief, only if Tier 1 is solid first. Not attempted here; flagged plainly
  rather than silently dropped.
- `task.tabs()`, `task.cdp()`, `task.ownership`, `page.spaceId`,
  `page.openedBy`, `page.targetId`, `page.acceptDialog`/`dismissDialog`,
  `page.waitForEvent`, `page.dragAndDrop`, `page.waitForFileChooser` — in
  the full contract comment but named in neither the Tier-1 required list
  nor the must-fail-loudly list; treated the same as Tier 2 (skipped, not
  stubbed, not silently claimed as done).
- Shipping the `ego-browser` skill doc and wiring the binary onto
  `Dockerfile.studio`'s image PATH — a separate, explicitly out-of-scope
  follow-up per the dispatch.

## Test plan (bun:test — real process/filesystem, see existing
`test/bun/*.test.ts` inline comments for why this lane and not vitest)

New file(s) under `apps/fleet/test/bun/`, picked up automatically by
`bun-test`'s existing `test/bun` directory glob (confirmed, not assumed —
`package.json`'s `bun-test` script already globs the whole directory).

1. `ego-browser-registry.test.ts` — pure logic: create-vs-resume by id,
   create-vs-resume by name, auto-label sequencing (`p2`, `p3`, ...),
   `finish({keep})` for `"all"`, a real array, and `[]` (closes the space
   when nothing survives). No Playwright, no daemon, no child process —
   fast and deterministic.
2. `ego-browser-rpc.test.ts` — framing round-trips a request/response pair
   correctly, including one split across multiple chunk boundaries, and
   concurrent in-flight requests (fed in deliberately reordered/interleaved
   chunks) resolve against their OWN response by `id`, not by arrival
   order.
3. `ego-browser-unimplemented.test.ts` — every method in the loud-fail list
   throws synchronously, and the thrown message names the method it is.
4. `ego-browser-persistence.test.ts` — **the mandatory proof.** Spawns
   `ego-browser/cli.ts nodejs -e '<code>'` as a real child process (own
   `EGO_BROWSER_HOME` temp dir), creates/resumes a fixed task-space id,
   navigates page `p1` to a real local HTTP server this test stands up,
   process exits; a SEPARATE spawned process resumes `taskSpace(<same
   id>)`, reads `task.page("p1").url()`, asserts it matches — proving
   process 2 found process 1's live page, not a fresh one. Also covers the
   stdin heredoc entry point, proving both required entry points behave
   identically. (Uses async `Bun.spawn`, not `Bun.spawnSync` — the test's
   own in-process `Bun.serve` HTTP server must stay able to answer the
   spawned child's request while the spawn is in flight; `spawnSync` would
   block this process's event loop and deadlock the test against itself.
   Confirmed empirically during implementation.)
5. `ego-browser-smoke.test.ts` — one live end-to-end Tier-1 pass against a
   real local test page: `goto` -> `fill` -> `click` -> `waitForSelector`
   -> `evaluate` -> `snapshot()`, asserting the snapshot text contains the
   expected ref-annotated content AND reflects DOM state produced by the
   click (not a stale pre-interaction snapshot), proving the
   RPC-to-Playwright plumbing drives a real browser, not a mock.
6. `ego-browser-cli-helpers.ts` — shared spawn/cleanup helpers for 4/5
   (no `.test.` in the filename, so `bun test test/bun` does not try to run
   it as its own suite — same precedent `test/bun/exec-snippet.ts` already
   set in this directory).

## CI

`.github/workflows/fleet-check.yml`'s `bun-test` job needs chromium (it does
not have it today — only vitest/bun-test run there, no browser). Adding a
step mirroring the existing tmux step immediately above `bun run bun-test`
in the same job/file (`bun x playwright install chromium --with-deps`, same
"install what this lane needs deterministically" reasoning already
documented inline for tmux). Flagged explicitly in the PR: this is
infrastructure needed to make the mandated persistence/smoke tests actually
run in CI, not scope creep — skipping it would make a green CI a false
signal for the exact reason this task exists.

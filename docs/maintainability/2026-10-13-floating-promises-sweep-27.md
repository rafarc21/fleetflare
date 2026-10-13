# Floating-promises sweep 27 — apps/fleet src+cli (2026-10-13)

Ref #641. Analysis only, read-only, no code changed. Twenty-seventh
maintainability sweep: calls to async functions whose promise is neither
awaited, returned, passed to `ctx.waitUntil`, nor given `.catch` — rejections
that vanish or crash. Scope `apps/fleet/src/**` and `apps/fleet/cli/**` minus
`container/`. Line refs = physical lines at `origin/main` `8dd1778`, paths
relative to repo root.

**Tier rule (from #482):** GLM-OK = none of auth, secrets, credentials, rescue,
failover, accounts routing, deploy, migrations, write-proxy, leak-gate.
CLAUDE-ONLY = touches any of those.

## Result: zero findings

Every candidate the passes surfaced was verified handled. Not padding — the
codebase's discipline holds for floating promises the same way sweep 13 found
it holds for swallowed catches. The follow-up issue count for this sweep is
zero; nothing here needs a fix.

## Method

TS compiler API (typescript 5.9.3 program over all 181 src+cli files, same
approach as sweep 25), 11 passes covering every promise-dropping position:

1. Expression-statement calls whose callee's type is Promise-like.
2. `void`-operand calls.
3. Logical-arm, comma-arm, ternary-arm, condition-position promises.
4. Any-typed statement calls — 99 sites, hand-read in full (the AST pass
   alone is blind to them).
5. Async / expression-bodied callbacks under `forEach`, `.map(async`, event
   `on(...)` / `addEventListener`, `setTimeout` / `setInterval`.
6. Promise passed as argument to a non-promise parameter.
7. Template-span and object-literal-property promises.
8. Promise-typed members of dep interfaces called as bare statements.
9. Name-driven statement calls of every declared async function.
10. All `new Promise` executors: does every path settle?
11. All `.then(` sites: is there a rejection handler?

Plus hand verification of every `.then(` / `.catch(` / `new Promise(` /
`void` / event-handler site in scope.

## Evidence trail for the zero

- **9 statement-position Promise-typed calls** (pass 1): all carry
  `.then(ful, rej)` or `.catch(log)` — `src/race-timeout.ts:50` (documented:
  marks the race rejection handled at construction), `src/junior/route.ts:191`
  (heartbeat write `.catch` clears the interval), `src/llm/anthropic-route.ts:281`,
  `src/llm/anthropic-route.ts:567`, `src/studio/sandbox-api.ts:224`,
  `src/studio/do.ts:5004` (Promise.race timer cleanup, both arms),
  `src/studio/terminal.ts:100`, `cli/fleet.ts:3144`, `cli/ff.ts:586`
  (`main().catch(...)` entries).
- **99 any-typed statement calls** (pass 4, hand-read): all sync —
  `process.exit`/`stdout.write`/`stdin.on`, `writeFileSync`/`mkdirSync`/
  `unlinkSync`/`renameSync`/`cpSync`, `ws.accept`/`ws.send`/`ws.close`
  (workerd WS API is sync), `proc.kill`, `JSON.parse` — or `ctx.waitUntil(...)`
  (6 sites: `src/junior/route.ts:219`, `src/exceptions.ts:287`,
  `src/github/webhook.ts:632`, `src/github/webhook.ts:658`,
  `src/llm/anthropic-route.ts:459`, `src/llm/anthropic-route.ts:560`).
  `src/studio/do.ts:5794` `ctx.blockConcurrencyWhile` in the constructor is
  the platform's documented constructor-async-init API and its callback is
  fully try/catch'd, so it cannot reject.
- **Event-handler / timer callbacks** (the classic residue class): 8 in src —
  `src/studio/terminal.ts:99,100,106,107` (message handler
  `message(...).catch(log)`; close/error handlers sync), `src/studio/sandbox-api.ts:479,487,488`
  (sync enqueue / failStream), `setInterval` at `src/junior/route.ts:191`
  (heartbeat `.catch` stops the interval). No async callback is registered
  into any `forEach`, `.map(async` (all 8 are `Promise.all`-wrapped or
  returned), `on`, or `setTimeout` anywhere in scope — including the attach
  path's ws handlers (`cli/fleet.ts:2916-2948`), whose only async work is
  the `chain = chain.then(...)` stdin sequence with try/catch inside every
  link.
- **All 16 `new Promise` executors** resolve/reject synchronously or via
  timer callbacks (deadline idioms); all 8 `.then(` sites have rejection
  handlers; `cli/fleet.ts:2892`'s stdin chain try/catches every link.
- **Container/SDK calls** verified against library source:
  `deleteSchedules`/`renewActivityTimeout` are sync; `pty.write` is
  `ws.send` (void); `onStart`/`onStop` overrides fully awaited
  (`src/studio/do.ts:7448-7475`).
- **Lane-sensitive files** (failover.ts, rescue.ts, accounts routing,
  write-proxy/*, deploy/do.ts, leak-gate, auth.ts, creds/) were inside every
  pass's scope — zero hits there too, so no CLAUDE-ONLY findings either.
- Sweep 13's swallowed-`.catch(() => {})` sites were checked and excluded
  from re-reporting: the junior usage inserts are already finding 10 there.

## Annotated, not findings

Deliberate fire-and-forget, each caught and commented — the float-shaped code
that survives is deliberately shaped:

1. `apps/fleet/src/studio/terminal.ts:214` — `void pending?.then((pty) => pty.close()).catch((err) => console.error("studio terminal pty close failed", err));` — void + .catch with log; comment: "the failure itself must not vanish with them".
2. `apps/fleet/src/studio/terminal.ts:243` — `void this.pump(pty);` — pump's entire body is try/catch + `.catch(() => {})` on cancel, so it cannot reject; comment: "Deliberately not awaited by its caller: it only ends when the pty does".
3. `apps/fleet/src/junior/route.ts:192` — `void (async () => {...})()` — every internal path is try/catch'd, and the one real side effect (usage insert) is inside `ctx.waitUntil(...).catch(log)` with an 8-line comment explaining exactly why not a bare void.
4. `apps/fleet/src/studio/do.ts:3552` — `void (async () => {...})()` install-cache save tick — in-flight + storage-lease guards, every leg try/catch'd including the lease release, an 11-line comment head explaining the detachment, and a review-round-2 history (#210) in the comments.

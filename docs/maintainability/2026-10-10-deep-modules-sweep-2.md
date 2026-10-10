# Deep-modules design sweep 2 — apps/fleet cli, scripts, container (2026-10-10)

Ref #259 Part B step 1. Analysis only. No code changed. Maestro files issues from §3.
Sweep 1 (`apps/fleet/src`): `docs/maintainability/2026-10-08-deep-modules-sweep.md`. Not repeated here.

## 1. Method

**Skills used, as written** — `mattpocock/skills` @ `b0618bc436ad` (MIT):

- `skills/engineering/improve-codebase-architecture` (ICA) — process.
  - ICA §1 Explore: scope by `git log` hot spots, read `GLOSSARY.md` + `docs/adr/` (neither exists → nothing to respect / re-litigate), spawn sub-agents (one each for cli, container, scripts) to walk code organically, note friction, apply deletion test.
  - ICA §2 Present candidates: per candidate Files / Problem / Solution / Benefits / strength (`Strong` | `Worth exploring` | `Speculative`), end with top recommendation.
  - ICA §3 Grilling: NOT run. Brief = analysis only; grilling happens per issue in refactor lane (#259 Part B step 2).
- `skills/engineering/codebase-design` (CD) — vocabulary + principles: module, interface, implementation, depth, seam, adapter, leverage, locality; deletion test; "interface is test surface"; "one adapter = hypothetical seam".
  - CD/DEEPENING.md "Dependency categories" — tag per finding (in-process / local-substitutable / remote-owned / true external).
  - CD/DEEPENING.md "Testing strategy: replace, don't layer" — drives "characterization tests" line per finding.

**Deviations from skills (forced by brief), same as sweep 1:**

- ICA §2 says HTML report in OS temp dir. Brief needs one md file in repo → same card fields, markdown, committed.
- ICA §2 says "do NOT propose interfaces yet". Brief wants "hide A,B,C behind interface Y" → each finding names a candidate interface; treat it as a starting point for ICA §3 grilling, not a decision.
- ICA §1 says "don't follow rigid heuristics". Brief also wants a number per module → depth table (§2) for triage only; ranking (§3) by ICA §1 friction + CD deletion test, not by number.

**Metric — identical definition to sweep 1, so numbers compare:**

- `impl LOC` = lines holding at least one code token (comments + blank lines excluded). `phys` = physical lines.
- `iface` = exported values (functions, consts, classes, public methods) + params of exported functions/public methods + ⌈exported types ÷ 2⌉.
- `depth` = impl LOC ÷ iface. Low = shallow.
- `fan-in` = distinct non-test files in `apps/fleet` (src, cli, scripts, container, page) importing module. `test fan-in` = distinct files under `apps/fleet/test` importing it.
- `test-only exports` = exported values tests import and no production file imports → internals leaked through interface for tests (CD "interface is test surface").
- Caveat, per CD "Rejected framings": LOC ratio rewards padding. Number = smoke detector, not verdict. CD defines depth as leverage per unit of interface; §3 judges that.
- Tool: TS compiler AST (`typescript@5.6.3`), one ~150-line script, run outside repo. Reproducible from this definition.
- Blind spot in scope: entrypoints (`Bun.serve` / CLI `main` at top level) export nothing → depth n/a, yet they hold the worst friction (findings F2, F7, F15). Table under-reports them; §3 doesn't.

**Measure for #259 Part D weekly score (cli + scripts + container):**

| measure | value |
|---|--:|
| aggregate depth (Σ LOC ÷ Σ iface, modules with exports) | 13.3 |
| modules with depth < 4 | 6 / 42 |
| test-only exported values / all exported values | 96 / 275 (35%) |
| test files asserting on in-scope TS source text (`TEST_*_SRC` / `readFileSync` + `toContain`/`indexOf`) | 6 |

Source-text tests (6): `test/cli.backoff.test.ts`, `test/cli.destroy-outcome.test.ts`, `test/cli.recycle-outcome.test.ts`, `test/container.args.test.ts`, `test/bun/cli-destroy-flags.test.ts`, `test/bun/print-attach-handle.test.ts`. (Many more `test/bun/bringup-*` read `container/*.sh`; out of scope — shell, not TS.)

**Hot spots (ICA §1, `git log` since 2026-08, scope paths):** `cli/fleet.ts` (29 commits), `cli/readiness-format.ts` (9), `cli/accounts-format.ts` (4), then `wip-format`, `repair-failure`, `reap`, `ff`, `destroy-outcome`, `accounts` (3 each). Everything else ≤ 2. Findings weighted to `cli/fleet.ts`.

## 2. Depth table — all modules, shallowest first

Scope: `apps/fleet/cli`, `apps/fleet/scripts`, `apps/fleet/container` TS files (51). Paths relative to `apps/fleet/`. Ties broken by fan-in (higher first).

| # | module | impl LOC | phys | exp values | exp types | params | iface | depth | fan-in | test fan-in | test-only exports |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 1 | `cli/input.ts` | 12 | 28 | 3 | 1 | 1 | 5 | 2.4 | 1 | 1 | 0 |
| 2 | `container/ego-browser/api.ts` | 202 | 242 | 37 | 2 | 46 | 84 | 2.4 | 1 | 1 | 2 |
| 3 | `cli/task-new-retry.ts` | 41 | 54 | 4 | 0 | 11 | 15 | 2.7 | 2 | 1 | 1 |
| 4 | `cli/repair-failure.ts` | 36 | 58 | 3 | 0 | 8 | 11 | 3.3 | 4 | 2 | 0 |
| 5 | `cli/attach-liveness.ts` | 39 | 53 | 6 | 0 | 6 | 12 | 3.3 | 2 | 2 | 0 |
| 6 | `cli/restart-format.ts` | 31 | 41 | 4 | 0 | 4 | 8 | 3.9 | 1 | 2 | 1 |
| 7 | `cli/status-poll.ts` | 24 | 49 | 1 | 1 | 4 | 6 | 4 | 2 | 0 | 0 |
| 8 | `container/ego-browser/registry.ts` | 178 | 230 | 16 | 3 | 16 | 34 | 5.2 | 1 | 1 | 0 |
| 9 | `cli/reap-terminal.ts` | 17 | 23 | 1 | 1 | 1 | 3 | 5.7 | 1 | 1 | 0 |
| 10 | `container/ego-browser/rpc.ts` | 53 | 62 | 4 | 4 | 3 | 9 | 5.9 | 2 | 1 | 0 |
| 11 | `cli/junior-sweep.ts` | 19 | 24 | 1 | 1 | 1 | 3 | 6.3 | 1 | 1 | 0 |
| 12 | `container/memguard.ts` | 472 | 605 | 18 | 7 | 52 | 74 | 6.4 | 0 | 1 | 17 |
| 13 | `cli/backoff.ts` | 54 | 69 | 3 | 0 | 5 | 8 | 6.8 | 1 | 2 | 0 |
| 14 | `cli/junior.ts` | 150 | 195 | 8 | 2 | 12 | 21 | 7.1 | 1 | 1 | 4 |
| 15 | `scripts/english-check.ts` | 100 | 118 | 7 | 2 | 6 | 14 | 7.1 | 0 | 1 | 7 |
| 16 | `cli/context-salvage.ts` | 101 | 110 | 4 | 3 | 7 | 13 | 7.8 | 1 | 1 | 3 |
| 17 | `container/ego-browser/paths.ts` | 27 | 30 | 1 | 1 | 1 | 3 | 9 | 2 | 0 | 0 |
| 18 | `cli/memory-format.ts` | 36 | 45 | 2 | 1 | 1 | 4 | 9 | 1 | 1 | 0 |
| 19 | `cli/accounts-format.ts` | 262 | 288 | 10 | 3 | 16 | 28 | 9.4 | 2 | 2 | 4 |
| 20 | `cli/fleet-totals.ts` | 38 | 54 | 2 | 0 | 2 | 4 | 9.5 | 1 | 2 | 0 |
| 21 | `cli/inspect-request.ts` | 116 | 132 | 4 | 2 | 6 | 11 | 10.5 | 1 | 1 | 1 |
| 22 | `cli/burn-format.ts` | 32 | 48 | 2 | 0 | 1 | 3 | 10.7 | 1 | 1 | 0 |
| 23 | `container/ego-browser/idle-shutdown.ts` | 90 | 105 | 4 | 1 | 3 | 8 | 11.3 | 1 | 1 | 0 |
| 24 | `container/ego-browser/wire.ts` | 23 | 27 | 0 | 3 | 0 | 2 | 11.5 | 2 | 0 | 0 |
| 25 | `cli/destroy-outcome.ts` | 168 | 221 | 6 | 3 | 4 | 12 | 14 | 2 | 2 | 2 |
| 26 | `container/ego-browser/process-reap.ts` | 123 | 136 | 2 | 2 | 5 | 8 | 15.4 | 1 | 1 | 0 |
| 27 | `cli/wip-format.ts` | 225 | 247 | 5 | 1 | 8 | 14 | 16.1 | 1 | 2 | 2 |
| 28 | `cli/readiness-format.ts` | 600 | 705 | 14 | 1 | 22 | 37 | 16.2 | 3 | 4 | 0 |
| 29 | `cli/orca-workspace.ts` | 983 | 1349 | 18 | 12 | 34 | 58 | 16.9 | 2 | 7 | 7 |
| 30 | `cli/task-format.ts` | 120 | 144 | 4 | 0 | 3 | 7 | 17.1 | 2 | 2 | 1 |
| 31 | `cli/reap.ts` | 351 | 430 | 12 | 5 | 5 | 20 | 17.6 | 1 | 2 | 4 |
| 32 | `scripts/test-lies-check.ts` | 475 | 528 | 9 | 3 | 16 | 27 | 17.6 | 0 | 1 | 8 |
| 33 | `scripts/localci/summarize.ts` | 273 | 305 | 5 | 5 | 6 | 14 | 19.5 | 0 | 1 | 5 |
| 34 | `scripts/sensors/run.ts` | 317 | 355 | 4 | 6 | 9 | 16 | 19.8 | 0 | 1 | 4 |
| 35 | `cli/paste-mac.ts` | 21 | 39 | 1 | 0 | 0 | 1 | 21 | 1 | 0 | 0 |
| 36 | `cli/fleet.ts` | 2205 | 2737 | 33 | 9 | 46 | 84 | 26.3 | 4 | 13 | 14 |
| 37 | `container/ego-browser/client.ts` | 183 | 235 | 2 | 0 | 4 | 6 | 30.5 | 1 | 0 | 0 |
| 38 | `cli/recycle-outcome.ts` | 306 | 369 | 4 | 3 | 4 | 10 | 30.6 | 1 | 1 | 3 |
| 39 | `scripts/merge-danger.ts` | 131 | 142 | 2 | 2 | 1 | 4 | 32.8 | 0 | 1 | 2 |
| 40 | `cli/accounts.ts` | 399 | 429 | 5 | 2 | 6 | 12 | 33.3 | 1 | 0 | 0 |
| 41 | `cli/ff.ts` | 452 | 596 | 2 | 1 | 10 | 13 | 34.8 | 0 | 2 | 2 |
| 42 | `container/gh-proxy.ts` | 209 | 233 | 2 | 2 | 2 | 5 | 41.8 | 0 | 1 | 2 |

Entrypoints (no exports, depth n/a): `scripts/build-page.ts` (90 LOC), `scripts/deploy-containers-changed.ts` (145), `scripts/deploy-target.ts` (143), `scripts/directus-schema.ts` (80), `container/deploy-server.ts` (133), `container/ego-browser/cli.ts` (55), `container/ego-browser/daemon.ts` (355), `container/fleet-cli.ts` (44), `container/server.ts` (268).

**Reading notes:**

- Shallow by number, real by leverage: `container/ego-browser/api.ts` (depth 2.4) = documented public `Page`/`TaskSpace` contract for browser scripts; shallow because 22 methods are one-line `this.call(...)` forwards (F5), not because the contract is wrong.
- Shallow by number, fine by deletion test: `cli/input.ts`, `cli/backoff.ts`, `cli/attach-liveness.ts` — small, one job, callers would repeat them.
- Pure pass-through by deletion test: `cli/status-poll.ts` (split out only so two siblings share `readStatus`; re-exported again at `cli/destroy-outcome.ts:38`) → F13.
- Wide test-only surface: `container/memguard.ts` exports 18 values, 17 used only by tests, zero production importers (entrypoint) → F9. `cli/fleet.ts` 14 test-only exports (`cmdLs`, `reapDeps`, `rescueFetchInit`, …) exist because commands `process.exit` and print directly (deferred D7).
- Deep by number but wide: `cli/fleet.ts` depth 26.3 hides 2205 LOC behind 84 iface units, yet ~23 hand-built `fetch` calls inside it repeat the same request dance → F1.
- Already deep, use as models: `container/gh-proxy.ts` (`translate()` behind a 5-method `TranslateCtx`, tested through it), `cli/orca-workspace.ts` (injected `OrcaDeps`), `cli/reap.ts` (`runReap` + `ReapDeps`), `scripts/directus-schema.ts` (logic lives in `src/directus/schema-apply.ts`, script only parses + prints).

## 3. Ranked findings

Rank = leverage + locality gained per line changed, weighted to hot spots and observed drift (ICA §1). Every finding: behavior-preserving, two-way door (code-only, revertable) unless stated, one small PR.

**CLAUDE-ONLY** = touches rescue, failover, deploy, auth, secrets, crypto, payments, migrations, or admission (#259 Part C + brief). GLM never takes these. **GLM-OK** = none of those; sized ≤ 400 changed lines, testable at the interface.

Summary:

| # | finding | lane | strength | size |
|--:|---|---|---|---|
| 1 | Worker requests → one `FleetClient` | CLAUDE-ONLY | Strong | ~300 L (PR 1 of 2) |
| 2 | container redaction → one `Redactor` (+ clip-after-scrub) | CLAUDE-ONLY | Strong | ~120 L |
| 3 | credentials file → one `readCredentials()` | CLAUDE-ONLY | Strong | ~150 L |
| 4 | ego-browser RPC → `createRpcClient` / `serveRpc` | GLM-OK | Strong | ~150 L |
| 5 | ego-browser `Page` stubs → typed method map | GLM-OK | Strong | ~300 L |
| 6 | repo check scripts → `runRepoCheck` | GLM-OK | Strong | ~180 L |
| 7 | Orca row open/close → `openStudioRow` / `closeStudioRow` | GLM-OK | Strong | ~70 L |
| 8 | test-lies-check scanners → one `scanCalls` | GLM-OK | Worth exploring | ~120 L |
| 9 | memguard → `createGuard(io, cfg).tick(now)` | GLM-OK | Worth exploring | ~250 L (mostly tests) |
| 10 | ego-browser daemon endpoint + idle → `DaemonEndpoint`, `IdleShutdown.track` | GLM-OK | Worth exploring | ~120 L |
| 11 | ego-browser browser process → `BrowserProcess` | GLM-OK | Worth exploring | ~150 L |
| 12 | task-space close → `TaskSpaceRecord.finish(keep, closer)` | GLM-OK | Worth exploring | ~70 L |
| 13 | destroy/recycle timeout poll → `requestWithOutcome` | CLAUDE-ONLY | Strong | ~250 L |
| 14 | positional boolean flags → parsed command variant | CLAUDE-ONLY | Worth exploring | ~120 L |
| 15 | deploy probes → one `DeployTarget` module | CLAUDE-ONLY | Worth exploring | ~300 L |

8 GLM-OK, 7 CLAUDE-ONLY. Line refs = physical lines at `origin/main` `f0d178d`, paths relative to `apps/fleet/`.

### F1. Deepen Worker access: hide auth headers, base URL, `Accept`/`Content-Type`, timeout, `res.ok` check and error-body truncation behind `FleetClient.get/post(route) → Result<T>` — CLAUDE-ONLY (auth, secrets, rescue, deploy)

- **Files:** helpers `cli/fleet.ts:216-256` (`accessHeaders`, `studioUrl`, `boardUrl`, `memoryUrl`, `juniorUrl`, `wsUrl`); `fetch(` call sites: `cli/fleet.ts` ×23 (e.g. `:648-655`, `:887-893`, `:934-940`, `:1055-1079`, `:1131-1140`, `:1264-1274`, `:1339-1347`, `:2009-2016`, `:2086-2090`, `:2239-2245`), `cli/ff.ts` ×7 (`:104-110`, `:178-213`, `:232-239`, `:280-285`), `cli/accounts.ts` ×2 (`:89-102`, `:307-319`), `cli/junior.ts:183-186`; `accessHeaders` imported by `scripts/sensors/run.ts`.
- **Problem:** no single request path. Each caller rebuilds URL → spreads `accessHeaders` → adds headers (inconsistently) → checks `res.ok` → `res.text().slice(0, N)` with N ∈ {200, 300, 500, 800, 2000} → then exits, throws, falls back, or returns a tagged result (5 error styles). ~half have no timeout (`cli/fleet.ts:1939-1953` notes Bun's ~300 s default then applies). Studio list alone fetched 5 ways (`:648`, `:887`, `:934`, `:2086`, `ff.ts:104`); only reap's copy has timeout + `Array.isArray` check; rescue-all reuses the onboard copy so its error says "fleet ls". Three modules already have the right shape (never throw, named failure, timeout) — `cli/status-poll.ts:30-48`, `cli/inspect-request.ts:21-60`, `fetchJson` `cli/fleet.ts:2036-2040` — as three copies.
- **Solution (PR 1):** one `cli/client.ts` owning headers, base URL, default timeout, error decode; migrate studio-list (5 copies → `client.listStudios()`) + all read-only GETs in `fleet.ts`. PR 2: POST verbs + `ff.ts`. Each call site keeps its current exit/throw/fallback at the edge.
- **Behavior-preserving rule:** keep each site's current timeout (or none) and truncation length as an explicit option in PR 1; unifying them = separate decided issue (changes user-visible error text).
- **Benefits:** locality — auth/timeout policy in one file; leverage — ~36 sites shrink; tests swap one fake client instead of patching `globalThis.fetch` (`test/bun/rescue-all-fetch-timeout.test.ts:119-126`, `test/bun/ff-file-task-retry.test.ts:21-54`).
- **Deletion test:** deleting `accessHeaders` + `*Url` helpers removes nothing — complexity is already spread over ~36 callers → they are pass-throughs over a missing deep module (CD Principles).
- **Dependency:** remote but owned (Worker) → port + in-memory adapter (CD/DEEPENING "Remote but owned"). Fake Worker on `Bun.serve` already exists in `fleet-reap-wiring`, `fleet-ls-footer`, `accounts-cli`, `ff-no-tty`, `ff-new-main` tests.
- **Characterization tests first:** per migrated verb: 200, non-ok with HTML title (Cloudflare page), network error, timeout → same stdout/stderr/exit code. Use existing fake-Worker harness.
- **Skill step:** ICA §1 (repeated sequence; understanding one concept = bouncing between modules) + CD deletion test. **Strength:** Strong.

### F2. Deepen container redaction: hide URL-credential regex, value scrub, min-length guard and clip-after-scrub ordering behind one `container/redact.ts` `Redactor.clip(text, n)` — CLAUDE-ONLY (secrets, deploy)

- **Files:** `redactCreds` byte-identical `container/server.ts:104-106` and `container/deploy-server.ts:52-54`; value scrubs differ `server.ts:323-325` (`"***"`, no min length) vs `deploy-server.ts:62-68` (`«redacted»`, `>= 8` guard); ordering rule restated as comment at `deploy-server.ts:30-41`, `:122-129` and 3 more call sites; related shape scrubs `container/memguard.ts:484-493`, `src/studio/redact.ts`.
- **Problem:** rule "scrub before truncate" lives in comments, enforced per call site. **Observed gap:** `server.ts:292-294` builds `detail` from claude output/stderr and stores `detail.slice(0, 500)`; value scrub only runs later in `/status` (`scrubbedStatus`, `:327-348`). A token straddling char 500 keeps its leading part unscrubbed. Same pattern in `sh()` `:112` for bare tokens (URL regex runs first, value scrub only later).
- **Solution:** one module, both entrypoints call `clip`; Dockerfiles copy it (`container/Dockerfile:8`, `container/Dockerfile.deploy:18` copy entrypoints alone today).
- **Behavior-preserving rule:** PR 1 keeps each server's replacement marker and guard as options; it MAY fix the clip-before-scrub gap only as its own commit with its own failing test first (that one commit is a behavior change, security-positive, still two-way door). Otherwise split into its own issue.
- **Dependency:** in-process (pure).
- **Characterization tests first:** none exist — `server.ts`/`deploy-server.ts` are unimportable (`Bun.serve` at top level). Test the new module directly: URL creds, bare token, token straddling clip boundary, short value under guard.
- **Skill step:** ICA §1 (tight coupling leaking across seam; knowledge in comments) + CD Locality. **Strength:** Strong.

### F3. Deepen credentials: hide path, file-mode warning, JSON parse and field checks behind one `readCredentials(path?) → Credentials | {error}`; exit vs soft-fail chosen only at edges — CLAUDE-ONLY (auth, secrets, rescue, deploy)

- **Files:** `cli/fleet.ts:84` (`CREDENTIALS_PATH` fixed at module load), `:86-113` `loadCredentials`, `:138-172` `loadCredentialsIfPresent`, `:185-214` `tryLoadCredentials` (mode-warning block ×3: `:99-105`, `:146-152`, `:196-202`); fourth parse `scripts/deploy-target.ts:136-142`; `scripts/sensors/run.ts:50` imports loader from 2737-line CLI entrypoint.
- **Problem:** 4 copies differ by a hidden flag (exit / null / `{error}`). Justifying comment `cli/fleet.ts:127-131` cites "roughly a dozen existing call sites"; real `loadCredentials()` callers = 2 (`cli/fleet.ts:2667`, `cli/ff.ts:467`). Strict loader throws on bad JSON (`:107`) while soft ones catch. `deploy-target.ts` copy skips mode + field checks — it decides which fleet the pre-deploy rescue-all targets.
- **Solution:** one `cli/credentials.ts` (no CLI import cost); three loaders become thin edge adapters or vanish; scripts import the module, not `fleet.ts`.
- **Dependency:** local-substitutable (filesystem; pass path in).
- **Characterization tests first:** missing file, bad JSON, missing field, mode 0644 warning, valid → same output for each of 4 call styles. `test/bun/load-credentials-if-present.test.ts:11-15` spawns a subprocess only because path is fixed at load → after, test in-process with a temp path.
- **Skill step:** ICA §1 (flag-like variants; module leaking across seam) + CD "accept dependencies". **Strength:** Strong.

### F4. Deepen ego-browser RPC: hide framing, id correlation, per-call timeout, fail-all-on-close and dispatch behind `rpc.ts` `createRpcClient(socket)` + `serveRpc(socket, handlers)` — GLM-OK

- **Files:** `container/ego-browser/rpc.ts` (61 lines, framing only: `encodeMessage`, `MessageFramer`); correlation + timers + close in `container/ego-browser/client.ts:147-234`; dispatch in `container/ego-browser/daemon.ts:518-562`; identical buffer-decode line `client.ts:185` / `daemon.ts:549`.
- **Problem:** protocol knowledge split over 3 files; `rpc.ts` shallow. `test/bun/ego-browser-rpc.test.ts:43-64` re-implements id matching inside the test (`pendingById`, `:56`) → never runs real correlation; timeout + close paths untested except via live Chromium.
- **Solution:** `rpc.ts` owns both ends; `client.ts` and `daemon.ts` call it.
- **Benefits:** locality — protocol in one file; tests drive both ends over an in-memory socket pair.
- **Dependency:** local-substitutable (Unix socket → in-memory duplex).
- **Characterization tests first:** out-of-order responses, call timeout, socket close fails all pending, unknown method → error. Then delete the `pendingById` re-implementation (CD "replace, don't layer").
- **Must not touch:** nothing in risk list. **Skill step:** ICA §1 ("pure functions extracted for testability, real bugs in how they're called") + CD deletion test. **Strength:** Strong.

### F5. Deepen ego-browser page surface: hide 22 hand-written `Page` forwards and 25 daemon handlers' param typing behind one typed `PageRpc` method map in `wire.ts` + generic forwarder/dispatcher — GLM-OK

- **Files:** `container/ego-browser/api.ts:35-143` (22× `this.call("page.X", …)`, 21× `spaceId: this.spaceId, label: this.label`); `container/ego-browser/daemon.ts:300-511` (same 25 names; 21× `await resolvePage(params.spaceId, params.label)`, inline param types, `as never` casts); `container/ego-browser/wire.ts:11-26` (only 3 shared types).
- **Problem:** method name + param shape written twice, kept in sync by hand. Matcher marshaling `api.ts:18-22` ↔ `daemon.ts:263-267` untested.
- **Solution:** `wire.ts` declares `PageRpc = { [method]: {params, result} }`; `api.ts` keeps its public `Page` class (documented contract) but bodies call one typed forwarder; daemon handlers typed from the map, `resolvePage` applied once.
- **Behavior-preserving rule:** public `Page`/`TaskSpace` method names + signatures unchanged (browser scripts depend on them).
- **Dependency:** in-process + RPC (do after F4; uses its in-memory pair).
- **Characterization tests first:** for each of 25 methods, client call → daemon receives same method + params (in-memory pair, fake page). `ego-browser-unimplemented.test.ts` already uses the interface — keep.
- **Skill step:** CD Deep vs shallow ("can I reduce the number of methods? simplify params?") + ICA §1 deletion test. **Strength:** Strong. Est. −200 / +100.

### F6. Deepen repo check scripts: hide `git ls-files`, allowlist, per-line escape, finding format, summary and exit code behind one `scripts/repo-check.ts` `runRepoCheck({ select, scanFile, allowlist, stream })` — GLM-OK

- **Files:** `scripts/english-check.ts:29` (`REPO_ROOT`), `:43`, `:49-53`, `:83-85`, `:88-91`, `:93-107` (`scanRepo`, `git ls-files -z` at `:94`), `:109-117` main; `scripts/test-lies-check.ts:38-63`, `:473-475`, `:480-490`, `:492-508` (`git ls-files -z` at `:493`), `:510-527` main.
- **Problem:** same 4-step dance (list → read → scan → report + exit) twice; copies drifted: english-check prints findings to stderr (`:111`), test-lies-check to stdout (`:515`); escape applied inside detector (`english-check.ts:75`) vs after (`test-lies-check.ts:489`); second `git ls-files` only to count (`test-lies-check.ts:517`). `REPO_ROOT` from `import.meta.dir` → CLI can't target another root, so `test/bun/test-lies-check.test.ts:428-464` copies the script into a temp git repo to test main; `test/english-only.test.ts:4` imports `ALLOWLIST`, `LINE_ALLOWLIST`, `REPO_ROOT` (test-only exports).
- **Solution:** shared runner takes `root` + detector; both mains become ~5 lines.
- **Behavior-preserving rule:** keep each script's stream (stderr vs stdout), messages and exit codes byte-identical; CI (`.github/workflows/english-check.yml:28`, `fleet-check.yml:50`) and `scripts/localci/localci.sh:164,173` call them unchanged.
- **Dependency:** local-substitutable (filesystem + git → temp dir).
- **Characterization tests first:** per script: clean repo → exit 0 + line; finding → exit 1 + same formatted line on same stream; escaped line skipped. Run against a temp root via new `root` param.
- **Skill step:** ICA §1 (repeated sequence) + CD deletion test (both mains shallow; detectors deep). **Strength:** Strong.

### F7. Deepen Orca row lifecycle: hide list-tasks → title → ensure sequence behind `openStudioRow(id, tasks, deps)` and remove → describe behind `closeStudioRow(id, deps) → lines` in `cli/orca-workspace.ts` — GLM-OK

- **Files:** ensure pair `cli/fleet.ts:1089`, `:1149`, `:1201`, `cli/ff.ts:394`, batch form `cli/fleet.ts:848-853`; remove pair `cli/fleet.ts:1251-1252`, `:2136-2137`; returned `WorkspaceOutcome` (`cli/orca-workspace.ts:166-170`, `:533-557`) dropped at all 4 single-studio sites.
- **Problem:** shallow siblings callers must sequence (`studioWorkspaceTitle` + `ensureStudioWorkspace`; `removeStudioWorkspace` + `describeWorkspaceRemoval`), only ever used in pairs.
- **Solution:** two functions in `orca-workspace.ts`; 7 call sites become one line each.
- **Behavior-preserving rule:** same Orca calls, same printed lines. **Must not touch:** anything else inside `cmdProvision` / `cmdRecycle` / `cmdDestroy` / `reapDeps` — edit only the listed lines (those verbs drive rescue/failover server-side). Source-text pin `test/cli.recycle-outcome.test.ts:431-433` counts `ensureStudioWorkspace(` occurrences → update the count to the new function name; do not delete the pin.
- **Dependency:** local-substitutable (`OrcaDeps` fakes exist).
- **Characterization tests first:** `test/bun/orca-workspace.test.ts` style: `openStudioRow` with tasks → same title + ensure call; `closeStudioRow` removed / absent / Orca missing → same lines.
- **Skill step:** ICA §1 (shallow siblings callers must sequence) + CD deletion test. **Strength:** Strong.

### F8. Deepen test-lies-check scanning: hide quote/escape/bracket-depth walking and line-number calc behind one `scanCalls(text, matcher) → CallMatch[]` — GLM-OK

- **Files:** `scripts/test-lies-check.ts` walkers ×3 `:78-94` (`hasTopLevelComma`), `:103-121` (`extractBalanced`), `:263-279` (`firstArgText`); call finders ×3 `:133-151` (`findCalls`), `:206-218` (`findExpectToBeCalls`), `:425-449` (`findBunFileTextCalls`), each recomputing line via `text.slice(0, m.index).split("\n").length`.
- **Problem:** one quote-state machine written 3×; quote-handling fix must land 3×.
- **Solution:** one private tokenizer; detectors keep their public names.
- **Behavior-preserving rule:** detector outputs identical on whole repo — diff `bun run test-lies-check` output before/after.
- **Dependency:** in-process (pure).
- **Characterization tests first:** `test/bun/test-lies-check.test.ts` already tests through detectors (`findTautologies`, `findSourceReading`, `findOwnModuleMocks`) — add cases: nested quotes, template literals with `${}`, escaped quotes, commas inside brackets. Walkers stay private.
- **Skill step:** CD Deep vs shallow (hide complexity inside) + deletion test (3 walkers merge, nothing lost). **Strength:** Worth exploring.

### F9. Deepen memguard: hide lead-pid refresh, `adjScan`, `step`, `adjPlan`, settle-on-failed-kill and `selfPid`/`leadParentPid` threading behind `createGuard(io, cfg).tick(now)` — GLM-OK

- **Files:** `container/memguard.ts` tick orchestration only in `main()` `:576-600` (failed-kill settle `:594-597`); `selfPid` + `leadParentPid` threaded through 7 signatures (`:221`, `:233`, `:252`, `:262`, `:301`, `:392`, `:451`); pass-through `refreshLeadParentPid` `:207-209` (`return resolved;`); `pct`/`low` computed twice (`:401`, `:467`).
- **Problem:** 17 of 18 exports test-only (`test/bun/memguard-select.test.ts:11-31`); real tick only exercised by `test/bun/memguard-docker.test.ts`, skipped without Docker (`:223`). Bugs in sequencing are untested where Docker absent.
- **Solution:** guard object holds pids + caches; io port (`readProcs`, `readMemory`, `kill`, `setAdj`, `log`, `now`) injected; `main()` = build io + loop.
- **Behavior-preserving rule:** same kill/adj decisions, same log lines. Keep pure selection fns internal (internal seam, CD Principles) — retarget tests, don't delete coverage.
- **Dependency:** local-substitutable (`/proc` + cgroup files → fake io).
- **Characterization tests first:** fake io scripted over N ticks: below threshold no-op; over threshold kills largest non-protected; kill fails → settles; lead pid changes mid-run → protection follows. Then migrate `memguard-select` cases to `tick()` (CD "replace, don't layer").
- **Note:** memguard protects studio processes from OOM; not rescue/failover code. If maestro classes OOM-kill as rescue-adjacent, flip to CLAUDE-ONLY.
- **Skill step:** CD "interface is test surface" + ICA §1 (untested through interface). **Strength:** Worth exploring.

### F10. Deepen ego-browser daemon endpoint + idle: hide pid/sock file protocol behind `DaemonEndpoint` and in-flight counting behind `IdleShutdown.track(fn)` — GLM-OK

- **Files:** names only `container/ego-browser/paths.ts:20-29`; protocol spread `client.ts:39-45` (pid alive), `:110-111` (stale cleanup), `daemon.ts:516` (rm sock before listen), `:568` (write pid after listen), `:208-209` (rm both on shutdown); caller-owned counter `daemon.ts:152`, `:521`, `:535`, schedule in every `finally` `:536` + startup grace `:581`; pass-through `scheduleIdleCheck` `:220-222`.
- **Problem:** `IdleShutdown` takes an `inFlightZero` predicate but caller owns counter + scheduling; file protocol in 5 places across 2 files.
- **Solution:** `IdleShutdown.track(fn)` wraps each request; `DaemonEndpoint` owns claim/release/isAlive.
- **Dependency:** local-substitutable (temp dir, fake timers).
- **Characterization tests first:** request in flight blocks shutdown; idle after last request fires once; startup grace honoured; stale pid file cleaned; live pid → client reuses. `ego-browser-idle-shutdown-scheduler.test.ts` already uses interface with fake timers — extend. Live tests grepping `daemon.log` (`ego-browser-idle-shutdown-launch-failure.test.ts:93,105`, `ego-browser-daemon-spawn-race.test.ts:45-47`) keep passing unchanged.
- **Skill step:** ICA §1 (shallow siblings callers must sequence) + CD deletion test. **Strength:** Worth exploring.

### F11. Deepen browser process ownership: hide launch timeout, rejected-promise reset, pid discovery, bounded close + SIGKILL behind `BrowserProcess` with injectable launcher — GLM-OK

- **Files:** `container/ego-browser/daemon.ts:66-118` (`getBrowser`), `:169-211` (`shutdown`); helpers moved out "so … unit-testable" (`daemon.ts:33-38`) to `container/ego-browser/process-reap.ts:69-111` (`findDirectChildPid`), `:124-135` (`raceWithTimeout`).
- **Problem:** file split by testability, not knowledge: helpers tested with fakes, the launch → record pid → bounded close → SIGKILL sequence stays untestable in the entrypoint; verified only by log text (`ego-browser-launch-self-heal.test.ts:16-27,55`, `ego-browser-idle-shutdown-container.test.ts:46-50`).
- **Solution:** `BrowserProcess.get()` / `.close(budgetMs)` in `process-reap.ts` (rename fine); launcher + kill injected.
- **Behavior-preserving rule:** same log lines (live tests grep them).
- **Dependency:** local-substitutable (fake launcher).
- **Characterization tests first:** launch timeout → next `get()` retries; concurrent `get()` → one launch; close hangs → SIGKILL to recorded pid after budget.
- **Skill step:** ICA §1 ("pure functions extracted for testability, bugs in how they're called"; files split by step). **Strength:** Worth exploring.

### F12. Deepen task-space close: hide per-label target close, label removal, context close and registry removal behind async `TaskSpaceRecord.finish(keep, closer)` + `closeLabel(label)` — GLM-OK

- **Files:** pure receipt `container/ego-browser/registry.ts:119-129`; caller-sequenced close `container/ego-browser/daemon.ts:339-352`; repeat in `page.close` `daemon.ts:499-505`; `resolveTarget(label, ctx => ctx.newPage())` ×2 (`:241`, `:326`); numeric-id parse ×2 in `registry.ts` (`:180-182`, `:189-190`).
- **Problem:** receipt extracted for testability; risky ordering stays with caller; `ego-browser-registry.test.ts` can't see it.
- **Solution:** registry record performs close via injected `closer`; daemon handlers one line.
- **Dependency:** in-process (fake page/context).
- **Characterization tests first:** finish keep=none/some/all → same `{retained, closed}`, closes called per closed label, context closed + record removed only when space closed; close throwing ignored (`.catch(() => {})` today).
- **Skill step:** ICA §1 (shallow siblings) + CD "return results, don't produce side effects" weighed against locality. **Strength:** Worth exploring.

### F13. Deepen long repair verbs: hide timed POST, poll-on-no-answer loop and verdict wording behind `requestWithOutcome(verb, url, landed: (row) => boolean)` — CLAUDE-ONLY (rescue, failover)

- **Files:** `cli/destroy-outcome.ts:123-152` (`requestDestroy`), `:155-220` (`pollAfterNoAnswer`); `cli/recycle-outcome.ts:160-196` (`requestRecycle`), `:301-368` (`pollAfterNoAnswer`) — same skeleton, predicate differs (`bringupLanded` `:289-297`); `cli/status-poll.ts` (48 lines) split only for sharing; pass-through re-export `cli/destroy-outcome.ts:37-38`; `cli/recycle-outcome.ts:38` imports `DESTROY_*` constants from sibling; grab-bag `cli/repair-failure.ts:161-173`; third outcome layer in wiring `cli/fleet.ts:2123-2142` (`destroyRaceOutcome` from `cli/reap.ts:108`).
- **Problem:** "what happens when destroy/recycle times out" = 5 files. Files split by step (request / poll / format) not knowledge (one repair verb).
- **Solution:** one generic module; destroy + recycle pass predicate + wording; `status-poll.ts` folds in.
- **Dependency:** remote but owned (Worker) — `fetchImpl` port already exists.
- **Characterization tests first:** `cli.destroy-outcome.test.ts` + `cli.recycle-outcome.test.ts` test through `fetchImpl` (good) — add: answer in time, timeout then landed, timeout then not landed, status read fails. Source-text pins (`cli.destroy-outcome.test.ts:186-196`, `cli.recycle-outcome.test.ts:425-435`) → replace with behavior tests (CD "replace, don't layer").
- **Skill step:** ICA §1 (bouncing between small modules) + CD deletion test (`status-poll.ts`, re-export = pass-through). **Strength:** Strong.

### F14. Deepen command inputs: replace positional boolean runs with the parsed command variant (`cmdDestroy(creds, parsed)`) — CLAUDE-ONLY (rescue, failover)

- **Files:** `cli/fleet.ts:1101-1103` (`cmdProvision(creds, id, freshSession, cancelFreshSession, discardSession)`), `:1170-1172` (`cmdRecycle(…, discardUnsynced, freshSession, forceMappedAccount)`), `:1234` (`cmdDestroy(…, force, discardUnsynced, park)`), `cli/repair-failure.ts:161` (`destroyPath(force, discardUnsynced, park)`); dispatcher `cli/fleet.ts:2683-2692`; inner reuse `:1365`, `:2125`.
- **Problem:** flag params leak parser shape; same-typed booleans swap silently. Only guard = source-text test `test/bun/cli-destroy-flags.test.ts:9-24` (greps `"destroyPath(force, discardUnsynced, park)"`). `--discard-unsynced` skips pre-teardown rescue → a swap is data loss.
- **Solution:** pass the parser's variant object (or a named options object); `destroyPath` takes the same.
- **Dependency:** in-process.
- **Characterization tests first:** per verb × flag combo → exact route path/query (fake Worker records URL). Then delete the source-text test.
- **Skill step:** #259 checklist "flag params leaking internals" + CD "simplify the parameters". **Strength:** Worth exploring.

### F15. Deepen deploy probes: hide wrangler argv model, config read, probe spawn + JSON scrape and 0/1/2 exit protocol behind one `scripts/deploy-probe.ts` used by both scripts — CLAUDE-ONLY (deploy, rescue, auth, secrets)

- **Files:** `scripts/deploy-target.ts:41-45`, `:47-96` (argv), `:98-118`, `:120-126` (`unstable_readConfig` `:123`), `:168-181` (spawn `:172`, scrape `:177`); `scripts/deploy-containers-changed.ts:33-37`, `:39-55`, `:60-65` (`:62`), `:79-89` (spawn `:83`, scrape `:87`); bash argv rules `scripts/deploy.sh:141`, `:170`, `:204`, `:233`; `deploy.sh:232` admits "applies the same rule again".
- **Problem:** wrangler argv parsed in 5 shell fns + 2 TS files; copies drifted (`CI: "1"` only in one; camelCase normalise + `-eprod` refusal only in `deploy-target`; empty `CLOUDFLARE_ENV` resolved differently `deploy-target.ts:104,149` vs `deploy-containers-changed.ts:54`). `deploy-containers-changed.ts` safe only because `deploy.sh` runs `deploy-target` first — ordering lives in bash.
- **Solution (PR 1, TS only):** shared module for config read + probe spawn + scrape + exit helper; argv parse unified in TS. Bash functions untouched in PR 1.
- **Behavior-preserving rule:** keep each drift as explicit option; unify by decision later.
- **Dependency:** true external (wrangler) → injected spawn.
- **Characterization tests first:** in-process table: argv → target/env/verdict for each existing `test/bun/deploy-rescue-gate.test.ts` case (~75, all spawn real bash today; header `:7-39` explains the timeout budget).
- **Skill step:** ICA §1 (coupling leaking across seam; shallow siblings callers must sequence). **Strength:** Worth exploring.

### Deferred / not ranked (ICA §2: surfaced, not top-15)

- **D1. `fleet ls` rendering (`cli/fleet.ts:264-445`, `:598-698`; `cli/readiness-format.ts`; `wip-format`, `restart-format`, `burn-format`, `fleet-totals`; `cli/reap.ts:185` `formatIdleAlarm`):** one concept over 8 files, split by test-runner reachability (`cli/burn-format.ts:1-8`), not knowledge; `readiness-format.ts` (hot spot, 9 commits) holds decision logic (`readyOverride`). ~300 L. GLM-OK slice = fold re-export `cli/fleet.ts:264` + move `formatIdleAlarm`; account cells (`formatAccount`, `formatDeadAccounts`) CLAUDE-ONLY (failover, admission).
- **D2. Repo targeting (`detectRepo()` ×15 in `cli/fleet.ts`, `reportRepo` ×15, `repoIdSegment` fold ×4 with three different fallbacks `:789`, `:802`, `:1117`):** rescue-all scope decides which studios get rescued pre-deploy. CLAUDE-ONLY. ~150 L.
- **D3. Board verbs (`boardRequest` `cli/fleet.ts:1264-1274` exits → re-implemented at `:1493-1530`, `:2239-2245`, `:2287-2296`, `:1306-1316`):** do after F1. Touches `rescue-gc`. CLAUDE-ONLY.
- **D4. Rescue call ×2 (`cli/fleet.ts:2006-2017` vs `:2113-2122`, reap copy lacks timeout → `timedOut` mapping):** do with F1 PR 2. CLAUDE-ONLY.
- **D5. Dead-account read ×2 (`cli/fleet.ts:685-691` vs `cli/accounts.ts:35-41`):** observation — comment `:681-684` says "must never break `fleet ls`" but a network error throws to `main().catch` and exits 1 after table printed. Fix = behavior change → own issue. CLAUDE-ONLY (failover).
- **D6. Container job host + token checkout (`container/server.ts:350-412` vs `deploy-server.ts:203-229`; `server.ts:155-176` vs `deploy-server.ts:116-159`, guards drifted `.git/HEAD` vs `.git/config`):** first step = export `createHandler()`, keep `Bun.serve` under `import.meta.main` so they become testable (`test/container.args.test.ts` regexes source today). CLAUDE-ONLY (deploy, secrets).
- **D7. CLI entry seam (`cli/fleet.ts:2620-2726` `main`, 35 `process.exit`):** `run(argv, io, client) → exitCode` removes most source-text tests. After F1. CLAUDE-ONLY (deploy gate calls it).
- **D8. Container ↔ Worker contracts (gate actions ×3: `container/server.ts:60`, `container/fleet-cli.ts:9`, `src/tasks/types.ts:3-5`; status types mirrored; `GhOp` ×2 `container/gh-proxy.ts:12-19` / `src/write-proxy/gh-route.ts:28-35`):** contract test first. CLAUDE-ONLY (approval gate = admission).
- **D9. Local-CI lane model (`scripts/localci/summarize.ts:115-121` vs `:153-168` rerun eligibility drifted; known-flaky parsed ×2 `:102-107` vs `scripts/sensors/run.ts:247-251`):** ~120 L. Lanes gate merges → CLAUDE-ONLY (admission) unless maestro rules local CI out of "admission"; then GLM-OK.
- **D10. merge-danger (`scripts/merge-danger.ts:127-134` drops each glob's `why`; JSON contract to `jq` untested; table misses `cli/fleet.ts` rescue-all):** classifier for all one-way doors. CLAUDE-ONLY.
- **D11. Sensors `main` (`scripts/sensors/run.ts:330-350`, failure isolation bug recorded `:263-282` lives in untested glue):** `runSensors(deps)`. Reads credentials/Access headers → CLAUDE-ONLY.
- **D12. `buildGridPage` (`scripts/build-page.ts:96-105`):** 3-line pass-through; inline it. GLM-OK, ~15 L — too small for its own issue; bundle into any GLM PR touching `scripts/`.

## 4. Top recommendation

**F1 Worker client** (CLAUDE-ONLY) — hottest file (`cli/fleet.ts`, 29 commits), ~36 copies of one dance with 5 error styles and missing timeouts; unlocks D3, D4, D7 and simplifies F13/F14 tests. **Fix-first observation:** F2's clip-before-scrub gap (`container/server.ts:294`) — small, security-positive, Claude lane.

**GLM lane first picks:** F6 repo check runner (clear duplicate, CI runs it on every PR, byte-identical output easy to verify), then F4 → F5 (ego-browser RPC then method map, in that order), F7 (~70 L warm-up).

## 5. Re-measure

Re-run metric (§1 definition) weekly per #259 Part D. Expected if F4-F12 (GLM-OK) land: test-only exports −15 to −25 (memguard tests move to `tick()`; english-check test-only exports go if F6 passes `root`), modules depth < 4 unchanged (F5 keeps `Page` public contract; the metric won't see the daemon-side gain), source-text test files unchanged (only F13, F14, D6, D7 remove them — Claude lane). The metric under-counts this sweep's GLM gains (entrypoint orchestration, duplicate protocols), so count findings closed too (#259 Part D).

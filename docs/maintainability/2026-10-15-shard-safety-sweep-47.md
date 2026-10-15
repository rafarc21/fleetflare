# Shard safety sweep 47 — apps/fleet tests that break when the suite is split (2026-10-15)

Ref #944, refs #715. Analysis only, read-only, no code changed. Forty-seventh
maintainability sweep; scope apps/fleet/test/** (vitest + bun). Line refs =
physical lines at origin/main `9ee708d1`, paths relative to `apps/fleet/`.

Method: static reading only (no full-suite run). Hunted the six shard-hazard
classes the brief names — module-level mutable singletons, process.env mutated
without restore, fixed ports, shared temp paths or files, global fetch/timer
stubs never restored, tests reading files other tests write — plus module-load
capability probes that change behavior per container.

**Tier rule:** GLM-OK = none of auth, secrets, tokens, credentials, rescue,
failover, accounts routing, deploy, migrations, write-proxy, leak-gate,
approvals. Every finding below is GLM-OK; no CLAUDE-ONLY findings this sweep.

## Findings

| # | file:line | shared state | failure mode when sharded / run alone |
|--:|---|---|---|
| F1 | test/bun/paste-cmd.test.ts:19, test/bun/paste-mac.test.ts:16 | fixed `/tmp/fleet-paste.png` | cross-file cleanup race |
| F2 | test/bun/memguard-docker.test.ts:53,101,108-146 | fixed `/tmp/ws`, `/tmp/child.pid`, `/tmp/claude`, `/tmp/marker.js`, `/tmp/hog.js`, `/tmp/leak.js` | stale scratch from a prior run |
| F3 | test/bun/install-cache-security-disk.test.ts:722-725 | module-load `canUnshareMount` + `process.env.CI` | skip-or-throw per container |
| F4 | test/bun/bringup-heartbeat-core.test.ts:37-71 | `cachedFakeClaude` / `cachedTmuxStubDir` singletons never cleaned | leaked dirs; stale on re-run |
| F5 | test/bun/session-memory.test.ts:156-160 | module-level LCG `seed` never reset | order-dependent fixture bytes |
| F6 | test/bun/orca-registry-rows.test.ts:1329-1339 | sole `mock.module("node:os")` restore | breaks if a second node:os mock is sharded in |

### S47-F1. paste-cmd + paste-mac — shared fixed `/tmp` clipboard path — GLM-OK

- **File:** `test/bun/paste-cmd.test.ts:19` and `test/bun/paste-mac.test.ts:16`
  both pin `PASTE_TMP = "/tmp/fleet-paste.png"` — the fixed, non-injectable
  path `cli/paste-mac.ts`'s `PASTE_TMP_PATH` uses (paste-mac.ts:11).
- **Shared state:** one machine-wide file. Both files `rmSync(PASTE_TMP)` in
  `beforeEach`/`afterEach`; paste-mac also asserts `existsSync(PASTE_TMP)`
  is true after a fake `pngpaste` writes it (paste-mac.test.ts:78-81).
- **Failure mode sharded:** bun runs these as separate processes (or the
  #715 gate runs them in two containers sharing `/tmp`). One file's
  `afterEach` `rmSync` lands between the other file's write and its
  `existsSync` assert → `expect(existsSync(PASTE_TMP)).toBe(true)` fails on a
  file it did not write, or a leftover from the other lane makes
  "no image" assertions pass/fail on foreign bytes.
- **Proposed fix:** make `PASTE_TMP_PATH` read from an env override (e.g.
  `FLEET_PASTE_TMP`), and have each test set it to its own `mkdtemp` path —
  same injectable-seam pattern `studioGitSafetyCmd`'s `wrapperPath`/`realGit`
  already use for exactly this reason.

### S47-F2. memguard-docker — fixed machine-wide scratch, no cleanup — GLM-OK

- **File:** `test/bun/memguard-docker.test.ts:53` (`/tmp/child.pid`), `:101`
  (`FLEET_WORKSPACE=/tmp/ws`), `:108-146` (`/tmp/marker.js`, `/tmp/hog.js`,
  `/tmp/leak.js`, `/tmp/claude`).
- **Shared state:** every path is an absolute `/tmp` literal. The file has no
  `beforeEach`/`afterEach`/`afterAll` (verified: zero hooks). The docker
  `--rm` run removes the container but not the host `/tmp` scratch.
- **Failure mode sharded:** a re-run of this file (shard retry, or two
  shards both running it) reads the previous run's `/tmp/ws/.fleet/memguard.log`
  at `:192` (`wc -l`) and `/tmp/child.pid` at `:145-146`; a stale pid from a
  crashed prior run feeds `kv.child_adj_at_birth` and the assertions that
  depend on it.
- **Proposed fix:** derive the workspace/scratch from a per-run `mkdtemp`
  prefix mounted into the container (`-v ${prefix}:/tmp/ws:rw`), and write
  `child.pid` under it — one throwaway prefix per test run.

### S47-F3. install-cache-security-disk — module-load capability probe — GLM-OK

- **File:** `test/bun/install-cache-security-disk.test.ts:722-725` —
  `canUnshareMount` (spawnSync probe) and `process.env.CI` are read at MODULE
  LOAD and choose the suite wrapper: `describe` / a throwing placeholder /
  `describe.skip`.
- **Shared state:** the probe result and CI flag are fixed for the whole
  process before any test runs.
- **Failure mode sharded:** the #715 gate splits the suite across containers
  with different capabilities. A container where `unshare -r --mount` is
  unavailable but `CI=true` gets the throwing placeholder test, failing the
  entire file; a container with the capability but `CI` unset silently skips
  the real ENOSPC proof — the exact silent-cap shape the brief calls out.
- **Proposed fix:** probe per run at file load but, when `CI=true` and the
  probe fails, `test.skip` with an explicit marker instead of throwing — a
  skipped proof is visible in the shard report, a thrown placeholder fails
  the whole shard.

### S47-F4. bringup-heartbeat-core — cached module singletons never cleaned — GLM-OK

- **File:** `test/bun/bringup-heartbeat-core.test.ts:37-45`
  (`cachedFakeClaude`) and `:56-71` (`cachedTmuxStubDir`) hold `mkdtemp`'d
  directories in module-level variables; no `afterEach`/`afterAll` ever
  `rmSync`s them (verified: the only `rmSync` calls are per-test temp dirs,
  never the cached ones).
- **Shared state:** the cache means every test in the file reuses one stub
  binary dir for the process lifetime.
- **Failure mode sharded / run alone:** run alone, the file leaks two tmpdirs
  per process. Re-run (shard retry) returns a cached path whose directory may
  already be reaped by tmpfs cleanup → a stale `claude`/`tmux` stub binary
  path, failing the spawn that relies on it.
- **Proposed fix:** `rmSync` both cached dirs in an `afterAll`, or rebuild the
  stub contents into a fresh dir per `beforeAll` and clear the cache.

### S47-F5. session-memory — module-level LCG seed never reset — GLM-OK

- **File:** `test/bun/session-memory.test.ts:156-160` — `let seed = 7` drives
  `rnd()`; `line(i)` builds synthetic session snapshots from it. `beforeEach`
  resets `maxWrite`/`sinceSample` (`.ts:79-80`) but never `seed`.
- **Shared state:** the byte content of every generated snapshot depends on
  how many `rnd()` calls earlier tests made — order-dependent fixture bytes.
- **Failure mode sharded:** reordering tests (or inserting one before an
  existing one) changes the generated jsonl bytes, which feed the
  `maxWrite`/`peak` measurements. Today's assertions are
  `toBeGreaterThan(0)`-style and survive, but any future exact-size assertion
  becomes a flake with no visible cause.
- **Proposed fix:** reset `seed = 7` in `beforeEach` so each test's fixture
  content is deterministic and order-independent.

### S47-F6. orca-registry-rows — sole node:os mock, restore depends on solitude — GLM-OK

- **File:** `test/bun/orca-registry-rows.test.ts:1329-1339` — the
  salvage-destination redirect is the repo's ONLY `mock.module("node:os")`.
  The file's own comment states the constraint: "this is the repo's only
  node:os mock (a second one would have to capture before that one)"; it
  restores by spreading a captured `realOs` back in `finally`.
- **Shared state:** `node:os` module registry is process-global in bun.
- **Failure mode sharded:** a shard that runs any second file also mocking
  `node:os` (now, or added later) makes this file's `finally` restore `realOs`
  OVER the other file's mock — silently breaking the other file's homedir
  redirect, or vice-versa when this file's capture runs after another mock is
  already installed.
- **Proposed fix:** pass the salvage destination as an injected parameter
  rather than reading `homedir()` (the production 2-param call already takes
  a destination), or capture `realOs` lazily and assert no other node:os mock
  is active before installing.

## Ruled out (verified clean, not findings)

- **Vitest lane:** every `globalThis.fetch` stub is installed in `beforeEach`
  and restored in `afterEach`; every `vi.useFakeTimers()` is paired with
  `vi.useRealTimers()` (file-level `afterEach` or per-test `finally`); every
  `process.env.*` mutation is restored in `afterEach`/`finally`. D1 is
  isolated per test by vitest-pool-workers ("implements isolated per-test
  storage"), so the `beforeEach DELETE FROM fleet_state/events` sweeps are
  defense-in-depth, not load-bearing.
- **Fixed ports:** every `Bun.serve` in the bun lane uses `port: 0`; no
  `.listen()`/`createServer()`/fixed port anywhere in apps/fleet/test.
- **Repo-checkout writes:** no test writes into the committed tree — every
  `writeFileSync` goes to `mkdtemp`/`tmpdir`/`/tmp` scratch.
- **Module-level `let calls = []` arrays** in the vitest files (github.api-*,
  telegram.api, approvals.gates, tasks.loop, deploy.run, github.app, directus,
  board.*) are all reset in `beforeEach`.
- **env mutations with restore:** junior-auth, real-git-preload,
  bringup-claude-relaunch, orca-registry all restore `process.env` in
  `afterEach`/`finally`.

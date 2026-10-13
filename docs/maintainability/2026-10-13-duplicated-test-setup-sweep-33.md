# Duplicated-test-setup sweep 33 — apps/fleet/test + test/bun (2026-10-13)

Ref #733. Thirty-third maintainability sweep; scope: fixture/mock/builder code copy-pasted in 3+ test files under `apps/fleet/test/`. Doc-only, read-only, no code changed. Line refs = physical lines at `origin/main` `f7fdeaf` on 2026-10-13, paths relative to `apps/fleet/test/`.

Method: scripted helper-body census — every function/const-arrow definition in every `*.test.ts` under `apps/fleet/test` (helpers/ and bun/helpers/ excluded as destinations), bodies brace-matched, whitespace-normalized, md5-grouped; same-name-divergent groups listed by hand. Every group below then re-verified by reading the copies in the files. Sweep 18 (#537) already extracted the helpers it found (board-api, studio-row, tmux-env, poll, credentials, exec-snippet — all landed); this sweep files only NEW clusters and sweep-18 leftovers that are still live.

**Lane rule:** a finding is CLAUDE-ONLY if its subject touches auth, secrets, tokens, credentials, rescue, failover, accounts routing, deploy, migrations, write-proxy, leak-gate or approvals. Fixture values in these files are fake, never real credentials — the rule is about who should do the refactor, not about the values.

## Findings

| # | finding | copies | tier |
|--:|---|---|---|
| F1 | `tmpDir(prefix)` + `const FLEET` + `tempDirs` cleanup trio | 7 files | GLM-OK |
| F2 | `fakeCtx()` ExecutionContext queue-drain fake | 8 files | GLM-OK |
| F3 | `authorized()` verifyAccess spy | 8 files | CLAUDE-ONLY |
| F4 | `ok()`/`ORCA_ENV`/`terminals()` orca-result fixtures | 4 files | GLM-OK |
| F5 | adopt-fixture consts (ROOT_KEY/WT_KEY/WT_ID/ROOT_ID/CLI/SDK/TEAMMATE) | 4 files | GLM-OK |
| F6 | `FAKE_FLEET_JSON`/`FAKE_ORG_JSON`/`FAKE_ROLE_MD` blueprint fixtures | 7 files | GLM-OK |
| F7 | `envWithFakeStudio` env-builder family | 6 files | GLM-OK |
| F8 | SECTION_* transcript marker consts | 3 files | GLM-OK |
| F9 | `session(over)` ObservedSession builder | 3 files | GLM-OK |
| F10 | `sign(body)` webhook HMAC signer (sweep-18 F8, grown 2→3) | 3 files | GLM-OK |
| F11 | `b64Utf8(s)` UTF-8 base64 encoder | 3 files | GLM-OK |
| F12 | `row(id, hash, repoSlug)` spawn-token StudioStatus row | 3 files | CLAUDE-ONLY (creds.route lane) |
| F13 | `status()` 11-null StudioStatus builder — sweep-18 F9 leftovers | 11 files | CLAUDE-ONLY majority; 2 GLM-OK |
| F14 | gate-fixture quartet `ID`/`TOKEN`/`ContainerProto`/`FAKE_OAUTH` | 5 full + 1 partial | CLAUDE-ONLY |
| F15 | `REPO` + `testEnv` AGENT_REPO pair | 6 files | GLM-OK 3 / CLAUDE-ONLY 3 |

### F1 — `tmpDir(prefix)` + `const FLEET` + `tempDirs` cleanup trio — GLM-OK

7 bun-lane CLI suites carry the same three-part setup: `const FLEET = join(import.meta.dir, "../../cli/fleet.ts")`, a `tmpDir(prefix)` that mkdtemps and pushes into a local `tempDirs: string[]`, and an afterEach that rmSyncs the stack. Copies: `bun/accounts-cli.test.ts:19,22`, `bun/cli.task-verify.test.ts:31,34`, `bun/memory-cmd.test.ts:18,21`, `bun/cli.task-reap.test.ts:17,24`, `bun/paste-cmd.test.ts:17,26`, `bun/paste-mac.test.ts:23`, `bun/task-state-cli.test.ts:17,20` (tmpDir only in paste-mac; FLEET only in the other 6 — 5 files carry both). `bun/cli.task-reap.test.ts` has FLEET at :17, tmpDir at :24. Also present in `bun/cli-check-clear-guard.test.ts:46` (tempDirs+tmpDir, same shape) and `bun/cli-destroy-unmerged.test.ts:203` (function-scoped variant, noted not folded). All bodies byte-identical where present. Proposed home: new `bun/helpers/fleet-cli.ts` exporting `FLEET`, `tmpDir(prefix)` bound to one module-level `tempDirs`, and `registerTempCleanup()` to call in afterEach — or simplest: `tmpDirs()` returning {dir, cleanup}. Estimated lines removed: ~60 (7×3-line tmpDir + 7×2-line cleanup + 6×1-line FLEET).

### F2 — `fakeCtx()` ExecutionContext queue-drain fake — GLM-OK

8 vitest suites hand-roll a fake `ExecutionContext` whose `waitUntil` queues promises into a `tasks` array (mostly with a `.catch(() => {})` to swallow unobserved rejections) plus `passThroughOnException`, and — in the drainable variant — `drain(): Promise.all(tasks)`. Copies: `github.webhook-core.test.ts:95`, `github.webhook-autoclose.test.ts:95` (plain-function variant, no vi.fn, drain), `exceptions.test.ts:12`, `index.test.ts:57` (no drain), `junior.usage.test.ts:30`, `junior.route.test.ts:34`, `llm.anthropic-route.test.ts:32` (vi.fn variant, drain), `studio.glm-leadtype-persist-do.test.ts:95` (typed-return variant, no vi.fn, no drain). Genuine shapes: 3 (vi.fn+drain, plain+drain, no-drain). Proposed home: new `helpers/fake-ctx.ts` exporting `fakeCtx({drain: boolean})` or two named exports `queuedCtx()`/`drainingCtx()`. Estimated lines removed: ~50 (8×6-7 lines).

### F3 — `authorized()` verifyAccess spy — CLAUDE-ONLY

Byte-identical one-liner `vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null)` in 8 files: `studio.routes-handle.test.ts:404`, `studio.routes-accounts.test.ts:406`, `studio.grid.test.ts:56`, `studio.paste.test.ts:58`, `board.open-prs-route.test.ts:59`, `board.routes.test.ts:69`, `studio.ws.test.ts:30`, `studio.spawn.test.ts:164`. Each imports `authModule` only to spy it. This mocks the auth boundary — auth lane → CLAUDE-ONLY. Proposed home: `helpers/http.ts` (already owns `authorizedReq` — same boundary) exporting `mockAuthorized()`. The helper must return the spy so `vi.restoreAllMocks`/`mockRestore` semantics stay caller-owned. Estimated lines removed: ~24 (8×3: import+fn).

### F4 — orca-result fixtures `ok()`/`ORCA_ENV`/`terminals()` — GLM-OK

4 bun-lane orca suites share three fixtures: `const ORCA_ENV = { TERM_PROGRAM: "Orca" }`, `ok(stdout): OrcaResult` returning `{ok:true, stdout, stderr:"", timedOut:false}`, and `terminals(...connected)` building the `list-terminals` JSON payload. Copies: `bun/orca-registry.test.ts:49,51,187`, `bun/orca-ensure.test.ts:39,41,177`, `bun/print-attach-handle.test.ts:16,18`, `bun/fleet-tabs-scope.test.ts:29,31,88`. All byte-identical. Proposed home: new `bun/helpers/orca-fixtures.ts`. Estimated lines removed: ~45 (4×3 consts + 3×7-line fns).

### F5 — adopt-fixture consts — GLM-OK

4 bun-lane adopt/bringup suites copy the same fixture session-key/ids and transcript first-line shapes: `ROOT_KEY`/`WT_KEY`/`WT_ID`/`ROOT_ID`/`CLI`/`SDK`/`TEAMMATE`. Copies: `bun/studio-adopt.test.ts:21-28`, `bun/worktree-session-adopt.test.ts:24-31` (full set), `bun/bringup-session-adopt.test.ts:32-34` (WT_KEY/WT_ID/CLI), `bun/bringup-fresh-session.test.ts:28-30` (divergent repo-key spelling `-workspace-acmeclient`, noted not folded). The full-set pair `studio-adopt`+`worktree-session-adopt` also share `projects(key)` and `session(key,id,body,ageSeconds)` byte-identical (5 lines each). Proposed home: new `bun/helpers/adopt-fixtures.ts` exporting the constants + `projects()` + `session()`; the fresh-session spellings stay local (different fixture repo). Estimated lines removed: ~35.

### F6 — `FAKE_FLEET_JSON`/`FAKE_ORG_JSON`/`FAKE_ROLE_MD` blueprint fixtures — GLM-OK

7 suites carry a fake fleet-blueprint triple: a fleet.json payload, an org.json payload, and a role .md frontmatter block, plus often a `fakeFetchBlueprintFile()` dispatching on path suffix. Copies: `studio.routes-handle.test.ts:64,87,90` + `fakeFetchBlueprintFile` :92, `studio.routes-accounts.test.ts:66,89,92` + :94 (routes-handle/routes-accounts byte-identical to each other), `studio.refresh.test.ts:40,53` + :55, `studio.provision.test.ts:37,40,43`, `directus.provision.test.ts:25,28,30`, `studio.recycle-guard.test.ts:69,72,82`, `studio.spawn.test.ts:44,49,63`. Divergence is load-bearing: fleet.json role lists differ per suite (["pilot"] vs ["pilot","scratch"] vs 4 roles), ref differs (main vs v1.0.0), role .md name/allowedTools differ — the fixtures encode each suite's own org shape. Foldable part: the `fakeFetchBlueprintFile` path-suffix dispatcher (3 near-identical) and a `fakeBlueprint({repo, ref, roles, roleMd, org})` builder with sensible defaults. Proposed home: new `helpers/blueprint-fixture.ts` exporting `fakeBlueprintFiles(opts)` returning the three strings + optional dispatcher. Estimated lines removed: ~80 (7 suites × ~10-12 fixture lines collapsed to builder calls).

### F7 — `envWithFakeStudio` env-builder family — GLM-OK

Same name, four genuinely different signatures (NOT one fold): `studio.routes-handle.test.ts:353` and `studio.routes-accounts.test.ts:355` (10-param provision-harness builder, byte-identical to each other), `studio.paste.test.ts:45` (writeFile fake), `studio.grid.test.ts:43` (tails map), `studio.burn-window-expiry.test.ts:69` (no-arg), `studio.ws.test.ts:138` (attachPty). ONLY the routes-handle/routes-accounts pair is a fold: those two files are a split of one former suite (PR #728, S26-F3) and their 40-line builders + `fakeStudioNamespace` + `fakeStorage` bodies are byte-identical copies kept in sync by hand. Also byte-identical pair: `fakeFetchBlueprintFile` :92/:94 and `fakeStudioNamespace` :128/:130. Proposed home: new `helpers/routes-studio-harness.ts` owning the shared pair; the other four stay local (different deps). Estimated lines removed: ~90 (routes-accounts drops its duplicate of ~90 shared lines).

### F8 — SECTION_* transcript marker consts — GLM-OK

3 suites spell the transcript section-marker literals from `src/studio/transcript.ts:266-272`: `studio.transcript.test.ts:18-25` (8 markers incl. SECTION_PANE/SECTION_MEMGUARD/SECTION_ACTIVITY_HOOK), `studio.restart-count.test.ts:23-27` (5), `bun/transcript-wire-equivalence.test.ts:20-24` (5). Proposal: export the markers from the source module (`src/studio/transcript.ts` already defines them as consts — export them) and import in tests; no test helper needed. This is the same pattern `helpers/bringup-pins.ts` solved for the bring-up script. Estimated lines removed: ~15.

### F9 — `session(over)` ObservedSession builder — GLM-OK

3 files build the same ObservedSession fixture: `studio.survival-retry.test.ts:54` and `studio.survival-input.test.ts:54` byte-identical (`verdict:"resumed", at: NOW, via:"recycle", restore:"restored", snapshotAgeS:600, turnsBefore:12, reason:null`); `cli.recycle-outcome.test.ts:29` diverges on fixture values (at frozen 2026-09-30, snapshotAgeS 5, turnsBefore 3) — same shape, different defaults, foldable via overrides at call sites. `studio.survival-retry/input` also share `captured()` (already sweep-18 F5, CLAUDE-ONLY, left out here) and an OBSERVED_KEY map-storage pair. Proposed home: new `helpers/observed-session.ts` exporting `session(over)`. survival-retry/survival-input are a S26-F10 split pair keeping copies in sync by hand. Estimated lines removed: ~12.

### F10 — `sign(body)` webhook HMAC-SHA256 signer — GLM-OK

Sweep 18 F8 was ×2 below the bar; a third copy has since landed (PR #720 split): `github.webhook-core.test.ts:13`, `github.webhook-autoclose.test.ts:13` (byte-identical pair, core/autoclose split of one file), `public-flags.test.ts:36` (same logic, different secret const name). Fold: `helpers/webhook-sign.ts` exporting `sign(body, secret)`. Estimated lines removed: ~12. Sweep-18 F12's `TIMEOUT_SHIM_DIR` gtimeout shim is still live ×3 (bun/rescue-push.test.ts, bun/git-wrapper.test.ts, bun/rescue-leak-gate.test.ts, re-verified 2026-10-13) — remains CLAUDE-ONLY and unfiled here; the perl-fallback divergence documented in sweep 18 still applies.

### F11 — `b64Utf8(s)` UTF-8 base64 encoder — GLM-OK

3 byte-identical copies of `btoa(String.fromCharCode(...new TextEncoder().encode(s)))`: `studio.transcript.test.ts:115`, `studio.observation-tick.test.ts:30`, `studio.failover-274.test.ts:88`. Related but not folded: `helpers/datetime.ts` `b64(bytes)` (byte-array input, different domain). Proposed home: `helpers/datetime.ts` next to `b64` (the file's header already says it owns small encoders) or new `helpers/b64.ts`. Estimated lines removed: ~9. failover-274 is failover-lane in subject but the helper itself is a pure encoder — GLM-OK to migrate the other two; failover-274's copy listed CLAUDE-ONLY in the filing.

### F12 — `row(id, hash, repoSlug)` spawn-token StudioStatus row — CLAUDE-ONLY

3 byte-identical copies: `junior.usage.test.ts:203`, `junior.route.test.ts:24`, `creds.route.test.ts:29`. Builds a running StudioStatus with an explicit spawnTokenHash — a spawn-token fixture. `creds.route.test.ts` is credentials-lane (its fixture table names Infisical secret paths) → whole batch CLAUDE-ONLY. Also near-identical sibling `llm.anthropic-route.test.ts:27` (adds leadType param — noted, not folded). Proposed home: `helpers/studio-row.ts` (add `rowWithHash(id, hash, repoSlug)`), or keep local per lane rule. Estimated lines removed: ~9.

### F13 — `status()` 11-null StudioStatus builder — sweep-18 F9 leftovers — CLAUDE-ONLY majority; 2 GLM-OK

Sweep 18 F9 adopted `helpers/studio-row.ts` `row()` in 9 clean files; 11 copies remain (hand-rolled `function status(overrides)` or arrow `const status = (o) => ...`), all byte-identical 11-null literals with per-suite id/state defaults: `studio.account-by-repo.test.ts:41`, `studio.refresh.test.ts:76`, `studio.account-failover.test.ts:64`, `studio.auto-continue.test.ts:61`, `studio.replacement-restore.test.ts:44`, `studio.replacement-restart.test.ts:64`, `studio.worktree-session.test.ts:27`, `studio.registry.test.ts:14`, `studio.account-launched.test.ts:54`, `studio.parked-auto-resume.test.ts:83`, `studio.spawn.test.ts:139`. Arrow-wrapped adopters already exist elsewhere (grid, fleet-resume, burn, etc.) and are fine. Lane split per sweep-18 F9's own carve-outs (re-verified live 2026-10-13): refresh (credentialWriteCmd describes), registry (limited-account reroute describe :301), worktree-session (failover relaunch describe :138), account-by-repo, account-failover, auto-continue, account-launched, parked-auto-resume, spawn → CLAUDE-ONLY. GLM-OK: replacement-restore, replacement-restart only (their describes are restart/restore/verify — no failover/auth; note studio.replacement.test.ts itself was sweep-18-ruled CLAUDE-ONLY, but these two are different files split from it later). Fix: adopt `row({id, state: "running", ...})`. Estimated lines removed: ~50 (11×4-5 lines).

### F14 — gate-fixture quartet `ID`/`TOKEN`/`ContainerProto`/`FAKE_OAUTH` — CLAUDE-ONLY

6 suites test the container-start gate with the same fixture block: `const ID = "fleetflare--web-studio"`, `const TOKEN = "spawn-token-fixture"`, `const ContainerProto = Object.getPrototypeOf(Sandbox.prototype) as {...}` (start/startAndWaitForPorts spy surface), some plus `const FAKE_OAUTH = "sk-ant-oat01-" + "a".repeat(40)` and a `class Started extends Error`. Copies: `studio.start-gate.test.ts:31-33`, `studio.account-gate-do.test.ts:21-24`, `studio.destroy-race.test.ts:49-52`, `studio.recycle-mapped-rescue-do.test.ts:33-36`, `studio.recycle-remap-race-do.test.ts:25-31` (full quartet ×5), plus `studio.glm-leadtype-persist-do.test.ts:38-39` (partial member only: FAKE_OAUTH + ContainerProto; its ID diverges — `fleet300-glm-e2e--web-studio`, no TOKEN — folds only the oauth/proto pair). Subjects: start-gate + accounts-routing + rescue — CLAUDE-ONLY. Values are fixtures, never real tokens. Proposed home: new `helpers/container-gate-fixture.ts`. Estimated lines removed: ~30.

### F15 — `REPO` + `testEnv` AGENT_REPO pair — GLM-OK

7 files spell `const REPO = "..."` plus `const testEnv = { ...env, AGENT_REPO: REPO } as unknown as Env` (or the inline-literal variant). Spelling groups re-verified: `board.fleet-directs.test.ts:21-22` alone spells `example-org/websites`; `board.fleet-routes.test.ts:23,25`, `memory.routes.test.ts:19,21`, `board.read-repos.test.ts:20,23` (adds GITHUB_APP_PRIVATE_KEY), `board.routes.test.ts:54` (inline literal), `board.open-prs-route.test.ts:29` (inline literal) spell `acme-org/websites`. `board.close-action.test.ts:21` is NOT a member — it has no REPO const and no AGENT_REPO (correction from this sweep's first review round). Fold: `helpers/env-with.ts` exporting `repoEnv(repo, extra)` = `{...env, AGENT_REPO: repo, ...extra} as unknown as Env`. Lane carve-outs per sweep-18 F6 precedent (re-verified live): `board.fleet-routes.test.ts` (auth describe :106) and `board.routes.test.ts`, `board.read-repos.test.ts` (auth/token describes) → CLAUDE-ONLY. GLM-OK: fleet-directs, memory.routes, open-prs-route. Estimated lines removed: ~10.

## Not filed

- `deps()` (24 same-name files) — name-sharing idiom for per-suite ports bags; bodies genuinely divergent (different deps types, different fakes). Not copy-paste.
- `fakeStorage()` variants (28 files) — sweep 18 F10 already ruled: divergent by design (multi-key seeds, failure injection, Pick shapes); only 5 byte-identical clones were filed CLAUDE-ONLY and remain unmerged. Not re-filed.
- `envWith(vars)` (4 files, 3 byte-identical) — 2-line wrapper over a spread with DB; below the payoff bar on its own, folded into the F15 filing's helper if wanted.
- `fakePty()` (3 ws files) — same idiom, diverging handles (writes counter, cancelled flag, closes counter); folding changes what each suite can assert. Left local.
- `fakeSyncDeps` (4 files) — same name, four different signatures/option sets (session.test's 9-field opts, destroy's rescue/harvest answers, readiness/replacement-restart's exec-delegating shape). Genuinely divergent.
- `harness()` (5 files) — same name, divergent bodies (survival tmux harness vs failover harness vs bringup sh harness). Not copy-paste.
- `row(overrides)` 1-arg StudioStatus builders (ff, resume-guards, bun/cli.fleet-ls-prs) — same literal family as F13/F12 but only 3 files with three different default ids; adopting helpers/studio-row row() covers them — listed under F13's fix, not filed separately.

## Summary

15 findings: 9 GLM-OK clusters with proposed shared homes (new `bun/helpers/` modules: fleet-cli, orca-fixtures, adopt-fixtures; new `helpers/` modules: fake-ctx, blueprint-fixture, routes-studio-harness, observed-session, webhook-sign; additions to existing: helpers/http.ts, helpers/datetime.ts, helpers/studio-row.ts, src/studio/transcript.ts export), 3 CLAUDE-ONLY findings (F3 authorized spy — auth, F12 rowWithHash — creds lane, F14 gate quartet — rescue/accounts), 2 mixed findings filed split (F13, F15), F10 grew from sweep 18's below-bar observation into a 3-copy fold. Estimated total lines removed if all land: ~430.

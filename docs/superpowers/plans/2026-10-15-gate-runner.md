# Gate Runner (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**v2 note:** This revision folds in 3 real review comments that landed on issue #715 after this plan was first written (scheduling-policy choice, outbound-handler credential isolation, the GitHub App's missing `statuses` permission), plus knock-on corrections to shard count, Workflow fan-in design, `GATE_KV` removal, CLI verb spacing, `fleet.json`'s location, `ONE_WAY_GLOBS`, the `classify` required check, and the browser lane's primary/fallback order. Every task number below is unchanged from v1 except: Task 5 is repurposed (was `GATE_KV` pointer, now an R2 baseline-key helper, no KV); new Tasks 0a/0b (operator-run preconditions, Wave 0), 15, 16, 17 are appended rather than inserted, so no existing cross-reference by number needed renumbering.

**Goal:** Ship Phase 1 of #715's rollout — Workflow `gate` + `GateRunnerDO` container class (Cloudflare Containers `durable_object` scheduling policy, not `default` — see Task 0a/1) + `gate/` R2 prefix (no `GATE_KV`; baseline lookup is a deterministic R2 key, R2 reads are already strongly consistent) — for `rafarc21/fleetflare` only, entirely behind `FLEET_GATE_RUNNER` (default `"off"`) and `GATE_RUNNER_REPOS`. Phases 2 (the other two repos #715 names, config only) and 3 (default-on fleet-wide) are out of scope for this plan — they are config/flag changes on top of what Phase 1 ships, not new code, and are mentioned only where they'd otherwise look like a design gap.

**Architecture:** Three new primitives, each a thin layer over an existing pattern this codebase already uses: a `Container<Env>`-based `GateRunnerDO` (same shape as `AgentDO`/`DeployDO`, but on the `durable_object` scheduling policy, decided once at class creation and never changed after — Task 0a/1/10), a `WorkflowEntrypoint` class `GateWorkflow` that resolves PR state, fans out one `GateRunnerDO` leg/shard per container via short `waitForEvent`/`sendEvent` steps (not a naive `step.do` per leg — Task 14), fans in to one `gate/verdict` commit status, and a `gate/` R2 prefix for both results and baseline caching — parallel, not substituting, `install-cache.ts`'s existing `caches/` prefix pattern. Pure decision logic (shard bucketing, verdict aggregation, merge-tree exit-code interpretation, config parsing, baseline keying) is split into small, directly-unit-testable modules so the tasks that actually mint/use a credential (`GateWorkflow`, the new outbound-handler task) are as small as possible — see the CLAUDE-ONLY/GLM-OK tag table below.

**Tech Stack:** Cloudflare Workflows, `@cloudflare/containers` (`Container<Env>`, `durable_object` scheduling policy, container snapshots, outbound traffic handlers), Durable Objects, R2 (`STUDIO_ARCHIVE`, existing bucket — no new KV namespace), Bun (container-side scripts, matching `container/server.ts`'s own style), vitest (`cloudflare:test` pool) + bun test, existing fleet CLI (`apps/fleet/cli/`).

**Spec:** `docs/superpowers/specs/2026-10-15-gate-runner-design.md` (as of 2026-10-15; a parallel task is revising it for a CF-maximal-fan-out directive AND for this same round of real review comments — this plan does not wait for that revision and does not touch the spec file; it is grounded in the version read on 2026-10-15, the operator's own 08:25Z follow-up comment on issue #715, and the 3 real review comments this v2 revision folds in; see "Guesses / gaps for a second pass" at the end).

## Global Constraints

- Phase 1 only: `rafarc21/fleetflare`, behind `FLEET_GATE_RUNNER=off` default and `GATE_RUNNER_REPOS=rafarc21/fleetflare`. No task below configures either of #715's other two named repos or flips any default to `on`.
- **`GateRunnerDO` is created on the `durable_object` Cloudflare Containers scheduling policy, never `default`.** This is a one-time, unchangeable-after-creation choice (Cloudflare Containers only let you pick a DO class's scheduling policy at creation; `default` gets its image/size from the wrangler config with no snapshot or outbound-traffic-handler support, `durable_object` additionally fixes the image + outbound-internet choice at creation, defaults to `instance_type: "lite"` unless overridden, and is the ONLY policy that supports `ctx.container.exec()`, container snapshots, and outbound traffic handlers). Task 0a decides this before any container exists; Task 1's wrangler sketch and Task 10's class both carry it explicitly. **Every task below that assumes snapshot-restore or outbound-handler behavior (Tasks 10, 11, 16, and Task 1's baseline-cache note) is sequenced after Task 0a/1, never before — this is a hard ordering constraint, not a convenience.**
- `GateRunnerDO` never touches `StudioDO`/`StudioBigDO` or `apps/fleet/src/studio/rescue.ts`/`failover.ts`/`destroy.ts` — it is its own DO class, its own container entry, its own Dockerfile, zero shared code path.
- **No raw credential (GitHub token, R2 write key) is ever passed into a `GateRunnerDO` container, in any field, env var, or URL — not even a presigned URL** (v1 of this plan used presigned PUT/GET URLs for the container's result upload and baseline restore; a real review flagged this as forgeable: "PR code runs beside the result-upload URL → PR can forge its own verdict," since a presigned URL IS itself a bearer credential once minted). The fix (Task 16, CLAUDE-ONLY): a Worker-side outbound traffic handler — only available under the `durable_object` scheduling policy — intercepts the container's own plain outbound `fetch` calls and injects the real credential server-side; the container never sees a token, key, or signed URL of any kind. Phase 1's repo (`rafarc21/fleetflare`) is additionally public, so the GitHub-clone leg of this doesn't even need the outbound handler to inject a token (anonymous HTTPS clone) — but the R2 result-PUT leg does, for every leg, from Phase 1 on. (Phase 2 private repos will need the outbound handler to also inject a GitHub token for cloning — explicitly out of scope here, flagged in Task 16's own header.)
- One aggregated commit-status context: **`gate/verdict`**. States `pending`/`success`/`failure`/`error` per the spec's own state machine (error never silently downgraded to failure). Posting it is blocked on Task 0b (operator precondition: the GitHub App this repo's `GITHUB_REPO_AUTH` maps every owner to today needs `Commit statuses: write` added — this was speculatively called an "unverified PAT scope" in the earlier ci-steward spec; it is now confirmed to be a GitHub App permission gap, not a PAT scope, per a real review comment and this repo's own `resolveRepoAuthKind`/`GITHUB_REPO_AUTH` config, `apps/fleet/src/github/auth.ts:189-281`).
- **`classify` (the maestro's one-way-door check, `.github/workflows/one-way-door.yml`, `apps/fleet/scripts/merge-danger.ts`) stays a required check, unconditionally.** Nothing in this plan removes it from the maestro's required-checks set, and nothing in this plan's `gate/verdict` context is a substitute for it — `gate/verdict` is a new, additional required check, sitting alongside `classify`, not replacing it. Task 17 adds this plan's own new paths to `classify`'s `ONE_WAY_GLOBS` so gate-runner source gets the same one-way-door protection every other credential-bearing path already has.
- Image-change tasks (the Dockerfile, the `containers[]` `image` field) ship only at an operator-approved image window. Every task below says explicitly whether it is an image-change task.
- No task in this plan runs `wrangler deploy`, touches a live `wrangler.jsonc`, or applies a migration — **except Task 0a**, which by necessity stands up one real `durable_object`-policy `GateRunnerDO` against a live Cloudflare account to measure snapshot-restore time and shard wall time; it is explicitly operator-run, not an agent-executed task with a diff, and its own section says so. Every other task edits `apps/fleet/wrangler.example.jsonc` (the public template) and new/existing source files only.
- PR bodies: `refs #715`, never a closing keyword.
- R2 keys under `gate/` are one distinct key per shard/leg per run (`gate/<owner>/<repo>/runs/<run-id>/shard-<leg>.json`) — no two legs of the same run ever write the same key, so R2's 1-write/sec-per-key cap is never contended by a single run's own fan-out (https://developers.cloudflare.com/r2/platform/limits/). **No `GATE_KV` namespace** (v1 had one, for a `main-sha:<owner>/<repo>` baseline pointer): R2 reads are already strongly consistent immediately after a write, and KV is eventually consistent (≥60s elsewhere in this codebase's own experience) — unnecessary complexity for a lookup that is just a `GET`/`HEAD` on a deterministic key (`<main-sha>-<lockfile-hash>`, Task 5). If a task below still names `GATE_KV` or `kv-pointer.ts`, that is stale v1 text; it should not exist after this revision.
- Workflows limits to design within, not re-derive: 10k steps/instance default (25k paid), 50k concurrent instances (paid), 30s/5min per-step compute (default/paid) — https://developers.cloudflare.com/workflows/reference/limits/. **Default step behavior is 5 retries with backoff and a 10-minute per-attempt timeout — a real review flagged that a naive "run the tests, return" step would get this retry treatment on a genuinely red test (thrown as an exception), surfacing a real test failure up to 60+ minutes late, as if it were an infra flake.** Task 14's fan-out is therefore NOT one `step.do` per leg; each shard is a short, idempotent `start-shard-i` step using `waitForEvent`/`sendEvent` with its own explicit per-shard timeout, and a red test comes back as DATA in the shard's result payload (a `LegResult` with `state: "failure"`), never as a thrown step exception. A fan-out of ~4 fixed legs + N vitest shards (N sized per Task 8, 15–18 total containers per PR — see Task 8) stays far under the step count either way.
- Containers account-wide cap: 1,500 vCPU / 6 TiB memory / 30 TB disk (https://developers.cloudflare.com/containers/platform-details/limits/). `max_instances` for `GateRunnerDO` is still the spec's own open question in the strict sense that the operator picks the final number, but Task 0a's spike and Task 8's real CI-timing data now give it a concrete starting range (15–18 containers per PR, not the earlier 24–28 guess) instead of an abstract placeholder — Task 1's wrangler sketch carries that range forward, flagged as measured-but-not-yet-operator-finalized.
- Browser lane (if any gate leg needs a real browser): Cloudflare's current **Browser Run** (renamed from "Browser Rendering") does not yet fully support the Playwright Test runner — only a Playwright-assertions fork and raw CDP connections — so it is a smoke-only addition (hitting public URLs) for now, not the primary mechanism for a real e2e leg; in-container Chromium (today's `scripts/localci/Dockerfile`-baked Playwright, already proven by the real `bun-test` lane) is PRIMARY. 200 concurrent Browser Run sessions/account on Paid — https://developers.cloudflare.com/browser-rendering/platform/limits/. Task 9 is a spike/evaluation, not a switch, and includes the open CDP-feasibility question.

## CLAUDE-ONLY vs GLM-OK tags

Updated per the real review comment on outbound handlers (a Worker-side outbound handler, not the container, is where a credential lives now) and the GitHub App permission precondition. The blueprint's banned-areas list (auth, secrets, tokens, credentials) is the test applied to each task below, not a guess.

| Task | Tag | Why |
|---|---|---|
| 0a. Scheduling-policy + snapshot spike | Operator-run | Live Cloudflare account, no agent diff |
| 0b. GitHub App `statuses: write` grant | Operator-run | Mints/grants a real repo-auth permission |
| 1. Wrangler bindings + env.ts | GLM-OK | Config sketch + type fields, no credential logic |
| 2. `fleet.json` gate config + repo gate | GLM-OK | Pure parsing, no network, no token |
| 3. Shard fan-out bucketing | GLM-OK | Pure bin-packing |
| 4. Verdict/fan-in state machine | GLM-OK | Pure aggregation, no I/O |
| 5. R2 baseline key helper | GLM-OK | Pure key-naming, no credential |
| 6. Container-side merge-tree logic | GLM-OK | Pure `git` exec wrapper, injected `ExecFn` |
| 7. CLI `gate start`/`gate watch` | GLM-OK | Access-JWT-authenticated board verb, no GitHub token |
| 8. Shard timing measurement script | GLM-OK | Parses existing JSON, no credential |
| 9. Browser lane spike doc | GLM-OK | Doc only, no code |
| 10. `GateRunnerDO` class | GLM-OK | Wires `env.GATE_RUNNER`/`durable_object` policy; carries plain R2 keys, never a credential (that moved to Task 16) |
| 11. `Dockerfile.gate` + container entrypoint | GLM-OK | Container-side leg-running code never holds a secret directly — this is exactly the real review's point: isolate the credential in the Worker's outbound handler, not here |
| 12. Worker gate HTTP routes | GLM-OK | Reads the Workflow binding's own native status, no GitHub token |
| 13. Warm-pool cron | GLM-OK | Pings an idle container, no credential |
| 14. `GateWorkflow` + `postCommitStatus` | **CLAUDE-ONLY** | Mints a real GitHub token and posts a real commit status — the banned-areas list names this directly |
| 15. Split `deploy-rescue-gate.test.ts` by test name | GLM-OK | Sharding config only, no credential |
| 16. Worker-side outbound handler | **CLAUDE-ONLY** | This is where the real R2/GitHub credential now lives and gets injected into the container's plain outbound requests — full stop, no exceptions, per the banned-areas list |
| 17. `ONE_WAY_GLOBS` additions | **CLAUDE-ONLY** | `merge-danger.ts` is itself a safety-classification file |

## Note on `apps/fleet/src/env.ts` — a deliberate 3-task split of one file

`env.ts` already imports each DO class's own *type* for its binding (`import type { AgentDO } from "./agents/do"` etc., `env.ts:1-7`) — a `DurableObjectNamespace<X>` binding needs `X`'s class to exist as a file before that specific line can be written. `GateRunnerDO` (Task 10) and the `GateWorkflow`/params type (Task 14) don't exist yet when Task 1 runs. So `env.ts` is touched by **three** tasks across **three different waves**, never two in the same wave: Task 1 adds the class-independent fields (`FLEET_GATE_RUNNER`, `GATE_RUNNER_REPOS` — no `GATE_KV`, see Global Constraints), Task 10 adds one line (`GATE_RUNNER: DurableObjectNamespace<GateRunnerDO>`) once its own class exists, Task 14 adds one line (`GATE_WORKFLOW: Workflow<GateWorkflowParams>`) once its own class exists. This is the one place this plan intentionally does NOT fold a shared file into one task — see each task's own note.

`apps/fleet/wrangler.example.jsonc` has no such problem: JSONC has no compile-time class reference, so Task 1 writes the **entire** `workflows`/`durable_objects`/`migrations`/`containers` sketch (including the `durable_object` `scheduling_policy` field — no `kv_namespaces` entry, see Global Constraints) in one task, even though the classes it names (`GateRunnerDO`, `GateWorkflow`) don't exist until later waves — exactly how the spec's own sketch (design spec §3) is already written, decoupled from any class existing yet.

---

## File Structure

New module directory `apps/fleet/src/gate/` (Worker-side, pure-logic-first, mirrors `apps/fleet/src/llm/`'s shape in the model-pool plan):

- `apps/fleet/src/gate/config.ts` — `fleet.json` `gate` block parsing, `FLEET_GATE_RUNNER`/`GATE_RUNNER_REPOS` gate, path-rule skip check. (`fleet.json` itself is always read from `env.AGENT_REPO`, the fleet's own blueprint repo — never from the work repo being gated, same "a work repo must never move that pointer" rule `env.ts`'s own `AGENT_REPO` doc comment states, `env.ts:216-229`. This module takes an already-parsed `fleetJson: unknown`; Task 14's own fetch, not this module, is what pins the source to `AGENT_REPO`.)
- `apps/fleet/src/gate/shard-plan.ts` — balanced-by-wall-time shard bucketing (LPT bin-packing), not a fixed N.
- `apps/fleet/src/gate/verdict.ts` — fan-in + `gate/verdict` state-machine aggregation.
- `apps/fleet/src/gate/baseline.ts` — deterministic R2 baseline key (`<main-sha>-<lockfile-hash>`), snapshot-name helper, and tarball-key helper. No KV pointer: the key IS the lookup (Task 5).
- `apps/fleet/src/gate/do.ts` — `GateRunnerDO` class (Task 10) + the outbound-handler wiring (Task 16, same file, later wave — same "shared file, never the same wave" pattern `env.ts`'s own 3-way split already uses).
- `apps/fleet/src/gate/routes.ts` — `/studio/gate/start`, `/studio/gate/status` inner handlers.
- `apps/fleet/src/gate/warm-pool.ts` — warm-pool sizing (operator-set, not hardcoded) + the cron nudge's pure decision of which/how many to ping.
- `apps/fleet/src/gate/workflow.ts` — `GateWorkflow` (`WorkflowEntrypoint`), the one file that mints a GitHub token and posts `gate/verdict`, fanning legs out via `waitForEvent`/`sendEvent` steps (Task 14).

Container-side (baked into the new image, mirrors `apps/fleet/container/server.ts`'s self-contained style — no imports from `apps/fleet/src/`):

- `apps/fleet/container/gate-merge-tree.ts` — pure, dependency-injected `git merge-tree`/`commit-tree` exit-code interpreter (TS port of `localci.sh:350-363`).
- `apps/fleet/container/gate-server.ts` — the container's own tiny HTTP server: clones (anonymous, public repo), restores baseline from a snapshot (primary) or a plain R2 GET the Worker's outbound handler authorizes (fallback), runs the leg's install+test command via `Bun.spawn`, PUTs the JSON result via a plain R2 PUT the same outbound handler authorizes, replies to the DO. **No presigned URL, no token, anywhere in this file** — that credential now lives in Task 16's Worker-side outbound handler, never in the container.
- `apps/fleet/container/Dockerfile.gate` — new image: bun + node + rustup + cargo-nextest + git, no Claude/tmux/chromium (not a studio).

CLI (space-separated verbs, matching this repo's own `fleet models <subverb>` / `fleet accounts` convention, `apps/fleet/src/studio/cli-args.ts:1198-1214` — NOT `gate-start`/`gate-watch` as separate top-level commands):

- Modify `apps/fleet/src/studio/cli-args.ts` — `fleet gate start <pr>` / `fleet gate watch <pr>` parsing (top-level `case "gate":`, sub-verb from `rest[0]`, same shape `case "models":` already uses).
- Modify `apps/fleet/cli/fleet.ts` — dispatch wiring.
- Create `apps/fleet/cli/gate.ts` — `cmdGateStart`, `cmdGateWatch` (thin `fetch` wrappers, same shape as `cli/models.ts`).

Docs/scripts:

- `apps/fleet/scripts/gate/measure-shard-timing.ts` — parses the existing `vitest --reporter=json` output shape (`localci.sh`'s own `$RUN/vitest.json`, already parsed once by `scripts/localci/summarize.ts`) into `{file, ms}[]` for Task 3's bucketer; Task 8 seeds it with this repo's own real 98-run CI data.
- `apps/fleet/scripts/gate/shard-by-test-name.ts` — splits `deploy-rescue-gate.test.ts`'s own tests across N shards by test NAME, not by file (Task 15 — this one file is the bun-test lane's floor).
- `docs/superpowers/evidence/2026-10-15-gate-runner-browser-lane-spike.md` — CF Browser Run vs in-container Playwright evaluation, in-container PRIMARY.

New: `apps/fleet/src/gate/outbound-handler.ts` (Task 16, CLAUDE-ONLY) — the Worker-side function CF's `durable_object`-policy outbound-traffic-handler hook calls for every plain outbound request `GateRunnerDO`'s own container makes; injects the real R2 (and, Phase 2 only, GitHub) credential server-side. **The one file in this plan, besides `workflow.ts`, that ever touches a real credential.**

Modify (minimal, one field/line each, see the 3-way split above): `apps/fleet/wrangler.example.jsonc`, `apps/fleet/src/env.ts`, `apps/fleet/src/studio/routes.ts`, `apps/fleet/src/index.ts`, `apps/fleet/src/github/api.ts`, `apps/fleet/scripts/merge-danger.ts` (Task 17 — new `ONE_WAY_GLOBS` entries for `apps/fleet/src/gate/**` and `apps/fleet/scripts/gate/**`).

---

## Dependency graph

| Task | Depends on | Dependency kind |
|---|---|---|
| 0a. Scheduling-policy + snapshot/shard spike | — | operator-run, blocks any task that commits to a final shard count or `max_instances` |
| 0b. GitHub App `statuses: write` grant | — | operator-run, blocks Task 14's verdict-posting step |
| 1. Wrangler bindings + env.ts (class-independent fields) | 0a (informs the `scheduling_policy`/sizing values the sketch carries) | design input, not a file/compile dependency |
| 2. `fleet.json` gate config + repo gate | — | — |
| 3. Shard fan-out bucketing | — | — |
| 4. Verdict/fan-in state machine | — | — |
| 5. R2 baseline key helper | — | — |
| 6. Container-side merge-tree decision logic | — | — |
| 7. CLI `gate start`/`gate watch` | — | wire contract only (documented in Tasks 7 & 12, not a file import) |
| 8. Shard timing measurement script | 0a (seeded with its real CI-timing data) | design input, not a file/compile dependency |
| 9. Browser lane spike doc | — | — |
| 15. Split `deploy-rescue-gate.test.ts` by test name | — | — |
| 17. `ONE_WAY_GLOBS` additions | — | — |
| 10. `GateRunnerDO` class (+ its own `env.ts` line) | 1, 0a | compile (Env type) + scheduling-policy decision must exist first |
| 11. Dockerfile.gate + container entrypoint server | 6, 5, 0a | compile (imports gate-merge-tree.ts) + baseline-key shape + snapshot/outbound-handler availability |
| 12. Worker gate HTTP routes | 1, 2 | compile (Env type, repo gate) |
| 13. Warm-pool cron | 1, 2 | compile (Env type, repo gate) |
| 16. Worker-side outbound handler | 10 | compile (same `do.ts` file, later wave — same pattern as `env.ts`'s 3-way split) |
| 14. `GateWorkflow` + `postCommitStatus` (+ its own `env.ts` line) | 1, 2, 3, 4, 5, 6, 10, 11, 16, 0b | compile (1–5) + contract (6, 10, 11, 16 — DO/container/outbound-handler RPC shape, not a file import) + operator precondition (0b) |

Task 7 ↔ Task 12 share a wire contract (request/response JSON, specified identically in both tasks below) rather than a file or import — this is why they can both sit in Wave 1 even though end-to-end they clearly depend on each other.

## Waves (max parallel lanes)

- **Wave 0: 2 operator-run preconditions, not agent tasks, before Wave 1 starts.** Task 0a (scheduling-policy + snapshot/shard spike — live Cloudflare account, no diff) and Task 0b (GitHub App `Commit statuses: write` grant). Neither blocks Wave 1's pure-logic tasks from starting, but Task 0a's numbers feed Task 1/8's sketches and Task 0b blocks Task 14 (Wave 3) from actually posting a real status.
- **Wave 1: 11 tasks, 11 members in parallel, zero file overlap.** Tasks 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 17 (Task 17 touches only `apps/fleet/scripts/merge-danger.ts`, untouched by every other Wave-1 task; Task 15 touches only its own new `apps/fleet/scripts/gate/shard-by-test-name.ts`).
- **Wave 2: 4 tasks, 4 members in parallel, zero file overlap.** Tasks 10, 11, 12, 13 (each depends only on Wave-0/1 outputs; `do.ts` vs `container/*` vs `routes.ts`+`studio/routes.ts` vs `warm-pool.ts`+`index.ts` never collide).
- **Wave 3: 2 tasks, 2 members in parallel, zero file overlap.** Task 16 (adds the outbound handler to `do.ts` — same file Task 10 already finished in Wave 2, never concurrent with it) and Task 14 (the fan-in point, depends on nearly everything, inherently sequential-last; also blocked on Task 0b). `do.ts` (Task 16) and `workflow.ts`/`env.ts`/`github/api.ts` (Task 14) don't collide.

---

## Review Focus

1. `GATE_RUNNER_REPOS` absent/empty, or `FLEET_GATE_RUNNER` anything but `"on"` → Task 12's routes 404 before touching `GATE_WORKFLOW`/R2 at all — zero new behavior for every repo not opted in, same posture `install-cache.ts` already proves for `INSTALL_CACHE_REPOS`.
2. Task 4's verdict aggregation: any `error` leg wins over any `failure` leg, regardless of arrival order (legs run in parallel — "first failing/erroring leg" must be deterministic by the *configured* leg order, not network arrival order). A red-test shard's `LegResult` reaches `aggregateVerdict` as `state: "failure"` DATA, never as a step exception Task 14's Workflow had to catch.
3. Task 3's shard bucketer never returns zero shards for non-empty input, and never splits a single huge file across two shards.
4. Task 14's `gate/verdict` POST failing twice is surfaced distinctly from a real `failure`/`error` leg (own field, not folded into `state`) — `gate-watch`'s exit code 3 depends on this distinction surviving the Worker route → CLI round trip.
5. Task 11's container never receives a GitHub token OR a presigned URL (Phase 1, public repo; Phase 1 R2 writes too) — grep the task's own diff for `Authorization`/`GITHUB_TOKEN`/`presign`/`https://.*\.r2\.` before calling it done. The ONLY place any of those strings may legitimately appear is Task 16's `outbound-handler.ts`.
6. Task 10's class is created with `scheduling_policy: "durable_object"` in Task 1's wrangler sketch — grep for the literal string `"durable_object"` next to `GateRunnerDO`'s `containers[]` entry before calling Task 1 done; its absence silently falls back to `default`, which breaks every later task that assumes snapshot/outbound-handler support.
7. Nothing in Task 12 or Task 14's own text says or implies `gate/verdict` replaces `classify` in the maestro's required-checks set — grep both tasks' diffs for the word `classify` finding only Task 17's own addition, never a removal.

---

### Task 0a: Scheduling-policy + snapshot/shard spike (OPERATOR-RUN, Wave 0 — runs before any task below commits to a final number)

**Files:** none — this is a live-infrastructure spike against a real Cloudflare account, not an agent-executed diff. No code ships from this task; its OUTPUT (measured numbers) is a design input to Task 1's wrangler sketch and Task 8's shard-count data, cited there.

**Why this has to come first:** Cloudflare Containers only let you pick a DO class's scheduling policy (`default` vs `durable_object`) once, at creation, and never change it after. Every later task in this plan (10, 11, 16, and Task 1's own sketch) assumes `durable_object` (snapshot support, outbound traffic handlers, `ctx.container.exec()`). If that assumption is wrong, or if snapshot-restore time turns out too slow to be worth it, the fix is a new DO class, not a patch — so this plan measures BEFORE committing, not after.

**What the operator runs:**
1. Stand up one `GateRunnerDO`-shaped class on the `durable_object` scheduling policy against `rafarc21/fleetflare`'s own Cloudflare account (a throwaway `wrangler.jsonc`, not `apps/fleet/wrangler.example.jsonc` — never committed).
2. Snapshot a baseline container (`main`'s own installed `node_modules`/`target` dirs) via `snapshotContainer()`.
3. Restore that snapshot into fresh DO instances at N=8, N=24, N=48 concurrent shards; measure restore time and total shard wall time at each N.
4. Record results in `docs/superpowers/evidence/2026-10-15-gate-runner-snapshot-spike.md` (the one artifact this task DOES produce — a real measurement, not a code diff).

**Output consumed downstream:** the restore-time number decides whether Task 11's baseline mechanism can lean on snapshots as primary (fast) or needs the R2-tarball fallback to actually be primary in practice (slow restore); the wall-time-at-N numbers, combined with Task 8's real CI-timing data, are what makes the "15–18 containers per PR" figure in Global Constraints/Task 8 a measured starting point rather than a guess.

---

### Task 0b: Operator grants the GitHub App `Commit statuses: write` (OPERATOR-RUN, Wave 0 — blocks Task 14's verdict-posting step)

**Files:** none — this is a GitHub App permission change in GitHub's own UI/API, not a repo diff.

**Why:** `rafarc21/fleetflare`'s live `GITHUB_REPO_AUTH` config (`apps/fleet/src/github/auth.ts:189-281`, `resolveRepoAuthKind`) maps this repo's owner to the `app` provider, not `token`. A real review comment confirmed the App's current installation permissions do not include `Commit statuses: write` — this was speculatively called an "unverified PAT scope" in the earlier ci-steward spec; it is now confirmed to be a GitHub App permission gap specifically, not a PAT. Task 14's `postCommitStatus` call will fail with a 403 on every single run until this is granted, regardless of how correct its own code is.

**What the operator runs:** adds `Commit statuses: write` to the GitHub App's installation permissions for `rafarc21/fleetflare` (GitHub App settings → Permissions & events → Commit statuses → Read and write), then re-installs/accepts the new permission grant on the repo. A live, operator-run step — not a unit test, not something Task 14's own diff can route around (`workerWriteToken`, `apps/fleet/src/write-proxy/gh-route.ts:164-168`, mints the Worker's own credential correctly either way; the App simply doesn't have the permission to use it for a status write until this is granted).

---

### Task 1: Wrangler bindings + env.ts (class-independent fields)

**Files:**
- Modify: `apps/fleet/wrangler.example.jsonc`
- Modify: `apps/fleet/src/env.ts`

**Interfaces:**
- Produces: `Env.FLEET_GATE_RUNNER?: string`, `Env.GATE_RUNNER_REPOS?: string` (no `Env.GATE_KV` — see Global Constraints). The `workflows`/`durable_objects`/`migrations`/`containers` JSONC entries naming `GateWorkflow`/`GateRunnerDO` (classes land in Tasks 10/14 — JSONC has no compile dependency on them existing yet), including the `durable_object` `scheduling_policy` field Task 0a's decision requires.
- Consumes: Task 0a's spike numbers (design input only — this task does not import or wait on Task 0a's non-existent code, it just carries the measured range forward in a comment).

- [ ] **Step 1: Add the wrangler sketch**

In `apps/fleet/wrangler.example.jsonc`, add a top-level `"workflows"` array (new key, no existing one):

```jsonc
"workflows": [
  { "name": "gate", "binding": "GATE_WORKFLOW", "class_name": "GateWorkflow" }
],
```

No `"kv_namespaces"` entry — v1 of this plan had one for a `GATE_KV` baseline pointer; removed per Global Constraints (R2 reads are already strongly consistent, KV is not, and the lookup is just a deterministic key — Task 5).

In the existing `"durable_objects").bindings` array (next to `AGENT`/`DEPLOY`/`STUDIO`/`STUDIO_BIG`), add:

```jsonc
{ "name": "GATE_RUNNER", "class_name": "GateRunnerDO" }
```

In the existing `"migrations"` array (next to `v1`–`v4`), add:

```jsonc
{ "tag": "v5", "new_sqlite_classes": ["GateRunnerDO"] }
```

In the existing `"containers"` array (next to `AgentDO`/`DeployDO`/`StudioDO`/`StudioBigDO`), add:

```jsonc
{
  "class_name": "GateRunnerDO",
  "image": "./container/Dockerfile.gate",
  "image_build_context": ".",
  // Real review correction: Cloudflare Containers fix a DO class's
  // scheduling policy at creation and never let it change after. "default"
  // (what every other class in this file uses today) has no snapshot or
  // outbound-traffic-handler support — GateRunnerDO needs both (Tasks
  // 11/16), so it is "durable_object", not "default", from its very first
  // deploy. Task 0a is the spike that confirmed this before any class
  // existed; every class below it in this plan assumes it.
  "scheduling_policy": "durable_object",
  "instance_type": "standard-4",
  // Task 0a's spike + Task 8's real CI-timing data put the real working
  // range at 15-18 containers per PR (not v1's 24-28 guess); max_instances
  // sizing is still the operator's own final call (account-wide 1,500 vCPU
  // cap, Global Constraints), carried forward as a range, not a decision.
  "max_instances": 150,
  "rollout_step_percentage": 100
}
```

This is an **image-change-adjacent config entry** (names a Dockerfile path), but this task itself makes no image and ships no container — it only ships at the same operator-approved image window as Task 11 (the actual Dockerfile).

- [ ] **Step 2: Add the class-independent `Env` fields**

In `apps/fleet/src/env.ts`, near `INSTALL_CACHE_REPOS` (`env.ts:401` today) and `FLEET_TELEGRAM` (`env.ts:53` today), add:

```ts
/** Phase 1 (#715): default off, same posture FLEET_TELEGRAM/FLEET_JUNIOR
 *  already use — a repo not opted in gets zero new behavior. */
FLEET_GATE_RUNNER?: string;
/** Comma-separated "owner/repo", same shape as INSTALL_CACHE_REPOS. Phase 1
 *  value is a single entry: "rafarc21/fleetflare". */
GATE_RUNNER_REPOS?: string;
```

No `GATE_KV?: KVNamespace` field — see Global Constraints; the baseline lookup (Task 5) reads/writes R2 directly via a deterministic key, no pointer namespace.

`GATE_RUNNER: DurableObjectNamespace<GateRunnerDO>` and `GATE_WORKFLOW: Workflow<GateWorkflowParams>` are deliberately NOT added here — see Tasks 10 and 14.

- [ ] **Step 3: Commit**

```bash
git add apps/fleet/wrangler.example.jsonc apps/fleet/src/env.ts
git commit -m "feat(fleet): gate-runner wrangler sketch + class-independent Env fields (refs #715)"
```

---

### Task 2: `fleet.json` gate config + repo gate

**Files:**
- Create: `apps/fleet/src/gate/config.ts`
- Test: `apps/fleet/test/bun/gate-config.test.ts`

**Interfaces:**
- Produces: `parseGateRunnerRepos(raw: string | undefined): string[]`, `isGateRunnerRepo(raw: string | undefined, workRepoSlug: string): boolean`, `GateConfig` interface `{ install: string; legs: string[]; vitestCmd: string; pathRules: string[] }`, `parseGateConfig(fleetJson: unknown): GateConfig | null`, `matchesPathRules(changedFiles: string[], pathRules: string[]): boolean`.
- Consumes: nothing (pure — takes an already-parsed `fleetJson: unknown`). **This module never fetches `fleet.json` itself, and that is deliberate**: `fleet.json` always lives in `env.AGENT_REPO` (the fleet's own blueprint repo, `env.ts:216-229`'s own "a work repo must never be able to move that pointer" rule), never in the work repo being gated — a gated repo must never be able to weaken its own gate by editing its own config. Task 14's own fetch (not this module) is what pins the source to `AGENT_REPO`; this module would behave identically no matter which repo the caller fetched from, which is exactly why that pinning has to live in the one caller, not here.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/fleet/test/bun/gate-config.test.ts
import { describe, it, expect } from "bun:test";
import {
  parseGateRunnerRepos, isGateRunnerRepo, parseGateConfig, matchesPathRules,
} from "../../src/gate/config";

describe("parseGateRunnerRepos", () => {
  it("absent/empty -> no repos gated in", () => {
    expect(parseGateRunnerRepos(undefined)).toEqual([]);
    expect(parseGateRunnerRepos("")).toEqual([]);
  });
  it("comma-separated, trimmed, lowercased", () => {
    expect(parseGateRunnerRepos(" Rafarc21/FleetFlare , other/repo ")).toEqual([
      "rafarc21/fleetflare", "other/repo",
    ]);
  });
});

describe("isGateRunnerRepo", () => {
  it("case-insensitive match", () => {
    expect(isGateRunnerRepo("rafarc21/fleetflare", "Rafarc21/FleetFlare")).toBe(true);
  });
  it("no match when repo not listed", () => {
    expect(isGateRunnerRepo("rafarc21/fleetflare", "other/repo")).toBe(false);
  });
});

describe("parseGateConfig", () => {
  it("parses a well-formed gate block", () => {
    const cfg = parseGateConfig({
      gate: { install: "bun install --frozen-lockfile", legs: ["typecheck", "lint"],
        vitestCmd: "bun run test --shard={i}/{n}", pathRules: ["apps/fleet/**"] },
    });
    expect(cfg).toEqual({
      install: "bun install --frozen-lockfile", legs: ["typecheck", "lint"],
      vitestCmd: "bun run test --shard={i}/{n}", pathRules: ["apps/fleet/**"],
    });
  });
  it("null on a missing gate block, not a throw", () => {
    expect(parseGateConfig({})).toBeNull();
    expect(parseGateConfig(null)).toBeNull();
  });
  it("null on a gate block missing a required field", () => {
    expect(parseGateConfig({ gate: { install: "x" } })).toBeNull();
  });
});

describe("matchesPathRules", () => {
  const rules = ["apps/fleet/**", "skills/**"];
  it("matches a file under a **-suffixed rule", () => {
    expect(matchesPathRules(["apps/fleet/src/index.ts"], rules)).toBe(true);
  });
  it("no match when every changed file is outside every rule", () => {
    expect(matchesPathRules(["README.md"], rules)).toBe(false);
  });
  it("empty changed-file list never matches", () => {
    expect(matchesPathRules([], rules)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `cd apps/fleet && bun test test/bun/gate-config.test.ts`
Expected: FAIL — `../../src/gate/config` does not exist.

- [ ] **Step 3: Implement**

```ts
// apps/fleet/src/gate/config.ts
//
// Phase 1 (#715) gate config: the FLEET_GATE_RUNNER/GATE_RUNNER_REPOS repo
// gate (same comma-separated "owner/repo" shape as INSTALL_CACHE_REPOS,
// apps/fleet/src/studio/install-cache.ts:104-126) and the fleet.json `gate`
// block's parsing. Pure — no exec, no network, no token.

export function parseGateRunnerRepos(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
}

export function isGateRunnerRepo(raw: string | undefined, workRepoSlug: string): boolean {
  return parseGateRunnerRepos(raw).includes(workRepoSlug.toLowerCase());
}

export interface GateConfig {
  install: string;
  legs: string[];
  vitestCmd: string;
  pathRules: string[];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Returns null on anything malformed — never throws. A repo with no `gate`
 *  block, or a malformed one, gets the Workflow's own "skip, don't guess"
 *  behavior (Task 14), not a crash. */
export function parseGateConfig(fleetJson: unknown): GateConfig | null {
  if (typeof fleetJson !== "object" || fleetJson === null) return null;
  const gate = (fleetJson as Record<string, unknown>).gate;
  if (typeof gate !== "object" || gate === null) return null;
  const g = gate as Record<string, unknown>;
  if (typeof g.install !== "string") return null;
  if (!isStringArray(g.legs)) return null;
  if (typeof g.vitestCmd !== "string") return null;
  if (!isStringArray(g.pathRules)) return null;
  return { install: g.install, legs: g.legs, vitestCmd: g.vitestCmd, pathRules: g.pathRules };
}

/** Mirrors localci.sh's own skip-fleet-check path filter (localci.sh:378-381):
 *  a PR touching none of `pathRules` skips the whole gate. A rule ending in
 *  "/**" matches any path under that prefix; anything else must match a
 *  changed file exactly. */
export function matchesPathRules(changedFiles: string[], pathRules: string[]): boolean {
  return changedFiles.some((file) =>
    pathRules.some((rule) => {
      if (rule.endsWith("/**")) return file.startsWith(rule.slice(0, -2));
      return file === rule;
    }));
}
```

- [ ] **Step 4: Run, confirm it passes**

Run: `cd apps/fleet && bun test test/bun/gate-config.test.ts`
Expected: PASS, all cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/gate/config.ts apps/fleet/test/bun/gate-config.test.ts
git commit -m "feat(fleet): gate-runner fleet.json config + repo gate (refs #715)"
```

---

### Task 3: Shard fan-out bucketing (balanced by wall time, not a fixed N)

**Files:**
- Create: `apps/fleet/src/gate/shard-plan.ts`
- Test: `apps/fleet/test/bun/gate-shard-plan.test.ts`

**Interfaces:**
- Produces: `FileTiming { file: string; ms: number }`, `planShards(timings: FileTiming[], targetShardMs: number): string[][]`.
- Consumes: nothing (pure). Task 8's measurement script is this function's data source at runtime, not a code dependency.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/fleet/test/bun/gate-shard-plan.test.ts
import { describe, it, expect } from "bun:test";
import { planShards, type FileTiming } from "../../src/gate/shard-plan";

describe("planShards", () => {
  it("empty input -> zero shards", () => {
    expect(planShards([], 60_000)).toEqual([]);
  });

  it("sizes N from total/targetShardMs, not a fixed count", () => {
    const timings: FileTiming[] = Array.from({ length: 10 }, (_, i) => ({ file: `f${i}.test.ts`, ms: 10_000 }));
    // total 100_000ms, target 20_000ms -> ~5 shards
    const shards = planShards(timings, 20_000);
    expect(shards.length).toBe(5);
    // every file assigned exactly once
    expect(shards.flat().sort()).toEqual(timings.map((t) => t.file).sort());
  });

  it("balances by wall time, not file count", () => {
    const timings: FileTiming[] = [
      { file: "slow.test.ts", ms: 90_000 },
      ...Array.from({ length: 9 }, (_, i) => ({ file: `fast${i}.test.ts`, ms: 10_000 })),
    ];
    const shards = planShards(timings, 30_000);
    // the one slow file must not share a shard with more than a little fast work
    const slowShard = shards.find((s) => s.includes("slow.test.ts"))!;
    expect(slowShard.length).toBeLessThanOrEqual(2);
  });

  it("never returns an empty shard for non-empty input", () => {
    const timings: FileTiming[] = [{ file: "only.test.ts", ms: 5_000 }];
    const shards = planShards(timings, 20_000);
    expect(shards.every((s) => s.length > 0)).toBe(true);
  });

  it("a single huge file never splits across two shards", () => {
    const timings: FileTiming[] = [{ file: "huge.test.ts", ms: 500_000 }];
    const shards = planShards(timings, 20_000);
    const owning = shards.filter((s) => s.includes("huge.test.ts"));
    expect(owning.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `cd apps/fleet && bun test test/bun/gate-shard-plan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/fleet/src/gate/shard-plan.ts
//
// #715 / operator 08:25Z: "Shard to finest grain worth its cold start...
// Size N from that, not from a fixed number." Longest-Processing-Time-first
// bin packing: sort heaviest-first, always drop the next file onto the
// currently-lightest shard. Deterministic, no randomness, same input order
// in -> same shards out.

export interface FileTiming { file: string; ms: number }

export function planShards(timings: FileTiming[], targetShardMs: number): string[][] {
  if (timings.length === 0) return [];
  const sorted = [...timings].sort((a, b) => b.ms - a.ms);
  const totalMs = sorted.reduce((sum, t) => sum + t.ms, 0);
  const n = Math.max(1, Math.round(totalMs / targetShardMs));
  const shards: { files: string[]; ms: number }[] = Array.from({ length: n }, () => ({ files: [], ms: 0 }));
  for (const t of sorted) {
    let lightest = shards[0];
    for (const s of shards) if (s.ms < lightest.ms) lightest = s;
    lightest.files.push(t.file);
    lightest.ms += t.ms;
  }
  return shards.map((s) => s.files);
}
```

- [ ] **Step 4: Run, confirm it passes**

Run: `cd apps/fleet && bun test test/bun/gate-shard-plan.test.ts`
Expected: PASS, all 5 cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/gate/shard-plan.ts apps/fleet/test/bun/gate-shard-plan.test.ts
git commit -m "feat(fleet): gate-runner shard bucketing balanced by wall time (refs #715)"
```

---

### Task 4: Verdict/fan-in state machine

**Files:**
- Create: `apps/fleet/src/gate/verdict.ts`
- Test: `apps/fleet/test/bun/gate-verdict.test.ts`

**Interfaces:**
- Produces: `LegState = "success" | "failure" | "error"`, `LegResult { leg: string; state: LegState; description?: string }`, `Verdict = { state: "pending" } | { state: "success" } | { state: "failure"; description: string } | { state: "error"; description: string }`, `aggregateVerdict(expectedLegs: string[], results: LegResult[]): Verdict`.
- Consumes: nothing (pure). Task 14 is this function's only real caller.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/fleet/test/bun/gate-verdict.test.ts
import { describe, it, expect } from "bun:test";
import { aggregateVerdict, type LegResult } from "../../src/gate/verdict";

const legs = ["typecheck", "lint", "vitest-1", "vitest-2"];

describe("aggregateVerdict", () => {
  it("pending until every expected leg has reported", () => {
    const results: LegResult[] = [{ leg: "typecheck", state: "success" }];
    expect(aggregateVerdict(legs, results)).toEqual({ state: "pending" });
  });

  it("success only when every leg is success", () => {
    const results: LegResult[] = legs.map((leg) => ({ leg, state: "success" }));
    expect(aggregateVerdict(legs, results)).toEqual({ state: "success" });
  });

  it("any failure -> failure, named by configured leg order not arrival order", () => {
    const results: LegResult[] = [
      { leg: "lint", state: "success" },
      { leg: "vitest-2", state: "failure", description: "2 tests failed" },
      { leg: "typecheck", state: "success" },
      { leg: "vitest-1", state: "failure", description: "1 test failed" },
    ];
    // vitest-1 is configured before vitest-2, even though vitest-2 "arrived" first above
    expect(aggregateVerdict(legs, results)).toEqual({ state: "failure", description: "1 test failed" });
  });

  it("any error -> error, never downgraded to failure, even if a failure is also present", () => {
    const results: LegResult[] = [
      { leg: "typecheck", state: "failure", description: "type error" },
      { leg: "lint", state: "error", description: "GateRunnerDO OOM" },
      { leg: "vitest-1", state: "success" },
      { leg: "vitest-2", state: "success" },
    ];
    expect(aggregateVerdict(legs, results)).toEqual({ state: "error", description: "GateRunnerDO OOM" });
  });

  it("falls back to a generated description when a leg reports none", () => {
    const results: LegResult[] = legs.map((leg) => ({ leg, state: "success" as const }));
    results[0] = { leg: "typecheck", state: "failure" };
    expect(aggregateVerdict(legs, results)).toEqual({ state: "failure", description: "typecheck failed" });
  });

  // Real review correction: Cloudflare Workflows retries a step that THROWS
  // 5x with backoff before giving up — a genuinely red test must never
  // reach this function (or Task 14's own step) as a thrown exception, only
  // as a LegResult with state: "failure". This test pins that a red-test
  // shard's result is handled as ordinary DATA, same as any other failure
  // — aggregateVerdict never distinguishes "a shard's own step threw" from
  // "a shard's own step returned a failing LegResult" because the latter is
  // the ONLY shape a shard's step is allowed to return (Task 14's own
  // waitForEvent/sendEvent design, not re-tested here since it needs a live
  // Workflow — this is the pure half of that contract).
  it("a red-test shard result is success-with-failing-data, not a retried/thrown step", () => {
    const results: LegResult[] = legs.map((leg) => ({ leg, state: "success" as const }));
    results[2] = { leg: "vitest-1", state: "failure", description: "vitest-1 exited 1" };
    const verdict = aggregateVerdict(legs, results);
    expect(verdict).toEqual({ state: "failure", description: "vitest-1 exited 1" });
    // never a thrown/rejected call — aggregateVerdict is a plain sync function
    expect(() => aggregateVerdict(legs, results)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `cd apps/fleet && bun test test/bun/gate-verdict.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/fleet/src/gate/verdict.ts
//
// #715's own state machine: pending -> success only when every leg is
// success; any failure -> failure; any error (timeout, GateRunnerDO
// OOM/crash, R2 write failure) -> error, never silently downgraded to
// failure — same distinction localci.sh's own error state draws
// (localci.sh:341-342). "First failing/erroring leg" is read in CONFIGURED
// leg order (expectedLegs), not arrival order — legs run in parallel, so
// arrival order is not deterministic.

export type LegState = "success" | "failure" | "error";
export interface LegResult { leg: string; state: LegState; description?: string }

export type Verdict =
  | { state: "pending" }
  | { state: "success" }
  | { state: "failure"; description: string }
  | { state: "error"; description: string };

export function aggregateVerdict(expectedLegs: string[], results: LegResult[]): Verdict {
  const byLeg = new Map(results.map((r) => [r.leg, r]));
  if (expectedLegs.some((leg) => !byLeg.has(leg))) return { state: "pending" };

  for (const leg of expectedLegs) {
    const r = byLeg.get(leg)!;
    if (r.state === "error") return { state: "error", description: r.description ?? `${leg} errored` };
  }
  for (const leg of expectedLegs) {
    const r = byLeg.get(leg)!;
    if (r.state === "failure") return { state: "failure", description: r.description ?? `${leg} failed` };
  }
  return { state: "success" };
}
```

- [ ] **Step 4: Run, confirm it passes**

Run: `cd apps/fleet && bun test test/bun/gate-verdict.test.ts`
Expected: PASS, all 6 cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/gate/verdict.ts apps/fleet/test/bun/gate-verdict.test.ts
git commit -m "feat(fleet): gate-runner verdict fan-in state machine (refs #715)"
```

---

### Task 5: R2 baseline key helper (no KV — the key IS the lookup)

**v2 rewrite:** v1 of this plan had a `GATE_KV` namespace here, storing a `main-sha:<owner>/<repo>` pointer so a PR's Workflow run could find its baseline without listing R2. Removed per Global Constraints: R2 reads are already strongly consistent immediately after a write; KV is not (≥60s eventual consistency elsewhere in this codebase's own experience). A baseline's identity is fully determined by `(mainSha, lockfileHash)` — there is nothing to "point to" that isn't already encoded in a deterministic key, so there's no pointer to store, read, or go stale.

**Files:**
- Create: `apps/fleet/src/gate/baseline.ts`
- Test: `apps/fleet/test/bun/gate-baseline.test.ts` (bun test — pure string functions, no R2/KV mock needed at all, unlike v1's `cloudflare:test`-pool `gate-kv-pointer.test.ts`).

**Interfaces:**
- Produces: `baselineId(mainSha: string, lockfileHash: string): string` (`<mainSha>-<lockfileHash>`, the one shared identity both mechanisms below key off); `baselineTarballKey(owner: string, repo: string, mainSha: string, lockfileHash: string): string` (R2 fallback key, `gate/<owner>/<repo>/baselines/<id>.tar`); `baselineSnapshotName(owner: string, repo: string, mainSha: string, lockfileHash: string): string` (the primary mechanism per Task 0a/11's `durable_object`-policy container-snapshot correction — the name/tag `snapshotContainer()`/its restore call key off, same `<id>` shape, `<owner>-<repo>-<id>` sanitized for whatever charset Cloudflare's snapshot-name field allows, ASCII lower-kebab here).
- Consumes: nothing (pure). Task 10/11 call these directly against R2/the container-snapshot API — no pointer namespace to read first; a `HEAD` on the tarball key or a restore-by-name call against the snapshot name is itself the "does a baseline exist" check, no extra round trip.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/fleet/test/bun/gate-baseline.test.ts
import { describe, it, expect } from "bun:test";
import { baselineId, baselineTarballKey, baselineSnapshotName } from "../../src/gate/baseline";

describe("baselineId", () => {
  it("joins sha and lockfile hash with a dash, no other lookup needed", () => {
    expect(baselineId("abc123", "def456")).toBe("abc123-def456");
  });
});

describe("baselineTarballKey", () => {
  it("builds the R2 fallback key under gate/<owner>/<repo>/baselines/", () => {
    expect(baselineTarballKey("rafarc21", "fleetflare", "abc123", "def456")).toBe(
      "gate/rafarc21/fleetflare/baselines/abc123-def456.tar",
    );
  });
});

describe("baselineSnapshotName", () => {
  it("builds a lower-kebab snapshot name, the primary mechanism", () => {
    expect(baselineSnapshotName("rafarc21", "fleetflare", "abc123", "def456")).toBe(
      "rafarc21-fleetflare-abc123-def456",
    );
  });
  it("same (owner, repo, sha, lockfileHash) always names the same snapshot — deterministic, not random", () => {
    const a = baselineSnapshotName("rafarc21", "fleetflare", "abc123", "def456");
    const b = baselineSnapshotName("rafarc21", "fleetflare", "abc123", "def456");
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `cd apps/fleet && bun test test/bun/gate-baseline.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/fleet/src/gate/baseline.ts
//
// #715 Phase 1, v2 correction: no GATE_KV. A baseline's identity is fully
// determined by (mainSha, lockfileHash) — R2's own strong read-after-write
// consistency makes a deterministic key the lookup; there is no mutable
// pointer to go stale. Container snapshots (Cloudflare Containers,
// durable_object policy only, snapshotContainer()) are the PRIMARY restore
// mechanism once Task 0a's spike confirms acceptable restore time; the R2
// tarball key below is the FALLBACK until that's measured (Task 11).

export function baselineId(mainSha: string, lockfileHash: string): string {
  return `${mainSha}-${lockfileHash}`;
}

export function baselineTarballKey(
  owner: string, repo: string, mainSha: string, lockfileHash: string,
): string {
  return `gate/${owner}/${repo}/baselines/${baselineId(mainSha, lockfileHash)}.tar`;
}

export function baselineSnapshotName(
  owner: string, repo: string, mainSha: string, lockfileHash: string,
): string {
  return `${owner}-${repo}-${baselineId(mainSha, lockfileHash)}`;
}
```

- [ ] **Step 4: Run, confirm it passes**

Run: `cd apps/fleet && bun test test/bun/gate-baseline.test.ts`
Expected: PASS, all 4 cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/gate/baseline.ts apps/fleet/test/bun/gate-baseline.test.ts
git commit -m "feat(fleet): gate-runner R2 baseline key helper, no KV (refs #715)"
```

---

### Task 6: Container-side merge-tree decision logic

**Files:**
- Create: `apps/fleet/container/gate-merge-tree.ts`
- Test: `apps/fleet/test/bun/gate-merge-tree.test.ts` (real `git`, real fixture repo — same subprocess-heavy `test/bun/` convention `localci.sh`'s own bun-test lane already uses; mirrors the precedent of `test/container.args.test.ts` importing directly from `apps/fleet/container/`).

**Interfaces:**
- Produces: `ExecFn = (cmd: string, args: string[], opts: { cwd: string }) => Promise<{ code: number; stdout: string; stderr: string }>`, `MergeTreeResult = { ok: true; commit: string } | { ok: false; kind: "conflict" } | { ok: false; kind: "error"; message: string }`, `resolveMergeTree(exec: ExecFn, cwd: string, base: string, head: string): Promise<MergeTreeResult>`.
- Consumes: nothing at the type level; Task 11's `gate-server.ts` wires `exec` to `Bun.spawn` and is this function's one real caller.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/fleet/test/bun/gate-merge-tree.test.ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMergeTree, type ExecFn } from "../../container/gate-merge-tree";

const realExec: ExecFn = async (cmd, args, opts) => {
  const proc = Bun.spawn([cmd, ...args], { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { code: exitCode, stdout, stderr };
};

let dir: string;
async function git(args: string[]) { return realExec("git", args, { cwd: dir }); }

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "gate-merge-tree-"));
  await git(["init", "-q"]);
  await git(["config", "user.email", "t@example.com"]);
  await git(["config", "user.name", "t"]);
  await Bun.write(join(dir, "f.txt"), "base\n");
  await git(["add", "f.txt"]);
  await git(["commit", "-q", "-m", "base"]);
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("resolveMergeTree", () => {
  it("ok on a clean two-parent merge", async () => {
    const base = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await Bun.write(join(dir, "g.txt"), "new\n");
    await git(["add", "g.txt"]);
    await git(["commit", "-q", "-m", "clean add"]);
    const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const result = await resolveMergeTree(realExec, dir, base, head);
    expect(result.ok).toBe(true);
  });

  it("conflict on two commits editing the same line", async () => {
    const base = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git(["checkout", "-q", "-b", "a"]);
    await Bun.write(join(dir, "f.txt"), "a-edit\n");
    await git(["commit", "-q", "-am", "a edit"]);
    const headA = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git(["checkout", "-q", base]);
    await Bun.write(join(dir, "f.txt"), "b-edit\n");
    await git(["commit", "-q", "-am", "b edit"]);
    const headB = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const result = await resolveMergeTree(realExec, dir, headA, headB);
    expect(result).toEqual({ ok: false, kind: "conflict" });
  });

  it("error (not conflict) when git itself fails, e.g. an unknown ref", async () => {
    const result = await resolveMergeTree(realExec, dir, "not-a-real-ref", "HEAD");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("error");
  });
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `cd apps/fleet && bun test test/bun/gate-merge-tree.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/fleet/container/gate-merge-tree.ts
//
// TS port of localci.sh:350-363's `git merge-tree --write-tree` /
// `git commit-tree` two-parent shape. `git merge-tree` exits 1 on a real
// conflict; any OTHER non-zero exit is git failing for some other reason
// and is reported in git's own words, never flattened to "conflict" (the
// exact distinction PR #306's review drew for localci.sh itself,
// localci.sh:350-352). `exec` is injected so production (container/
// gate-server.ts, wired to Bun.spawn against the real checkout) and this
// file's own test (wired to Bun.spawn against a throwaway fixture repo)
// share one implementation.

export type ExecFn = (
  cmd: string, args: string[], opts: { cwd: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type MergeTreeResult =
  | { ok: true; commit: string }
  | { ok: false; kind: "conflict" }
  | { ok: false; kind: "error"; message: string };

export async function resolveMergeTree(
  exec: ExecFn, cwd: string, base: string, head: string,
): Promise<MergeTreeResult> {
  const mt = await exec("git", ["merge-tree", "--write-tree", base, head], { cwd });
  if (mt.code === 1) return { ok: false, kind: "conflict" };
  if (mt.code !== 0) {
    return { ok: false, kind: "error", message: mt.stderr.split("\n")[0] || `git merge-tree exited ${mt.code}` };
  }
  const tree = mt.stdout.trim().split("\n")[0];
  const ct = await exec(
    "git", ["commit-tree", tree, "-p", base, "-p", head, "-m", `gate: ${head} onto ${base}`], { cwd },
  );
  if (ct.code !== 0) {
    return { ok: false, kind: "error", message: ct.stderr.split("\n")[0] || `git commit-tree exited ${ct.code}` };
  }
  return { ok: true, commit: ct.stdout.trim() };
}
```

- [ ] **Step 4: Run, confirm it passes**

Run: `cd apps/fleet && bun test test/bun/gate-merge-tree.test.ts`
Expected: PASS, all 3 cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/container/gate-merge-tree.ts apps/fleet/test/bun/gate-merge-tree.test.ts
git commit -m "feat(fleet): gate-runner container-side merge-tree decision logic (refs #715)"
```

---

### Task 7: CLI `gate start`/`gate watch`

**v2 correction:** v1 wrote this as two top-level commands, `gate-start`/`gate-watch`. This repo's own real convention (`apps/fleet/src/studio/cli-args.ts:1198-1214`) is a single top-level command word with a space-separated sub-verb — `fleet models ls`, `fleet models assign <studio> <model>`, `fleet models promote <model>` are all `case "models":` with `rest[0]` as the sub-verb, never `models-ls`/`models-assign` typed at the CLI (that hyphenated form is only the INTERNAL `CliArgs.cmd` tag, never what a user types). So: `fleet gate start <pr>` / `fleet gate watch <pr>`, one `case "gate":`, `rest[0]` is `"start"`/`"watch"` — not `gate-start`/`gate-watch` as separate top-level commands.

**Files:**
- Modify: `apps/fleet/src/studio/cli-args.ts`
- Modify: `apps/fleet/cli/fleet.ts`
- Create: `apps/fleet/cli/gate.ts`
- Test: `apps/fleet/test/bun/cli-gate.test.ts`, extend `apps/fleet/test/studio.cli-args.test.ts`

**Interfaces:**
- Produces: `CliArgs` variants `{ cmd: "gate-start"; pr: number }`, `{ cmd: "gate-watch"; pr: number }` (internal tag only, same hyphenated-internal/space-separated-CLI split `models-ls` etc. already use); `cmdGateStart(creds, pr): Promise<void>`, `cmdGateWatch(creds, pr): Promise<void>`; `gateWatchExitCode(status: GateStatusResponse): number` (pure, extracted for testability — `cmdGateWatch` cannot itself be unit-tested without a real network call, same reasoning `agents/do.ts`'s `shouldAbortOnTerminal` extraction gives).
- Consumes (wire contract, shared with Task 12 — not a file import): `POST /studio/gate/start` body `{ repo: string; pr: number }` → `{ started: true; runId: string } | { error: string }` (404 when the repo isn't gated in). `GET /studio/gate/status?repo=<owner/repo>&runId=<runId>` → `GateStatusResponse = { state: "pending" | "success" | "failure" | "error"; description?: string; statusPostFailed?: boolean }`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/fleet/test/bun/cli-gate.test.ts
import { describe, it, expect } from "bun:test";
import { gateWatchExitCode, type GateStatusResponse } from "../../cli/gate";

describe("gateWatchExitCode", () => {
  it("success -> 0", () => {
    expect(gateWatchExitCode({ state: "success" })).toBe(0);
  });
  it("failure -> 1", () => {
    expect(gateWatchExitCode({ state: "failure", description: "x" })).toBe(1);
  });
  it("error -> 2", () => {
    expect(gateWatchExitCode({ state: "error", description: "x" })).toBe(2);
  });
  it("statusPostFailed overrides the state's own code -> 3", () => {
    const status: GateStatusResponse = { state: "success", statusPostFailed: true };
    expect(gateWatchExitCode(status)).toBe(3);
  });
});
```

Extend `apps/fleet/test/studio.cli-args.test.ts` (existing file) with the `gate start`/`gate watch` parsing cases, following that file's own existing per-command describe-block shape (e.g. the `models-ls`/`models-assign` blocks already there, and `case "models":`'s own `rest`-array shape at `cli-args.ts:1198-1214`):

```ts
describe("gate start / gate watch", () => {
  it("gate start <pr> parses the PR number", () => {
    expect(parseCliArgs(["gate", "start", "715"])).toEqual({ cmd: "gate-start", pr: 715 });
  });
  it("gate watch <pr> parses the PR number", () => {
    expect(parseCliArgs(["gate", "watch", "715"])).toEqual({ cmd: "gate-watch", pr: 715 });
  });
  it("gate start with no PR -> usage", () => {
    expect(parseCliArgs(["gate", "start"]).cmd).toBe("usage");
  });
  it("gate start with a non-numeric PR -> usage", () => {
    expect(parseCliArgs(["gate", "start", "abc"]).cmd).toBe("usage");
  });
  it("gate with no sub-verb -> usage", () => {
    expect(parseCliArgs(["gate"]).cmd).toBe("usage");
  });
  it("gate with an unrecognized sub-verb -> usage", () => {
    expect(parseCliArgs(["gate", "frobnicate", "715"]).cmd).toBe("usage");
  });
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `cd apps/fleet && bun test test/bun/cli-gate.test.ts`
Expected: FAIL — `../../cli/gate` does not exist.
Run: `cd apps/fleet && bun test test/studio.cli-args.test.ts`
Expected: FAIL on the new `gate start`/`gate watch` cases — unrecognized command.

- [ ] **Step 3: Implement**

In `apps/fleet/src/studio/cli-args.ts`, add to the `CliArgs` union (near the existing `models-*` variants, `cli-args.ts:264-267`):

```ts
| { cmd: "gate-start"; pr: number }
| { cmd: "gate-watch"; pr: number }
```

and to the command dispatch (a new `case "gate":`, same shape as the existing `case "models":`, `cli-args.ts:1198-1214` — ONE top-level command word, sub-verb read from `rest[0]`, not two top-level commands):

```ts
// #715: `fleet gate [start <pr> | watch <pr>]`. Same "sub-action word,
// never a flag" shape `fleet models`/`fleet accounts` already use.
case "gate": {
  const rest = argv.slice(1);
  if (rest[0] === "start") {
    if (rest.length !== 2 || !/^\d+$/.test(rest[1])) return usage("usage: fleet gate start <pr>");
    return { cmd: "gate-start", pr: Number(rest[1]) };
  }
  if (rest[0] === "watch") {
    if (rest.length !== 2 || !/^\d+$/.test(rest[1])) return usage("usage: fleet gate watch <pr>");
    return { cmd: "gate-watch", pr: Number(rest[1]) };
  }
  return usage("usage: fleet gate [start <pr> | watch <pr>]");
}
```

Add a `CLI_HELP`-style entry (next to the existing `"models-ls"` entry, `cli-args.ts:441-452` — keyed by the internal hyphenated tag, same as every other multi-word command's help entry already is):

```ts
"gate-start": { args: "<pr>", summary: "fleet gate start <pr> — starts a gate-runner Workflow run for <pr> (no-op if FLEET_GATE_RUNNER is off for the repo)." },
"gate-watch": { args: "<pr>", summary: "fleet gate watch <pr> — polls a gate-runner run for <pr> to a terminal state; exit 0 green/1 red/2 infra error/3 status-post failed." },
```

Create `apps/fleet/cli/gate.ts` (same thin-`fetch` shape as `cli/models.ts`):

```ts
// apps/fleet/cli/gate.ts — `fleet gate start <pr>` / `fleet gate watch <pr>`
// (#715 Phase 1). Same request-building shape cli/models.ts already uses —
// one POST to kick a run off, one GET per poll, a thrown Error on anything
// but a 2xx. No GitHub token here: both routes are Access-JWT-authenticated
// board verbs, same lane as every other `fleet` command (src/gate/routes.ts
// owns the one place a real GitHub token gets minted, Task 14).
import { accessHeaders, type Credentials } from "./fleet";
import { errText } from "./diag";

export interface GateStatusResponse {
  state: "pending" | "success" | "failure" | "error";
  description?: string;
  statusPostFailed?: boolean;
}

const POLL_MS = 5_000;

export async function cmdGateStart(creds: Credentials, pr: number): Promise<void> {
  let res: Response;
  try {
    res = await fetch(new URL("/studio/gate/start", creds.workerUrl), {
      method: "POST", headers: { ...accessHeaders(creds), "content-type": "application/json" },
      body: JSON.stringify({ repo: creds.repo, pr }),
    });
  } catch (err) {
    throw new Error(`fleet gate-start: could not reach ${creds.workerUrl}: ${errText(err)}`);
  }
  const body = await res.json() as { started?: boolean; runId?: string; error?: string };
  if (!res.ok || body.error) {
    console.error(`gate-start failed: ${body.error ?? res.status}`);
    process.exitCode = 2;
    return;
  }
  console.log(`gate-start: run ${body.runId} started for PR #${pr}`);
}

/** Pure — extracted so the exit-code mapping is unit-testable without a
 *  real network call, same "localci.sh exit convention" shape its own
 *  Exit comment states (localci.sh:24): 0 green, 1 red, 2 infra error,
 *  3 a status POST failed twice. statusPostFailed overrides the state's
 *  own code, since a stale gate/verdict is itself the failure to report. */
export function gateWatchExitCode(status: GateStatusResponse): number {
  if (status.statusPostFailed) return 3;
  switch (status.state) {
    case "success": return 0;
    case "failure": return 1;
    case "error": return 2;
    case "pending": return 2; // caller should not exit on pending, see cmdGateWatch
  }
}

export async function cmdGateWatch(creds: Credentials, pr: number): Promise<void> {
  const url = new URL("/studio/gate/status", creds.workerUrl);
  url.searchParams.set("repo", creds.repo);
  url.searchParams.set("pr", String(pr));
  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, { headers: accessHeaders(creds) });
    } catch (err) {
      console.error(`fleet gate-watch: could not reach ${creds.workerUrl}: ${errText(err)}`);
      process.exitCode = 2;
      return;
    }
    const status = await res.json() as GateStatusResponse;
    if (status.state !== "pending") {
      console.log(`gate: ${status.state}${status.description ? ` — ${status.description}` : ""}`);
      process.exitCode = gateWatchExitCode(status);
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
```

Wire dispatch in `apps/fleet/cli/fleet.ts`: add `import { cmdGateStart, cmdGateWatch } from "./gate";` next to the existing `cmdModelsLs` import (`fleet.ts:34`), and in the `switch (parsed.cmd)` block (next to `"models-set"`, `fleet.ts:3145`):

```ts
case "gate-start":
  return cmdGateStart(creds, parsed.pr);
case "gate-watch":
  return cmdGateWatch(creds, parsed.pr);
```

- [ ] **Step 4: Run, confirm it passes**

Run: `cd apps/fleet && bun test test/bun/cli-gate.test.ts test/studio.cli-args.test.ts`
Expected: PASS, every new case green, every pre-existing case in `studio.cli-args.test.ts` still green.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/studio/cli-args.ts apps/fleet/cli/fleet.ts apps/fleet/cli/gate.ts apps/fleet/test/bun/cli-gate.test.ts apps/fleet/test/studio.cli-args.test.ts
git commit -m "feat(fleet): gate-start/gate-watch CLI (refs #715)"
```

---

### Task 8: Shard timing measurement script

**v2: real starting numbers, not an abstract placeholder.** 98 runs of this repo's existing `check` job (today's `bun-test`/`vitest` lanes) model fleetflare's own floor: bun shards pack to a 209s floor at N=4-8 (one hot file, `apps/fleet/test/bun/deploy-rescue-gate.test.ts`, needs splitting BY TEST to go lower — Task 15), vitest shards floor at 67s at N=8 (hot file `apps/fleet/test/studio.burn.test.ts`). Recommended real mix, combined with Task 0a's snapshot-spike numbers: bun 5 (8 after Task 15's hot-file split), vitest 8, typecheck/check 1, english+test-lies+classify 1 → **15-18 containers per PR**, not v1's 24-28 guess. This is the concrete number Task 1's wrangler sketch and the Containers account-wide cap bullet (Global Constraints) both now cite.

**Files:**
- Create: `apps/fleet/scripts/gate/measure-shard-timing.ts`
- Test: `apps/fleet/test/bun/gate-measure-shard-timing.test.ts`

**Interfaces:**
- Produces: `parseVitestTimings(text: string): { file: string; ms: number }[]`.
- Consumes: the `vitest --reporter=json` output shape `scripts/localci/summarize.ts`'s `parseVitestJson` already parses (`testResults[].name`/`.startTime`/`.endTime`) — same shape, not a shared import (that function lives in a different, unrelated module with its own responsibility). Task 0a's spike numbers are this script's own real-world calibration, not a code dependency.

- [ ] **Step 1: Write the failing test**

```ts
// apps/fleet/test/bun/gate-measure-shard-timing.test.ts
import { describe, it, expect } from "bun:test";
import { parseVitestTimings } from "../../scripts/gate/measure-shard-timing";

describe("parseVitestTimings", () => {
  it("one entry per test file, duration from endTime - startTime", () => {
    const json = JSON.stringify({
      testResults: [
        { name: "/repo/apps/fleet/test/a.test.ts", startTime: 1000, endTime: 1500 },
        { name: "/repo/apps/fleet/test/b.test.ts", startTime: 2000, endTime: 2300 },
      ],
    });
    expect(parseVitestTimings(json)).toEqual([
      { file: "test/a.test.ts", ms: 500 },
      { file: "test/b.test.ts", ms: 300 },
    ]);
  });

  it("malformed JSON -> empty, never a throw", () => {
    expect(parseVitestTimings("not json")).toEqual([]);
  });

  it("missing startTime/endTime -> 0ms, not NaN or a throw", () => {
    const json = JSON.stringify({ testResults: [{ name: "/repo/apps/fleet/test/c.test.ts" }] });
    expect(parseVitestTimings(json)).toEqual([{ file: "test/c.test.ts", ms: 0 }]);
  });
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `cd apps/fleet && bun test test/bun/gate-measure-shard-timing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/fleet/scripts/gate/measure-shard-timing.ts
//
// #715 / operator 08:25Z: shard count must be MEASURED, not a fixed number.
// Parses the same `vitest --reporter=json` shape localci.sh already
// produces (its own $RUN/vitest.json, scripts/localci/summarize.ts's own
// parseVitestJson) into {file, ms}[] for src/gate/shard-plan.ts's bucketer.
// Run standalone: `bun run apps/fleet/scripts/gate/measure-shard-timing.ts
// <vitest.json path>` prints the {file, ms}[] JSON to stdout.
//
// Real starting numbers (98 runs of this repo's own `check` job, v2
// correction — see this task's own header): vitest shards floor at 67s at
// N=8 (hot file test/studio.burn.test.ts); the bun-test lane's own floor
// (209s at N=4-8) is a SEPARATE lane this script doesn't parse — that one
// needs Task 15's by-test split, not more vitest shards.

export function parseVitestTimings(text: string): { file: string; ms: number }[] {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return [];
  }
  const results = (j as { testResults?: unknown }).testResults;
  if (!Array.isArray(results)) return [];
  return results.map((r) => {
    const rec = r as { name?: unknown; startTime?: unknown; endTime?: unknown };
    const file = String(rec.name ?? "").replace(/^.*\/apps\/fleet\//, "");
    const start = typeof rec.startTime === "number" ? rec.startTime : 0;
    const end = typeof rec.endTime === "number" ? rec.endTime : 0;
    return { file, ms: Math.max(0, end - start) };
  });
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: measure-shard-timing.ts <vitest-reporter-json-path>");
    process.exit(2);
  }
  const text = await Bun.file(path).text();
  console.log(JSON.stringify(parseVitestTimings(text)));
}
```

- [ ] **Step 4: Run, confirm it passes**

Run: `cd apps/fleet && bun test test/bun/gate-measure-shard-timing.test.ts`
Expected: PASS, all 3 cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/scripts/gate/measure-shard-timing.ts apps/fleet/test/bun/gate-measure-shard-timing.test.ts
git commit -m "feat(fleet): gate-runner shard-timing measurement script (refs #715)"
```

---

### Task 9: Browser lane spike (design doc, no code) — v2: primary/fallback flipped

**v2 correction:** v1 recommended CF Browser Rendering as PRIMARY for any future browser-touching leg. A real review comment flagged that Cloudflare's current **Browser Run** (renamed from "Browser Rendering") does not yet fully support the Playwright Test runner — only a Playwright-assertions fork and raw CDP connections — so it can't actually run this repo's own `playwright test` suites today. Flipped: in-container Chromium (today's `apps/fleet/scripts/localci/Dockerfile` pattern, already proven by the real `bun-test` lane) is PRIMARY for any real e2e leg; Browser Run becomes a smoke-only addition (hitting public URLs, no Playwright Test runner needed for that) plus an open spike question, not a switch to flip.

**Files:**
- Create: `docs/superpowers/evidence/2026-10-15-gate-runner-browser-lane-spike.md`

**Interfaces:** none — this is a design/evaluation doc, not implementable logic. No later task depends on its content for compilation; it informs whichever repo's Phase 2 `fleet.json` gate block ends up with a browser-touching leg (fleetflare's own Phase 1 leg list — typecheck/lint/invariants/rust/vitest shards — has no browser leg today).

- [ ] **Step 1: Write the doc**

```markdown
# Gate runner browser lane — in-container Playwright vs CF Browser Run

Evaluation only (#715 operator 08:25Z directive, v2-corrected per a real
review comment on #715) — no leg in fleetflare's own Phase 1 gate list
(typecheck/lint/invariants/rust/vitest shards) is a browser test, so this
doc has no Phase 1 consumer. It is here so a later repo/phase whose gate
DOES need a browser lane has the comparison already made instead of
defaulting to "whatever's already baked into the image."

## Candidates

1. **In-container Chromium** (today's `apps/fleet/scripts/localci/Dockerfile`
   pattern, Playwright baked into the image) — PRIMARY. Proven today (one
   of #715's other named repos already gates this way per #715's own
   background), runs the real `playwright test` runner this repo's own
   e2e suites already use. Tradeoff: every concurrent browser-touching
   shard is itself a GateRunnerDO container, competing with every OTHER leg
   for the same 1,500-vCPU account cap
   (https://developers.cloudflare.com/containers/platform-details/limits/).
2. **CF Browser Run** (Workers binding, formerly "Browser Rendering";
   Puppeteer/Playwright-compatible REST + binding API) —
   https://developers.cloudflare.com/browser-rendering/. Limit: 200
   concurrent sessions/account on the Paid plan
   (https://developers.cloudflare.com/browser-rendering/platform/limits/).
   Does NOT yet fully support the Playwright TEST RUNNER — only a
   Playwright-assertions fork and raw CDP connections — so it cannot run
   this repo's own `playwright test` suites as-is today. SMOKE-ONLY
   addition for now (hitting public URLs, no test-runner dependency), plus
   one open question below.

## Recommendation

Primary: in-container Chromium, for any real e2e leg needing the actual
`playwright test` runner — it is proven today and needs no new binding.
Addition, not a replacement: CF Browser Run for smoke checks against public
URLs, since it doesn't compete with the container vCPU budget the rest of
this plan's legs share and 200 concurrent sessions is well above what one
PR's gate needs. Fallback/future: if Browser Run's Playwright Test runner
support lands, re-evaluate — same posture `fleet.json`'s own per-repo
`gate` block already takes for every other leg: config, not a hard-coded
choice.

## Open for the operator — the one spike this doc can't answer from docs alone

Does `playwright test` actually work over a raw CDP connection against
Browser Run today, for THIS repo's own test suites? Find out with a real
spike before any future plan depends on it — this doc only establishes the
primary/fallback ORDER, not whether the fallback path is viable at all.

Browser Run's binding needs its own wrangler.jsonc entry (another new
binding kind, same "docs-only sketch now, real binding at image-window
time" posture this plan's own Task 1 takes for `workflows`) — not sketched
here since no Phase 1 leg needs it yet.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/evidence/2026-10-15-gate-runner-browser-lane-spike.md
git commit -m "docs(fleet): gate-runner browser lane spike, in-container primary (refs #715)"
```

---

### Task 10: `GateRunnerDO` class — v2: no presigned URLs, plain R2 keys only

**v2 correction:** v1 had this task presign a PUT URL (for the leg's result) and GET URLs (for baseline restore) via the existing `presignR2` helper, then hand those URLs to the container in its env vars. A real review comment flagged that a presigned URL IS itself a bearer credential once minted — "PR code runs beside the result-upload URL → PR can forge its own verdict." Fixed: this task now hands the container plain R2 KEYS (not URLs), created on the `durable_object` scheduling policy (Task 0a/1 decided this first), and the container does plain, unauthenticated-looking `fetch`es that Task 16's Worker-side outbound handler intercepts and actually authorizes — the container never holds a credential OR a credential-bearing URL of any kind. `presignR2` is no longer called anywhere in this plan.

**Files:**
- Create: `apps/fleet/src/gate/do.ts`
- Modify: `apps/fleet/src/env.ts` (one line — see the Global Constraints note on the 3-way split)
- Test: `apps/fleet/test/bun/gate-do.test.ts` (pure helpers only — `GateRunnerDO` itself cannot be constructed under `vitest-pool-workers`, same documented gap `agents/do.ts`'s own header names for `AgentDO`; every decision this class makes is extracted to a plain function first, same shape `shouldAbortOnTerminal`/`toStartInput` already use in `agents/do.ts`).

**Interfaces:**
- Produces: `class GateRunnerDO extends Container<Env>`, exposing `POST /run-leg` (called by Task 14's Workflow step); `buildLegEnvVars(req: GateLegRequest): Record<string, string>` (pure, extracted); `GateLegRequest { owner: string; repo: string; commit: string; leg: string; installCmd: string; legCmd: string; resultKey: string; baselineKeys: string[] }` (plain KEYS now, never a URL).
- Consumes: `Env.GATE_RUNNER` (added by this task, see below). **No longer consumes `presignR2`** — the credential/signing concern moved entirely to Task 16's outbound handler, added to this same file in Wave 3 (never the same wave as this task — same "shared file, different wave" pattern `env.ts`'s own 3-way split uses).

**Phase 1 scoping note:** `rafarc21/fleetflare` is public — `GateLegRequest` carries no GitHub token field. The container (Task 11's `gate-server.ts`) clones anonymously. A `ghToken?: string` field is deliberately NOT added here; Phase 2's private repos are out of scope for this plan and would need their own task to add one (mirroring `agents/do.ts`'s own `StartBody.ghToken` passthrough shape, `agents/do.ts:16`) AND would need Task 16's outbound handler extended to inject it, never passed through this file.

- [ ] **Step 1: Write the failing test**

```ts
// apps/fleet/test/bun/gate-do.test.ts
import { describe, it, expect } from "bun:test";
import { buildLegEnvVars, type GateLegRequest } from "../../src/gate/do";

describe("buildLegEnvVars", () => {
  it("carries every leg field into the container's env, no token or URL field", () => {
    const req: GateLegRequest = {
      owner: "rafarc21", repo: "fleetflare", commit: "abc123", leg: "typecheck",
      installCmd: "bun install --frozen-lockfile", legCmd: "bun run check",
      resultKey: "gate/rafarc21/fleetflare/runs/715/shard-typecheck.json",
      baselineKeys: ["gate/rafarc21/fleetflare/baselines/mainsha-lockhash.tar"],
    };
    const env = buildLegEnvVars(req);
    expect(env).toEqual({
      GATE_REPO: "rafarc21/fleetflare", GATE_COMMIT: "abc123", GATE_LEG: "typecheck",
      GATE_INSTALL_CMD: "bun install --frozen-lockfile", GATE_LEG_CMD: "bun run check",
      GATE_RESULT_KEY: "gate/rafarc21/fleetflare/runs/715/shard-typecheck.json",
      GATE_BASELINE_KEYS: "gate/rafarc21/fleetflare/baselines/mainsha-lockhash.tar",
    });
    expect(Object.keys(env).join(",")).not.toMatch(/token/i);
    expect(Object.values(env).join(",")).not.toMatch(/https?:\/\//);
  });

  it("empty baselineKeys -> empty string, not undefined", () => {
    const req: GateLegRequest = {
      owner: "rafarc21", repo: "fleetflare", commit: "abc123", leg: "lint",
      installCmd: "x", legCmd: "y", resultKey: "z", baselineKeys: [],
    };
    expect(buildLegEnvVars(req).GATE_BASELINE_KEYS).toBe("");
  });
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `cd apps/fleet && bun test test/bun/gate-do.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Add to `apps/fleet/src/env.ts` (near the existing `AGENT: DurableObjectNamespace<AgentDO>` line, `env.ts:11`):

```ts
import type { GateRunnerDO } from "./gate/do";
// ...
GATE_RUNNER: DurableObjectNamespace<GateRunnerDO>;
```

```ts
// apps/fleet/src/gate/do.ts
//
// #715 Phase 1: GateRunnerDO runs ONE leg or ONE shard per container
// instance, writes its JSON result to R2, exits. Not a studio: no Claude
// session, no claude binary, no write-proxy — same four-part container-
// class pattern every existing class uses (AgentDO/DeployDO/StudioDO/
// StudioBigDO, wrangler.example.jsonc:183-242), via the plain Container<Env>
// base AgentDO/DeployDO already use (agents/do.ts, deploy/do.ts) — NOT the
// heavier Sandbox<Env> base StudioDO uses (no tmux/chromium/claude needed).
// Created on the `durable_object` scheduling policy (Task 1's wrangler
// sketch) — this class's own code never checks that at runtime, since the
// policy is fixed at creation; it just relies on the snapshot/outbound-
// handler capabilities that policy provides, wired in by Task 16, later.
//
// v2 correction: this file hands the container PLAIN R2 KEYS, never a
// presigned URL — a real review flagged that a presigned URL IS a bearer
// credential, forgeable by the very PR code it's meant to gate. The
// container's own plain fetches to R2 are authorized by Task 16's
// Worker-side outbound handler, added to this file in a later wave.
import { Container } from "@cloudflare/containers";
import type { Env } from "../env";

const GATE_CONTAINER_PORT = 8080;

export interface GateLegRequest {
  owner: string; repo: string; commit: string; leg: string;
  installCmd: string; legCmd: string;
  resultKey: string; baselineKeys: string[];
}

/** Pure — extracted so the env-var shape is unit-testable without a real
 *  container, same reasoning agents/do.ts's toStartInput extraction gives.
 *  No token field, no URL field: Phase 1's repo (rafarc21/fleetflare) is
 *  public, and even the R2 keys below are plain keys, not credentials —
 *  Task 16's outbound handler is what turns a plain fetch to one of these
 *  keys into an authorized one. */
export function buildLegEnvVars(req: GateLegRequest): Record<string, string> {
  return {
    GATE_REPO: `${req.owner}/${req.repo}`,
    GATE_COMMIT: req.commit,
    GATE_LEG: req.leg,
    GATE_INSTALL_CMD: req.installCmd,
    GATE_LEG_CMD: req.legCmd,
    GATE_RESULT_KEY: req.resultKey,
    GATE_BASELINE_KEYS: req.baselineKeys.join(","),
  };
}

export class GateRunnerDO extends Container<Env> {
  defaultPort = GATE_CONTAINER_PORT;
  // Ephemeral by design (one leg, then exit) — short sleepAfter so a
  // crashed/stuck container doesn't idle-burn vCPU against the account's
  // 1,500-vCPU cap.
  sleepAfter = "2m";

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/run-leg" && req.method === "POST") {
      const body = (await req.json()) as GateLegRequest;
      const envVars = buildLegEnvVars(body);
      await this.start({ envVars });
      await this.startAndWaitForPorts();
      const legRes = await this.containerFetch(new Request(`http://container/run`, { method: "POST" }));
      const legBody = await legRes.json() as { state: "success" | "failure" | "error"; description?: string };
      return Response.json(legBody);
    }
    return new Response("not found", { status: 404 });
  }
  // Task 16 (Wave 3, later than this task, same file) adds BOTH this
  // class's outbound-traffic-handler wiring AND the `/run-leg` change to
  // ACK fast (202) + keep running the container via `this.ctx.waitUntil`,
  // calling `sendEvent` on the calling Workflow instance once done — both
  // land in Task 16, not split across Task 16 and Task 14, so `do.ts` is
  // still only ever touched by ONE task per wave (Task 10 here, Task 16
  // later) — Task 14 (same wave as 16, different file) only CONSUMES this
  // contract, never edits this file. Not sketched in THIS task; see
  // Task 16's own header.
}
```

- [ ] **Step 4: Run, confirm it passes**

Run: `cd apps/fleet && bun test test/bun/gate-do.test.ts`
Expected: PASS, both cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/gate/do.ts apps/fleet/src/env.ts apps/fleet/test/bun/gate-do.test.ts
git commit -m "feat(fleet): GateRunnerDO container class, plain R2 keys not presigned URLs (refs #715)"
```

---

### Task 11: `Dockerfile.gate` + container entrypoint server (IMAGE CHANGE — operator-approved window only) — v2: plain keys, outbound-handler-mediated R2 access, snapshot-primary baseline

**v2 correction:** v1's `gate-server.ts` PUT its result straight to a presigned URL and restored a baseline from a presigned GET URL — both bearer credentials the container held directly. Fixed: the container now does a plain `fetch` against a fixed internal R2 proxy path, carrying a plain R2 KEY (never a credential); Task 16's Worker-side outbound handler is what turns that plain request into an authorized one before it leaves the Worker's own network boundary — the container's own code and its own TLS/HTTP view of the world never contain anything that looks like a secret. Baseline restore also now tries a container snapshot FIRST (Task 0a/5's primary mechanism) before falling back to the R2 tarball GET (same outbound-handler-mediated path as the result PUT).

**Files:**
- Create: `apps/fleet/container/Dockerfile.gate`
- Create: `apps/fleet/container/gate-server.ts`

**Interfaces:**
- Produces: the container's own `POST /run` HTTP handler (consumed by Task 10's `GateRunnerDO.fetch`'s `/run-leg` handler, via `containerFetch`).
- Consumes: `resolveMergeTree`/`ExecFn` from Task 6's `apps/fleet/container/gate-merge-tree.ts` (used for a `leg === "merge-tree"` request — the one leg type whose "install/test command" IS the merge-tree/commit-tree pair, run once per PR before every other leg can check out a resolved tree); the env vars Task 10's `buildLegEnvVars` sets (`GATE_REPO`, `GATE_COMMIT`, `GATE_LEG`, `GATE_INSTALL_CMD`, `GATE_LEG_CMD`, `GATE_RESULT_KEY`, `GATE_BASELINE_KEYS` — plain keys, not URLs); Task 16's outbound handler, implicitly, via every plain `fetch` this file makes to the fixed `http://gate-r2.internal/<key>` path (the handler, not this file, decides what that resolves to and with what credential).

**This is an image-change task.** It ships only at an operator-approved image window (same constraint `apps/fleet/scripts/merge-danger.ts`'s `ONE_WAY_GLOBS` already enforces for every other container Dockerfile, `merge-danger.ts:34-38`). **Plan-level decision, answering the spec's own open question #4:** this Dockerfile lives at `apps/fleet/container/Dockerfile.gate`, NOT `apps/fleet/scripts/gate/Dockerfile` — same directory every other class's Dockerfile already lives in, already covered by `ONE_WAY_GLOBS`'s existing `apps/fleet/container/**` pattern (`merge-danger.ts:35-38`), so this plan needs **zero** `merge-danger.ts` change for THIS path (Task 17's own new `apps/fleet/src/gate/**`/`apps/fleet/scripts/gate/**` entries are a separate, unrelated gap). The spec itself explicitly left this choice to "whoever writes the implementation plan" — this is that choice; flag it to the operator for the spec's next revision.

This task has no TDD step of its own beyond what Task 6 already proved (`resolveMergeTree`'s decision table) — `gate-server.ts`'s own `/run` handler is thin wiring (read env vars, call `Bun.spawn`, PUT a result) in the same self-contained style `container/server.ts` already uses (no test file for that file either, per today's repo). The file-structure note below is the concrete deliverable.

**Open gap, flagged explicitly (not guessed past):** the exact Cloudflare Containers hook/method name a `durable_object`-policy DO class overrides to register its own outbound traffic handler is NOT pinned down here — this plan describes the OUTCOME (container's plain fetch to a fixed internal path gets rewritten + authorized server-side) and leaves the exact binding/method name for Task 16's own implementer to verify against live Cloudflare Containers docs at build time, same posture this plan already takes for other not-yet-built-against-live-docs specifics.

- [ ] **Step 1: Write `gate-server.ts`**

```ts
// apps/fleet/container/gate-server.ts
//
// GateRunnerDO's container-side HTTP server (#715 Phase 1). Self-contained,
// no imports from apps/fleet/src/ — same style container/server.ts already
// uses. Clones ANONYMOUSLY (Phase 1's repo, rafarc21/fleetflare, is public —
// no GitHub token anywhere in this file, by construction, not by omission).
//
// v2: result PUT and baseline restore both go through a fixed internal
// path (http://gate-r2.internal/<key>) that Task 16's Worker-side outbound
// handler intercepts and authorizes — this file never holds a credential
// or a credential-bearing URL, only a plain key string.
import { resolveMergeTree, type ExecFn } from "./gate-merge-tree";

const PORT = Number(process.env.PORT ?? 8080);
const WORKDIR = "/workspace/repo";
const R2_INTERNAL_BASE = "http://gate-r2.internal"; // rewritten by Task 16's outbound handler, never resolved as-is

const exec: ExecFn = async (cmd, args, opts) => {
  const proc = Bun.spawn([cmd, ...args], { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { code, stdout, stderr };
};

async function restoreBaseline(baselineKeys: string[]): Promise<void> {
  // Snapshot restore (Task 0a/5's primary mechanism) happens BEFORE this
  // container's own code runs at all — GateRunnerDO starts the container
  // FROM a snapshot when one exists for this (main-sha, lockfile-hash), so
  // by the time gate-server.ts is running, a snapshot restore (if any) is
  // already done. This function is only the FALLBACK: an R2 tarball GET,
  // for the case no snapshot exists yet (first PR against a new main SHA).
  for (const key of baselineKeys) {
    try {
      const res = await fetch(`${R2_INTERNAL_BASE}/${key}`);
      if (!res.ok) continue;
      await Bun.write(`${WORKDIR}/.gate-baseline.tar`, await res.arrayBuffer());
      await exec("tar", ["-xf", `${WORKDIR}/.gate-baseline.tar`, "-C", WORKDIR], { cwd: WORKDIR });
    } catch (err) {
      console.error("gate-server: baseline restore failed", err instanceof Error ? err.message : String(err));
    }
  }
}

async function run(): Promise<{ state: "success" | "failure" | "error"; description?: string }> {
  const repo = process.env.GATE_REPO ?? "";
  const commit = process.env.GATE_COMMIT ?? "";
  const leg = process.env.GATE_LEG ?? "";
  const installCmd = process.env.GATE_INSTALL_CMD ?? "";
  const legCmd = process.env.GATE_LEG_CMD ?? "";
  const resultKey = process.env.GATE_RESULT_KEY ?? "";
  const baselineKeys = (process.env.GATE_BASELINE_KEYS ?? "").split(",").filter((k) => k.length > 0);

  const clone = await exec("git", ["clone", "--quiet", `https://github.com/${repo}.git`, WORKDIR], { cwd: "/workspace" });
  if (clone.code !== 0) return { state: "error", description: `clone failed: ${clone.stderr.split("\n")[0]}` };

  if (leg === "merge-tree") {
    const [base, head] = commit.split("..");
    const result = await resolveMergeTree(exec, WORKDIR, base, head);
    const outcome = result.ok
      ? { state: "success" as const }
      : result.kind === "conflict"
        ? { state: "failure" as const, description: "merge conflict against main" }
        : { state: "error" as const, description: result.message };
    await putResult(resultKey, { ...outcome, commit: result.ok ? result.commit : undefined });
    return outcome;
  }

  await restoreBaseline(baselineKeys);

  const checkout = await exec("git", ["checkout", "--quiet", commit], { cwd: WORKDIR });
  if (checkout.code !== 0) return { state: "error", description: `checkout failed: ${checkout.stderr.split("\n")[0]}` };

  const install = await exec("bash", ["-c", installCmd], { cwd: WORKDIR });
  if (install.code !== 0) {
    const outcome = { state: "error" as const, description: `install failed: ${install.stderr.split("\n")[0]}` };
    await putResult(resultKey, outcome);
    return outcome;
  }

  const test = await exec("bash", ["-c", legCmd], { cwd: WORKDIR });
  const outcome = test.code === 0
    ? { state: "success" as const }
    : { state: "failure" as const, description: `${leg} exited ${test.code}` };
  await putResult(resultKey, { ...outcome, stdout: test.stdout.slice(-4000), stderr: test.stderr.slice(-4000) });
  return outcome;
}

async function putResult(key: string, body: unknown): Promise<void> {
  if (!key) return;
  try {
    await fetch(`${R2_INTERNAL_BASE}/${key}`, { method: "PUT", body: JSON.stringify(body) });
  } catch (err) {
    console.error("gate-server: result PUT failed", err instanceof Error ? err.message : String(err));
  }
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    if (new URL(req.url).pathname === "/run" && req.method === "POST") {
      const outcome = await run();
      return Response.json(outcome);
    }
    return new Response("not found", { status: 404 });
  },
});
```

- [ ] **Step 2: Write `Dockerfile.gate`**

```dockerfile
# apps/fleet/container/Dockerfile.gate — GateRunnerDO's image (#715 Phase 1).
# Not Dockerfile.studio: no Claude, no tmux, no chromium, no sandbox base —
# plain bun base, same shape Dockerfile (AgentDO's own) already uses.
ARG SOURCE_DATE_EPOCH=1790640000

FROM oven/bun:1.3-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f AS src
ARG SOURCE_DATE_EPOCH
COPY gate-server.ts gate-merge-tree.ts /src/app/app/
RUN mkdir -p /src/base/etc \
    && printf '127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n' > /src/base/etc/hosts \
    && chmod -R u=rwX,go=rX /src \
    && find /src -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

FROM oven/bun:1.3-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f
ARG SOURCE_DATE_EPOCH
ARG APT_SNAPSHOT=20260929T000000Z
COPY --from=src /src/base/ /

# git (for merge-tree/clone) + rustup/cargo-nextest (the "rust" leg). Pinned
# the same APT_SNAPSHOT discipline Dockerfile.deploy's own header documents
# (reproducible build — scripts/image-repro-check.sh).
RUN apt-get update && apt-get install -y --no-install-recommends git curl build-essential \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable \
    && /root/.cargo/bin/cargo install cargo-nextest --locked \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.cargo/bin:${PATH}"

COPY --from=src /src/app/ /
WORKDIR /app
CMD ["bun", "run", "gate-server.ts"]
```

- [ ] **Step 3: Commit**

```bash
git add apps/fleet/container/Dockerfile.gate apps/fleet/container/gate-server.ts
git commit -m "feat(fleet): GateRunnerDO image + container entrypoint, no presigned URLs (refs #715)

IMAGE CHANGE — ships only at an operator-approved image window."
```

---

### Task 12: Worker gate HTTP routes

**Files:**
- Create: `apps/fleet/src/gate/routes.ts`
- Modify: `apps/fleet/src/studio/routes.ts` (mount, next to the existing `/studio/models` mount, `routes.ts:909-911`)
- Test: `apps/fleet/test/gate-routes.test.ts` (vitest, `cloudflare:test` pool — mocks `env.GATE_WORKFLOW`, same fake-binding approach `models-route` tests already use for `env.DB`)

**Interfaces:**
- Produces: `handleGateRoute(req: Request, env: Env): Promise<Response>`.
- Consumes (wire contract, shared with Task 7, specified in full there): `POST /studio/gate/start` `{ repo, pr }` → `{ started: true; runId } | { error }`; `GET /studio/gate/status?repo&pr` → `GateStatusResponse`. Calls `env.GATE_WORKFLOW.create(...)` / `env.GATE_WORKFLOW.get(id).status()` — the Workflows binding's own native instance-status API, **not** a second GitHub API read: this route never touches a GitHub token (a deliberate design choice — see "Guesses / gaps" at the end, since the spec itself didn't pin this down).

- [ ] **Step 1: Write the failing test**

```ts
// apps/fleet/test/gate-routes.test.ts
import { describe, it, expect, vi } from "vitest";
import { handleGateRoute } from "../src/gate/routes";
import type { Env } from "../src/env";

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    FLEET_GATE_RUNNER: "on", GATE_RUNNER_REPOS: "rafarc21/fleetflare",
    GATE_WORKFLOW: {
      create: vi.fn(async () => ({ id: "run-1" })),
      get: vi.fn(() => ({ status: vi.fn(async () => ({ status: "running" })) })),
    },
    ...overrides,
  } as unknown as Env;
}

describe("handleGateRoute", () => {
  it("POST /studio/gate/start -> 404 when FLEET_GATE_RUNNER is off", async () => {
    const env = fakeEnv({ FLEET_GATE_RUNNER: "off" });
    const req = new Request("https://worker/studio/gate/start", {
      method: "POST", body: JSON.stringify({ repo: "rafarc21/fleetflare", pr: 715 }),
    });
    const res = await handleGateRoute(req, env);
    expect(res.status).toBe(404);
  });

  it("POST /studio/gate/start -> 404 when the repo isn't in GATE_RUNNER_REPOS", async () => {
    const env = fakeEnv({ GATE_RUNNER_REPOS: "other/repo" });
    const req = new Request("https://worker/studio/gate/start", {
      method: "POST", body: JSON.stringify({ repo: "rafarc21/fleetflare", pr: 715 }),
    });
    const res = await handleGateRoute(req, env);
    expect(res.status).toBe(404);
  });

  it("POST /studio/gate/start -> creates a workflow instance for a gated-in repo", async () => {
    const env = fakeEnv();
    const req = new Request("https://worker/studio/gate/start", {
      method: "POST", body: JSON.stringify({ repo: "rafarc21/fleetflare", pr: 715 }),
    });
    const res = await handleGateRoute(req, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ started: true, runId: "run-1" });
    expect(env.GATE_WORKFLOW.create).toHaveBeenCalledOnce();
  });

  it("GET /studio/gate/status -> reads the workflow instance's own status, no GitHub call", async () => {
    const env = fakeEnv();
    const req = new Request("https://worker/studio/gate/status?repo=rafarc21/fleetflare&runId=run-1");
    const res = await handleGateRoute(req, env);
    expect(res.status).toBe(200);
    expect(env.GATE_WORKFLOW.get).toHaveBeenCalledWith("run-1");
  });
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `cd apps/fleet && bun x vitest run test/gate-routes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/fleet/src/gate/routes.ts
//
// /studio/gate/start, /studio/gate/status (#715 Phase 1). Mounted inside
// src/studio/routes.ts's handleStudio, same Access-gated lane as
// /studio/models — this module carries no auth of its own, same posture
// handleModelsRoute's own header states. Never touches a GitHub token:
// /start creates a GATE_WORKFLOW instance (the Workflow itself, Task 14,
// is the one place that mints one); /status reads the Workflow binding's
// OWN native instance-status API, not a second GitHub read.
import type { Env } from "../env";
import { isGateRunnerRepo } from "./config";

const j = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

export async function handleGateRoute(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/studio/gate/start" && req.method === "POST") {
    const body = (await req.json()) as { repo: string; pr: number };
    if (env.FLEET_GATE_RUNNER !== "on" || !isGateRunnerRepo(env.GATE_RUNNER_REPOS, body.repo)) {
      return j({ error: "gate runner not enabled for this repo" }, 404);
    }
    const instance = await env.GATE_WORKFLOW.create({ params: { repo: body.repo, pr: body.pr } });
    return j({ started: true, runId: instance.id });
  }

  if (url.pathname === "/studio/gate/status" && req.method === "GET") {
    const runId = url.searchParams.get("runId");
    if (!runId) return j({ error: "runId required" }, 400);
    const instance = env.GATE_WORKFLOW.get(runId);
    const status = await instance.status();
    // Task 14's own verdict is carried in the Workflow's own output once
    // terminal; "running"/"queued" map to pending here.
    const out = status.output as { state?: string; description?: string; statusPostFailed?: boolean } | undefined;
    if (status.status !== "complete" && status.status !== "errored") {
      return j({ state: "pending" });
    }
    if (status.status === "errored" || !out?.state) {
      return j({ state: "error", description: "gate workflow instance errored" });
    }
    return j({ state: out.state, description: out.description, statusPostFailed: out.statusPostFailed });
  }

  return j({ error: "not found" }, 404);
}
```

Mount in `apps/fleet/src/studio/routes.ts` (next to the existing `/studio/models` block, `routes.ts:909-911`):

```ts
if (url.pathname === "/studio/gate/start" || url.pathname === "/studio/gate/status") {
  return handleGateRoute(req, env);
}
```

and add `import { handleGateRoute } from "../gate/routes";` next to the existing `handleModelsRoute` import (`routes.ts:49`).

- [ ] **Step 4: Run, confirm it passes**

Run: `cd apps/fleet && bun x vitest run test/gate-routes.test.ts`
Expected: PASS, all 4 cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/gate/routes.ts apps/fleet/src/studio/routes.ts apps/fleet/test/gate-routes.test.ts
git commit -m "feat(fleet): gate-start/gate-status Worker routes (refs #715)"
```

---

### Task 13: Warm-pool keep-warm cron

**Files:**
- Create: `apps/fleet/src/gate/warm-pool.ts`
- Modify: `apps/fleet/src/index.ts` (`handleScheduled`, next to the existing watchdog block, `index.ts:184-188`)
- Test: `apps/fleet/test/bun/gate-warm-pool.test.ts`

**Interfaces:**
- Produces: `warmPoolSize(raw: string | undefined): number` (pure — operator-set via a new `GATE_WARM_POOL_SIZE` var, default `0` = off, never hardcoded), `shouldNudgeWarmPool(size: number, flag: string | undefined): boolean`.
- Consumes: `Env.FLEET_GATE_RUNNER`, a new `Env.GATE_WARM_POOL_SIZE?: string` (this task's own addition — no other task touches this field, no collision).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/fleet/test/bun/gate-warm-pool.test.ts
import { describe, it, expect } from "bun:test";
import { warmPoolSize, shouldNudgeWarmPool } from "../../src/gate/warm-pool";

describe("warmPoolSize", () => {
  it("absent -> 0 (off), the safe default", () => {
    expect(warmPoolSize(undefined)).toBe(0);
  });
  it("a set, valid size is the operator's own tradeoff, not hardcoded", () => {
    expect(warmPoolSize("5")).toBe(5);
  });
  it("malformed value -> 0, never NaN", () => {
    expect(warmPoolSize("not-a-number")).toBe(0);
  });
  it("negative value -> 0, never negative", () => {
    expect(warmPoolSize("-3")).toBe(0);
  });
});

describe("shouldNudgeWarmPool", () => {
  it("false when size is 0", () => {
    expect(shouldNudgeWarmPool(0, "on")).toBe(false);
  });
  it("false when FLEET_GATE_RUNNER is off even with a set size", () => {
    expect(shouldNudgeWarmPool(5, "off")).toBe(false);
  });
  it("true when both are set", () => {
    expect(shouldNudgeWarmPool(5, "on")).toBe(true);
  });
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `cd apps/fleet && bun test test/bun/gate-warm-pool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/fleet/src/gate/warm-pool.ts
//
// #715 / operator 08:25Z: "warm GateRunner pool... sized as an operator-set
// tradeoff," never a hardcoded number. GATE_WARM_POOL_SIZE absent/invalid
// = 0 = off, same "zero new behavior until opted in" posture every other
// gate-runner flag in this plan already takes.

export function warmPoolSize(raw: string | undefined): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export function shouldNudgeWarmPool(size: number, flag: string | undefined): boolean {
  return size > 0 && flag === "on";
}
```

Add to `apps/fleet/src/env.ts`: `GATE_WARM_POOL_SIZE?: string;` (next to the fields Task 1 added — this is a fourth, separate addition by Task 13; still never concurrent with another task's edit to the same file, per the Global Constraints note).

In `apps/fleet/src/index.ts`'s `handleScheduled` (next to the existing watchdog block, after `index.ts:188`):

```ts
import { warmPoolSize, shouldNudgeWarmPool } from "./gate/warm-pool";
// ...
const poolSize = warmPoolSize(env.GATE_WARM_POOL_SIZE);
if (shouldNudgeWarmPool(poolSize, env.FLEET_GATE_RUNNER)) {
  for (let i = 0; i < poolSize; i++) {
    try {
      const stub = env.GATE_RUNNER.get(env.GATE_RUNNER.idFromName(`warm-${i}`));
      await stub.fetch("https://gate-runner/ping");
    } catch (err) {
      console.error(`gate warm-pool nudge ${i} failed`, err);
    }
  }
}
```

(`GateRunnerDO.fetch`'s `/ping` path is a small addition to Task 10's class — out of scope to re-touch Task 10's file here; note this in the self-review as a follow-up one-liner for whichever task lands last between 10 and 13, or add `/ping` directly in Task 10 itself up front since Task 10 already owns `do.ts`. **Correction baked into Task 10 above is NOT assumed** — flagging this explicitly as a small cross-task seam: Task 10's `GateRunnerDO.fetch` should return 200 on any unrecognized path rather than 404, OR Task 13 should add the one-line `/ping` branch to `do.ts` itself as part of ITS OWN diff. Since `do.ts` is Task 10's file, and Task 13 is in the same wave, this is the ONE place this plan's wave-2 file-disjointness is imperfect — see "Guesses / gaps" at the end.)

- [ ] **Step 4: Run, confirm it passes**

Run: `cd apps/fleet && bun test test/bun/gate-warm-pool.test.ts`
Expected: PASS, all 7 cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/gate/warm-pool.ts apps/fleet/src/env.ts apps/fleet/src/index.ts apps/fleet/test/bun/gate-warm-pool.test.ts
git commit -m "feat(fleet): gate-runner warm-pool keep-warm cron (refs #715)"
```

---

### Task 14: `GateWorkflow` + `postCommitStatus` (CLAUDE-ONLY, Wave 3) — v2: event fan-in, not a naive `step.do` per leg; blocked on Task 0b

**v2 correction (real review comment — this changes the Workflow's own DESIGN, not just its wording):** Cloudflare Workflows retries a step that THROWS 5x with backoff, up to a 10-minute per-attempt timeout. v1's `run-legs` step wrapped the ENTIRE fan-out — every leg's full container run — inside one `step.do` call: if any single leg's `fetch` legitimately threw (a real infra blip), the WHOLE batch (every leg, including ones that already finished) would be retried, re-running containers that had already posted a correct result. Fixed: each leg is now a short, idempotent `start-shard-<leg>` step that only KICKS OFF its `GateRunnerDO` (fire-and-forget, via `ctx.waitUntil`, not awaited to completion inside the step), followed by a `step.waitForEvent` with its own explicit per-leg timeout; `GateRunnerDO` calls `sendEvent` back on the SAME workflow instance once its container finishes, carrying the `LegResult` — including a red test's `state: "failure"` — as the event's DATA payload, never as a thrown step exception. A genuinely red test can never trigger Workflows' infra-retry behavior; only a real infra failure (the event never arriving before its own timeout) does.

**Files:**
- Create: `apps/fleet/src/gate/workflow.ts`
- Modify: `apps/fleet/src/env.ts` (one line — see the Global Constraints note)
- Modify: `apps/fleet/src/github/api.ts` (add `postCommitStatus`)
- Test: `apps/fleet/test/bun/gate-workflow-verdict.test.ts` (the one pure seam inside this file — everything else needs a live Workflow/DO/GitHub-token round trip and is validated per the spec's own testing plan, not unit-tested here)

**Does NOT touch `apps/fleet/src/gate/do.ts`.** The `/run-leg` handler change this task's own design needs (ACK fast with 202, call `sendEvent` back on the calling Workflow instance once the container finishes, instead of the Worker-side route awaiting the container's full run synchronously) is Task 16's own diff against `do.ts`, not this task's — keeping `do.ts` touched by exactly one task per wave (Task 10, then Task 16), never both Task 14 and Task 16 in the same Wave 3.

**Precondition, not a routing-around option:** blocked on Task 0b (the GitHub App's `Commit statuses: write` grant). `postCommitStatus` will 403 on every run until that lands, regardless of how correct this task's own diff is — this is a GitHub App permission gap, confirmed by a real review comment, not an "unverified PAT scope" as the earlier ci-steward spec speculated.

**Interfaces:**
- Produces: `class GateWorkflow extends WorkflowEntrypoint<Env, GateWorkflowParams>`, `GateWorkflowParams { repo: string; pr: number }`; `postCommitStatus(token: string, repo: string, sha: string, state: "pending" | "success" | "failure" | "error", context: string, description: string): Promise<void>` (in `github/api.ts`, alongside `mergePullRequest`/`ghRequest` it already exports).
- Consumes: Task 2's `config.ts` (`parseGateConfig`, `matchesPathRules`), Task 3's `shard-plan.ts` (`planShards`), Task 4's `verdict.ts` (`aggregateVerdict`), Task 5's `baseline.ts` (`baselineId`, `baselineTarballKey`, `baselineSnapshotName` — no KV, see Global Constraints), Task 10's `GateRunnerDO` RPC contract (`POST /run-leg`, documented in Task 10) via `env.GATE_RUNNER`, Task 16's outbound handler implicitly (every leg's R2 access goes through it, this file never touches R2 directly), existing `apps/fleet/src/github/api.ts` exports (`getPullRequest`, `getDefaultBranch`) and `apps/fleet/src/github/auth.ts`'s `repoTokenMinter`. `fleet.json`'s own gate block is fetched from `env.AGENT_REPO`, never from `repo` (the work repo being gated) — Task 2's own header states this; this is the one place in the plan that actually performs that fetch, so this is the one place the pin matters.

- [ ] **Step 1: Write the failing test (the one pure seam)**

```ts
// apps/fleet/test/bun/gate-workflow-verdict.test.ts
//
// GateWorkflow itself needs a live Workflow/DO/GitHub round trip (the
// spec's own testing plan, item 4: a real PR diffed against a Mac localci.sh
// run) — not unit-testable here. This pins the one pure decision the
// Workflow's own fan-in step makes before calling postCommitStatus: mapping
// verdict.ts's Verdict into the exact (state, description) pair a commit
// status needs.
import { describe, it, expect } from "bun:test";
import { verdictToStatusArgs } from "../../src/gate/workflow";

describe("verdictToStatusArgs", () => {
  it("success -> pending description text replaced with a terminal one", () => {
    expect(verdictToStatusArgs({ state: "success" })).toEqual({
      state: "success", description: "all legs green",
    });
  });
  it("failure carries its own description through unchanged", () => {
    expect(verdictToStatusArgs({ state: "failure", description: "vitest-3 failed" })).toEqual({
      state: "failure", description: "vitest-3 failed",
    });
  });
  it("error carries its own description through unchanged", () => {
    expect(verdictToStatusArgs({ state: "error", description: "GateRunnerDO OOM" })).toEqual({
      state: "error", description: "GateRunnerDO OOM",
    });
  });
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `cd apps/fleet && bun test test/bun/gate-workflow-verdict.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

In `apps/fleet/src/github/api.ts` (alongside `mergePullRequest`, `api.ts:87`):

```ts
/** Posts one commit status. No existing helper does this today — the only
 *  prior art is localci.sh's own `gh api -X POST
 *  repos/$GH_REPO/statuses/$SHA` (localci.sh:251-265). The ONE caller of
 *  this function in the whole codebase is GateWorkflow (src/gate/
 *  workflow.ts) — see that file's own header for why it, not this function,
 *  owns the retry-twice-then-give-up behavior localci.sh's own `post`
 *  helper has. */
export async function postCommitStatus(
  token: string, repo: string, sha: string,
  state: "pending" | "success" | "failure" | "error", context: string, description: string,
): Promise<void> {
  await ghRequest(
    token, `https://api.github.com/repos/${repo}/statuses/${sha}`,
    { method: "POST", body: JSON.stringify({ state, context, description }) },
    `postCommitStatus ${context}=${state}`,
  );
}
```

Add to `apps/fleet/src/env.ts`: `import type { GateWorkflow } from "./gate/workflow";` and `GATE_WORKFLOW: Workflow<GateWorkflowParams>;` (the `GateWorkflowParams` type itself is exported from `workflow.ts`, imported alongside the class).

```ts
// apps/fleet/src/gate/workflow.ts
//
// #715 Phase 1: the Workflow `gate`. Resolves PR head + main -> merge-tree
// commit -> fans out one GateRunnerDO leg/shard per container -> fans in to
// one gate/verdict commit status -> writes the run's manifest to R2. The
// ONE file in this plan that mints a GitHub token and posts a REAL commit
// status — every other piece of logic it calls (config, shard-plan,
// verdict, baseline) is pure and already unit-tested in its own task.
//
// v2 correction (real review, changes design not just wording): Workflows
// retries a step that THROWS 5x with backoff. Each leg below is therefore
// a SHORT, idempotent "start-shard-<leg>" step (just kicks the container
// off, fire-and-forget via ctx.waitUntil) followed by a step.waitForEvent
// with its OWN per-leg timeout — GateRunnerDO calls sendEvent back on this
// same instance once its container finishes, carrying the LegResult
// (including a red test's state: "failure") as EVENT DATA, never as a
// thrown step exception. A red test can never trigger Workflows' own
// infra-retry behavior; only a real infra failure (timeout with no event)
// does.
//
// Precondition, not resolved here: Task 0b (operator grants the GitHub
// App `Commit statuses: write`) must land before postCommitStatus below
// can succeed — confirmed a GitHub App permission gap by a real review
// comment, not an "unverified PAT scope" as the earlier ci-steward spec
// speculated.
import { WorkflowEntrypoint, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env";
import { getPullRequest, getDefaultBranch, postCommitStatus } from "../github/api";
import { repoTokenMinter } from "../github/auth";
import { parseGateConfig, matchesPathRules } from "./config";
import { planShards } from "./shard-plan";
import { aggregateVerdict, type LegResult, type Verdict } from "./verdict";
import { baselineTarballKey, baselineSnapshotName } from "./baseline";

export interface GateWorkflowParams { repo: string; pr: number }

const GATE_STATUS_CONTEXT = "gate/verdict";
const SHARD_EVENT_TYPE = "gate.shard.result";
const SHARD_TIMEOUT = "10 minutes"; // one per-leg ceiling, not one ceiling for the whole fan-out

/** Pure — the one seam unit-tested without a live Workflow (Step 1, above).
 *  verdict.ts's own "pending" state never reaches here (the Workflow only
 *  calls this after aggregateVerdict returns a terminal state). */
export function verdictToStatusArgs(
  verdict: Exclude<Verdict, { state: "pending" }>,
): { state: "success" | "failure" | "error"; description: string } {
  if (verdict.state === "success") return { state: "success", description: "all legs green" };
  return { state: verdict.state, description: verdict.description };
}

/** Fans one leg out as a short kick-off step + a waitForEvent with its own
 *  timeout — NOT a step.do that awaits the container's full run. Task 10's
 *  do.ts (its own later-wave addition, same task as this one touches) is
 *  what calls `env.GATE_WORKFLOW.get(instanceId).sendEvent(...)` once the
 *  container finishes; this function only kicks that off and waits. */
async function runLeg(
  env: Env, step: WorkflowStep, instanceId: string,
  owner: string, repoName: string, leg: string, commit: string,
  installCmd: string, legCmd: string, resultKey: string, baselineKeys: string[],
): Promise<LegResult> {
  await step.do(`start-shard-${leg}`, async () => {
    const stub = env.GATE_RUNNER.get(env.GATE_RUNNER.idFromName(`${owner}/${repoName}-${leg}`));
    // GateRunnerDO's own /run-leg handler (Task 10/14's do.ts addition)
    // ACKs immediately (202) and keeps the container running via its own
    // `this.ctx.waitUntil` — the fire-and-forget boundary lives in the DO,
    // not here, so this step's own await resolves fast either way. The
    // actual leg result arrives later via sendEvent, below, never via this
    // fetch's own response body.
    await stub.fetch("https://gate-runner/run-leg", {
      method: "POST",
      body: JSON.stringify({
        owner, repo: repoName, commit, leg, installCmd, legCmd, resultKey, baselineKeys,
        instanceId, eventType: SHARD_EVENT_TYPE,
      }),
    });
  });
  const received = await step.waitForEvent<LegResult>(`shard-${leg}-done`, {
    type: SHARD_EVENT_TYPE, timeout: SHARD_TIMEOUT,
  });
  return received.payload;
}

export class GateWorkflow extends WorkflowEntrypoint<Env, GateWorkflowParams> {
  async run(event: { payload: GateWorkflowParams }, step: WorkflowStep) {
    const { repo, pr } = event.payload;
    const [owner, repoName] = repo.split("/");
    const mintToken = repoTokenMinter(this.env);
    const instanceId = (this as unknown as { instanceId?: string }).instanceId ?? `${repo}-${pr}`;

    const prInfo = await step.do("resolve-pr", async () => {
      const token = await mintToken(repo);
      const pull = await getPullRequest(token, repo, pr);
      const base = await getDefaultBranch(token, repo);
      return { headSha: pull.headSha, base };
    });

    // fleet.json's own gate block — fetched from env.AGENT_REPO, NEVER from
    // `repo` (the work repo being gated; Task 2's own header states why).
    // legs/install/vitestCmd come from parseGateConfig once that fetch
    // lands in the real implementation. Path-rule skip (matchesPathRules)
    // short-circuits before any container spins up, same as localci.sh's
    // own skip_fleet. baselineTarballKey/baselineSnapshotName (Task 5) key
    // off (owner, repo, prInfo.base-sha, lockfileHash) — snapshot restore
    // is attempted first by GateRunnerDO's own start sequence (Task 11),
    // the tarball key below is only the fallback list passed through.

    const mergeTreeResult = await runLeg(
      this.env, step, instanceId, owner, repoName, "merge-tree",
      `${prInfo.base}..${prInfo.headSha}`, "", "",
      `gate/${owner}/${repoName}/runs/${pr}/shard-merge-tree.json`, [],
    );
    const legResults: LegResult[] = [{ leg: "merge-tree", state: mergeTreeResult.state, description: mergeTreeResult.description }];
    // Every other leg (typecheck/lint/invariants/rust/vitest shards, per
    // Task 2's fleet.json config + Task 3's shard-plan) fans out via the
    // same runLeg() call, one GateRunnerDO instance each, each with its own
    // start-shard-<leg> step + waitForEvent — elided here since it is the
    // same pattern repeated N times, not new logic.

    const verdict = await step.do("aggregate-verdict", async () =>
      aggregateVerdict(legResults.map((r) => r.leg), legResults));

    let statusPostFailed = false;
    if (verdict.state !== "pending") {
      statusPostFailed = await step.do("post-verdict", async () => {
        const token = await mintToken(repo);
        const args = verdictToStatusArgs(verdict);
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            await postCommitStatus(token, repo, prInfo.headSha, args.state, GATE_STATUS_CONTEXT, args.description);
            return false;
          } catch (err) {
            console.error(`gate/verdict POST attempt ${attempt} failed`, err);
          }
        }
        return true;
      });
    }

    return { ...(verdict.state === "pending" ? { state: "error" as const, description: "no legs reported" } : verdict), statusPostFailed };
  }
}
```

- [ ] **Step 4: Run, confirm it passes**

Run: `cd apps/fleet && bun test test/bun/gate-workflow-verdict.test.ts`
Expected: PASS, all 3 cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/gate/workflow.ts apps/fleet/src/env.ts apps/fleet/src/github/api.ts apps/fleet/test/bun/gate-workflow-verdict.test.ts
git commit -m "feat(fleet): GateWorkflow + postCommitStatus (refs #715)"
```

---

### Task 15: Split `deploy-rescue-gate.test.ts` by test name, not by file (Wave 1, new)

**Why:** Task 8's real CI-timing data (98 runs) shows `apps/fleet/test/bun/deploy-rescue-gate.test.ts` is the bun-test lane's own floor — one file, confirmed real in this repo (138 tests across its own `describe`/`it` blocks). File-level sharding can't split this floor any further; the fix is a test-NAME filter, so the same file's tests spread across multiple shards.

**Files:**
- Create: `apps/fleet/scripts/gate/shard-by-test-name.ts`
- Test: `apps/fleet/test/bun/gate-shard-by-test-name.test.ts`

**Interfaces:**
- Produces: `listTestNames(filePath: string): Promise<string[]>` (shells out to `bun test --list-tests` or an equivalent enumeration — exact bun flag verified against this repo's own bun version at implementation time, flagged as a guess here); `bucketTestNames(names: string[], n: number): string[][]` (pure — reuses the same LPT-style balancing idea as Task 3's `planShards`, but keyed by test NAME not file, since this is one file's own tests).
- Consumes: nothing at the type level; the gate leg's own `legCmd` for this file becomes `bun test deploy-rescue-gate.test.ts -t "<name-filter-for-this-shard>"` once wired into Task 2's `fleet.json` gate block — that wiring is config, not code, out of scope for this task's own diff.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/fleet/test/bun/gate-shard-by-test-name.test.ts
import { describe, it, expect } from "bun:test";
import { bucketTestNames } from "../../scripts/gate/shard-by-test-name";

describe("bucketTestNames", () => {
  it("splits N names across n buckets, every name assigned exactly once", () => {
    const names = Array.from({ length: 16 }, (_, i) => `test ${i}`);
    const buckets = bucketTestNames(names, 8);
    expect(buckets.length).toBe(8);
    expect(buckets.flat().sort()).toEqual(names.slice().sort());
  });

  it("never returns an empty bucket when n <= names.length", () => {
    const names = ["a", "b", "c"];
    const buckets = bucketTestNames(names, 3);
    expect(buckets.every((b) => b.length > 0)).toBe(true);
  });

  it("empty input -> n empty buckets, not a throw", () => {
    expect(bucketTestNames([], 4)).toEqual([[], [], [], []]);
  });
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `cd apps/fleet && bun test test/bun/gate-shard-by-test-name.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/fleet/scripts/gate/shard-by-test-name.ts
//
// #715 v2 (real CI-timing data): deploy-rescue-gate.test.ts's own 138 tests
// are the bun-test lane's floor at file-level sharding (209s at N=4-8).
// bucketTestNames splits that ONE file's own test names round-robin across
// n shards — simple round-robin, not LPT-weighted like Task 3's
// planShards, since per-test timing within one file isn't measured here
// (Task 8's own scope is per-FILE timing); round-robin is good enough to
// go from "209s floor" to "209s / n", even without per-test weights.

export function bucketTestNames(names: string[], n: number): string[][] {
  const buckets: string[][] = Array.from({ length: n }, () => []);
  names.forEach((name, i) => buckets[i % n].push(name));
  return buckets;
}

if (import.meta.main) {
  const n = Number(process.argv[2] ?? 8);
  const proc = Bun.spawn(["bun", "test", "test/bun/deploy-rescue-gate.test.ts", "--list-tests"], { stdout: "pipe" });
  const text = await new Response(proc.stdout).text();
  const names = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  console.log(JSON.stringify(bucketTestNames(names, n)));
}
```

- [ ] **Step 4: Run, confirm it passes**

Run: `cd apps/fleet && bun test test/bun/gate-shard-by-test-name.test.ts`
Expected: PASS, all 3 cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/scripts/gate/shard-by-test-name.ts apps/fleet/test/bun/gate-shard-by-test-name.test.ts
git commit -m "feat(fleet): split deploy-rescue-gate.test.ts by test name, not file (refs #715)"
```

---

### Task 16: Worker-side outbound handler for `GateRunnerDO` (CLAUDE-ONLY, Wave 3)

**Why this is CLAUDE-ONLY, full stop:** this is the one file, besides `workflow.ts`, where a real credential (the R2 write key) lives — the blueprint's banned-areas list names auth/secrets/tokens/credentials directly. v1 of this plan had no such file: it presigned URLs in Task 10 instead, which a real review comment flagged as itself a forgeable credential ("PR code runs beside the result-upload URL → PR can forge its own verdict"). This task is the actual fix: the credential moves OFF any path the container ever sees, into a Worker-side hook that only Cloudflare's own outbound-traffic-handler mechanism can reach — confirmed real and documented ("programmable egress proxies... have access to all Workers bindings... No token is exposed to the container. The secret lives in the Worker's environment and is never passed into the sandbox"), available only under the `durable_object` scheduling policy Task 0a/1 already committed to.

**Files:**
- Modify: `apps/fleet/src/gate/do.ts` (Task 10's file — this task's own diff, in a LATER wave than Task 10, never concurrent with it)
- Create: `apps/fleet/src/gate/outbound-handler.ts`
- Test: `apps/fleet/test/bun/gate-outbound-handler.test.ts` (the pure routing/rewrite decision — which internal path maps to which real R2 key/credential-injection call — is unit-tested; the actual credential injection itself needs a live container+Worker round trip, same posture Task 14's own live-round-trip items take)

**Interfaces:**
- Produces: `resolveOutboundTarget(path: string): { bucket: "STUDIO_ARCHIVE"; key: string } | null` (pure — parses the container's own fixed `http://gate-r2.internal/<key>` request path from Task 11's `gate-server.ts` into the real R2 binding + key, or `null` for anything that doesn't match that one allowed shape — an allow-list, not a passthrough); the actual outbound-handler hook wired onto `GateRunnerDO` (exact Cloudflare Containers method/hook name flagged as unverified against live docs in Task 11's own header — this task's implementer confirms it at build time); the `/run-leg` handler change (ACK 202 fast, `this.ctx.waitUntil` keeps the container run going, `sendEvent` back on the calling Workflow instance once done — Task 14's own design need, consumed here since `do.ts` is this task's file this wave, not Task 14's).
- Consumes: `env.STUDIO_ARCHIVE` (existing R2 binding, this plan's own `gate/` prefix within it — no new bucket); Task 5's `baselineTarballKey`/`baselineSnapshotName` key SHAPES (to validate an incoming path actually looks like a gate-runner key before authorizing anything against it — never a blanket "sign anything asked").

**Review Focus for this task specifically:** `resolveOutboundTarget` must return `null` (never authorize) for any path that doesn't match the exact `gate/<owner>/<repo>/...` prefix shape — a container that somehow got a different internal path should get refused, not silently signed against an arbitrary key.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/fleet/test/bun/gate-outbound-handler.test.ts
import { describe, it, expect } from "bun:test";
import { resolveOutboundTarget } from "../../src/gate/outbound-handler";

describe("resolveOutboundTarget", () => {
  it("a valid gate-runner result key resolves to STUDIO_ARCHIVE + that key", () => {
    expect(resolveOutboundTarget("/gate/rafarc21/fleetflare/runs/715/shard-typecheck.json")).toEqual({
      bucket: "STUDIO_ARCHIVE", key: "gate/rafarc21/fleetflare/runs/715/shard-typecheck.json",
    });
  });

  it("a valid baseline tarball key resolves the same way", () => {
    expect(resolveOutboundTarget("/gate/rafarc21/fleetflare/baselines/abc-def.tar")).toEqual({
      bucket: "STUDIO_ARCHIVE", key: "gate/rafarc21/fleetflare/baselines/abc-def.tar",
    });
  });

  it("anything outside the gate/ prefix is refused, never authorized", () => {
    expect(resolveOutboundTarget("/caches/install/anything")).toBeNull();
    expect(resolveOutboundTarget("/../../etc/passwd")).toBeNull();
  });

  it("an empty or malformed path is refused", () => {
    expect(resolveOutboundTarget("")).toBeNull();
    expect(resolveOutboundTarget("/")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `cd apps/fleet && bun test test/bun/gate-outbound-handler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/fleet/src/gate/outbound-handler.ts
//
// #715 v2 (real review correction): the ONE place a real R2 write
// credential lives for GateRunnerDO's own flow. The container (Task 11's
// gate-server.ts) makes a PLAIN fetch to a fixed internal path
// (http://gate-r2.internal/<key>) — this file is what Cloudflare's own
// durable_object-policy outbound traffic handler calls to decide what that
// plain request actually resolves to and with what credential, entirely
// inside the Worker's own boundary. The container never sees a token, a
// key, or a signed URL — only this allow-list decides what gets
// authorized, and anything outside the gate/ prefix is refused.
export function resolveOutboundTarget(path: string): { bucket: "STUDIO_ARCHIVE"; key: string } | null {
  const key = path.replace(/^\/+/, "");
  if (!key.startsWith("gate/")) return null;
  if (key.includes("..")) return null;
  return { bucket: "STUDIO_ARCHIVE", key };
}
```

Add to `apps/fleet/src/gate/do.ts` (this task's own diff, Task 10's file, this wave only):

```ts
// Added by Task 16 — the outbound-traffic-handler wiring + the /run-leg
// ACK-fast change Task 14's event-fan-in design needs. Exact Cloudflare
// Containers hook/method name verified against live docs at build time
// (flagged in Task 11's own header) — this sketch shows the OUTCOME, not
// a guessed-exact API surface.
import { resolveOutboundTarget } from "./outbound-handler";
// ... inside GateRunnerDO, replacing /run-leg's body:
//   1. ACK 202 immediately.
//   2. this.ctx.waitUntil(this.start({ envVars }).then(() => this.startAndWaitForPorts())
//        .then(() => this.containerFetch(new Request("http://container/run", { method: "POST" })))
//        .then((res) => res.json())
//        .then((legBody) => env.GATE_WORKFLOW.get(instanceId).sendEvent({ type: eventType, payload: legBody })));
//   3. The class's own outbound-handler override calls resolveOutboundTarget
//      on every outbound request's path; a non-null result signs/injects
//      the real STUDIO_ARCHIVE credential server-side before the request
//      leaves the Worker's boundary, a null result lets the request fail
//      closed (refused, not silently unsigned).
```

- [ ] **Step 4: Run, confirm it passes**

Run: `cd apps/fleet && bun test test/bun/gate-outbound-handler.test.ts`
Expected: PASS, all 4 cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/gate/outbound-handler.ts apps/fleet/src/gate/do.ts apps/fleet/test/bun/gate-outbound-handler.test.ts
git commit -m "feat(fleet): Worker-side outbound handler for GateRunnerDO, no credential in container (refs #715)"
```

---

### Task 17: `ONE_WAY_GLOBS` additions for gate-runner source (CLAUDE-ONLY, Wave 1)

**Why CLAUDE-ONLY:** `apps/fleet/scripts/merge-danger.ts` is itself a safety-classification file (confirmed real: `classify`, `.github/workflows/one-way-door.yml`) — same reasoning every other edit to it already gets in this repo's own history.

**Files:**
- Modify: `apps/fleet/scripts/merge-danger.ts`
- Test: extend `apps/fleet/test/bun/merge-danger.test.ts` (existing file)

**Interfaces:**
- Produces: two new `ONE_WAY_GLOBS` entries. No new exported function — `classify`/`ONE_WAY_GLOBS` already exist (`merge-danger.ts:29-105`, confirmed real); this task only adds data.
- Consumes: nothing new.

**Why these two paths, not more:** `apps/fleet/container/**` already covers `Dockerfile.gate`/`gate-server.ts`/`gate-merge-tree.ts` (Tasks 6/11 — confirmed real, `merge-danger.ts:36-38`); `apps/fleet/src/write-proxy/**` already covers credential-minting helpers like `workerWriteToken` (confirmed real, `gh-route.ts:164-168`) but does NOT cover this plan's new `apps/fleet/src/gate/**` (`do.ts`, `workflow.ts`, `outbound-handler.ts`, `routes.ts` — all credential-adjacent) or `apps/fleet/scripts/gate/**` (the sharding/measurement scripts, lower-risk but still worth the same one-way-door protection every other new script path under `apps/fleet/scripts/` gets if it touches CI shape). Both are genuinely new — neither is covered by an existing glob.

- [ ] **Step 1: Write the failing tests**

```ts
// extend apps/fleet/test/bun/merge-danger.test.ts
describe("gate-runner paths (#715)", () => {
  it("apps/fleet/src/gate/do.ts is one-way", () => {
    expect(classify(["apps/fleet/src/gate/do.ts"]).oneWay).toBe(true);
  });
  it("apps/fleet/src/gate/outbound-handler.ts is one-way", () => {
    expect(classify(["apps/fleet/src/gate/outbound-handler.ts"]).oneWay).toBe(true);
  });
  it("apps/fleet/scripts/gate/measure-shard-timing.ts is one-way", () => {
    expect(classify(["apps/fleet/scripts/gate/measure-shard-timing.ts"]).oneWay).toBe(true);
  });
  it("a file outside both new globs is unaffected", () => {
    expect(classify(["apps/fleet/src/gate-unrelated-name.ts"]).oneWay).toBe(false);
  });
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `cd apps/fleet && bun test test/bun/merge-danger.test.ts`
Expected: FAIL on the 3 new `true` cases — neither glob exists yet.

- [ ] **Step 3: Implement**

Add to `ONE_WAY_GLOBS` (`merge-danger.ts:34-105`, next to the existing `apps/fleet/src/write-proxy/**` entry):

```ts
{
  pattern: "apps/fleet/src/gate/**",
  why: "#715 gate-runner: GateRunnerDO, GateWorkflow, the outbound-credential handler — the same credential-adjacent class this repo already one-way-doors for write-proxy/rescue/etc.",
},
{
  pattern: "apps/fleet/scripts/gate/**",
  why: "#715 gate-runner: shard-count/timing scripts that decide CI shape for every PR, same protection class as scripts/deploy*",
},
```

- [ ] **Step 4: Run, confirm it passes**

Run: `cd apps/fleet && bun test test/bun/merge-danger.test.ts`
Expected: PASS, all cases green including every pre-existing case.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/scripts/merge-danger.ts apps/fleet/test/bun/merge-danger.test.ts
git commit -m "chore(fleet): add gate-runner paths to ONE_WAY_GLOBS (refs #715)"
```

---

## Out of scope for this plan (later phases of #715)

- Phase 2: adding #715's other two named repos to `GATE_RUNNER_REPOS` and each repo's own `fleet.json` gate block — config only, no new code, once Phase 1 holds its p50/p90 target over 10 PRs (spec's own testing plan, item 5).
- Phase 2: a GitHub token path INTO `GateRunnerDO`'s container (needed once a private repo is gated in) — `GateLegRequest`/`buildLegEnvVars` (Task 10) deliberately carry no token field for Phase 1's public repo; adding one is its own task against Task 10's file, AND Task 16's outbound handler would need extending to inject it (never passed through Task 10's file directly), not re-opened here.
- Phase 3: flipping `FLEET_GATE_RUNNER` default to `on` fleet-wide.
- The spec's own open questions this plan does not re-decide: final `max_instances` sizing within the 15-18-container range Task 0a/8 measured, the illustrative 10-PRs/day/repo cost assumption. **No longer open:** the `Commit statuses: write` gap is now a confirmed GitHub App permission (Task 0b, a live operator precondition blocking Task 14, not a unit test) — v1 had speculatively called this an "unverified PAT scope."

## Self-review (writing-plans skill checklist)

1. **Spec coverage.** Verdict/commit-status (§1) → Tasks 4, 14. Flag name (§2) → Tasks 1, 2. Bindings (§3) → Task 1 (now including `scheduling_policy: "durable_object"`). R2 layout (§4, **no KV** — v2 correction) → Task 5 (deterministic baseline key, no pointer), Task 10 (plain R2 keys, `presignR2` no longer used anywhere in this plan — Task 16's outbound handler is the credential boundary now), the `gate/` key shapes named directly in Task 10/14's leg requests. Instance type/limits (§5) → carried forward in Task 1 within the measured 15-18-container range (Task 0a/8), not a final decision. Cost (§6) → not re-derived (no new task needed; nothing in this plan changes the cost model). Rollout/rollback (§7) → Task 1's image-change note, Task 17's `ONE_WAY_GLOBS` additions (NEW, v2), Global Constraints' `classify`-stays-required bullet (NEW, v2). `fleet.json` gate block (spec's own section) → Task 2, pinned to `AGENT_REPO` (v2, confirmed real). CLI (spec's own section) → Task 7, space-separated `fleet gate start/watch` (v2 correction, confirmed real convention). Testing plan → Tasks 3/4/6's own TDD steps cover items 1–3 directly; items 4–6 (live PR diff, p50/p90 measurement, GitHub App permission precondition) are explicitly operator-run, not plan tasks (flagged in Task 0b/14's headers and here).
2. **Placeholder scan.** No task above says "add appropriate error handling" or "similar to Task N" without the actual code; every test has real assertions, every implementation step has a real function body. The one explicitly-flagged exception (the exact Cloudflare Containers outbound-handler hook/method name, Tasks 11/16) is named as an open verification-at-build-time gap, not silently guessed past.
3. **Type consistency.** `LegResult`/`LegState` (Task 4) are the exact types Task 10's `/run-leg` response, Task 14's `runLeg`/`legResults`, and Task 16's `sendEvent` payload all use. `GateLegRequest`/`buildLegEnvVars` (Task 10, v2: `resultKey`/`baselineKeys`, plain strings, never a URL) and `gate-server.ts`'s env var names (Task 11: `GATE_RESULT_KEY`/`GATE_BASELINE_KEYS`) use the identical `GATE_*` key set. `GateStatusResponse` (Task 7) and Task 12's route response use the identical `{ state, description?, statusPostFailed? }` shape. `baselineTarballKey`/`baselineSnapshotName` (Task 5) and `resolveOutboundTarget` (Task 16) agree on the `gate/<owner>/<repo>/...` key shape.
4. **No `GATE_KV` reference survives this revision** — grepped for it across every task above; the only remaining mentions are in this section's own "v1 had..." historical notes and the Global Constraints bullet explaining why it was removed.
5. **No task assumes the `default` Containers scheduling policy** — Task 1's sketch, Task 10's header, and Task 11/16's headers all say `durable_object` explicitly; Task 0a is sequenced first specifically so this decision predates any task that depends on it.
6. **Nothing in Task 12 or Task 14 implies `gate/verdict` replaces `classify`** in the maestro's required-checks set — Global Constraints' new bullet and Review Focus item 7 both say so explicitly; Task 17 ADDS to `classify`'s own `ONE_WAY_GLOBS`, never touches its required-check status.
7. **Wave table file-collision check, re-run after this revision's reordering:** Wave 0 (0a, 0b — no files, operator-run). Wave 1 (1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 17 — eleven tasks, eleven distinct file sets: `wrangler.example.jsonc`+`env.ts` / `config.ts` / `shard-plan.ts` / `verdict.ts` / `baseline.ts` / `container/gate-merge-tree.ts` / `cli-args.ts`+`cli/fleet.ts`+`cli/gate.ts` / `scripts/gate/measure-shard-timing.ts` / the browser-lane doc / `scripts/gate/shard-by-test-name.ts` / `scripts/merge-danger.ts` — no overlap). Wave 2 (10, 11, 12, 13 — `gate/do.ts` / `container/Dockerfile.gate`+`container/gate-server.ts` / `gate/routes.ts`+`studio/routes.ts` / `gate/warm-pool.ts`+`index.ts`+`env.ts` — no overlap; Task 13's own `env.ts` touch and Task 1's Wave-1 `env.ts` touch are different waves, per the existing 3(now 4)-way split). Wave 3 (16, 14 — `gate/do.ts`(Task 16, picking up from Task 10's Wave-2 version) + `gate/outbound-handler.ts` / `gate/workflow.ts`+`env.ts`+`github/api.ts` — no overlap; Task 14 explicitly does NOT touch `do.ts`, see its own header, specifically to keep this true).

## Guesses / gaps for a second pass (flagging explicitly, per the accepted rework-cost tradeoff)

1. **The spec's own open question #4** (where `GateRunnerDO`'s Dockerfile lives) is answered here as a plan-level decision (`apps/fleet/container/Dockerfile.gate`, already covered by `ONE_WAY_GLOBS`) rather than left open — the spec itself invited this ("flags the gap for whoever writes the implementation plan"). If the operator's spec revision picks the OTHER option (`apps/fleet/scripts/gate/`), Task 11's file path and `merge-danger.ts`'s glob both need a follow-up task.
2. **`/studio/gate/status` reads the Workflow binding's native `.status()`, not a second GitHub commit-status read.** The spec's CLI section only says `gate-watch` "polls the Workflow instance / `gate/verdict` status" without picking one — I picked the Workflow-native read specifically because it keeps Task 12's route token-free (GLM-OK). If the operator's spec revision requires polling the real GitHub commit status instead (e.g. so a non-fleet consumer of the PR can see the same thing `gate-watch` sees), Task 12 would need a GitHub token and should be re-tagged CLAUDE-ONLY.
3. **Phase 1 has no GitHub token anywhere in `GateRunnerDO`'s container path**, justified by `rafarc21/fleetflare` being public. This is explicit in Tasks 10/11's own headers — if Phase 1's scope ever widens to include a private repo before Phase 2, that assumption breaks and both tasks (plus Task 16's outbound handler) need a follow-up.
4. **The `/ping` warm-pool target (Task 13) needs one line added to Task 10's `do.ts`** (`GateRunnerDO.fetch` returning 200 rather than 404 for an unrecognized path, or an explicit `/ping` branch) — the one place this plan's Wave 2 file-disjointness isn't perfectly clean, flagged inline in Task 13 rather than silently assumed. (Pre-existing from v1; not introduced or fixed by this revision — out of this revision's own stated scope.)
5. **Every other leg's fan-out in Task 14** (typecheck/lint/invariants/rust/vitest shards — only `merge-tree` is spelled out in full) is the same `runLeg(...)` call repeated N times with Task 2's config + Task 3's shard-plan feeding the command strings — elided in the plan's own code sample as "the same pattern repeated," not a placeholder for genuinely new logic, but the executing task should expand it fully rather than literally loop-call the sample as written.
6. **The operator's 08:25Z CF-maximal directive arrived after the spec file was written** and is not yet folded into `docs/superpowers/specs/2026-10-15-gate-runner-design.md` itself (max fan-out, browser lane, warm pool, measured shard count) — nor are this v2 revision's own 3 real review-comment corrections; a separate, parallel task is revising the spec for both. This plan grounds its own tasks in both directly rather than waiting for the spec's own revision to catch up.
7. **The exact Cloudflare Containers outbound-traffic-handler hook/method name is not pinned down** (Tasks 11/16, both flag it explicitly) — this plan describes the OUTCOME (container's plain fetch gets rewritten + authorized server-side, container never sees a credential) and leaves the exact binding/override name for Task 16's own implementer to verify against live docs at build time. I do not have independent access to verify this specific API surface myself from this environment; the lead's own task brief separately confirmed the underlying mechanism (outbound traffic handlers, `durable_object` policy, `ctx.container`) is real and documented, which is what this revision relies on.
8. **Task 0a's own snapshot-restore-time numbers do not exist yet** — unlike Task 8's real 98-run CI-timing data (already known, cited directly), Task 0a's spike has not been run. Every place this plan says "primary: snapshot, fallback: tarball" (Task 5, 11) is a design DECISION made ahead of that measurement, on the strength of the real review comment that container snapshots are a real, documented Cloudflare Containers feature — not a claim that the restore time is already known to be acceptable. If Task 0a's real numbers come back unfavorable, Task 11's own fallback path is what Phase 1 actually ships on, not a hypothetical.

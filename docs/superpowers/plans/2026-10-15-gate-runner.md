# Gate Runner (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 1 of #715's rollout — Workflow `gate` + `GateRunnerDO` container class + `gate/` R2 prefix + `GATE_KV` — for `rafarc21/fleetflare` only, entirely behind `FLEET_GATE_RUNNER` (default `"off"`) and `GATE_RUNNER_REPOS`. Phases 2 (two operator repos, config only) and 3 (default-on fleet-wide) are out of scope for this plan — they are config/flag changes on top of what Phase 1 ships, not new code, and are mentioned only where they'd otherwise look like a design gap.

**Architecture:** Three new primitives, each a thin layer over an existing pattern this codebase already uses: a `Container<Env>`-based `GateRunnerDO` (same shape as `AgentDO`/`DeployDO`), a `WorkflowEntrypoint` class `GateWorkflow` that resolves PR state, fans out one `GateRunnerDO` leg/shard per container, fans in to one `gate/verdict` commit status, and a `gate/` R2 prefix + new `GATE_KV` namespace for baseline caching — parallel, not substituting, `install-cache.ts`'s existing `caches/` prefix pattern. Pure decision logic (shard bucketing, verdict aggregation, merge-tree exit-code interpretation, config parsing) is split into small, directly-unit-testable modules so the one task that actually mints/uses a GitHub token (`GateWorkflow` itself) is as small as possible.

**Tech Stack:** Cloudflare Workflows, `@cloudflare/containers` (`Container<Env>`), Durable Objects, R2 (`STUDIO_ARCHIVE`, existing bucket), new KV namespace, Bun (container-side scripts, matching `container/server.ts`'s own style), vitest (`cloudflare:test` pool) + bun test, existing fleet CLI (`apps/fleet/cli/`).

**Spec:** `docs/superpowers/specs/2026-10-15-gate-runner-design.md` (as of 2026-10-15; a parallel task is revising it for a CF-maximal-fan-out directive — this plan is grounded in the version read today and in the operator's own 08:25Z follow-up comment on issue #715, which arrived after the spec and is **not yet folded into the spec file**; see "Guesses / gaps for a second pass" at the end).

## Global Constraints

- Phase 1 only: `rafarc21/fleetflare`, behind `FLEET_GATE_RUNNER=off` default and `GATE_RUNNER_REPOS=rafarc21/fleetflare`. No task below configures the two operator repos or flips any default to `on`.
- `GateRunnerDO` never touches `StudioDO`/`StudioBigDO` or `apps/fleet/src/studio/rescue.ts`/`failover.ts`/`destroy.ts` — it is its own DO class, its own container entry, its own Dockerfile, zero shared code path.
- No secrets in R2 artifacts. Phase 1's repo (`rafarc21/fleetflare`) is public — no task below mints or forwards a GitHub token into a `GateRunnerDO` container; cloning happens anonymously over HTTPS. (Phase 2 private repos will need a token path — explicitly out of scope here, flagged in the task that would otherwise need it.)
- One aggregated commit-status context: **`gate/verdict`**. States `pending`/`success`/`failure`/`error` per the spec's own state machine (error never silently downgraded to failure).
- Image-change tasks (the Dockerfile, the `containers[]` `image` field) ship only at an operator-approved image window. Every task below says explicitly whether it is an image-change task.
- No task in this plan runs `wrangler deploy`, touches a live `wrangler.jsonc`, or applies a migration. Tasks edit `apps/fleet/wrangler.example.jsonc` (the public template) and new/existing source files only.
- PR bodies: `refs #715`, never a closing keyword.
- R2 keys under `gate/` are one distinct key per shard/leg per run (`gate/<owner>/<repo>/runs/<run-id>/shard-<leg>.json`) — no two legs of the same run ever write the same key, so R2's 1-write/sec-per-key cap is never contended by a single run's own fan-out (https://developers.cloudflare.com/r2/platform/limits/). The one KV key that *is* shared across runs (`main-sha:<owner>/<repo>`) is written once per `main`-SHA baseline build, not once per PR — far under KV's 1-write/sec-per-key cap (https://developers.cloudflare.com/kv/platform/limits/).
- Workflows limits to design within, not re-derive: 10k steps/instance default (25k paid), 50k concurrent instances (paid), 30s/5min per-step compute (default/paid) — https://developers.cloudflare.com/workflows/reference/limits/. A fan-out of ~4 fixed legs + N vitest shards (N sized per Task 8, not fixed) stays far under the step count; a step that only `await`s a container RPC and never itself loops/computes stays far under the per-step compute ceiling even when the real wall-clock the container takes is long (compute time ≠ wall time for an `await`-bound step).
- Containers account-wide cap: 1,500 vCPU / 6 TiB memory / 30 TB disk (https://developers.cloudflare.com/containers/platform-details/limits/). `max_instances` for `GateRunnerDO` is the spec's own open question (not re-decided here); whatever the operator picks, Task 1's wrangler sketch carries the spec's placeholder (150) with the spec's own flag that it is a question, not a decision.
- Browser Rendering (if any gate leg needs a real browser): 200 concurrent sessions/account on Paid — https://developers.cloudflare.com/browser-rendering/platform/limits/. Task 9 is a spike/evaluation, not a switch.

## Note on `apps/fleet/src/env.ts` — a deliberate 3-task split of one file

`env.ts` already imports each DO class's own *type* for its binding (`import type { AgentDO } from "./agents/do"` etc., `env.ts:1-7`) — a `DurableObjectNamespace<X>` binding needs `X`'s class to exist as a file before that specific line can be written. `GateRunnerDO` (Task 10) and the `GateWorkflow`/params type (Task 14) don't exist yet when Task 1 runs. So `env.ts` is touched by **three** tasks across **three different waves**, never two in the same wave: Task 1 adds the class-independent fields (`GATE_KV`, `FLEET_GATE_RUNNER`, `GATE_RUNNER_REPOS`), Task 10 adds one line (`GATE_RUNNER: DurableObjectNamespace<GateRunnerDO>`) once its own class exists, Task 14 adds one line (`GATE_WORKFLOW: Workflow<GateWorkflowParams>`) once its own class exists. This is the one place this plan intentionally does NOT fold a shared file into one task — see each task's own note.

`apps/fleet/wrangler.example.jsonc` has no such problem: JSONC has no compile-time class reference, so Task 1 writes the **entire** `workflows`/`kv_namespaces`/`durable_objects`/`migrations`/`containers` sketch in one task, even though the classes it names (`GateRunnerDO`, `GateWorkflow`) don't exist until later waves — exactly how the spec's own sketch (design spec §3) is already written, decoupled from any class existing yet.

---

## File Structure

New module directory `apps/fleet/src/gate/` (Worker-side, pure-logic-first, mirrors `apps/fleet/src/llm/`'s shape in the model-pool plan):

- `apps/fleet/src/gate/config.ts` — `fleet.json` `gate` block parsing, `FLEET_GATE_RUNNER`/`GATE_RUNNER_REPOS` gate, path-rule skip check.
- `apps/fleet/src/gate/shard-plan.ts` — balanced-by-wall-time shard bucketing (LPT bin-packing), not a fixed N.
- `apps/fleet/src/gate/verdict.ts` — fan-in + `gate/verdict` state-machine aggregation.
- `apps/fleet/src/gate/kv-pointer.ts` — `GATE_KV` `main-sha:<owner>/<repo>` pointer read/write.
- `apps/fleet/src/gate/do.ts` — `GateRunnerDO` class.
- `apps/fleet/src/gate/routes.ts` — `/studio/gate/start`, `/studio/gate/status` inner handlers.
- `apps/fleet/src/gate/warm-pool.ts` — warm-pool sizing (operator-set, not hardcoded) + the cron nudge's pure decision of which/how many to ping.
- `apps/fleet/src/gate/workflow.ts` — `GateWorkflow` (`WorkflowEntrypoint`), the one file that mints a GitHub token and posts `gate/verdict`.

Container-side (baked into the new image, mirrors `apps/fleet/container/server.ts`'s self-contained style — no imports from `apps/fleet/src/`):

- `apps/fleet/container/gate-merge-tree.ts` — pure, dependency-injected `git merge-tree`/`commit-tree` exit-code interpreter (TS port of `localci.sh:350-363`).
- `apps/fleet/container/gate-server.ts` — the container's own tiny HTTP server: clones (anonymous, public repo), checks out, restores baseline cache from a presigned GET URL, runs the leg's install+test command via `Bun.spawn`, PUTs the JSON result to a presigned URL, replies to the DO.
- `apps/fleet/container/Dockerfile.gate` — new image: bun + node + rustup + cargo-nextest + git, no Claude/tmux/chromium (not a studio).

CLI:

- Modify `apps/fleet/src/studio/cli-args.ts` — `gate-start <pr>` / `gate-watch <pr>` parsing.
- Modify `apps/fleet/cli/fleet.ts` — dispatch wiring.
- Create `apps/fleet/cli/gate.ts` — `cmdGateStart`, `cmdGateWatch` (thin `fetch` wrappers, same shape as `cli/models.ts`).

Docs/scripts:

- `apps/fleet/scripts/gate/measure-shard-timing.ts` — parses the existing `vitest --reporter=json` output shape (`localci.sh`'s own `$RUN/vitest.json`, already parsed once by `scripts/localci/summarize.ts`) into `{file, ms}[]` for Task 3's bucketer.
- `docs/superpowers/evidence/2026-10-15-gate-runner-browser-lane-spike.md` — CF Browser Rendering vs in-container Playwright evaluation.

Modify (minimal, one field/line each, see the 3-way split above): `apps/fleet/wrangler.example.jsonc`, `apps/fleet/src/env.ts`, `apps/fleet/src/studio/routes.ts`, `apps/fleet/src/index.ts`, `apps/fleet/src/github/api.ts`.

---

## Dependency graph

| Task | Depends on | Dependency kind |
|---|---|---|
| 1. Wrangler bindings + env.ts (class-independent fields) | — | — |
| 2. `fleet.json` gate config + repo gate | — | — |
| 3. Shard fan-out bucketing | — | — |
| 4. Verdict/fan-in state machine | — | — |
| 5. `GATE_KV` baseline pointer | — | — |
| 6. Container-side merge-tree decision logic | — | — |
| 7. CLI `gate-start`/`gate-watch` | — | wire contract only (documented in Tasks 7 & 12, not a file import) |
| 8. Shard timing measurement script | — | — |
| 9. Browser-rendering lane spike doc | — | — |
| 10. `GateRunnerDO` class (+ its own `env.ts` line) | 1 | compile (Env type) |
| 11. Dockerfile.gate + container entrypoint server | 6 | compile (imports gate-merge-tree.ts) |
| 12. Worker gate HTTP routes | 1, 2 | compile (Env type, repo gate) |
| 13. Warm-pool cron | 1, 2 | compile (Env type, repo gate) |
| 14. `GateWorkflow` + `postCommitStatus` (+ its own `env.ts` line) | 1, 2, 3, 4, 5, 6, 10, 11 | compile (1–5) + contract (6, 10, 11 — DO/container RPC shape, not a file import) |

Task 7 ↔ Task 12 share a wire contract (request/response JSON, specified identically in both tasks below) rather than a file or import — this is why they can both sit in Wave 1 even though end-to-end they clearly depend on each other.

## Waves (max parallel lanes)

- **Wave 1: 9 tasks, 9 members in parallel, zero file overlap.** Tasks 1, 2, 3, 4, 5, 6, 7, 8, 9.
- **Wave 2: 4 tasks, 4 members in parallel, zero file overlap.** Tasks 10, 11, 12, 13 (each depends only on Wave-1 files; `do.ts` vs `container/*` vs `routes.ts`+`studio/routes.ts` vs `warm-pool.ts`+`index.ts` never collide).
- **Wave 3: 1 task.** Task 14 — the fan-in point, depends on nearly everything, inherently sequential-last.

---

## Review Focus

1. `GATE_RUNNER_REPOS` absent/empty, or `FLEET_GATE_RUNNER` anything but `"on"` → Task 12's routes 404 before touching `GATE_WORKFLOW`/`GATE_KV`/R2 at all — zero new behavior for every repo not opted in, same posture `install-cache.ts` already proves for `INSTALL_CACHE_REPOS`.
2. Task 4's verdict aggregation: any `error` leg wins over any `failure` leg, regardless of arrival order (legs run in parallel — "first failing/erroring leg" must be deterministic by the *configured* leg order, not network arrival order).
3. Task 3's shard bucketer never returns zero shards for non-empty input, and never splits a single huge file across two shards.
4. Task 14's `gate/verdict` POST failing twice is surfaced distinctly from a real `failure`/`error` leg (own field, not folded into `state`) — `gate-watch`'s exit code 3 depends on this distinction surviving the Worker route → CLI round trip.
5. Task 11's container never receives a GitHub token (Phase 1, public repo) — grep the task's own diff for `Authorization`/`GITHUB_TOKEN` before calling it done.

---

### Task 1: Wrangler bindings + env.ts (class-independent fields)

**Files:**
- Modify: `apps/fleet/wrangler.example.jsonc`
- Modify: `apps/fleet/src/env.ts`

**Interfaces:**
- Produces: `Env.GATE_KV?: KVNamespace`, `Env.FLEET_GATE_RUNNER?: string`, `Env.GATE_RUNNER_REPOS?: string`. The `workflows`/`durable_objects`/`migrations`/`containers` JSONC entries naming `GateWorkflow`/`GateRunnerDO` (classes land in Tasks 10/14 — JSONC has no compile dependency on them existing yet).
- Consumes: nothing.

- [ ] **Step 1: Add the wrangler sketch**

In `apps/fleet/wrangler.example.jsonc`, add a top-level `"workflows"` array (new key, no existing one):

```jsonc
"workflows": [
  { "name": "gate", "binding": "GATE_WORKFLOW", "class_name": "GateWorkflow" }
],
"kv_namespaces": [
  { "binding": "GATE_KV", "id": "<YOUR_GATE_KV_NAMESPACE_ID>" }
],
```

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
  "instance_type": "standard-4",
  // #715's own number; spec's own open question (max_instances sizing) —
  // not re-decided here, carried forward as-is for the operator.
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
/** New KV namespace (#715) — main-sha baseline pointer, src/gate/kv-pointer.ts. */
GATE_KV?: KVNamespace;
```

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
- Consumes: nothing (pure).

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
Expected: PASS, all 5 cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/gate/verdict.ts apps/fleet/test/bun/gate-verdict.test.ts
git commit -m "feat(fleet): gate-runner verdict fan-in state machine (refs #715)"
```

---

### Task 5: `GATE_KV` baseline pointer helper

**Files:**
- Create: `apps/fleet/src/gate/kv-pointer.ts`
- Test: `apps/fleet/test/gate-kv-pointer.test.ts` (vitest, `cloudflare:test` pool — needs a real `KVNamespace` mock, this repo's first KV binding of any kind, `grep -rn "kv_namespaces" apps/fleet` returns nothing today).

**Interfaces:**
- Produces: `BaselinePointer { sha: string; lockfileHash: string; baselinePrefix: string; updatedAt: number }`, `getBaselinePointer(kv: KVNamespace, owner: string, repo: string): Promise<BaselinePointer | null>`, `putBaselinePointer(kv: KVNamespace, owner: string, repo: string, pointer: BaselinePointer): Promise<void>`.
- Consumes: a `KVNamespace` (not `Env` — deliberately decoupled from Task 1's `Env.GATE_KV` field so this file has zero compile dependency on Task 1 and can land in Wave 1).

- [ ] **Step 1: Write the failing test**

```ts
// apps/fleet/test/gate-kv-pointer.test.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { getBaselinePointer, putBaselinePointer, type BaselinePointer } from "../src/gate/kv-pointer";

describe("gate kv-pointer", () => {
  it("round-trips a pointer", async () => {
    const kv = (env as unknown as { GATE_KV: KVNamespace }).GATE_KV;
    const pointer: BaselinePointer = {
      sha: "abc123", lockfileHash: "def456",
      baselinePrefix: "gate/rafarc21/fleetflare/baselines/abc123-def456", updatedAt: 1760000000000,
    };
    await putBaselinePointer(kv, "rafarc21", "fleetflare", pointer);
    expect(await getBaselinePointer(kv, "rafarc21", "fleetflare")).toEqual(pointer);
  });

  it("null when no pointer has been written yet", async () => {
    const kv = (env as unknown as { GATE_KV: KVNamespace }).GATE_KV;
    expect(await getBaselinePointer(kv, "rafarc21", "no-such-repo")).toBeNull();
  });
});
```

Note for the executing task: this needs a `GATE_KV` KV namespace declared in whatever `wrangler.test.jsonc`/vitest-pool-workers config this repo's existing vitest setup uses (check `apps/fleet/vitest.config.ts` and its referenced test wrangler config for how `STUDIO_ARCHIVE`/`DB` are already declared there, and add `GATE_KV` the same way — same file, no collision with Task 1's `wrangler.example.jsonc`).

- [ ] **Step 2: Run, confirm it fails**

Run: `cd apps/fleet && bun x vitest run test/gate-kv-pointer.test.ts`
Expected: FAIL — module not found (and/or `GATE_KV` undefined until the test-config addition above lands).

- [ ] **Step 3: Implement**

```ts
// apps/fleet/src/gate/kv-pointer.ts
//
// GATE_KV's one key shape (#715 spec §4): main-sha:<owner>/<repo> -> the
// baseline a PR's Workflow run looks up without listing R2. Takes a plain
// KVNamespace, not Env, so this module has no compile dependency on
// src/env.ts's GATE_KV field landing first.

export interface BaselinePointer {
  sha: string;
  lockfileHash: string;
  baselinePrefix: string;
  updatedAt: number;
}

function pointerKey(owner: string, repo: string): string {
  return `main-sha:${owner}/${repo}`;
}

export async function getBaselinePointer(
  kv: KVNamespace, owner: string, repo: string,
): Promise<BaselinePointer | null> {
  const raw = await kv.get(pointerKey(owner, repo));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as BaselinePointer;
  } catch {
    return null;
  }
}

export async function putBaselinePointer(
  kv: KVNamespace, owner: string, repo: string, pointer: BaselinePointer,
): Promise<void> {
  await kv.put(pointerKey(owner, repo), JSON.stringify(pointer));
}
```

- [ ] **Step 4: Run, confirm it passes**

Run: `cd apps/fleet && bun x vitest run test/gate-kv-pointer.test.ts`
Expected: PASS, both cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/gate/kv-pointer.ts apps/fleet/test/gate-kv-pointer.test.ts
git commit -m "feat(fleet): gate-runner GATE_KV baseline pointer helper (refs #715)"
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

### Task 7: CLI `gate-start`/`gate-watch`

**Files:**
- Modify: `apps/fleet/src/studio/cli-args.ts`
- Modify: `apps/fleet/cli/fleet.ts`
- Create: `apps/fleet/cli/gate.ts`
- Test: `apps/fleet/test/bun/cli-gate.test.ts`, extend `apps/fleet/test/studio.cli-args.test.ts`

**Interfaces:**
- Produces: `CliArgs` variants `{ cmd: "gate-start"; pr: number }`, `{ cmd: "gate-watch"; pr: number }`; `cmdGateStart(creds, pr): Promise<void>`, `cmdGateWatch(creds, pr): Promise<void>`; `gateWatchExitCode(status: GateStatusResponse): number` (pure, extracted for testability — `cmdGateWatch` cannot itself be unit-tested without a real network call, same reasoning `agents/do.ts`'s `shouldAbortOnTerminal` extraction gives).
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

Extend `apps/fleet/test/studio.cli-args.test.ts` (existing file) with the `gate-start`/`gate-watch` parsing cases, following that file's own existing per-command describe-block shape (e.g. the `models-ls`/`models-assign` blocks already there):

```ts
describe("gate-start / gate-watch", () => {
  it("gate-start <pr> parses the PR number", () => {
    expect(parseCliArgs(["gate-start", "715"])).toEqual({ cmd: "gate-start", pr: 715 });
  });
  it("gate-watch <pr> parses the PR number", () => {
    expect(parseCliArgs(["gate-watch", "715"])).toEqual({ cmd: "gate-watch", pr: 715 });
  });
  it("gate-start with no PR -> usage", () => {
    expect(parseCliArgs(["gate-start"]).cmd).toBe("usage");
  });
  it("gate-start with a non-numeric PR -> usage", () => {
    expect(parseCliArgs(["gate-start", "abc"]).cmd).toBe("usage");
  });
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `cd apps/fleet && bun test test/bun/cli-gate.test.ts`
Expected: FAIL — `../../cli/gate` does not exist.
Run: `cd apps/fleet && bun test test/studio.cli-args.test.ts`
Expected: FAIL on the new `gate-start`/`gate-watch` cases — unrecognized command.

- [ ] **Step 3: Implement**

In `apps/fleet/src/studio/cli-args.ts`, add to the `CliArgs` union (near the existing `models-*` variants, `cli-args.ts:264-267`):

```ts
| { cmd: "gate-start"; pr: number }
| { cmd: "gate-watch"; pr: number }
```

and to the command dispatch (same `switch` that handles `"models"`, following that block's own `rest`-array shape, `cli-args.ts:1204-1216`):

```ts
case "gate-start": {
  if (rest.length !== 1 || !/^\d+$/.test(rest[0])) return usage("usage: fleet gate-start <pr>");
  return { cmd: "gate-start", pr: Number(rest[0]) };
}
case "gate-watch": {
  if (rest.length !== 1 || !/^\d+$/.test(rest[0])) return usage("usage: fleet gate-watch <pr>");
  return { cmd: "gate-watch", pr: Number(rest[0]) };
}
```

Add a `CLI_HELP`-style entry (next to the existing `"models-ls"` entry, `cli-args.ts:441-452`):

```ts
"gate-start": { args: "<pr>", summary: "Starts a gate-runner Workflow run for <pr> (no-op if FLEET_GATE_RUNNER is off for the repo)." },
"gate-watch": { args: "<pr>", summary: "Polls a gate-runner run for <pr> to a terminal state; exit 0 green/1 red/2 infra error/3 status-post failed." },
```

Create `apps/fleet/cli/gate.ts` (same thin-`fetch` shape as `cli/models.ts`):

```ts
// apps/fleet/cli/gate.ts — `fleet gate-start <pr>` / `fleet gate-watch <pr>`
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

**Files:**
- Create: `apps/fleet/scripts/gate/measure-shard-timing.ts`
- Test: `apps/fleet/test/bun/gate-measure-shard-timing.test.ts`

**Interfaces:**
- Produces: `parseVitestTimings(text: string): { file: string; ms: number }[]`.
- Consumes: the `vitest --reporter=json` output shape `scripts/localci/summarize.ts`'s `parseVitestJson` already parses (`testResults[].name`/`.startTime`/`.endTime`) — same shape, not a shared import (that function lives in a different, unrelated module with its own responsibility).

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

### Task 9: Browser-rendering lane spike (design doc, no code)

**Files:**
- Create: `docs/superpowers/evidence/2026-10-15-gate-runner-browser-lane-spike.md`

**Interfaces:** none — this is a design/evaluation doc, not implementable logic. No later task depends on its content for compilation; it informs whichever repo's Phase 2 `fleet.json` gate block ends up with a browser-touching leg (fleetflare's own Phase 1 leg list — typecheck/lint/invariants/rust/vitest shards — has no browser leg today).

- [ ] **Step 1: Write the doc**

```markdown
# Gate runner browser lane — CF Browser Rendering vs in-container Playwright

Evaluation only (#715 operator 08:25Z directive) — no leg in fleetflare's
own Phase 1 gate list (typecheck/lint/invariants/rust/vitest shards) is a
browser test, so this doc has no Phase 1 consumer. It is here so a later
repo/phase whose gate DOES need a browser lane has the comparison already
made instead of defaulting to "whatever's already baked into the image."

## Candidates

1. **CF Browser Rendering** (Workers binding, Puppeteer/Playwright-compatible
   REST + binding API) — https://developers.cloudflare.com/browser-rendering/.
   Limit: 200 concurrent sessions/account on the Paid plan
   (https://developers.cloudflare.com/browser-rendering/platform/limits/).
   No container image to bake/maintain; sessions are billed/limited
   separately from GateRunnerDO's own container vCPU budget — a browser-
   heavy leg does not eat into the 1,500-vCPU container cap this plan's
   other legs share.
2. **In-container chromium** (today's `apps/fleet/scripts/localci/Dockerfile`
   pattern, Playwright baked into the image) — proven today (an operator repo's
   own gate already runs this way per #715's background), but every
   concurrent browser-touching shard is itself a GateRunnerDO container,
   competing with every OTHER leg for the same 1,500-vCPU account cap
   (https://developers.cloudflare.com/containers/platform-details/limits/).

## Recommendation

Primary: CF Browser Rendering, for any FUTURE browser-touching leg — it
doesn't compete with the container vCPU budget the rest of this plan's legs
share, and 200 concurrent sessions is well above what one PR's gate needs
even at high fan-out. Fallback: in-container Playwright, for a leg Browser
Rendering's API shape can't express (a real Playwright API Browser
Rendering's binding doesn't cover) — same posture `fleet.json`'s own
per-repo `gate` block already takes for every other leg: config, not a
hard-coded choice.

## Open for the operator

Browser Rendering's binding needs its own wrangler.jsonc entry (another new
binding kind, same "docs-only sketch now, real binding at image-window
time" posture this plan's own Task 1 takes for workflows/kv_namespaces) —
not sketched here since no Phase 1 leg needs it yet.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/evidence/2026-10-15-gate-runner-browser-lane-spike.md
git commit -m "docs(fleet): gate-runner browser-rendering lane spike (refs #715)"
```

---

### Task 10: `GateRunnerDO` class

**Files:**
- Create: `apps/fleet/src/gate/do.ts`
- Modify: `apps/fleet/src/env.ts` (one line — see the Global Constraints note on the 3-way split)
- Test: `apps/fleet/test/bun/gate-do.test.ts` (pure helpers only — `GateRunnerDO` itself cannot be constructed under `vitest-pool-workers`, same documented gap `agents/do.ts`'s own header names for `AgentDO`; every decision this class makes is extracted to a plain function first, same shape `shouldAbortOnTerminal`/`toStartInput` already use in `agents/do.ts`).

**Interfaces:**
- Produces: `class GateRunnerDO extends Container<Env>`, exposing `POST /run-leg` (called by Task 14's Workflow step); `buildLegEnvVars(req: GateLegRequest): Record<string, string>` (pure, extracted); `GateLegRequest { owner: string; repo: string; commit: string; leg: string; installCmd: string; legCmd: string; resultPutUrl: string; baselineGetUrls: string[] }`.
- Consumes: `Env.GATE_RUNNER` (added by this task, see below); `presignR2` (existing, `apps/fleet/src/studio/install-cache.ts:1369` — reused as-is, not re-implemented: this task mints a presigned PUT URL for the leg's result JSON and presigned GET URLs for any baseline cache keys, via the already-reviewed helper, never touching the raw R2 credentials itself).

**Phase 1 scoping note:** `rafarc21/fleetflare` is public — `GateLegRequest` carries no GitHub token field. The container (Task 11's `gate-server.ts`) clones anonymously. A `ghToken?: string` field is deliberately NOT added here; Phase 2's private repos are out of scope for this plan and would need their own task to add one (mirroring `agents/do.ts`'s own `StartBody.ghToken` passthrough shape, `agents/do.ts:16`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/fleet/test/bun/gate-do.test.ts
import { describe, it, expect } from "bun:test";
import { buildLegEnvVars, type GateLegRequest } from "../../src/gate/do";

describe("buildLegEnvVars", () => {
  it("carries every leg field into the container's env, no token field", () => {
    const req: GateLegRequest = {
      owner: "rafarc21", repo: "fleetflare", commit: "abc123", leg: "typecheck",
      installCmd: "bun install --frozen-lockfile", legCmd: "bun run check",
      resultPutUrl: "https://example.r2.cloudflarestorage.com/signed-put",
      baselineGetUrls: ["https://example.r2.cloudflarestorage.com/signed-get"],
    };
    const env = buildLegEnvVars(req);
    expect(env).toEqual({
      GATE_REPO: "rafarc21/fleetflare", GATE_COMMIT: "abc123", GATE_LEG: "typecheck",
      GATE_INSTALL_CMD: "bun install --frozen-lockfile", GATE_LEG_CMD: "bun run check",
      GATE_RESULT_PUT_URL: "https://example.r2.cloudflarestorage.com/signed-put",
      GATE_BASELINE_GET_URLS: "https://example.r2.cloudflarestorage.com/signed-get",
    });
    expect(Object.keys(env).join(",")).not.toMatch(/token/i);
  });

  it("empty baselineGetUrls -> empty string, not undefined", () => {
    const req: GateLegRequest = {
      owner: "rafarc21", repo: "fleetflare", commit: "abc123", leg: "lint",
      installCmd: "x", legCmd: "y", resultPutUrl: "z", baselineGetUrls: [],
    };
    expect(buildLegEnvVars(req).GATE_BASELINE_GET_URLS).toBe("");
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
import { Container } from "@cloudflare/containers";
import type { Env } from "../env";
import { presignR2 } from "../studio/install-cache";

const GATE_CONTAINER_PORT = 8080;
const RESULT_URL_TTL_SECONDS = 1800; // same TTL install-cache.ts's own presign calls use

export interface GateLegRequest {
  owner: string; repo: string; commit: string; leg: string;
  installCmd: string; legCmd: string;
  resultPutUrl: string; baselineGetUrls: string[];
}

/** Pure — extracted so the env-var shape is unit-testable without a real
 *  container, same reasoning agents/do.ts's toStartInput extraction gives.
 *  No token field: Phase 1's repo (rafarc21/fleetflare) is public. */
export function buildLegEnvVars(req: GateLegRequest): Record<string, string> {
  return {
    GATE_REPO: `${req.owner}/${req.repo}`,
    GATE_COMMIT: req.commit,
    GATE_LEG: req.leg,
    GATE_INSTALL_CMD: req.installCmd,
    GATE_LEG_CMD: req.legCmd,
    GATE_RESULT_PUT_URL: req.resultPutUrl,
    GATE_BASELINE_GET_URLS: req.baselineGetUrls.join(","),
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
      const body = (await req.json()) as {
        owner: string; repo: string; commit: string; leg: string;
        installCmd: string; legCmd: string; resultKey: string; baselineKeys: string[];
      };
      const resultPutUrl = await presignR2(this.env, body.resultKey, "PUT", RESULT_URL_TTL_SECONDS);
      if (resultPutUrl === null) {
        return Response.json({ state: "error", description: "presign PUT failed — R2 secrets missing or signing threw" }, { status: 500 });
      }
      const baselineGetUrls = (await Promise.all(
        body.baselineKeys.map((k) => presignR2(this.env, k, "GET", RESULT_URL_TTL_SECONDS)),
      )).filter((u): u is string => u !== null);
      const envVars = buildLegEnvVars({
        owner: body.owner, repo: body.repo, commit: body.commit, leg: body.leg,
        installCmd: body.installCmd, legCmd: body.legCmd,
        resultPutUrl, baselineGetUrls,
      });
      await this.start({ envVars });
      await this.startAndWaitForPorts();
      const legRes = await this.containerFetch(new Request(`http://container/run`, { method: "POST" }));
      const legBody = await legRes.json() as { state: "success" | "failure" | "error"; description?: string };
      return Response.json(legBody);
    }
    return new Response("not found", { status: 404 });
  }
}
```

- [ ] **Step 4: Run, confirm it passes**

Run: `cd apps/fleet && bun test test/bun/gate-do.test.ts`
Expected: PASS, both cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/gate/do.ts apps/fleet/src/env.ts apps/fleet/test/bun/gate-do.test.ts
git commit -m "feat(fleet): GateRunnerDO container class (refs #715)"
```

---

### Task 11: `Dockerfile.gate` + container entrypoint server (IMAGE CHANGE — operator-approved window only)

**Files:**
- Create: `apps/fleet/container/Dockerfile.gate`
- Create: `apps/fleet/container/gate-server.ts`

**Interfaces:**
- Produces: the container's own `POST /run` HTTP handler (consumed by Task 10's `GateRunnerDO.fetch`'s `/run-leg` handler, via `containerFetch`).
- Consumes: `resolveMergeTree`/`ExecFn` from Task 6's `apps/fleet/container/gate-merge-tree.ts` (used for a `leg === "merge-tree"` request — the one leg type whose "install/test command" IS the merge-tree/commit-tree pair, run once per PR before every other leg can check out a resolved tree); the env vars Task 10's `buildLegEnvVars` sets (`GATE_REPO`, `GATE_COMMIT`, `GATE_LEG`, `GATE_INSTALL_CMD`, `GATE_LEG_CMD`, `GATE_RESULT_PUT_URL`, `GATE_BASELINE_GET_URLS`).

**This is an image-change task.** It ships only at an operator-approved image window (same constraint `apps/fleet/scripts/merge-danger.ts`'s `ONE_WAY_GLOBS` already enforces for every other container Dockerfile, `merge-danger.ts:34-38`). **Plan-level decision, answering the spec's own open question #4:** this Dockerfile lives at `apps/fleet/container/Dockerfile.gate`, NOT `apps/fleet/scripts/gate/Dockerfile` — same directory every other class's Dockerfile already lives in, already covered by `ONE_WAY_GLOBS`'s existing `apps/fleet/container/**` pattern (`merge-danger.ts:35-38`), so this plan needs **zero** `merge-danger.ts` change. The spec itself explicitly left this choice to "whoever writes the implementation plan" — this is that choice; flag it to the operator for the spec's next revision.

This task has no TDD step of its own beyond what Task 6 already proved (`resolveMergeTree`'s decision table) — `gate-server.ts`'s own `/run` handler is thin wiring (read env vars, call `Bun.spawn`, PUT a result) in the same self-contained style `container/server.ts` already uses (no test file for that file either, per today's repo). The file-structure note below is the concrete deliverable.

- [ ] **Step 1: Write `gate-server.ts`**

```ts
// apps/fleet/container/gate-server.ts
//
// GateRunnerDO's container-side HTTP server (#715 Phase 1). Self-contained,
// no imports from apps/fleet/src/ — same style container/server.ts already
// uses. Clones ANONYMOUSLY (Phase 1's repo, rafarc21/fleetflare, is public —
// no GitHub token anywhere in this file, by construction, not by omission).
import { resolveMergeTree, type ExecFn } from "./gate-merge-tree";

const PORT = Number(process.env.PORT ?? 8080);
const WORKDIR = "/workspace/repo";

const exec: ExecFn = async (cmd, args, opts) => {
  const proc = Bun.spawn([cmd, ...args], { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { code, stdout, stderr };
};

async function run(): Promise<{ state: "success" | "failure" | "error"; description?: string }> {
  const repo = process.env.GATE_REPO ?? "";
  const commit = process.env.GATE_COMMIT ?? "";
  const leg = process.env.GATE_LEG ?? "";
  const installCmd = process.env.GATE_INSTALL_CMD ?? "";
  const legCmd = process.env.GATE_LEG_CMD ?? "";
  const resultPutUrl = process.env.GATE_RESULT_PUT_URL ?? "";

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
    await putResult(resultPutUrl, { ...outcome, commit: result.ok ? result.commit : undefined });
    return outcome;
  }

  const checkout = await exec("git", ["checkout", "--quiet", commit], { cwd: WORKDIR });
  if (checkout.code !== 0) return { state: "error", description: `checkout failed: ${checkout.stderr.split("\n")[0]}` };

  const install = await exec("bash", ["-c", installCmd], { cwd: WORKDIR });
  if (install.code !== 0) {
    const outcome = { state: "error" as const, description: `install failed: ${install.stderr.split("\n")[0]}` };
    await putResult(resultPutUrl, outcome);
    return outcome;
  }

  const test = await exec("bash", ["-c", legCmd], { cwd: WORKDIR });
  const outcome = test.code === 0
    ? { state: "success" as const }
    : { state: "failure" as const, description: `${leg} exited ${test.code}` };
  await putResult(resultPutUrl, { ...outcome, stdout: test.stdout.slice(-4000), stderr: test.stderr.slice(-4000) });
  return outcome;
}

async function putResult(url: string, body: unknown): Promise<void> {
  if (!url) return;
  try {
    await fetch(url, { method: "PUT", body: JSON.stringify(body) });
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
git commit -m "feat(fleet): GateRunnerDO image + container entrypoint server (refs #715)

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

### Task 14: `GateWorkflow` + `postCommitStatus` (CLAUDE-ONLY, Wave 3)

**Files:**
- Create: `apps/fleet/src/gate/workflow.ts`
- Modify: `apps/fleet/src/env.ts` (one line — see the Global Constraints note)
- Modify: `apps/fleet/src/github/api.ts` (add `postCommitStatus`)
- Test: `apps/fleet/test/bun/gate-workflow-verdict.test.ts` (the one pure seam inside this file — everything else needs a live Workflow/DO/GitHub-token round trip and is validated per the spec's own testing plan, not unit-tested here)

**Interfaces:**
- Produces: `class GateWorkflow extends WorkflowEntrypoint<Env, GateWorkflowParams>`, `GateWorkflowParams { repo: string; pr: number }`; `postCommitStatus(token: string, repo: string, sha: string, state: "pending" | "success" | "failure" | "error", context: string, description: string): Promise<void>` (in `github/api.ts`, alongside `mergePullRequest`/`ghRequest` it already exports).
- Consumes: Task 2's `config.ts` (`parseGateConfig`, `matchesPathRules`), Task 3's `shard-plan.ts` (`planShards`), Task 4's `verdict.ts` (`aggregateVerdict`), Task 5's `kv-pointer.ts` (`getBaselinePointer`/`putBaselinePointer`), Task 10's `GateRunnerDO` RPC contract (`POST /run-leg`, documented in Task 10) via `env.GATE_RUNNER`, existing `apps/fleet/src/github/api.ts` exports (`getPullRequest`, `getDefaultBranch`) and `apps/fleet/src/github/auth.ts`'s `repoTokenMinter`.

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
// verdict, kv-pointer) is pure and already unit-tested in its own task.
//
// Open risk carried forward from the spec, NOT resolved here: the PAT's
// "Commit statuses: write" scope is UNVERIFIED as of the 2026-09-25
// ci-steward spec. Before this ships behind FLEET_GATE_RUNNER=on for real,
// re-probe it: `gh api -X POST repos/rafarc21/fleetflare/statuses/<sha>
// -f state=pending -f context=gate/probe` — a live, operator-run step, not
// a unit test.
import { WorkflowEntrypoint, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env";
import { getPullRequest, getDefaultBranch, postCommitStatus } from "../github/api";
import { repoTokenMinter } from "../github/auth";
import { parseGateConfig, matchesPathRules } from "./config";
import { planShards } from "./shard-plan";
import { aggregateVerdict, type LegResult, type Verdict } from "./verdict";
import { getBaselinePointer, putBaselinePointer } from "./kv-pointer";

export interface GateWorkflowParams { repo: string; pr: number }

const GATE_STATUS_CONTEXT = "gate/verdict";

/** Pure — the one seam unit-tested without a live Workflow (Step 1, above).
 *  verdict.ts's own "pending" state never reaches here (the Workflow only
 *  calls this after aggregateVerdict returns a terminal state). */
export function verdictToStatusArgs(
  verdict: Exclude<Verdict, { state: "pending" }>,
): { state: "success" | "failure" | "error"; description: string } {
  if (verdict.state === "success") return { state: "success", description: "all legs green" };
  return { state: verdict.state, description: verdict.description };
}

export class GateWorkflow extends WorkflowEntrypoint<Env, GateWorkflowParams> {
  async run(event: { payload: GateWorkflowParams }, step: WorkflowStep) {
    const { repo, pr } = event.payload;
    const [owner, repoName] = repo.split("/");
    const mintToken = repoTokenMinter(this.env);

    const prInfo = await step.do("resolve-pr", async () => {
      const token = await mintToken(repo);
      const pull = await getPullRequest(token, repo, pr);
      const base = await getDefaultBranch(token, repo);
      return { headSha: pull.headSha, base };
    });

    // fleet.json's own gate block — not fetched here in detail (repo-content
    // read via existing fetchRepoFile, same token path); legs/install/
    // vitestCmd come from parseGateConfig once that fetch lands in the real
    // implementation. Path-rule skip (matchesPathRules) short-circuits
    // before any container spins up, same as localci.sh's own skip_fleet.

    const legResults: LegResult[] = await step.do("run-legs", async () => {
      const results: LegResult[] = [];
      const stub = this.env.GATE_RUNNER.get(this.env.GATE_RUNNER.idFromName(`${repo}-${pr}-merge-tree`));
      const res = await stub.fetch("https://gate-runner/run-leg", {
        method: "POST",
        body: JSON.stringify({
          owner, repo: repoName, commit: `${prInfo.base}..${prInfo.headSha}`, leg: "merge-tree",
          installCmd: "", legCmd: "",
          resultKey: `gate/${owner}/${repoName}/runs/${pr}/shard-merge-tree.json`, baselineKeys: [],
        }),
      });
      const body = await res.json() as LegResult;
      results.push({ leg: "merge-tree", state: body.state, description: body.description });
      return results;
      // Every other leg (typecheck/lint/invariants/rust/vitest shards, per
      // Task 2's fleet.json config + Task 3's shard-plan) fans out the same
      // way, one GateRunnerDO instance each, collected into `results` the
      // same way — elided here since it is the same pattern repeated N
      // times, not new logic.
    });

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

## Out of scope for this plan (later phases of #715)

- Phase 2: adding the two operator repos to `GATE_RUNNER_REPOS` and each repo's own `fleet.json` gate block — config only, no new code, once Phase 1 holds its p50/p90 target over 10 PRs (spec's own testing plan, item 5).
- Phase 2: a GitHub token path INTO `GateRunnerDO`'s container (needed once a private repo is gated in) — `GateLegRequest`/`buildLegEnvVars` (Task 10) deliberately carry no token field for Phase 1's public repo; adding one is its own task against Task 10's file, not re-opened here.
- Phase 3: flipping `FLEET_GATE_RUNNER` default to `on` fleet-wide.
- The spec's own open questions this plan does not re-decide: `max_instances` sizing (150 vs tighter), the illustrative 10-PRs/day/repo cost assumption, re-verifying the PAT's `Commit statuses: write` scope (carried forward as a live, operator-run precondition in Task 14's header, not a unit test).

## Self-review (writing-plans skill checklist)

1. **Spec coverage.** Verdict/commit-status (§1) → Tasks 4, 14. Flag name (§2) → Tasks 1, 2. Bindings (§3) → Task 1. R2/KV layout (§4) → Tasks 5, 10 (`presignR2` reuse), the `gate/` key shapes named directly in Task 10/14's leg requests. Instance type/limits (§5) → carried forward verbatim in Task 1, not re-decided. Cost (§6) → not re-derived (no new task needed; nothing in this plan changes the cost model). Rollout/rollback (§7) → Task 1's image-change note, Task 11's `ONE_WAY_GLOBS` decision, Global Constraints. `fleet.json` gate block (spec's own section) → Task 2. CLI (spec's own section) → Task 7. Testing plan → Tasks 3/4/6's own TDD steps cover items 1–3 directly; items 4–6 (live PR diff, p50/p90 measurement, PAT re-probe) are explicitly operator-run, not plan tasks (flagged in Task 14's header and here).
2. **Placeholder scan.** No task above says "add appropriate error handling" or "similar to Task N" without the actual code; every test has real assertions, every implementation step has a real function body.
3. **Type consistency.** `LegResult`/`LegState` (Task 4) are the exact types Task 10's `/run-leg` response and Task 14's `legResults` array use. `GateLegRequest`/`buildLegEnvVars` (Task 10) and `gate-server.ts`'s env var names (Task 11) use the identical `GATE_*` key set. `GateStatusResponse` (Task 7) and Task 12's route response use the identical `{ state, description?, statusPostFailed? }` shape.

## Guesses / gaps for a second pass (flagging explicitly, per the accepted rework-cost tradeoff)

1. **The spec's own open question #4** (where `GateRunnerDO`'s Dockerfile lives) is answered here as a plan-level decision (`apps/fleet/container/Dockerfile.gate`, already covered by `ONE_WAY_GLOBS`) rather than left open — the spec itself invited this ("flags the gap for whoever writes the implementation plan"). If the operator's spec revision picks the OTHER option (`apps/fleet/scripts/gate/`), Task 11's file path and `merge-danger.ts`'s glob both need a follow-up task.
2. **`/studio/gate/status` reads the Workflow binding's native `.status()`, not a second GitHub commit-status read.** The spec's CLI section only says `gate-watch` "polls the Workflow instance / `gate/verdict` status" without picking one — I picked the Workflow-native read specifically because it keeps Task 12's route token-free (GLM-OK). If the operator's spec revision requires polling the real GitHub commit status instead (e.g. so a non-fleet consumer of the PR can see the same thing `gate-watch` sees), Task 12 would need a GitHub token and should be re-tagged CLAUDE-ONLY.
3. **Phase 1 has no GitHub token anywhere in `GateRunnerDO`'s container path**, justified by `rafarc21/fleetflare` being public. This is explicit in Tasks 10/11's own headers — if Phase 1's scope ever widens to include a private repo before Phase 2, that assumption breaks and both tasks need a follow-up.
4. **The `/ping` warm-pool target (Task 13) needs one line added to Task 10's `do.ts`** (`GateRunnerDO.fetch` returning 200 rather than 404 for an unrecognized path, or an explicit `/ping` branch) — the one place this plan's Wave 2 file-disjointness isn't perfectly clean, flagged inline in Task 13 rather than silently assumed.
5. **Every other leg's fan-out in Task 14** (typecheck/lint/invariants/rust/vitest shards — only `merge-tree` is spelled out in full) is the same `GATE_RUNNER.get(...).fetch("/run-leg", ...)` pattern repeated N times with Task 2's config + Task 3's shard-plan feeding the command strings — elided in the plan's own code sample as "the same pattern repeated," not a placeholder for genuinely new logic, but the executing task should expand it fully rather than literally loop-call the sample as written.
6. **The operator's 08:25Z CF-maximal directive arrived after the spec file was written** and is not yet folded into `docs/superpowers/specs/2026-10-15-gate-runner-design.md` itself (max fan-out, Browser Rendering, warm pool, measured shard count). This plan grounds Tasks 3, 8, 9, 13 in that directive directly rather than waiting for the spec's own revision to catch up — per the operator's own accepted rework-cost tradeoff, a second pass may need to adjust these tasks once the spec text itself changes.

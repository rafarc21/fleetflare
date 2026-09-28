# Fleet Spawn P3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Studio agents spawn peers under Worker-enforced org rules; the fleet provisions and operates at 100-studio scale; P2's ledgered backlog debts are paid.

**Architecture:** Spawn = the existing provision path behind a new org-checked machine-auth route (`/fleet/spawn`, webhook-pattern, outside Access). Scale = caps + per-role sizing + exec-volume reduction. No new runtime machinery.

**Tech Stack:** Existing stack; zero new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-17-fleet-spawn-p3-design.md` (rulings R-P3-1..7 bind).

## Global Constraints

- Base: P2 head (`c643af3`). Gates stay green after every task: unit (570 base) · check · integration (18 base) · acceptance (8 base).
- Batch lane untouched: zero diffs under `container/server.ts`, `container/deploy-server.ts`, `src/agents/`, `src/deploy/`, `src/tasks/`. `container/fleet-cli.ts` is batch-lane-owned: READ only.
- Spawn token: prefix `fsp_`, 64 hex chars after prefix; redact pattern `fsp_[0-9a-f]+` added to redact.ts; token NEVER in status/registry/logs/telegram (same discipline as every credential).
- `MAX_STUDIOS` env var default "100"; wrangler.jsonc StudioDO `max_instances` 5 → 100 in the same commit that lands the Worker-side cap (never before).
- Org cache TTL 300s. Constants live in `src/studio/org.ts`.
- bun only. Small conventional commits. Caveman docs/commits; code normal.

## File Structure (locked)

```
apps/fleet/
  src/studio/
    org.ts            # org.json parse + maySpawn + org cache (fetch via github/api.ts at pinned ref)
    spawn.ts          # spawn core: token resolve → org check → child id → provision delegate (pure over ports)
    do.ts             # spawnToken mint at provision; env injection
    routes.ts         # /fleet/spawn (machine) + /studio/spawn (operator passthrough); grid header totals
    redact.ts         # + fsp_ pattern
    blueprint.ts      # role frontmatter + instance_type/keep_alive/may_spawn passthrough
    transcript.ts     # consolidated single-exec ship tick
    session-sync.ts   # daily-prune gating
    grid.ts + page/grid.template.html + page/grid.html   # fleet totals header
  cli/fleet.ts        # spawn + provision commands; formatBurn legend
  container/studio-fleet   # in-container spawn script (new, baked by Dockerfile.studio)
  container/Dockerfile.studio  # bake studio-fleet
  test/studio.org.test.ts, studio.spawn.test.ts (+ extensions in transcript/session/grid/refresh tests)
  test-integration/attach.e2e.ts + cli.acceptance.ts (+ spawn e2e/acceptance)
```

---

### Task 1: Org module + spawn-token plumbing

**Files:**
- Create: `apps/fleet/src/studio/org.ts`, `apps/fleet/test/studio.org.test.ts`
- Modify: `apps/fleet/src/studio/do.ts` (mint `fsp_`+64hex at provision → DO storage key `spawnToken` + container env `FLEET_SPAWN_TOKEN`), `apps/fleet/src/studio/redact.ts` (+`fsp_[0-9a-f]+` + test), `apps/fleet/src/studio/blueprint.ts` (role frontmatter gains optional `may_spawn` array — ALREADY parsed as array field; expose typed; plus optional `instance_type`, `keep_alive` scalars with defaults)

**Interfaces:**
- Produces: `parseOrgJson(s: string): Org` (`{edges: Record<string,string[]>, gates: Record<string,string[]>}`, BlueprintError on malformed); `maySpawn(org: Org, parentRole: string, childRole: string): boolean` (false on unknown roles, false on self unless explicitly edged); `fetchOrgCached(deps, ref): Promise<Org>` (300s module cache keyed by ref, stale-on-error like the JWKS pattern minus the cap — org is repo-controlled config, serve-stale acceptable); `mintSpawnToken(): string` (`fsp_` + 64 lowercase hex via crypto).
- Tests: parse shapes + errors; maySpawn matrix (edge present/absent/unknown/self); cache hit/expiry/stale-on-error; token format + redaction (status seeded with a token → scrubbed); provision injects env (extend the T12-era env assertions).

- [ ] TDD: failing tests → implement → full suite → commit `feat(fleet): org module + spawn tokens`

---

### Task 2: Spawn routes + core

**Files:**
- Create: `apps/fleet/src/studio/spawn.ts`, `apps/fleet/test/studio.spawn.test.ts`
- Modify: `apps/fleet/src/studio/routes.ts` (mount `/fleet/spawn` BEFORE the Access-assumed `/studio/` prefix branch in index.ts? NO — index.ts routes by prefix; add `/fleet/` prefix branch in `src/index.ts` delegating to `handleFleetSpawn` — minimal diff like the P1 mount), `apps/fleet/src/index.ts`, `apps/fleet/src/studio/types.ts` (`spawnedBy: string|null` on StudioStatus — additive)

**Interfaces:**
- Produces: `handleFleetSpawn(req, env): Promise<Response>` — POST only (405 else); `X-Fleet-Spawn-Token` header → constant-time lookup across registry studios' stored tokens (do NOT enumerate DO storage per request: registry rows gain a token HASH (sha256 hex) written at provision; lookup = hash the presented token, find row — token itself never in registry); body `{role: string}`; resolve parent role from parent's status; `maySpawn` check at fleet.json's pinned ref → 403; child id `<repo>--<role>`; exists/`MAX_STUDIOS` → 409; else delegate to the EXISTING provision (child status gains `spawnedBy: parentId`). Operator passthrough: `POST /studio/spawn` (Access side) same core, parent = "operator" (org edge `operator` → configured; add `"operator": ["cto","pilot","scratch"]`-style edge to org.json).
- Tests: bad/absent token 401; unknown token 401; denied edge 403; cap 409; exists 409; happy 200 spawnedBy set; token-hash-only-in-registry assertion; constant-time compare shape (timing not unit-testable — assert the util used is the crypto.subtle.timingSafeEqual equivalent pattern or documented double-hmac).

- [ ] TDD → implement → suite → commit `feat(fleet): org-enforced spawn routes`

---

### Task 3: Container script + CLI + org.json update

**Files:**
- Create: `apps/fleet/container/studio-fleet` (bash or bun single-file: `studio-fleet spawn <role>` → POST /fleet/spawn with env token; worker URL from env `FLEET_WORKER_URL` injected at provision)
- Modify: `apps/fleet/container/Dockerfile.studio` (bake + chmod), `apps/fleet/src/studio/do.ts` (inject `FLEET_WORKER_URL` — from env var `WORKER_PUBLIC_URL` new wrangler var), `apps/fleet/wrangler.jsonc` (var), `apps/fleet/cli/fleet.ts` (`fleet spawn <role>` via /studio/spawn; `fleet provision <id>` explicit; formatBurn legend header line), `fleet/blueprint/org.json` (add operator edges + a `scratch` role edge for pilot), `fleet/blueprint/roles/scratch.md` (minimal real role for spawn testing/dogfood)

- [ ] Tests: CLI arg parsing pure bits; org.json + scratch.md parse against the real parser (fixture-bind style from T11); Dockerfile smoke (docker build + `studio-fleet --help`). Suite + commit `feat(fleet): spawn tooling + scratch role`

---

### Task 4: Scale knobs

**Files:**
- Modify: `apps/fleet/src/studio/blueprint.ts`→provision plumb (`instance_type`/`keep_alive` per role — provision passes keepAlive to `sbSetKeepAlive(this, roleKeepAlive)`; instance_type is DEPLOY-time (wrangler config) not per-DO — RULING: per-role instance_type is RECORDED in role files + fleet.json for the operator's deploy config but NOT runtime-switchable (platform constraint: instance type fixed per container class); document in spec-facing comment + finish-list rather than fake a runtime knob), `apps/fleet/src/studio/do.ts`, `apps/fleet/wrangler.jsonc` (`max_instances: 100`), `apps/fleet/src/studio/routes.ts`/`spawn.ts` (`MAX_STUDIOS` cap on BOTH provision entry points), `apps/fleet/src/env.ts`
- Tests: cap enforced on direct provision + spawn (99→ok, 100→409 at default); keep_alive:false role → sbSetKeepAlive(false) asserted; instance_type documented-not-plumbed test N/A (comment assertion only).

- [ ] TDD → implement → suite → commit `feat(fleet): fleet caps + per-role keepalive`

---

### Task 5: Backlog debts

**Files:**
- Modify: `apps/fleet/src/studio/transcript.ts` (consolidated ONE chained exec per ship tick emitting delimited sections `---FLEET-BOOTID---` etc.; parser + tests incl. partial/malformed sections; halves per-tick execs), `apps/fleet/src/studio/session-sync.ts` (prune runs only on daily-write ticks), error label fix (truncate-half), U+FFFD trim (TextDecoder stream:true or trim-to-last-complete-char on the 8KiB tail), `apps/fleet/src/studio/grid.ts` + templates (fleet totals header row; rebuild artifacts)
- Tests: consolidated parser matrix; prune gating; label; boundary trim (multi-byte fixture at 8192 boundary); totals math + rendered header.

- [ ] TDD → implement → rebuild pages → suite → commit `feat(fleet): exec consolidation, fleet totals, polish debts`

---

### Task 6: Integration + acceptance + close-out

- Integration additions: spawn e2e (parent pilot → studio-fleet script inside real container → child real container, registry shows both + spawnedBy; denied-edge 403 e2e; token-hash never in registry read-back). Test blueprint fixtures gain the scratch edge (dev-entry fixture side — real repo org.json also has it from T3, keep consistent).
- Acceptance additions: `fleet spawn` from Mac CLI; `fleet ls` parent+child rows; grid header totals present.
- All gates fresh + batch-lane zero-diff whole-branch + dry-run clean.
- OPERATOR-FINISH-LIST P3 section: max_instances raise note, MAX_STUDIOS var, per-role instance_type = deploy-config guidance, spawn-token rotation note (re-provision rotates), org.json operator edges.
- Report. NO PR (controller owns).

- [ ] Execute → commit(s) `test(fleet): P3 spawn e2e + acceptance` / `docs(fleet): P3 finish-list`

---

## Self-review notes (write time)

- Spec coverage: R-P3-1/2/7→T1-2, R-P3-3/6→T4 (+instance_type ruling folded), R-P3-4→T5 totals, R-P3-5→T5, tooling→T3, testing→T6.
- Placeholder scan: instance_type runtime-switch impossibility resolved as an explicit in-plan ruling (documented-not-plumbed), not a TBD.
- Type consistency: Org/maySpawn/mintSpawnToken (T1) consumed T2-3; spawnedBy additive (T2); token-hash registry field (T2) read T6.

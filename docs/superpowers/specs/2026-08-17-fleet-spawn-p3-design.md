# Fleet Spawn P3 — Design

Date 2026-08-17. Branch `35-terminal-watch` (continues past P2 head `c643af3`). Final phase of the IS#35 arc. Authored autonomously per operator directive; rulings inline. Gates at write time: unit 570/570, integration 18/18, acceptance 8/8.

## Goal

A studio agent can provision a peer studio (`fleet spawn`) under Worker-enforced org rules; the fleet operates at 100-studio scale within account limits and the Max token budget; the phase's backlog debts are paid. After P3, the operator's org chart runs itself: CTO spawns Release, gates hold, burn stays visible.

## Rulings

- **R-P3-1 Worker is law, roles are advisory.** Spawn requests validate against `org.json`'s `edges` (may_spawn) SERVER-side: requester role → spawnable roles. A studio proves its identity via a per-studio spawn token minted at provision (stored in DO + injected into container env), presented on the spawn call. Role files never grant what the Worker doesn't check. Cost if wrong: an agent spawns outside its edge — bounded by max_instances + registry visibility.
- **R-P3-2 Spawn = provision with a parent.** `fleet spawn <role>` from inside a studio calls `POST /studio/spawn` (new route): Worker resolves the caller's studio + role from the spawn token, checks `org.json` edges at the pinned blueprint ref, derives the child id `<repo>--<role>`, and runs the EXISTING provision path. No new provisioning machinery. Parent recorded in child status (`spawnedBy`). Cost if wrong: none new — provision is the tested path.
- **R-P3-3 Scale = limits math + provisioning tooling, not new runtime.** 100 studios fit default account limits (6.7% vCPU, P1 verdict). P3 adds: `fleet provision --repo X --role Y` batch tooling, instance-size selection from fleet.json per role (`instance_type` override per role file, falling back to fleet.json), and a `MAX_STUDIOS` Worker-side cap (env var, default 100) checked at provision — the anti-runaway brake max_instances=5 currently provides, raised deliberately. Cost if wrong: cap too low = provision 409s, one var change.
- **R-P3-4 Burn governance stays advisory but gains fleet totals.** Grid header row: fleet-wide turns/output/5h aggregate (the Plane-4 spec text T5 correctly deferred); alert threshold applies per-studio as shipped. NO hard token queue (P2 verdict stands: humans drive studios; the operator is the scheduler). Cost if wrong: none — visibility only.
- **R-P3-5 Backlog paid, scoped tight.** In: exec-volume reduction at scale (ship tick's 3 execs → 1 chained exec per tick; sync's daily-prune only on daily-write ticks), truncate-label fix, U+FFFD boundary trim, formatBurn legend. OUT (recorded, not built): streaming paste reader, studio-side approval channel beyond in-terminal blocks, R2-scope bucket automation, Moshi hooks integration, PAX tar, Spectrum-beta anything. Cost if wrong: backlog items resurface in operation — ledgered visibly.
- **R-P3-6 keepAlive policy = per-role.** Role frontmatter gains optional `keep_alive: true|false` (default true for studios — credits burn deliberately); provision passes it through. Idle-heavy fleets can flip roles to sleep. Cost if wrong: a sleeping studio cold-starts on attach (~seconds) — acceptable, reversible per role.

## Components

### 1. Spawn route + org enforcement
- `src/studio/org.ts`: `parseOrgJson(s)` (edges + gates shape from blueprint — parser exists conceptually in T11's blueprint.ts; extend there if cleaner), `maySpawn(org, parentRole, childRole): boolean`.
- Provision mints `spawnToken` (crypto random 64 hex, `fsp_` prefix — plan is authoritative; spec corrected post-T1) → DO storage + container env `FLEET_SPAWN_TOKEN`; refresh rotates it? NO — static per provision (rotation = churn without threat model; container compromise = token compromise either way). Scrubbed everywhere (add `[0-9a-f]{64,}`-guarded named pattern? Too broad — use prefix `fsp_` on the token, redact pattern `fsp_[0-9a-f]+`).
- **R-P3-7 Machine surface gets machine auth.** Spawn calls originate inside containers, which hold no Access service tokens — and the Access app is path-scoped to `/studio`. Therefore the machine route is `POST /fleet/spawn`, OUTSIDE the Access path (exactly like the existing webhook routes), authenticated solely by the spawn token (`X-Fleet-Spawn-Token`, constant-time compare against registered studios' tokens). Access keeps protecting the human surfaces; this mirrors the fleet's established webhook pattern. Cost if wrong: one more token class to rotate — bounded by per-studio scoping.
- Worker resolves parent studio by token, loads org.json at the pinned ref (cache 5 min), checks edge, derives child id, 409 on exists/cap, else provision. Response = child StudioStatus.
- `fleet spawn <role>` in-container: a NEW tiny `container/studio-fleet` script baked into the studio image (the batch lane's `container/fleet-cli.ts` is protected — untouched), calling `/fleet/spawn` with the env token. The Mac CLI also gains `fleet spawn` (operator-initiated, via Access service token against a thin `/studio/`-side spawn passthrough that reuses the same org check).

### 2. Scale + provisioning tooling
- Mac CLI: `fleet provision <repo>--<role> [--count N for scratch fleets]`; `MAX_STUDIOS` cap Worker-side; wrangler.jsonc `max_instances` 5 → 100 (deliberate raise now that provision is capped app-side).
- Per-role `instance_type` + `keep_alive` frontmatter (blueprint parser + provision plumbing + bring-up unaffected).

### 3. Burn totals + backlog items
- Grid header aggregate; formatBurn legend line in `fleet ls` header.
- Ship tick exec consolidation (one chained exec returns boot-id + stat + chunk + tail with delimiters — parse split); daily-prune gating.
- truncate-label, U+FFFD trim (decode with stream:true or trim to last complete char).

## Testing

Unit: org parser + maySpawn matrix (edges, unknown roles, self-spawn denied unless edged); spawn route (bad token 401, unknown parent 401, edge denied 403, cap 409, exists 409, happy 200 w/ spawnedBy); token scrub; per-role instance/keepAlive plumb-through; consolidated ship-exec parser (delimiters, partial output); aggregate math; U+FFFD trim.
Integration additions: spawn e2e — provision parent (pilot role file gains may_spawn for a `scratch` role in the TEST blueprint fixtures only), container-side script spawns child through real Worker route, child provisions real container, registry shows both + spawnedBy; org-denied spawn 403 e2e.
Acceptance additions: `fleet spawn` from Mac CLI; `fleet ls` shows parent+child; grid header totals render.
Gates: all suites green; batch lane zero-diff; dry-run clean.

## Out of scope (recorded for post-arc backlog)

Streaming paste, approval-channel transport, R2 bucket automation, Moshi hooks feed, PAX, Spectrum beta, multi-repo fleet.json orchestration beyond websites, hard token queue.

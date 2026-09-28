# Fleet Repo Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fleet infrastructure lives in its own repo. The running fleet never breaks, at any step.

**Architecture:** Two phases, split at the risk boundary. Phase 1 moves BLUEPRINT CONTENT (what studios read at runtime) and flips one pin. Phase 2 moves the WORKER CODE (what deploys). Phase 1 carries all the runtime risk; Phase 2 carries none.

**Tech Stack:** GitHub (repo + App installation), Cloudflare Workers, bun.

## Why split at all

`fleet.json` pins `blueprint.repo: acme-org/websites@main`. Every studio, for every client, reads its org chart, roles, skills and memory from a repo that also holds `sites/beta`, `sites/acme-careers`, `apps/reporting`. Client work and fleet infra share one PR queue — which already caused a real divergence: an agent's cleanup pushed straight to `main`, leaving it 38 commits ahead of `staging` and the promotion PR CONFLICTING.

Also: the repo is named `websites` and holds the fleet. That has already confused a reader once.

## The safety property

**Both repos hold the blueprint during transition.** Nothing is deleted until the new source is proven serving. The flip is one config line plus a deploy, revertible in one commit.

Two pins exist and they mean different things (`src/studio/repo.ts` documents the split):

| pin | meaning | moves in |
|---|---|---|
| `blueprint.repo` (fleet.json) | where studios read org chart, roles, skills, memory | **Phase 1** |
| `AGENT_REPO` (wrangler.jsonc) | default WORK repo, and where `fleet.json` itself lives | **stays** |

Only `blueprint.repo` moves. `AGENT_REPO` keeps pointing at `websites`, so `fleet.json` stays findable and the default work repo is unchanged.

## Global Constraints

- **Never delete from the old repo until the new one is proven serving.** Copy, verify, flip, then remove — in that order, no exceptions.
- The GitHub App (`example-org-fleet`) **must be installed on the new repo before anything reads it**. A missing installation is a 403 on every blueprint fetch, and studios boot blind.
- `bun` only. Caveman-compressed persistent text; code normal.
- Baseline 1527 vitest, `bun run check` clean across 5 tsconfig projects.
- After any pin change: deploy, then **verify a studio actually provisions from the new blueprint** before proceeding. Deploy is not proof.

---

### Task 1: Create and populate the new repo

**Files:** new repo `acme-org/fleet` (name to confirm with the operator)

- [ ] **Step 1: Create the repo, private, no auto-init**

```bash
gh repo create acme-org/fleet --private --description "FLEETFLARE agent fleet — studios, blueprint, worker"
```

- [ ] **Step 2: Copy blueprint content, preserving history where cheap**

Copy (do NOT move) from `fleetflare-agency`:
- `fleet/blueprint/` — studios, org.json
- `fleet/memory/` — harvested learnings + index
- `skills/` — Tier-1 skills studios materialize
- `fleet.json`

- [ ] **Step 3: Install the GitHub App on the new repo**

https://github.com/settings/installations → `example-org-fleet` → Configure → add the new repo → Save. **This is the operator's step; it cannot be scripted.** Verify with `gh api repos/acme-org/fleet` under the App, or via `listInstallationRepos`.

- [ ] **Step 4: Prove the new repo serves the blueprint**

Fetch `fleet/blueprint/org.json` and `fleet.json` from the new repo through the same path the Worker uses. Both must parse. Do not proceed on a 404 or 403.

- [ ] **Step 5: Commit** — `feat(fleet): blueprint content in its own repo`

---

### Task 2: Flip the pin

**Files:** `fleet.json` in `fleetflare-agency` (the FLEET repo — `AGENT_REPO` still points here)

- [ ] **Step 1: Change `blueprint.repo` to the new repo, leave `ref: main`**

- [ ] **Step 2: Deploy**

`cd apps/fleet && export CLOUDFLARE_ACCOUNT_ID=0000000000000000000000000000ac && env -u CLOUDFLARE_API_TOKEN bunx wrangler deploy`

Worker-only change; expect `no changes fleetflare-studiodo`.

- [ ] **Step 3: PROVE a studio provisions from the new blueprint**

Recycle `websites--pilot` (disposable). Then confirm inside the container that skills materialized and the harness is intact — `GET /studio/websites--pilot/provisioned` must return `{"kind":"provisioned"}`, and the probe must show the skills directory populated from the NEW source.

**If this fails, revert the pin and redeploy. That is the whole rollback.**

- [ ] **Step 4: Commit** — `feat(fleet): studios read the blueprint from its own repo`

---

### Task 3: Remove the duplicate — only after Task 2 is proven

**Files:** `fleetflare-agency`: `fleet/blueprint/`, `fleet/memory/`, `skills/`

- [ ] **Step 1: Confirm Task 2's verification is still green** (a studio provisioned from the new repo, measured, not remembered)

- [ ] **Step 2: Delete the copied paths from `fleetflare-agency`**

- [ ] **Step 3: Full suite + check**

- [ ] **Step 4: Recycle a studio again — proves nothing was secretly still reading the old copy**

- [ ] **Step 5: Commit** — `chore(fleet): drop blueprint content now served from its own repo`

---

### Task 4 (Phase 2, separate session): move the Worker

Deliberately NOT in this plan. `apps/fleet/` moving changes where deploys run from, the container build context, and the CLI's link target — but no runtime pin. Zero risk to a running studio, and it is a bigger diff. Do it once Phase 1 has been stable for a few days.

Carries: `apps/fleet/`, fleet specs and plans under `docs/superpowers/`, the `fleet-cockpit` skill's canonical copy, and `bun link` re-pointing.

---

## Self-review

- Spec coverage: the split analysis lives in this plan's own "Why split" and "safety property" sections; there is no separate spec because the design is one decision (which pin moves) and the value is entirely in the sequencing.
- Rollback is explicit and single-step at the only dangerous moment (Task 2 Step 3).
- Task 3 is gated on Task 2's proof, and re-proves after deletion — the one place where "it still works" could be an illusion caused by the old copy still being readable.

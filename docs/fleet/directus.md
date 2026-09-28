# Directus — the estate store

P5c. Spec: `docs/superpowers/specs/2026-08-27-fleet-guardrails-p5-design.md`
§7 (where things live) and §8 (client portal).

Code: `apps/fleet/src/directus/`.

---

## 1. What lives here, what does not

Five stores. Split by who writes, how it changes, who must read.

| store | holds |
|---|---|
| Repo | conventions, docs, infra-as-code. Changes WITH the code. |
| GitHub Issues | units of work with state. |
| **Directus** | **the ESTATE.** Project registry, contract, requirements, decision log, client portal. |
| Fleet memory | how-to-work learnings. |
| Infisical | every secret. Other four hold secret NAMES only. |

The line. Repo docs describe THIS PROJECT. Directus describes THE ESTATE.
Fleet memory describes HOW TO WORK.

Worked example, one fact each way:
- `wrangler.jsonc` → repo. It IS the infra.
- "prod on Demosite CF account; beta unreachable from others" → Directus. Spans
  repos, outlives them.
- "merged is not served" → fleet memory. True of the fleet, not one project.

---

## 2. Collections

`estate_` prefixed. AgencyOS owns `os_*` on the same instance; prefix stops
the collision.

| collection | holds |
|---|---|
| `estate_projects` | key, name, repo, CF account, Infisical project, domains, staging/prod URLs |
| `estate_contracts` | go-live, fixed-price, penalties, scope boundary **+** price, margin, terms (tiered — §3) |
| `estate_requirements` | ref, text, acceptance, status, issue_number |
| `estate_decisions` | ref, title, decision, rationale, status, supersedes |
| `estate_requests` | client portal inbound. body, status, issue_number (unique), verification_url, delivered_at |

`estate_projects.key` MUST equal the studio id's repo segment (`<repo>--<role>`).
That segment is the only estate handle the Worker holds at provision.

**Requirements are rows, ruled.** Not a document. Four mechanisms need the
citable `ref`: task brief cites it, verification intent names it, checklist
groups by it, fix-task cites the one it failed. Requirements must exist BEFORE
work starts, or briefs cannot cite and the checklist cannot group. Sprint
meeting's job.

---

## 3. Tiered exposure — ruled, non-negotiable

| tier | holds | who sees |
|---|---|---|
| stakes | go-live, fixed-price y/n, "penalties carry", scope boundary | every studio, in the project card |
| requirements | numbered, text, acceptance | any studio, on demand |
| commercial | price, margin, payment terms, penalty amounts | **Maestro only** |

Standing rule: never ship cost or margin to a client-facing surface. A studio
prompt IS a surface — what a studio knows it can write into a PR body.

Enforced 3 ways:
1. `?fields=` built from the stakes allow-list. Price never on the wire.
2. Commercial keys stripped from the parsed row anyway. Directus is a server
   we do not own; it may ignore `?fields=`.
3. `ContractStakes` type has no commercial member. The card renderer cannot
   hold one.

---

## 4. The project card

10-20 lines, injected at provision into the lead prompt. Not a document dump.

Answers five things: which repo, which account, which URLs, what is at stake,
which decisions are open.

A fact absent from the prompt is a fact the lead invents. Inventions are
confident and expensive.

**Optional at boot.** Studio comes up when Directus is unreachable or the
credential is absent. A fifth store that can block provisioning is a fifth way
to have no fleet. `resolveProjectCard` never throws; a null card provisions
byte-identically to pre-P5c.

---

## 5. Client portal (§8) — designed, NOT built

`apps/fleet/src/directus/portal.ts` header carries the full spec. Read it
before implementing the inbound path.

Vocabulary map:

| internal | client sees |
|---|---|
| submitted / backlog | Received |
| working | In progress |
| completed | Delivered — with verification link |
| failed / canceled | nothing |

**Delivered publishes only after the operator ticks the checklist.** Never on issue
close. Publishing on close is claimed-done-wasn't pointed at a paying client.
Gate needs both halves: `delivered_at` (the tick) AND `verification_url` (the
evidence).

Maestro triages requests into task specs. Auto-conversion produces garbage
tasks — a request is prose from a non-technical person, never a spec.

Not built: cron inbox, `request ls/accept/reject/link`, issue mirroring,
any writer.

---

## 6. Credentials — what the operator must provide

TWO tokens. Different privilege. Never the same value.

### `DIRECTUS_TOKEN` — the Worker's, READ-ONLY

The one credential this feature needs at runtime.

1. Directus admin → Settings → Access Policies → create policy
   `fleet-worker-read`.
2. Grant **Read** only, on these five collections:
   `estate_projects`, `estate_contracts`, `estate_requirements`,
   `estate_decisions`, `estate_requests`.
   No create, no update, no delete, on anything.
3. Directus admin → User Directory → create user `fleet-worker` → assign that
   policy → **Token** field → Generate → save the user → copy the token.
4. Paste:
   ```
   cd apps/fleet && wrangler secret put DIRECTUS_TOKEN
   ```
   Never in `wrangler.jsonc`. Never in a container env.

### `DIRECTUS_URL` — instance origin, NOT a secret

`https://<host>`. Must be https — the client refuses http rather than put the
bearer on a plaintext wire.

Belongs in `apps/fleet/wrangler.jsonc` `vars`, beside `WORKER_PUBLIC_URL`.
**Still outstanding** — P5c was scoped not to touch that file.

### `DIRECTUS_ADMIN_TOKEN` — schema apply only, never deployed

Admin static token. Used by a human, at a terminal, once per schema change.
Never a Worker secret. If it ever equals `DIRECTUS_TOKEN`, a bug in a request
handler can drop a column.

```
DIRECTUS_URL=https://<host> DIRECTUS_ADMIN_TOKEN=<admin token> \
  bun run scripts/directus-schema.ts --dry-run   # prints, writes nothing
DIRECTUS_URL=https://<host> DIRECTUS_ADMIN_TOKEN=<admin token> \
  bun run scripts/directus-schema.ts
```

Idempotent. Probes before every write. Never deletes, never alters — a drifted
field is reported and the script exits 2.

---

## 7. Rules

- The Worker writes. Containers never hold a Directus credential. Single-writer
  (§10) extends to Directus: Maestro decides, the Worker writes.
- Read path only in P5c. `fetchContractCommercial` exists and has no route.
  Whatever route eventually calls it must be Access-gated and unreachable by a
  spawn token.
- Nothing at request time creates a collection.

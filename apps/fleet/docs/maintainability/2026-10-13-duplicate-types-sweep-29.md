# Duplicate-types sweep 29 — apps/fleet src+cli (2026-10-13)

Ref #647. Analysis only, read-only, no code changed. Twenty-ninth
maintainability sweep; scope `apps/fleet/src/**` and `apps/fleet/cli/**`
minus `container/`. Line refs = physical lines at `origin/main` `8aa9d69`,
paths relative to `apps/fleet/`.

Method: two passes. (1) Name pass — every `interface`/`type` declaration name
extracted across src+cli, counted; every name declared 2+ times read by hand.
(2) Body pass — normalized declaration bodies (comments stripped, whitespace
collapsed) hashed and grouped, so same-shape-different-name pairs surface too.
Every candidate then hand-checked: field diff, lane (GLM-OK vs CLAUDE-ONLY),
importers, and whether a comment already documents the duplication as
deliberate.

**Tier rule:** GLM-OK = none of auth, secrets, credentials, rescue, failover,
accounts routing, deploy, migrations, write-proxy, leak-gate, approvals.
CLAUDE-ONLY = touches any of those.

**Sweep's rule for what counts:** same field set declared in 2+ files —
either same name twice, or same body under two names. Deliberate mirrors a
comment already justifies are findings still (the mirror CAN drift — F5 did),
marked intentional; single-word aliases local to one function's file are not
findings unless shared.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | `Row` ×3, three unrelated D1 row shapes: events/log.ts:3 (11 fields), approvals/store.ts:29 (12 fields), deploy/targets.ts:12 (8 fields). Different shapes, same generic name. Not one canonical — keep separate, RENAME to EventLogRow / ApprovalStoreRow / DeployTargetRow so the name carries the shape. | GLM-OK (store.ts sits in approvals/) |
| 2 | `TaskState` ×2, DIFFERENT closed unions: tasks/types.ts:11 `"idle"\|"running"\|"done"\|"failed"` vs board/types.ts:37 derived from TASK_STATES (7 board states). Same name, disjoint vocabularies. tasks/types.ts one now un-exported (ex-#602) — un-export fixed the collision risk; keep names distinct or rename to WorkerTaskState / BoardTaskState. | GLM-OK |
| 3 | `SyncResult` ×2, unrelated shapes: studio/session-sync.ts:341 (transcript-sync fields) vs cli/accounts.ts:282 (snapshot POST result). Both file-local, zero shared importers. RENAME: SessionSyncResult / AccountsSyncResult. | CLAUDE-ONLY (accounts routing) |
| 4 | `RepoReachFetch` ×2 IDENTICAL alias `(slug: string) => Promise<RepoReach>`: board/routes.ts:125, studio/routes.ts:187. Zero importers anywhere — both purely positional params. Canonical: export once from src/github/reach.ts (where RepoReach lives), delete both locals. | GLM-OK |
| 5 | `ProvisionedVerdict` ×2, one REAL drift: ff.ts:483 mirrors do.ts:2072 because do.ts imports "@cloudflare/sandbox" which does not resolve under cli tsconfig. DRIFT ALREADY: do.ts carries `warning?: string` on the "provisioned" variant; ff.ts parseVerdict drops it (parseVerdict returns `{ kind: "provisioned" }` only). test/studio.ff.test.ts:8 pins the two shapes two-way. Fix shape: ff.ts adds `warning?: string` (1 line + parse extraction) — cli still never imports do.ts. | CLAUDE-ONLY (do.ts rescue-adjacent) |
| 6 | `ReapDeps` ×2, DIFFERENT deps bags: src/studio/task-reap.ts:52 (board-task reap: repo, listOpenTasks, checkLanded, findCloser) vs cli/reap.ts:115 (studio reap: now, listStudios, listBoard, studioTasks, inspect, rescue, destroy, loadState). Same name for unrelated injected-deps interfaces. RENAME: TaskReapDeps / StudioReapDeps. | CLAUDE-ONLY (cli/reap rescue verbs) |
| 7 | `Json` ×3 IDENTICAL `type Json = any` (deno-lint-ignored): junior/route.ts:35, llm/anthropic-route.ts:42, llm/translate.ts:22. Zero importers, each local escape hatch. Canonical: one `type Json = any` in src/llm/json.ts (or keep local — an `any` alias is a per-file lint suppression; one line each, sharing buys little). Low value; note only. | GLM-OK |
| 8 | `DynamicEnv` ×3 IDENTICAL `Readonly<Record<string, unknown>>`: write-proxy/mode.ts:89, github/auth.ts:162, github/app.ts:59. Each isolates one computed-name env read behind a narrow type; app.ts:56 comment already says "same isolation as auth.ts's". Canonical: export from github/auth.ts, import in app.ts. | CLAUDE-ONLY (write-proxy + auth lanes) |
| 9 | `RepoFileChange` (github/api.ts:375) vs `FileChange` (memory/compact.ts:210): identical `{ path: string; content: string \| null }`; api.ts:372 comment says "Mirrors compact.ts's FileChange exactly". Direction: api.ts deliberately does NOT import compact.ts (Worker-side github module must not depend on memory module). Canonical: FileChange; api.ts re-exports/imports from a leaf types module, or mirror stands with the pin. Intentional mirror — keep + pin both ways. | GLM-OK |
| 10 | `BoardRepoDeps` (board/board.ts:965) vs `WorkRepoDeps` (studio/repo.ts:224): identical `{ reachRepo: (slug: string) => Promise<RepoReach> }`; board.ts:961 comment says "Same port, same reasoning as WorkRepoDeps". WorkRepoDeps exported + imported by studio/routes.ts:28; BoardRepoDeps file-local. Canonical: WorkRepoDeps; board.ts imports it. | GLM-OK |
| 11 | `DirectusConfig` (directus/client.ts:36) vs `AdminConfig` (directus/schema-apply.ts:32): same `{ url, token }` shape, different tokens (read-only DIRECTUS_TOKEN vs ADMIN). Names distinct on purpose — merging would hide which token a caller must pass. KEEP both, no action. | GLM-OK |
| 12 | `FetchLike` (directus/schema-apply.ts:41) vs `JuniorUsageFetch` (cli/junior.ts:177): identical `(url: string, init: RequestInit) => Promise<Response>` seam; zero shared importers. Both one-line fetch seams local to their module. Low value; rename only if a shared seam module ever lands. Note only. | GLM-OK |

## CLAUDE-ONLY hits (counted above, not for GLM)

F3 (accounts), F5 (do.ts/rescue), F6 (cli reap), F8 (write-proxy +
github/auth). No container/ hits: container re-declares TaskState/Milestone
etc. locally (server.ts) but container/ is excluded by scope.

## Proposed deepen issues

Filed with the lane re-check applied — an edit that touches a banned lane is
not GLM-OK however it is batched (same rule the findings table states):

- S29-F1 (issue #662): F2 only — TaskState ×2 rename. F1 (Row ×3) excluded:
  renames edit approvals/store.ts and deploy/targets.ts — approvals and
  deploy lanes. F3/F6 stay CLAUDE-ONLY (accounts, rescue verbs).
- S29-F2 (issue #664): F4 (RepoReachFetch canonical in reach.ts) + F10
  (BoardRepoDeps imports WorkRepoDeps). F8 excluded: its remaining part edits
  github/auth.ts — the auth lane.
- F5 (ProvisionedVerdict warning drift) is CLAUDE-ONLY — operator fixes or files separately.
- F7/F9/F11/F12: no action (F9 pin both ways if touched).

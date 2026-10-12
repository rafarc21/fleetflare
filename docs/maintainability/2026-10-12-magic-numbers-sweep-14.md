# Magic-numbers sweep 14 — apps/fleet src+cli (2026-10-12)

Ref #485. Analysis only, read-only, no code changed. Fourteenth maintainability
sweep; scope `apps/fleet/src/**` and `apps/fleet/cli/**` minus `container/`.
Line refs = physical lines at `origin/main` `b1d204b`, paths relative to
`apps/fleet/`.

Sweeps 1-13 (docs/maintainability/*.md) and the open deepen(*) issues they
filed are NOT repeated here.

**Tier rule:** GLM-OK = none of auth, secrets, credentials, rescue, failover,
accounts routing, deploy, migrations, write-proxy, leak-gate. CLAUDE-ONLY =
touches any of those.

The sweep's rule for what counts: a number is a finding only when two copies
serve ONE purpose (the same timeout being re-stated, the same cap re-derived),
not when two modules coincidentally pick the same round number. Where a copy
is a deliberate cross-layer number-reuse (comment says so), the finding asks
for the comment to name its sibling, not for a shared const across the layer
boundary.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | `timeout -k 2` raw in provision.ts vs `KILL_GRACE_SECONDS = 5` — same purpose, DISAGREEING values | GLM-OK (fix) |
| 2 | poll trio (attempts 6 / interval 10s / status 15s) re-declared in recycle-outcome.ts instead of derived from destroy-outcome.ts | GLM-OK |
| 3 | `INSPECT_EXEC_MS` 15s re-stated raw in `EXEC_CLASSES.inspect` | GLM-OK |
| 4 | `MINUTE_MS` 60_000 declared in ratelimit.ts AND exceptions.ts; rate-limit.ts re-derives inline | GLM-OK |
| 5 | 2000-char response-body cap: three independent `2000`/`MAX_CHARS`/`MAX_FIELD_CHARS` declarations | GLM-OK |
| 6 | `slice(0, 300)` error-snippet cap hand-copied 16x across 4 CLI files while `decodeBody` takes it as a parameter | GLM-OK |
| 7 | `formatSurvivalAge` byte-identical to `formatAge` (opposite sides of src/cli boundary) | GLM-OK |
| 8 | `EXEC_CLASSES.provision.timeoutMs` 600_000 re-stated raw inside `RECYCLE_CLIENT_TIMEOUT_MS` arithmetic | GLM-OK |
| 9 | `ACTIVITY_DO_STALE_SECONDS` 90 and its twin `HOOK_STALE_BUDGET_MS` 90_000 — same budget for the same stored value, number-reuse by comment only | GLM-OK |
| 10 | `defaultPort = 8080` + `sleepAfter` re-declared per Container subclass (agents/do.ts vs deploy/do.ts) | GLM-OK |

### S14-F1. `timeout -k 2` vs `KILL_GRACE_SECONDS = 5` — disagreeing copies — GLM-OK (fix)

- **Files:** `src/studio/exec-deadline.ts:6` (`export const KILL_GRACE_SECONDS = 5` — "SIGKILL follows SIGTERM this many seconds after the deadline"), used by `withKillDeadline` (`:20`), provision.ts:1036 and rescue.ts:351,387,399. Raw copies: `src/studio/provision.ts:3227,3228` — `timeout -k 2 ${killAfterSeconds}` in `killAsideClaudeSnippet`'s script wrapper (doc at `:3126` says "The in-container kill: `timeout -k 2 <this>`").
- **Disagreement:** 2s vs 5s grace for the SAME mechanism (SIGKILL lag after a `timeout` deadline, in-container). The exec-deadline constant's whole purpose is to be the ONE grace number; provision's aside-kill path predates or bypasses it.
- **Risk:** budgets derived from the grace (`DEADLINE_SLACK_MS = KILL_GRACE_SECONDS * 1000 + 2_000`, sandbox-api.ts:90) assume 5s; a 2s-grace kill that races the Worker's slack arithmetic is invisible until an aside claude refuses to die inside the slack window. Not observed failing — a drift, not an outage.
- **Proposed home:** import `KILL_GRACE_SECONDS` from `exec-deadline.ts` into provision.ts and interpolate it at both raw sites. If 2 is deliberate (a cheaper kill for a throwaway aside session), the const rename and comment must say so and the exec-deadline doc must name the exception — today nothing does.
- **Lane note:** provision.ts bring-up path; no credential content. The rescue.ts uses of the constant are the rescue lane's own — only the provision.ts sites are in scope here.

### S14-F2. The destroy/recycle poll trio re-declared, not derived — GLM-OK

- **Files:** `cli/destroy-outcome.ts:70,71,76` (`DESTROY_POLL_ATTEMPTS = 6`, `DESTROY_POLL_INTERVAL_MS = 10_000`, `DESTROY_STATUS_TIMEOUT_MS = 15_000`) and `cli/recycle-outcome.ts:83,84` (`RECYCLE_POLL_ATTEMPTS = 6`, `RECYCLE_POLL_INTERVAL_MS = 10_000`) — recycle-outcome.ts already imports `DESTROY_CLIENT_TIMEOUT_MS`/`DESTROY_STATUS_TIMEOUT_MS` (`:38`) and its comment says "Same poll bound as destroy" (`:81`), but attempts and interval are hand-copied numbers, not derived.
- **Risk:** one poll budget changes, the twin silently keeps the old shape — the comment claims sync ("Same poll bound as destroy") that nothing enforces. Values agree today.
- **Proposed home:** recycle-outcome.ts derives `RECYCLE_POLL_ATTEMPTS = DESTROY_POLL_ATTEMPTS` and `RECYCLE_POLL_INTERVAL_MS = DESTROY_POLL_INTERVAL_MS` (or imports them directly), keeping the names as aliases if the doc comments read better with them. One-line change, both files already cross-import.

### S14-F3. `INSPECT_EXEC_MS` re-stated in `EXEC_CLASSES.inspect` — GLM-OK

- **Files:** `src/studio/inspect.ts:94` (`export const INSPECT_EXEC_MS = 15_000`) and `src/studio/sandbox-api.ts:162` (`inspect: { sessionId: "fleet-inspect", timeoutMs: 15_000 }`) — the EXEC_CLASSES doc comment itself says "inspect 15s INSPECT_EXEC_MS, inspect.ts's own budget" (`:103`): the number is asserted to be that constant, then written raw.
- **Risk:** inspect budget changes in inspect.ts, the exec class silently keeps 15s; the comment keeps claiming they are one number.
- **Proposed home:** `inspect: { sessionId: "fleet-inspect", timeoutMs: INSPECT_EXEC_MS }` — sandbox-api.ts already imports from studio/ siblings (`exec-deadline.ts:33`). One-line.

### S14-F4. `MINUTE_MS` / one-minute window: three declarations, one inline re-derivation — GLM-OK

- **Files:** `src/ratelimit.ts:19` (`const MINUTE_MS = 60_000` — module-private, the bucket size for every rate-limit kind), `src/exceptions.ts:159` (`const RATE_WINDOW_MS = 60_000` — the insert-throttle window, deliberately module-private per its own doc), `src/studio/rate-limit.ts:144` (`Math.floor(now.getTime() / 60_000) * 60_000` — minute-of-hour offset arithmetic, raw 60_000 twice inline).
- **Risk:** none operationally — three modules each own a different counter and the values agree; the duplication is a readability cost, one shared "what is a minute in ms" that gets re-declared per file. The exceptions.ts copy is deliberately unshared (its doc says the rate cap is its own module-local concern); ratelimit.ts's is importable.
- **Proposed home:** leave the module-privates alone where their docs claim locality (exceptions.ts), and derive ratelimit.ts's own from itself; export `MINUTE_MS` from ratelimit.ts (already the natural import for llm/junior ratelimit modules) and use it in rate-limit.ts:144. Doc-only finding otherwise — recorded because a later sweep keeps re-meeting 60_000.

### S14-F5. 2000-char response-body cap: three independent declarations — GLM-OK

- **Files:** `src/exceptions.ts:106` (`const MAX_FIELD_CHARS = 2000`, worker-side exception field cap), `cli/repair-failure.ts:7` (`const MAX_CHARS = 2000` — "Upper bound for a pathological body"), `src/approvals/store.ts:113` (`result.slice(0, 2000)` raw in the D1 bind — the finishApproval result cap).
- **Disagreement risk:** none today — all three cap stored/printed error text near 2 KiB, but for three different stores (exceptions table, terminal line, approvals result column). Each has its own justification comment; the shared number is coincidence-plus-convention, not one budget.
- **Proposed home:** none across files (different layers: Worker vs CLI vs D1 row shape). Within reach: name the approvals/store.ts raw slice (`const RESULT_MAX_CHARS = 2000` next to the prepare) so the D1 column contract is stated where the schema lives, not inline in a bind call. The other two keep their own consts — their doc comments already do the work.

### S14-F6. `slice(0, 300)` — the error-snippet cap, hand-copied 16 times across 4 files — GLM-OK

- **Files:** `cli/fleet.ts` (9 sites — every fetch failure path), `cli/accounts.ts` (3), `cli/ff.ts` (3), all as `(await res.text()).slice(0, 300)`; `cli/inspect-request.ts:47` passes `300` as `decodeBody`'s cap; `cli/repair-failure.ts:10` documents the history ("Before #96 every verb printed text.slice(0, 300)").
- **Risk:** the 300 is the CLI's one readability budget for an error body — a number the whole CLI agrees on by convention, re-typed per call site. `decodeBody` (cli/diag.ts:41) already takes the cap as a parameter; the 16 raw copies predate it and never adopted a name.
- **Proposed home:** one `export const ERROR_SNIPPET_MAX_CHARS = 300` in cli/diag.ts (next to decodeBody, the module that already owns body-decoding) and a sweep of the 16 sites to interpolate it. Mechanical, GLM-safe, no behavior change.

### S14-F7. `formatSurvivalAge` — a byte-identical `formatAge` on the src side — GLM-OK

- **Files:** `src/studio/survival-brief.ts:348-355` (`formatSurvivalAge`) and `cli/readiness-format.ts:81-89` (`formatAge`) — identical bodies line for line (`s<60`, `>=86400 && %86400`, `>=3600 && %3600`, `<86400 → minutes`, else floor hours). CLI already imports from src (`readiness-format.ts:11` imports `SYNC_SESSION_SECONDS` from `../src/studio/session-sync`), so the import direction exists.
- **Risk:** one copy learns a new bucket (e.g. "1.5h" rendering) and the survival brief silently disagrees with `fleet ls`/reap wording for the same age. Pure display duplication.
- **Proposed home:** the age-format family lives in cli/readiness-format.ts and is CLI-facing; survival-brief.ts (Worker) needs the same rendering for card text. Either export `formatAge` from readiness-format.ts and import it in survival-brief.ts (CLI-pure module, no Worker graph — already proven importable), or accept the copy but pin it the way test/cli.backoff.test.ts source-pins the inlined backoff body in page/terminal.template.html. Import is the cheaper home; a source-pin test is the fallback if the Worker bundle must not touch cli/.

### S14-F8. `EXEC_CLASSES.provision.timeoutMs` re-stated in recycle's client budget — GLM-OK

- **Files:** `src/studio/sandbox-api.ts:166` (`provision: { timeoutMs: 600_000 }` — the class's own budget) and `cli/recycle-outcome.ts:78` (`export const RECYCLE_CLIENT_TIMEOUT_MS = DESTROY_CLIENT_TIMEOUT_MS + 600_000 + 60_000` — the doc block at `:51-60` spells out "600_000ms EXEC_CLASSES.provision.timeoutMs" as the second addend).
- **Risk:** the recycle client timeout is DERIVED arithmetic over the provision exec budget, but the middle addend is a raw copy — change the provision class budget and the CLI's honest-window math keeps 600s. The comment claims the derivation; the code does not.
- **Proposed home:** cli cannot import the Worker's sandbox-api.ts graph (cli/ files keep the Worker graph out; destroy-outcome.ts's own header says the modules are CLI-pure). So: keep the raw addend but make the derivation checkable — either a source-pin test (like the backoff pin) asserting `RECYCLE_CLIENT_TIMEOUT_MS === DESTROY_CLIENT_TIMEOUT_MS + 600_000 + 60_000`, or move `EXEC_CLASSES.provision.timeoutMs`'s number to a one-line const exported from a CLI-importable pure module (the pattern `session-sync.ts`/`inspect.ts` already set: src exports a const, cli imports it). At minimum the two sites must share a name in comments that grep finds.

### S14-F9. The 90s activity-staleness budget — number-reuse by comment only — GLM-OK

- **Files:** `cli/readiness-format.ts:271` (`export const ACTIVITY_DO_STALE_SECONDS = 90` — "3 × the ship tick's own 30s cadence") and `src/studio/activity.ts:430` (`const HOOK_STALE_BUDGET_MS = 90_000`, whose 20-line doc explicitly says it "Mirrors ACTIVITY_DO_STALE_SECONDS ... as a plain number rather than an import — studio/ is a layer BELOW cli/").
- **Risk:** the comment names the mirror and the layering reason — this is a KNOWN, documented number-reuse, not an accident. But nothing mechanical keeps the pair in sync: bump the ship tick to 60s and ACTIVITY_DO_STALE_SECONDS's derivation (3 × cadence) changes while HOOK_STALE_BUDGET_MS stays 90_000 unless someone re-reads this doc comment.
- **Proposed home:** the layering argument is right (studio/ must not import cli/), so the shared home is a src/-side pure module both can import: export the cadence (`SHIP_TRANSCRIPT_SECONDS`, do.ts:248, already exported) from session-sync.ts-style pure src, derive `3 * SHIP_TRANSCRIPT_SECONDS` in activity.ts, and have readiness-format.ts (cli, already importing src consts) derive ACTIVITY_DO_STALE_SECONDS the same way. Two one-line derivations, zero raw 90s left.

### S14-F10. Container `defaultPort`/`sleepAfter` re-declared per subclass — GLM-OK

- **Files:** `src/agents/do.ts:181,182` (`defaultPort = 8080; sleepAfter = "20m"`) and `src/deploy/do.ts:211,212` (`defaultPort = 8080; sleepAfter = "5m"`), with `src/agents/runtime.ts:49` (`port: number = 8080`) as a third 8080 and `deploy/do.ts:234,271` re-typing `8080` in containerFetch calls.
- **Risk:** low — these are the Containers platform's own defaults re-stated per class; the DOs are separate containers and their values may legitimately diverge (sleepAfter already does: 20m vs 5m). The 8080s are the real duplication: the platform's default port, re-typed 4 times with no shared name, and runtime.ts's default parameter is a silent third copy that must agree.
- **Proposed home:** one `export const CONTAINER_PORT = 8080` (agents/ or a small shared const module) used by both DOs and runtime.ts's default; containerFetch call sites keep the literal or adopt it. sleepAfter stays per-class — the divergence is real and the values are config, not a shared constant.

## Not filed (counted, no issue)

- `LIST_TIMEOUT_MS`/`CREATE_TIMEOUT_MS` (cli/orca-workspace.ts:69,76) vs other CLI fetch timeouts — orca runs a local binary, different transport, different budgets; coincidence, not one purpose.
- `ORG_RETRY_MS`/`JWKS_RETRY_MS` (org.ts:152, auth.ts:35) — both 60_000 but org cache vs JWKS refresh, independently documented purposes. auth.ts is also the auth lane's edge.
- `POLL_LOOP_TOKENS = 300_000` (member-alerts.ts:160) vs rate-limit windows — unrelated purposes.
- `TICK_DEADLINES_MS` (do.ts:3692) vs `EXEC_CLASSES` budgets — deliberately separate maps (whole-tick vs per-exec), each doc cross-references the other; the arithmetic between them is commented at do.ts:4874.
- 2000/day lead cap vs 2000-char caps — one is a count, one is a length; same digits, no relation.
- rescue.ts's `RESCUE_PUSH_TIMEOUT_SECONDS` family, failover.ts flap/park guards, accounts.ts watch interval — CLAUDE-ONLY-adjacent lanes, listed for completeness, filed by nobody.

## Counts

10 GLM-OK findings (S14-F1..S14-F10) → one deepen issue each, except S14-F1 (disagreeing copies) which gets its own fix(GLM-OK) issue. 0 CLAUDE-ONLY findings filed; the CLAUDE-ONLY-adjacent observations are listed under "Not filed" for the Claude lane.

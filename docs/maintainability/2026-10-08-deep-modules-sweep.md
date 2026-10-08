# Deep-modules design sweep — apps/fleet (2026-10-08)

Ref #259 Part B step 1. Analysis only. No code changed. Maestro files issues from §3.

## 1. Method

**Skills used, as written** — `mattpocock/skills` @ `b0618bc436ad` (MIT):

- `skills/engineering/improve-codebase-architecture` (ICA) — process.
  - ICA §1 Explore: scope by `git log` hot spots, read `GLOSSARY.md` + `docs/adr/` (neither exists here → nothing to respect / re-litigate), spawn sub-agents to walk code organically, note friction, apply deletion test.
  - ICA §2 Present candidates: per candidate Files / Problem / Solution / Benefits / strength (`Strong` | `Worth exploring` | `Speculative`), end with top recommendation.
  - ICA §3 Grilling: NOT run. Brief = analysis only; grilling happens per issue in refactor lane (#259 Part B step 2).
- `skills/engineering/codebase-design` (CD) — vocabulary + principles: module, interface, implementation, depth, seam, adapter, leverage, locality; deletion test; "interface is test surface"; "one adapter = hypothetical seam".
  - CD/DEEPENING.md "Dependency categories" — tag per finding (in-process / local-substitutable / remote-owned / true external).
  - CD/DEEPENING.md "Testing strategy: replace, don't layer" — drives the "characterization tests" line per finding.

**Deviations from the skills (forced by brief):**

- ICA §2 says HTML report in OS temp dir. Brief needs one md file in repo → same card fields, markdown, committed.
- ICA §1 says "don't follow rigid heuristics". Brief also wants a number per module → depth table (§2) used for triage only; ranking (§3) is by ICA §1 friction + CD deletion test, not by the number.

**Metric (simple, explainable):**

- `impl LOC` = non-blank, non-comment lines in file. (`phys lines` also shown: this codebase is comment-heavy, e.g. `do.ts` 2844 LOC vs 8285 lines.)
- `iface` = exported values (functions, consts, classes, public methods) + params of exported functions/public methods + ⌈exported types ÷ 2⌉.
- `depth` = impl LOC ÷ iface. Low = shallow.
- `fan-in` = distinct non-test files importing module (src, scripts, cli, container, page). `test fan-in` = distinct test files importing it.
- `test-only exports` = exported values that tests import and no production file imports → internals leaked through interface for tests (CD "interface is test surface").
- Caveat, per CD "Rejected framings": LOC ratio rewards padding. Treat number as smoke detector, not verdict. CD defines depth as leverage per unit of interface; §3 judges that.
- Tool: TS compiler AST (`typescript@5.6.3`), one ~150-line script, run outside repo. Reproducible from this definition.

**Baseline for #259 Part D weekly score (src only):**

| measure | value |
|---|--:|
| aggregate depth (Σ LOC ÷ Σ iface) | 7.5 |
| modules with depth < 4 | 30 / 133 |
| test-only exported values / all exported values (src+scripts) | 466 / 1222 (38%) |
| test files reading source text (`TEST_*_SRC` / `readFileSync(src/…)`) | 24 |

**Hot spots (ICA §1, `git log` since 2026-08):** `studio/do.ts` (15 commits), `rescue.ts` (9), `survival-delivery.ts` (8), `routes.ts` (8), `survival-brief.ts` (7), `provision.ts` / `failover.ts` / `accounts.ts` / `cli-args.ts` (6 each). Findings weighted toward these.

## 2. Depth table — all modules, shallowest first

Scope: `apps/fleet/src` + `apps/fleet/scripts`. Ties broken by fan-in (higher first).

| # | module | impl LOC | phys lines | exp values | exp types | params | iface | depth | fan-in | test fan-in | test-only exports |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 1 | `src/github/reach.ts` | 1 | 33 | 0 | 1 | 0 | 1 | 1 | 5 | 6 | 0 |
| 2 | `src/board/close-outcome.ts` | 1 | 15 | 0 | 1 | 0 | 1 | 1 | 2 | 0 | 0 |
| 3 | `src/studio/archive.ts` | 45 | 349 | 20 | 1 | 14 | 35 | 1.3 | 6 | 10 | 1 |
| 4 | `src/studio/exec-deadline.ts` | 9 | 31 | 3 | 0 | 3 | 6 | 1.5 | 3 | 4 | 0 |
| 5 | `src/time-budget.ts` | 11 | 48 | 3 | 1 | 3 | 7 | 1.6 | 3 | 3 | 0 |
| 6 | `src/tasks/watchdog.ts` | 28 | 116 | 6 | 1 | 10 | 17 | 1.6 | 2 | 3 | 0 |
| 7 | `src/studio/container-class.ts` | 8 | 41 | 3 | 0 | 2 | 5 | 1.6 | 1 | 0 | 0 |
| 8 | `src/studio/account-limits-store.ts` | 31 | 91 | 4 | 0 | 12 | 16 | 1.9 | 3 | 4 | 0 |
| 9 | `src/studio/profile.ts` | 30 | 92 | 7 | 0 | 8 | 15 | 2 | 5 | 3 | 4 |
| 10 | `src/studio/account-usage-store.ts` | 22 | 64 | 3 | 0 | 7 | 10 | 2.2 | 2 | 2 | 0 |
| 11 | `src/studio/tmux.ts` | 9 | 52 | 3 | 0 | 1 | 4 | 2.3 | 6 | 6 | 1 |
| 12 | `src/studio/recycle-cost.ts` | 49 | 86 | 7 | 0 | 14 | 21 | 2.3 | 5 | 2 | 0 |
| 13 | `src/memory/store.ts` | 18 | 63 | 5 | 0 | 3 | 8 | 2.3 | 4 | 3 | 0 |
| 14 | `src/state.ts` | 36 | 56 | 4 | 0 | 11 | 15 | 2.4 | 10 | 5 | 0 |
| 15 | `src/write-proxy/mode.ts` | 81 | 140 | 9 | 1 | 23 | 33 | 2.5 | 3 | 1 | 3 |
| 16 | `src/studio/restarts.ts` | 36 | 80 | 5 | 3 | 7 | 14 | 2.6 | 5 | 2 | 1 |
| 17 | `src/studio/harvest-record.ts` | 17 | 65 | 4 | 0 | 2 | 6 | 2.8 | 1 | 1 | 0 |
| 18 | `src/studio/paste.ts` | 26 | 104 | 4 | 2 | 4 | 9 | 2.9 | 2 | 1 | 1 |
| 19 | `src/studio/frames.ts` | 24 | 49 | 3 | 1 | 4 | 8 | 3 | 2 | 1 | 1 |
| 20 | `src/studio/task-state.ts` | 24 | 82 | 1 | 3 | 5 | 8 | 3 | 1 | 1 | 0 |
| 21 | `src/studio/accounts.ts` | 315 | 1013 | 25 | 6 | 73 | 101 | 3.1 | 7 | 8 | 5 |
| 22 | `src/events/rules.ts` | 23 | 47 | 3 | 1 | 3 | 7 | 3.3 | 1 | 1 | 1 |
| 23 | `src/board/types.ts` | 95 | 310 | 15 | 11 | 7 | 28 | 3.4 | 20 | 19 | 0 |
| 24 | `src/junior/authz.ts` | 80 | 158 | 5 | 1 | 17 | 23 | 3.5 | 3 | 6 | 1 |
| 25 | `src/write-proxy/studio-auth.ts` | 21 | 36 | 2 | 0 | 4 | 6 | 3.5 | 2 | 0 | 0 |
| 26 | `src/studio/container-watch.ts` | 40 | 73 | 4 | 0 | 7 | 11 | 3.6 | 2 | 1 | 0 |
| 27 | `src/board/comment-wake.ts` | 77 | 248 | 8 | 0 | 13 | 21 | 3.7 | 2 | 1 | 1 |
| 28 | `src/github/api.ts` | 607 | 1190 | 40 | 5 | 118 | 161 | 3.8 | 10 | 2 | 3 |
| 29 | `src/studio/rpc-failure.ts` | 46 | 112 | 6 | 0 | 6 | 12 | 3.8 | 3 | 0 | 0 |
| 30 | `src/approvals/store.ts` | 112 | 129 | 6 | 3 | 21 | 29 | 3.9 | 3 | 4 | 0 |
| 31 | `src/agents/registry.ts` | 28 | 45 | 3 | 2 | 3 | 7 | 4 | 7 | 0 | 0 |
| 32 | `src/junior/gate.ts` | 24 | 50 | 3 | 1 | 2 | 6 | 4 | 3 | 2 | 0 |
| 33 | `src/write-proxy/container-config.ts` | 24 | 47 | 3 | 0 | 3 | 6 | 4 | 3 | 4 | 0 |
| 34 | `src/studio/page.ts` | 8 | 32 | 1 | 0 | 1 | 2 | 4 | 1 | 0 | 0 |
| 35 | `src/studio/sweep.ts` | 52 | 101 | 6 | 3 | 5 | 13 | 4 | 1 | 1 | 2 |
| 36 | `src/studio/ids.ts` | 53 | 180 | 5 | 2 | 7 | 13 | 4.1 | 17 | 1 | 0 |
| 37 | `src/studio/observed.ts` | 231 | 1114 | 23 | 8 | 29 | 56 | 4.1 | 15 | 27 | 10 |
| 38 | `src/studio/org.ts` | 171 | 420 | 14 | 3 | 24 | 40 | 4.3 | 2 | 17 | 9 |
| 39 | `src/tasks/types.ts` | 31 | 40 | 3 | 5 | 1 | 7 | 4.4 | 4 | 1 | 0 |
| 40 | `src/board/path-overlap.ts` | 40 | 86 | 3 | 1 | 5 | 9 | 4.4 | 1 | 1 | 0 |
| 41 | `src/memory/index-file.ts` | 90 | 191 | 10 | 1 | 8 | 19 | 4.7 | 4 | 4 | 1 |
| 42 | `src/directus/portal.ts` | 42 | 187 | 4 | 1 | 4 | 9 | 4.7 | 0 | 1 | 4 |
| 43 | `src/studio/quiescence.ts` | 53 | 107 | 5 | 2 | 5 | 11 | 4.8 | 2 | 2 | 0 |
| 44 | `src/leak-gate.ts` | 112 | 189 | 15 | 1 | 7 | 23 | 4.9 | 5 | 7 | 4 |
| 45 | `src/directus/client.ts` | 157 | 335 | 12 | 1 | 19 | 32 | 4.9 | 1 | 2 | 9 |
| 46 | `scripts/english-check.ts` | 69 | 117 | 7 | 2 | 6 | 14 | 4.9 | 0 | 1 | 7 |
| 47 | `src/ops-repo.ts` | 10 | 25 | 1 | 0 | 1 | 2 | 5 | 3 | 1 | 0 |
| 48 | `src/github/auth.ts` | 136 | 447 | 10 | 2 | 15 | 26 | 5.2 | 10 | 1 | 2 |
| 49 | `src/telegram/api.ts` | 125 | 167 | 5 | 1 | 18 | 24 | 5.2 | 7 | 1 | 1 |
| 50 | `src/studio/member-alerts.ts` | 110 | 293 | 10 | 4 | 9 | 21 | 5.2 | 3 | 5 | 4 |
| 51 | `src/studio/install-cache.ts` | 561 | 2323 | 47 | 11 | 53 | 106 | 5.3 | 3 | 3 | 37 |
| 52 | `src/studio/registry.ts` | 164 | 418 | 8 | 1 | 21 | 30 | 5.5 | 10 | 17 | 2 |
| 53 | `src/junior/usage.ts` | 66 | 100 | 3 | 3 | 7 | 12 | 5.5 | 2 | 1 | 1 |
| 54 | `src/agents/do.ts` | 141 | 333 | 11 | 1 | 13 | 25 | 5.6 | 2 | 2 | 7 |
| 55 | `src/memory/specifics.ts` | 28 | 91 | 2 | 0 | 3 | 5 | 5.6 | 1 | 1 | 1 |
| 56 | `src/studio/sandbox-api.ts` | 171 | 730 | 15 | 6 | 12 | 30 | 5.7 | 2 | 10 | 5 |
| 57 | `src/studio/rate-limit.ts` | 191 | 375 | 14 | 5 | 16 | 33 | 5.8 | 8 | 3 | 0 |
| 58 | `src/board/api.ts` | 269 | 513 | 14 | 5 | 29 | 46 | 5.8 | 5 | 6 | 3 |
| 59 | `src/studio/rescue-gc.ts` | 52 | 78 | 4 | 3 | 3 | 9 | 5.8 | 3 | 1 | 1 |
| 60 | `src/deploy/targets.ts` | 24 | 31 | 1 | 1 | 2 | 4 | 6 | 2 | 2 | 0 |
| 61 | `src/github/mint-token-error.ts` | 6 | 25 | 1 | 0 | 0 | 1 | 6 | 2 | 1 | 0 |
| 62 | `src/studio/survival-delivery.ts` | 518 | 1502 | 25 | 6 | 58 | 86 | 6 | 1 | 2 | 17 |
| 63 | `src/junior/ratelimit.ts` | 49 | 136 | 3 | 2 | 4 | 8 | 6.1 | 1 | 1 | 2 |
| 64 | `src/studio/session-sync.ts` | 449 | 1229 | 34 | 8 | 35 | 73 | 6.2 | 8 | 25 | 18 |
| 65 | `src/studio/destroy.ts` | 251 | 499 | 5 | 3 | 33 | 40 | 6.3 | 1 | 10 | 4 |
| 66 | `src/studio/ff.ts` | 233 | 537 | 14 | 7 | 19 | 37 | 6.3 | 1 | 2 | 6 |
| 67 | `src/events/log.ts` | 45 | 57 | 2 | 0 | 5 | 7 | 6.4 | 6 | 9 | 1 |
| 68 | `src/board/board.ts` | 621 | 1299 | 22 | 8 | 69 | 95 | 6.5 | 10 | 11 | 4 |
| 69 | `src/board/assign-wake.ts` | 84 | 251 | 3 | 2 | 9 | 13 | 6.5 | 7 | 6 | 0 |
| 70 | `src/agents/runtime.ts` | 73 | 87 | 8 | 2 | 2 | 11 | 6.6 | 2 | 2 | 1 |
| 71 | `src/studio/grid.ts` | 47 | 160 | 3 | 2 | 3 | 7 | 6.7 | 1 | 3 | 1 |
| 72 | `src/studio/transcript.ts` | 296 | 1034 | 25 | 3 | 17 | 44 | 6.7 | 1 | 9 | 22 |
| 73 | `src/studio/inspect.ts` | 136 | 350 | 12 | 4 | 6 | 20 | 6.8 | 2 | 6 | 6 |
| 74 | `src/studio/do.ts` | 2844 | 8285 | 138 | 16 | 265 | 411 | 6.9 | 3 | 42 | 88 |
| 75 | `src/studio/provision.ts` | 1287 | 4041 | 73 | 11 | 99 | 178 | 7.2 | 9 | 55 | 27 |
| 76 | `src/github/wake-events.ts` | 108 | 283 | 7 | 1 | 7 | 15 | 7.2 | 3 | 1 | 2 |
| 77 | `src/board/close-action.ts` | 67 | 180 | 1 | 3 | 6 | 9 | 7.4 | 2 | 1 | 0 |
| 78 | `src/events/schema.ts` | 45 | 48 | 1 | 3 | 3 | 6 | 7.5 | 8 | 2 | 0 |
| 79 | `src/telegram/chunk.ts` | 30 | 48 | 2 | 0 | 2 | 4 | 7.5 | 1 | 1 | 0 |
| 80 | `src/board/leak.ts` | 56 | 77 | 3 | 2 | 3 | 7 | 8 | 4 | 4 | 0 |
| 81 | `src/studio/auth.ts` | 104 | 180 | 6 | 0 | 7 | 13 | 8 | 4 | 13 | 5 |
| 82 | `src/studio/repo.ts` | 145 | 372 | 6 | 4 | 10 | 18 | 8.1 | 10 | 1 | 0 |
| 83 | `src/studio/wake.ts` | 311 | 907 | 19 | 3 | 17 | 38 | 8.2 | 7 | 16 | 0 |
| 84 | `src/studio/claude-swap.ts` | 187 | 495 | 8 | 8 | 10 | 22 | 8.5 | 3 | 3 | 4 |
| 85 | `src/board/pr-landed.ts` | 60 | 166 | 2 | 1 | 4 | 7 | 8.6 | 2 | 1 | 1 |
| 86 | `src/write-proxy/pktline.ts` | 120 | 136 | 7 | 1 | 6 | 14 | 8.6 | 1 | 2 | 3 |
| 87 | `src/studio/spawn.ts` | 278 | 721 | 13 | 4 | 17 | 32 | 8.7 | 5 | 12 | 3 |
| 88 | `src/directus/schema-apply.ts` | 150 | 269 | 6 | 3 | 9 | 17 | 8.8 | 1 | 1 | 5 |
| 89 | `src/studio/activity.ts` | 241 | 770 | 11 | 4 | 14 | 27 | 8.9 | 6 | 5 | 1 |
| 90 | `src/github/app.ts` | 89 | 187 | 4 | 1 | 5 | 10 | 8.9 | 2 | 1 | 0 |
| 91 | `src/studio/memguard-log.ts` | 36 | 79 | 1 | 3 | 1 | 4 | 9 | 3 | 2 | 0 |
| 92 | `src/deploy/do.ts` | 181 | 293 | 6 | 6 | 11 | 20 | 9.1 | 3 | 2 | 2 |
| 93 | `src/board/verify.ts` | 177 | 351 | 5 | 5 | 11 | 19 | 9.3 | 3 | 2 | 2 |
| 94 | `src/write-proxy/gh-route.ts` | 149 | 189 | 6 | 3 | 8 | 16 | 9.3 | 2 | 1 | 3 |
| 95 | `src/studio/studio-blueprint.ts` | 150 | 330 | 5 | 3 | 9 | 16 | 9.4 | 1 | 6 | 1 |
| 96 | `src/studio/redact.ts` | 19 | 73 | 1 | 0 | 1 | 2 | 9.5 | 13 | 6 | 0 |
| 97 | `src/studio/blueprint.ts` | 313 | 757 | 13 | 2 | 19 | 33 | 9.5 | 4 | 8 | 1 |
| 98 | `src/exceptions.ts` | 115 | 326 | 4 | 0 | 8 | 12 | 9.6 | 2 | 2 | 2 |
| 99 | `src/studio/rescue.ts` | 699 | 2644 | 27 | 3 | 43 | 72 | 9.7 | 4 | 9 | 8 |
| 100 | `src/studio/terminal.ts` | 136 | 381 | 8 | 1 | 5 | 14 | 9.7 | 2 | 4 | 1 |
| 101 | `src/directus/card.ts` | 98 | 241 | 5 | 1 | 4 | 10 | 9.8 | 1 | 2 | 4 |
| 102 | `src/github/promote-close.ts` | 199 | 399 | 6 | 6 | 11 | 20 | 9.9 | 2 | 2 | 2 |
| 103 | `src/studio/gh-wrapper.ts` | 153 | 216 | 10 | 0 | 5 | 15 | 10.2 | 2 | 2 | 3 |
| 104 | `src/studio/failover.ts` | 1008 | 3122 | 44 | 6 | 42 | 89 | 11.3 | 6 | 22 | 14 |
| 105 | `src/memory/compact.ts` | 271 | 449 | 7 | 11 | 11 | 24 | 11.3 | 1 | 1 | 4 |
| 106 | `src/board/brief.ts` | 140 | 247 | 6 | 2 | 5 | 12 | 11.7 | 2 | 1 | 1 |
| 107 | `src/write-proxy/git-worker.ts` | 35 | 46 | 1 | 0 | 2 | 3 | 11.7 | 1 | 0 | 0 |
| 108 | `src/memory/prompt.ts` | 36 | 73 | 2 | 0 | 1 | 3 | 12 | 1 | 1 | 1 |
| 109 | `scripts/sensors/run.ts` | 197 | 354 | 4 | 6 | 9 | 16 | 12.3 | 0 | 1 | 4 |
| 110 | `src/directus/types.ts` | 75 | 149 | 0 | 12 | 0 | 6 | 12.5 | 3 | 3 | 0 |
| 111 | `scripts/test-lies-check.ts` | 355 | 527 | 9 | 3 | 16 | 27 | 13.1 | 0 | 1 | 8 |
| 112 | `src/directus/schema.ts` | 170 | 324 | 10 | 3 | 0 | 12 | 14.2 | 3 | 3 | 5 |
| 113 | `src/write-proxy/git-route.ts` | 184 | 239 | 5 | 1 | 7 | 13 | 14.2 | 2 | 2 | 1 |
| 114 | `src/board/routes.ts` | 614 | 1160 | 10 | 6 | 30 | 43 | 14.3 | 7 | 4 | 1 |
| 115 | `src/junior/route.ts` | 153 | 274 | 3 | 0 | 7 | 10 | 15.3 | 1 | 2 | 2 |
| 116 | `src/studio/burn.ts` | 819 | 2105 | 22 | 7 | 27 | 53 | 15.5 | 5 | 9 | 9 |
| 117 | `scripts/localci/summarize.ts` | 238 | 304 | 5 | 5 | 6 | 14 | 17 | 0 | 1 | 5 |
| 118 | `src/memory/routes.ts` | 138 | 234 | 3 | 1 | 4 | 8 | 17.3 | 1 | 2 | 2 |
| 119 | `src/approvals/gates.ts` | 139 | 231 | 2 | 2 | 5 | 8 | 17.4 | 1 | 1 | 0 |
| 120 | `src/board/envelope.ts` | 242 | 376 | 6 | 1 | 6 | 13 | 18.6 | 3 | 7 | 2 |
| 121 | `src/studio/credentials.ts` | 461 | 979 | 19 | 0 | 5 | 24 | 19.2 | 4 | 11 | 12 |
| 122 | `src/studio/onboard.ts` | 130 | 219 | 2 | 3 | 2 | 6 | 21.7 | 1 | 1 | 1 |
| 123 | `src/index.ts` | 114 | 228 | 5 | 0 | 0 | 5 | 22.8 | 0 | 4 | 1 |
| 124 | `src/studio/retro-template.ts` | 24 | 40 | 1 | 0 | 0 | 1 | 24 | 1 | 1 | 0 |
| 125 | `src/write-proxy/scan-push.ts` | 73 | 89 | 1 | 0 | 2 | 3 | 24.3 | 1 | 1 | 0 |
| 126 | `src/studio/types.ts` | 74 | 832 | 0 | 6 | 0 | 3 | 24.7 | 33 | 74 | 0 |
| 127 | `scripts/merge-danger.ts` | 100 | 141 | 2 | 2 | 1 | 4 | 25 | 0 | 1 | 2 |
| 128 | `src/studio/task-reap.ts` | 126 | 209 | 1 | 4 | 2 | 5 | 25.2 | 2 | 1 | 0 |
| 129 | `src/studio/survival-brief.ts` | 266 | 858 | 5 | 5 | 2 | 10 | 26.6 | 1 | 3 | 2 |
| 130 | `src/write-proxy/inflate.ts` | 159 | 178 | 2 | 0 | 3 | 5 | 31.8 | 1 | 2 | 1 |
| 131 | `src/studio/routes.ts` | 550 | 1383 | 3 | 3 | 12 | 17 | 32.4 | 1 | 11 | 1 |
| 132 | `src/write-proxy/pack.ts` | 164 | 181 | 2 | 2 | 2 | 5 | 32.8 | 2 | 1 | 1 |
| 133 | `src/github/webhook.ts` | 307 | 679 | 2 | 0 | 7 | 9 | 34.1 | 1 | 2 | 1 |
| 134 | `src/tasks/loop.ts` | 184 | 240 | 1 | 3 | 2 | 5 | 36.8 | 4 | 4 | 0 |
| 135 | `src/telegram/webhook.ts` | 149 | 210 | 1 | 0 | 3 | 4 | 37.3 | 1 | 3 | 0 |
| 136 | `src/env.ts` | 56 | 371 | 0 | 1 | 0 | 1 | 56 | 24 | 43 | 0 |
| 137 | `src/studio/cli-args.ts` | 586 | 1007 | 5 | 3 | 2 | 9 | 65.1 | 2 | 2 | 2 |

Entrypoint scripts (no exports, depth n/a): `scripts/build-page.ts` (59 LOC), `scripts/deploy-containers-changed.ts` (146 LOC), `scripts/deploy-target.ts` (144 LOC), `scripts/directus-schema.ts` (51 LOC).

**Reading notes:**

- Shallow by number but fine by deletion test: `studio/types.ts`, `board/types.ts`, `env.ts`, `github/reach.ts` (type/vocab modules, high fan-in, nothing to hide). `state.ts` (depth 2.4) passes deletion test: 10 importers would each repeat `fleet_state` SQL, `incrementCounter` holds a real atomicity fix.
- Deep by number but shallow by leverage: `studio/do.ts` depth 6.9 hides a 138-value interface, 88 of them test-only; 41 test files import it. Size masks breadth.
- `studio/archive.ts` (20 values, 45 LOC) = constant registry for R2 key layout; see F-deferred.

## 3. Ranked findings

Rank = leverage + locality gained per line changed, weighted to hot spots and to observed drift (ICA §1). Every finding: behavior-preserving, two-way door (code-only, revertable) unless stated, one small PR.

**CLAUDE-ONLY** = touches rescue, failover, deploy, auth, secrets, crypto, payments, migrations, or admission (#259 Part C + brief). GLM never takes these. **GLM-OK** = none of those.

Summary:

| # | finding | lane | strength | size |
|--:|---|---|---|---|
| 1 | operation lock → `withOperation` | CLAUDE-ONLY | Strong | ~150 L |
| 2 | rescue-ref grammar → `RescueRef` | CLAUDE-ONLY | Strong | ~120 L |
| 3 | studio wake gate → `wakeStudioFor` | GLM-OK | Strong | ~120 L |
| 4 | teardown → `evacuate` | CLAUDE-ONLY | Strong | ~250 L |
| 5 | GitHub existence checks + error type → one request fn | GLM-OK | Strong | ~120 L |
| 6 | rescue exec protocol → `rescue(exec, target, mode)` | CLAUDE-ONLY | Strong | ~150 L |
| 7 | refusals → tagged `Refusal` | CLAUDE-ONLY | Worth exploring | ~120 L |
| 8 | launch-account bring-up → `bringUpOnAccount` | CLAUDE-ONLY | Worth exploring | ~200 L |
| 9 | bring-up observation → `observeBringup` | CLAUDE-ONLY | Worth exploring | ~180 L |
| 10 | org TTL cache → injected `createRefCache(clock)` | GLM-OK | Strong | ~100 L |
| 11 | JWKS cache → same `createRefCache` | CLAUDE-ONLY | Worth exploring | ~80 L |
| 12 | account load stores → one read port | CLAUDE-ONLY | Worth exploring | ~200 L |
| 13 | readiness record closure → `this.recordFn()` everywhere | CLAUDE-ONLY | Worth exploring | ~60 L |
| 14 | close-outcome shim → delete via narrow port | GLM-OK | Worth exploring | ~40 L |
| 15 | transcript internals → test through interface | GLM-OK | Worth exploring | ~200 L (tests) |

Line refs = physical lines at `origin/main` `cc9a9a4`.

### F1. Deepen operation lock: hide `OPERATION_KEY`, freshness rule, acquire/clear-in-finally behind `withOperation(storage, op, fn)` + `operationInFlight(storage)` — CLAUDE-ONLY (failover, deploy, admission)

- **Files:** `src/studio/provision.ts:800-809` (`operationLockFresh`), `:3803-3804`/`:3875`, `:4001-4002`/`:4022`; `src/studio/failover.ts:3063-3064`/`:3106`, `:2270`, `:2367`; `src/studio/do.ts:1777`/`:1952`, raw reads `:2091`, `:2116`, `:2806-2807`, `:3559`, `:3670`, `:4796`, `:4965`, `:5092`, `:5266`, `:5361`; `src/studio/container-watch.ts:43`.
- **Problem:** lock = key + predicate; ~20 callers re-implement "only outermost holder clears". Drift already visible: `since` stored as number (provision) vs ISO string (failover, recycle); recycle (`do.ts:1777`) puts lock unconditionally and always clears (`:1952`) — can release another op's lock; `do.ts:3670` judges op freshness with `destroyingMarkerFresh`.
- **Solution:** one module owns key, freshness, re-entrancy. Callers pass a fn.
- **Benefits:** locality — lock rule in one place; leverage — 3 acquire sites + ~12 read sites shrink to one call; tests stop seeding raw `OPERATION_KEY`.
- **Deletion test:** concentrates (CD Principles). **Dependency:** in-process, DO storage (local-substitutable).
- **Behavior-preserving rule:** keep recycle's unconditional semantics and both `since` encodings readable in PR 1; any fix to recycle drift = separate, decided issue. Persisted `since` shape → reader must accept both forever (one-way on stored data; code itself two-way).
- **Characterization tests first:** nested provision-inside-failover keeps outer lock; recycle clears lock after throw; stale lock (> freshness window) treated as absent — for each acquire site. Existing: `studio.start-gate`, `studio.failover-274`, `studio.observation(-tick)`, `studio.self-heal`, `studio.recycle-guard`, `studio.container-watch`, `cli.recycle-outcome`.
- **Skill step:** ICA §1 (repeated sequence, tight coupling leaking across seam) + CD deletion test. **Strength:** Strong.

### F2. Deepen rescue-ref naming: hide `fleet/rescue/<studio>…` grammar (format, parse, stamp, wip test, shell grep pattern) behind one `RescueRef` module — CLAUDE-ONLY (rescue)

- **Files:** producer shell `src/studio/rescue.ts:351`, `:982`, `:987`, `:2206` (`wipSyncRef`); shell grep `src/studio/provision.ts:1026-1040` (`discoverRescueRefsCmd`); TS matchers `src/studio/survival-delivery.ts:247-500` (`rescueBranchPrefix`, `isRescueBranchFor`, `rescueRefStamp`, `isWipRescueRef`, `parseRescueStamp`); GC filter `src/board/routes.ts:327`.
- **Problem:** one grammar, four homes, kept in sync by comments ("byte-identical", `survival-delivery.ts:248`, `:292` records one past break).
- **Solution:** pure module exports `format`, `parse`, `shellGlob`; all four sites import it.
- **Benefits:** locality — grammar change = one file; leverage — survival, GC, discovery share one parser.
- **Dependency:** in-process (pure). **Two-way door:** yes, if produced strings stay byte-identical (ref names already exist on remotes).
- **Characterization tests first:** golden table of ref names → parse result; `shellGlob` vs TS `parse` agree on same table (run shell grep in bun test). Existing heavy users: `studio.survival-delivery.test.ts`, `studio.provision.test.ts`.
- **Skill step:** ICA §1 ("understanding one concept requires bouncing between many small modules"). **Strength:** Strong.

### F3. Deepen studio wake gate: hide registry lookup, stopped check, repo match, RPC error mapping behind `wakeStudioFor(deps, studioId, task, digest)` — GLM-OK

- **Files:** `src/board/assign-wake.ts:215-251` (`wakeOnAssign`), `src/board/comment-wake.ts:201-248` (`wakeOnComment`); deps wiring duplicated `src/board/routes.ts:475-497` and `src/github/webhook.ts:258-269`; cross-step import `src/board/assign-wake.ts:29` from `src/github/wake-events.ts`.
- **Problem:** same 5-step dance twice (read state w/ try-catch → no row → stopped → repo match → wake → non-ok outcome); only message + digest differ. Deps literal copied (webhook copy's comment points at routes copy).
- **Solution:** one gate fn + one `realWakeDeps(env)` factory; the two wrappers become message builders.
- **Benefits:** locality — gate bug fixed once; ~100 lines gone.
- **Deletion test:** each wrapper fails alone; shared gate concentrates. **Dependency:** local-substitutable (D1 registry, DO stub).
- **Characterization tests first:** `board.assign-wake.test.ts` + `board.comment-wake.test.ts` already use `AssignWakeDeps` fakes — add cases: no row, stopped, repo mismatch, wake throws, wake non-ok → same outcome strings for both entry points. Then move to gate tests (CD "replace, don't layer").
- **Must not touch:** `webhook.ts` `verifySignature` region. Edit only lines 258-269 wiring.
- **Skill step:** ICA §1 (repeated sequence) + CD deletion test. **Strength:** Strong.

### F4. Deepen teardown: hide probe, session sync, force-stamp clear, aside ship, rescue push + refusal mapping, done-record archive, harvest behind `evacuate(studio, guard) → EvacuationReport | Refusal` — CLAUDE-ONLY (rescue)

- **Files:** `src/studio/destroy.ts:197-329`; `src/studio/do.ts:1645-1770` (recycle copy), `:555-562` (`restartWithSync` first 3 steps); shared cast `destroy.ts:311` / `do.ts:1757`.
- **Problem:** 7-step sequence written twice, drifted: recycle keeps `rescue.worktrees` in report (`do.ts:1719`, `:1734`), destroy drops it; harvest-lost noted on row in destroy (`destroy.ts:318-321`), only counted in recycle (`do.ts:1764`); twin refusal-message sets.
- **Solution:** one `evacuate` with a guard arg; destroy/recycle keep only what differs (epoch bump, reprovision).
- **Behavior-preserving rule:** PR keeps both drifts as explicit options (`keepWorktrees`, `harvestNote`) — unify later by decision. Destroy-epoch bump stays between rescue refusal and archive (`destroy.ts:304`).
- **Dependency:** local-substitutable (exec, R2, GitHub ports via `SessionSyncDeps`).
- **Characterization tests first:** for both verbs — dead container, live clean, live dirty + push ok, push refused, archive fail, harvest fail → snapshot reports + refusal text. Existing: `studio.destroy`, `studio.recycle-guard`, `studio.destroy-race`, `studio.replacement`, `cli.destroy-outcome`.
- **Skill step:** ICA §1 (repeated sequence) + CD Locality. **Strength:** Strong.

### F5. Deepen GitHub REST access in `github/api.ts`: hide headers, 404→false, error status behind one `ghRequest` + `exists(token, path)` throwing `GitHubError` — GLM-OK

- **Files:** six copy-pasted existence checks `src/github/api.ts:514-522`, `:583-591`, `:601-609`, `:624-632`, `:642-650`, `:659-668`; inline headers `:28-33`, `:96`, `:177`, `:199`, `:247`, `:1027`; plain `Error` throws `:41`, `:104`, `:184`, `:205`, `:253`, `:293`; twin client `src/board/api.ts:20-97` (`GitHubError` `:58-63`); `USER_AGENT` ×3 (`board/api.ts:26`, `github/api.ts:8`, `github/app.ts:71`).
- **Problem:** two GitHub HTTP clients with different error types. `upstreamFailure` (`src/board/routes.ts:824-832`) maps only `GitHubError` 404 → 404; board methods backed by `github/api.ts` (e.g. `closeIssue`, `routes.ts:94`) throw plain `Error` → 502 on a real 404. Observation, not a fix — see rule below.
- **Solution (this PR):** inside `github/api.ts` only: one private request fn (headers, user agent, status check) + one `exists`. Six checks become one-liners. Same thrown message text.
- **Behavior-preserving rule:** keep plain `Error` + messages in PR 1. Switching to `GitHubError` changes 502→404 at `/board` → separate issue, needs decision + test.
- **Not in this PR (CLAUDE-ONLY follow-up):** repo-bound client absorbing token mint (`board/routes.ts:78-96` forwarders, `memory/routes.ts:88-105`, `write-proxy/gh-route.ts:170-189`) — auth/secrets.
- **Dependency:** true external (GitHub) — tests mock `fetch` already.
- **Characterization tests first:** per existence fn: 200→true, 404→false, 500→throws same message. `github.api.test.ts` covers most; add missing.
- **Skill step:** ICA §1 (shallow module, interface ≈ implementation) + CD deletion test (six fns vanish into one). **Strength:** Strong.

### F6. Deepen rescue exec protocol: hide `*Cmd` builders (9-11 positional params), sentinels, `parseRescueExecResult` behind `rescue(exec, target, mode: "push" | "snapshot" | "wip") → RescueResult` — CLAUDE-ONLY (rescue, secrets)

- **Files:** builders `src/studio/rescue.ts:889-900` (`rescuePushCmd`), `:1616-1622` (`rescueSnapshotCmd`), `:2364-2370` (`wipSyncCmd`); sentinels produced `rescue.ts:688-717`, parsed in `src/studio/do.ts:1006`; pass-through wrappers `do.ts:689`, `:712`, `:762`; re-exports `do.ts:574-583`.
- **Problem:** caller must pair builder + exec + parser across two files; positional `undefined` padding (`do.ts:690`, `:713`); protocol knowledge split (producer in rescue.ts, parser in do.ts).
- **Solution:** rescue.ts owns build + run + parse; do.ts wrappers deleted.
- **Dependency:** local-substitutable (container exec port).
- **Characterization tests first:** fake exec returning each sentinel (clean, pushed, refused, timeout) → `RescueResult`. Then retire exact-string tests `studio.session.test.ts:3136-3255` (`toEqual([rescuePushCmd(...)])`) per CD "replace, don't layer"; keep `bun/` shell-syntax tests that run the real script.
- **Skill step:** ICA §1 ("pure functions extracted for testability, real bugs in how they're called") + CD deletion test (do.ts wrappers = pass-through). **Strength:** Strong.

### F7. Deepen refusals: hide five string prefixes + per-verb prefix matching behind one tagged `Refusal` error + `refusalResponse(err)` — CLAUDE-ONLY (admission, rescue)

- **Files:** prefixes `src/studio/accounts.ts:842`, `src/studio/rpc-failure.ts:32`, `src/studio/recycle-cost.ts:57`, `src/studio/provision.ts:604`, `src/studio/destroy.ts:59`; re-exports `src/studio/do.ts:72`, `:77`, `:120`; matching `src/studio/routes.ts:1161-1166`, `:1261-1274`; strip `rpc-failure.ts:79-86`; destroy uses `{ok, reason}` instead (`routes.ts:1310`).
- **Problem:** refusal kind travels as message prefix over DO RPC; each verb matches prefixes in its own order; `routes.ts:1265-1269` documents one past bug from this.
- **Solution:** `Refusal { kind, message }` serialized once at RPC seam, one mapper to HTTP.
- **Two-way door:** keep wire text identical (CLI parses it — `apps/fleet/cli`), so code-only change.
- **Dependency:** in-process; crosses DO RPC as text.
- **Characterization tests first:** per verb × refusal kind → HTTP status + body. Existing assert prefixes: `studio.routes`, `studio.recycle-guard`, `studio.destroy`, `studio.fresh-session`, `studio.account-gate-do`.
- **Skill step:** ICA §1 (leak across seam) + CD Interface (error modes are interface). **Strength:** Worth exploring.

### F8. Deepen launch-account bring-up: hide resolve → env fields → decide → await-ready → apply clears behind `bringUpOnAccount(id, spawnToken, ctx)` — CLAUDE-ONLY (failover, secrets, admission)

- **Files:** three copies in `src/studio/do.ts:7014-7058` (provision), `:7279-7304` (restart), `:7585-7607` (recycle); 8 helpers exported for tests only `do.ts:3731-4307`.
- **Problem:** shallow siblings callers must sequence; order enforced by grepping source: `test/studio.account-launched.test.ts:141-263` (regex/`indexOf` on `TEST_STUDIO_DO_SRC`), `test/studio.exec-deadlines.test.ts:279` pins literal `if (!this.ctx.container?.running) await sbAwaitReady(this);`; `do.ts:7032-7044` keeps a redundant guard only to satisfy that grep.
- **Solution:** one sequenced fn; three call sites one line each.
- **Dependency:** in-process + DO storage (local-substitutable).
- **Characterization tests first (blocking):** behavioral tests for each verb — recorded account limited → reroute; other-repo primary → clears applied after ready; container not running → await ready before apply. Only then delete source-grep tests (CD "interface is test surface").
- **Skill step:** ICA §1 (shallow siblings; untested-through-interface) + CD "replace, don't layer". **Strength:** Worth exploring (do after F1).

### F9. Deepen bring-up observation: hide cmd build → exec → parse → `answered`/`tokenWritten` bookkeeping → probe-result fallback behind `observeBringup(exec, storage, ctx)` — CLAUDE-ONLY (failover, deploy)

- **Files:** `src/studio/provision.ts:3473-3490` (+ verdict/merge `:3496-3654`), `src/studio/failover.ts:3066-3104`; incarnation shell write ×3 `src/studio/observed.ts:759-760`, `:1102`, `src/studio/transcript.ts:403-404`; read ×2 `transcript.ts:395`, `:397`, `src/studio/inspect.ts:172`; unused helper `observed.ts:777` (`readFileLineCmd`).
- **Problem:** same dance twice, identical catch literal; `writeIncarnationCmd` + `readFileLineCmd` imported only by tests (`test/bun/cmd-syntax`, `test/bun/incarnation-newline`) → tests prove helpers prod doesn't call.
- **Solution:** one fn in `observed.ts`; inline shell fragments route through the two helpers (or helpers deleted).
- **Dependency:** in-process + container exec (local-substitutable).
- **Characterization tests first:** fake exec: answered, token written, exec throws → same `PaneProbeResult` from both callers. Existing: `studio.observed`, `studio.replacement`, `studio.destroy-race`, `bun/pane-probe-lead`, `bun/bringup-claude-relaunch`.
- **Skill step:** ICA §1 (repeated sequence) + CD deletion test. **Strength:** Worth exploring.

### F10. Deepen org config fetch: hide hand-rolled TTL / stale-on-error / backoff maps and `__reset`/`__seed` test hooks behind existing `createRefCache` with injected clock — GLM-OK

- **Files:** `src/studio/org.ts:149-272` (`fetchOrgCached` `:217`, hand-rolled cache), `:321-375` (`createRefCache`, already generic), `:377` (its one user); test hooks `org.ts:254-272`, `:358-374` (inside `createRefCache` too), `:408-420`.
- **Problem:** same cache logic twice in one file; test seams (`__resetOrgCacheForTests`, `__seedOrgCacheForTests`, `__seedOrgFailureForTests`, …) leak through interface; tests fake time by back-dating entries.
- **Solution:** `fetchOrgCached` built on `createRefCache({ now, ttl, retry })`; tests construct own instance → hooks deleted.
- **Dependency:** true external (GitHub contents) behind injected fetcher.
- **Characterization tests first:** fresh hit, TTL expiry refetch, upstream error serves stale, never-succeeded backoff — via injected `now`. Users: `studio.org`, `studio.spawn`, `studio.fleet-resume`.
- **Skill step:** CD Principles ("internal seams … don't expose through interface") + CD "Designing for testability" (accept dependencies). **Strength:** Strong.

### F11. Deepen Access JWKS cache: same as F10 for `studio/auth.ts` — CLAUDE-ONLY (auth, crypto)

- **Files:** `src/studio/auth.ts:12-125` (third hand-rolled cache + max-stale cap), hooks `:108-122` (`__resetJwksCacheForTests`, `__seedJwksCacheForTests`).
- **Problem / solution:** as F10; add `maxStaleMs` option to `createRefCache`. Ships after F10.
- **Characterization tests first:** key rotation refetch, max-stale exceeded → reject, upstream error within max-stale → accept. Existing: `studio.auth`.
- **Skill step:** as F10. **Strength:** Worth exploring.

### F12. Deepen account load reads: hide `account-limits-store`, `account-usage-store`, burn read, fail-open warning behind one `readAccountLoad(env, accounts) → {limits, usage, burn}` — CLAUDE-ONLY (failover, admission)

- **Files:** `src/studio/account-limits-store.ts` (91 lines), `src/studio/account-usage-store.ts` (64 lines) — near-identical D1 wrappers; burn read `src/studio/do.ts:3788`; fail-open dance `do.ts:4224-4245`, `src/studio/registry.ts:397-403`, `src/studio/routes.ts:450-451` (no catch), `src/studio/failover.ts:2582-2597`; `failoverDeps` `do.ts:6698-6735` (three ports, each re-resolving accounts); 9-positional `launchAccountOrReroute` `src/studio/accounts.ts:956-962`.
- **Problem:** stores fail deletion test (one `getFlag` + decode each); registry skips burn ordering (`registry.ts:286-303`) so displayed "next account" can differ from real pick.
- **Solution (this PR):** merge two stores + burn into one read port with one fail-open policy. NOT the full picker (cascade dedupe `accounts.ts:965-984` vs `failover.ts:2561-2690` = later, larger issue).
- **Behavior-preserving rule:** keep `routes.ts:450` throwing (no catch) as today; registry keeps skipping burn. Note both as decisions for follow-up.
- **Dependency:** local-substitutable (D1 via `state.ts`; tests fake it).
- **Characterization tests first:** empty store, malformed row, D1 throw → fail-open shape per caller. Existing: `account-limits-store.test`, `account-usage-store.test`, `studio.registry`, `studio.account-failover`.
- **Skill step:** ICA §1 (bouncing between small modules) + CD deletion test. **Strength:** Worth exploring.

### F13. Deepen readiness record: route 11 inline copies of record closure through existing `this.recordFn()` — CLAUDE-ONLY (deploy)

- **Files:** `src/studio/do.ts:6824` (`recordFn`), inline copies incl. `:5762`, `:6504`, `:6857`, `:8227` (11 total); six readiness entry points `:2067`, `:2387`, `:2420`, `:2876`, `:3034`, `:3107` (two near-identical bodies `:3034`/`:3107`); missing ctx `:3265`.
- **Problem:** readiness concept real, wrappers pass-through; first, smallest step = one closure.
- **Solution (this PR):** replace inline closures with `this.recordFn()`. Merge `provisionWithFreshVerdict`/`restartWithFreshVerdict` = follow-up issue.
- **Dependency:** in-process.
- **Characterization tests first:** readiness persisted identically after provision, restart, recycle, heal. Existing: `studio.readiness`, `studio.self-heal`, `studio.start-gate-writeback`.
- **Skill step:** ICA §1 (shallow wrappers) + CD deletion test. **Strength:** Worth exploring.

### F14. Deepen close action: delete `board/close-outcome.ts` shim by narrowing `close-action.ts`'s `Env` to a D1 port — GLM-OK

- **Files:** `src/board/close-outcome.ts:1-14` (type-only, exists because `src/board/close-action.ts:11` imports `Env`, dragging DO types into CLI tsconfig); `Env` used only for `env.DB` (`close-action.ts:114`, `:178`).
- **Problem:** file split by build constraint, not knowledge (ICA §1 "files split by step"). Depth 1.0 in table.
- **Solution:** `close-action.ts` takes `{ DB: D1Database }`; type moves home; `src/studio/task-reap.ts` import switches; shim deleted. Larger follow-up (move auto-close orchestration out of `src/github/webhook.ts:306-523`) stays separate — webhook.ts holds signature verification.
- **Dependency:** local-substitutable (D1).
- **Characterization tests first:** none new needed — type-only move; `board.close-action.test.ts` + `cli` typecheck (`apps/fleet/cli/tsconfig.json`) must pass.
- **Skill step:** CD deletion test (pure overhead). **Strength:** Worth exploring.

### F15. Deepen transcript: move 22 test-only exports behind interface — test via `transcript.ts`'s production entry points — GLM-OK

- **Files:** `src/studio/transcript.ts` (25 exported values, 22 test-only: `TRANSCRIPT_*_PATH`, `TRANSCRIPT_*_KEY`, `SECTION_*`, `parse*`, `decodeTailPreview`); tests `test/studio.transcript.test.ts` (9 shell-string asserts).
- **Problem:** interface 3× wider than production needs; tests pin internals, so any internal refactor breaks them (CD DEEPENING "If a test has to change when implementation changes, it's testing past the interface").
- **Solution:** characterization tests through production entry points with fake exec + storage; then un-export internals.
- **Dependency:** in-process + exec (local-substitutable).
- **Characterization tests first:** this PR IS the characterization tests + un-export. No prod logic change.
- **Note:** incarnation fragments `transcript.ts:395-404` overlap F9 — land F15 first or coordinate.
- **Skill step:** CD "interface is test surface" + DEEPENING "replace, don't layer". **Strength:** Worth exploring.

### Deferred / not ranked (ICA §2: surfaced, not top-15)

- **Session archive (`archive.ts` + `session-sync.ts` + `provision.ts:2175-2226` restore):** split by step (save vs restore vs key layout). Real, but R2 key layout is persisted → one-way on data; data-loss risk. CLAUDE-ONLY (deploy). Needs design-it-twice (CD/DESIGN-IT-TWICE.md) first.
- **Full account picker (cascade twice: `accounts.ts:965-984`, `failover.ts:2561-2690`, comments record 2 drifts):** highest leverage overall, ~600-900 lines → too big for one PR. After F12. CLAUDE-ONLY.
- **Credential selection (`write-proxy/mode.ts`, `git-worker.ts:16-19`, `gh-route.ts:165-172`, `github/auth.ts:329-341`):** auth-kind branch repeated 4×; `test/studio.rescue-token.test.ts:32` asserts source text. CLAUDE-ONLY (auth, secrets). Needs security review.
- **Board assignment side effects in HTTP layer (`board/routes.ts:520-636`, `handleBoard` 8 positional params `:671-682`):** junior authorization single-call-site guarantee (`routes.ts:535-553`) must hold. CLAUDE-ONLY (admission).
- **`failover.ts` split by knowledge (screen grammar `:58-849` vs switch policy `:2133+`; pane-state keys `:1478-1498` parked there to break import cycle):** locality, not depth; after full picker. CLAUDE-ONLY.
- **Repo-slug env parsing ×3 (`ops-repo.ts:15-25`, `studio/rescue.ts:35-46`, `write-proxy/mode.ts:28-57`; `memory/store.ts:36-38` pure pass-through):** GLM-OK slice = `ops-repo.ts` + `memory/store.ts` only; rest CLAUDE-ONLY.
- **`install-cache.ts` (37 test-only exports, shell-substring asserts `test/install-cache.test.ts:452-591`):** same fix as F15 but `test/bun/install-cache-security.test.ts` depends on strings → CLAUDE-ONLY.
- **`do.ts` surface (138 values, 88 test-only, 41 importing test files):** not one finding. F1, F4, F6, F7, F8, F13 each remove a slice. Re-measure after.

## 4. Top recommendation

**F1 operation lock** (CLAUDE-ONLY) — smallest change with observed drift (recycle lock, mixed `since` encodings, wrong freshness fn), ~20 callers gain locality, and F4/F8/F9 all sit inside its lock. **GLM lane first pick: F3 wake gate** — clear duplicate, fakes already exist, no risk area.

## 5. Re-measure

Re-run metric (§1 definition) weekly per #259 Part D. Expected movement if F1-F15 land: test-only exports −120ish, modules depth < 4 −4, source-text test files −3.

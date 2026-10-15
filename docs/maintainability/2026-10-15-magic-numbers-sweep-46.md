# Unexplained magic numbers sweep 46 — apps/fleet src (2026-10-15)

Ref #908. Analysis only, read-only, no code changed. Forty-sixth maintainability
sweep; scope apps/fleet/src/**. Line refs = physical lines at origin/main
`5aa1c307`, paths relative to `apps/fleet/`.

Successor to sweep 14 (docs/maintainability/2026-10-12-magic-numbers-sweep-14.md,
which hunted DUPLICATED literals); this sweep hunts UNEXPLAINED ones — a bare
numeric literal in a timeout/limit/retry/size position with no named constant
at the site and no comment saying why that value.

Method: grep for numeric literals in budget positions (setTimeout/sleep
arguments, per_page/limit/keep/window signature defaults, Math.min/max caps,
timeout maps), then hand-verify every candidate against its surrounding code.

**Ruled out (value explained by comment or named constant):** EXEC_CLASSES
(src/studio/sandbox-api.ts:160-170) and TICK_DEADLINES_MS
(src/studio/do.ts:3699-3704) — every value explained by the comment table
directly above each; src/studio/install-cache.ts's flat 600s `--max-time` (:938, :1694,
:1702 — doc comments at :902-906 and :1630); github/api.ts
listOpenPullNumbers/listOpenPullFiles `per_page=100` (:585, :616 — comments
state the one-page-at-GitHub's-max posture); junior/route.ts:178's
64_000/128_000 (comment names the Global Constraint and the client sibling
cap); tasks/watchdog.ts:110's `attempts >= 2` (doc comment at :95-105 explains the
two-consecutive-failures threshold in full).

**Tier rule:** GLM-OK = none of auth, secrets, tokens, credentials, rescue,
failover, accounts routing, deploy, migrations, write-proxy, leak-gate,
approvals. CLAUDE-ONLY = touches any of those. Two findings are CLAUDE-ONLY;
they are documented here but no follow-up is filed for them (sweep 14's
precedent for that lane).

## Findings

| # | file:line | literal | controls | proposed constant |
|--:|---|---|---|---|
| F1 | src/llm/model-quality.ts:30 | `10` | PRs per model in quality stats | MODEL_STATS_WINDOW_PRS |
| F2 | src/llm/model-quality-cron.ts:101 | `"100"` | closed-PR fetch page size | CLOSED_PULLS_PAGE_SIZE |
| F3 | src/exceptions.ts:209 | `1000` | worker_exceptions row cap | EXCEPTIONS_KEEP_ROWS |
| F4 | src/directus/client.ts:292 | `50` | portal requests page size | REQUESTS_PAGE_LIMIT |
| F5 | src/llm/models.ts:21-23 | `16000`/`32000` | per-model max_tokens floor/ceiling | derive from GLM_MIN_MAX_TOKENS/GLM_MAX_MAX_TOKENS |
| F6 | src/github/api.ts:743 | `100` | pull-commits page size | PULL_COMMITS_PAGE_SIZE |
| F7 | src/github/app.ts:35 | `540` | App JWT lifetime | APP_JWT_LIFETIME_SECONDS — CLAUDE-ONLY |
| F8 | src/deploy/do.ts:281 | `1800` | deploy poll budget | DEPLOY_POLL_BUDGET_SECONDS — CLAUDE-ONLY |

### S46-F1. model-quality.ts — modelStats window default 10 — GLM-OK

- **File:** `src/llm/model-quality.ts:30` — `modelStats(outcomes: PrOutcome[], window = 10)`.
- **Controls:** how many most-recent closed PRs per model feed its quality
  stats (the `w` slice at :34 — prs, firstCiPassRate, bounces, reverts).
- **Evidence:** the file's three decision thresholds are named constants with
  doc comments (MIN_PRS = 5 at :26, GAP = 0.25 at :27, MAX_REVERTS = 2 at :28,
  each feeding shouldDemote at :47-53), but the window bounding those same
  stats is a bare default parameter with nothing at the site saying why 10.
  The only caller (model-quality-cron.ts:170) passes no window, so 10 is the
  live value.
- **Proposed constant:** `MODEL_STATS_WINDOW_PRS = 10`, doc comment citing the
  spec's Quality section (2026-10-13-model-pool-design) as the value's home.

### S46-F2. model-quality-cron.ts — closed-PR fetch page size — GLM-OK

- **File:** `src/llm/model-quality-cron.ts:101` — `per_page: "100"` inside
  collectOutcomes' URLSearchParams.
- **Controls:** page size of the one-page fetch of closed PRs whose outcomes
  feed the model pool's quality pass.
- **Evidence:** the sibling bound QUALITY_WINDOW_DAYS = 14 (:25) is a named
  constant with a doc comment; the page size is a bare string literal. The
  file has no comment on the fetch's page posture (contrast github/api.ts's
  listOpenPullNumbers, whose doc comment says "One page (GitHub's own maximum,
  100)"). More than 100 closed PRs in the 14-day window and the fetch silently
  truncates — exactly the silent-cap shape a named constant should own.
- **Proposed constant:** `CLOSED_PULLS_PAGE_SIZE = 100` with a
  one-page-at-GitHub's-max comment matching github/api.ts's posture docs.

### S46-F3. exceptions.ts — prune row cap default 1000 — GLM-OK

- **File:** `src/exceptions.ts:209` — `pruneWorkerExceptions(db: D1Database, keep: number = 1000)`.
- **Controls:** the row cap worker_exceptions is pruned to (the
  `DELETE ... OFFSET ?` boundary at :213-215).
- **Evidence:** every other bound in this file is a named constant with a
  why-comment (MAX_FIELD_CHARS :107, STACK_HEAD_MAX_LINES :26,
  INSERT_TIMEOUT_MS :147, RATE_CAP_PER_WINDOW/RATE_WINDOW_MS :159-160); the
  doc comment above the function (:196-208) explains the boundary-timestamp
  mechanism but never why 1000 rows is the cap. Its only caller (:287) passes
  nothing, so 1000 is the live value.
- **Proposed constant:** `EXCEPTIONS_KEEP_ROWS = 1000`, comment anchored on
  the sibling STACK_HEAD rationale (:22-23 — "no use keeping forever at
  1000+ rows").

### S46-F4. directus/client.ts — portal requests page size default 50 — GLM-OK

- **File:** `src/directus/client.ts:292` — `listRequests(cfg, projectId, limit = 50)`.
- **Controls:** default page size of the client-portal requests list (the
  read half of the estate portal).
- **Evidence:** the sibling page bound REQUIREMENTS_PAGE_LIMIT = 200 (:68) is
  a named constant whose comment explains the reasoning; listRequests' own
  doc comment (:286-290) covers read-only-ness but says nothing about 50, and
  no caller passes `limit` yet (portal.ts is the future writer per that
  comment), so 50 is the value every future caller inherits silently.
- **Proposed constant:** `REQUESTS_PAGE_LIMIT = 50` beside
  REQUIREMENTS_PAGE_LIMIT.

### S46-F5. llm/models.ts — pool entry token bounds restated raw — GLM-OK

- **File:** `src/llm/models.ts:21-23` — the POOL initializer's
  `minMaxTokens: 16000, maxMaxTokens: 32000` on all three entries.
- **Controls:** per-model floor/ceiling on max_tokens sent upstream for the
  three pooled lead models (glm, kimi, deepseek).
- **Evidence:** the interface field docs (:8-16) explain the mechanism and
  name translate.ts's GLM_MIN_MAX_TOKENS/GLM_MAX_MAX_TOKENS as the precedent —
  but the POOL initializer restates the numbers raw instead of deriving from
  those constants (translate.ts:41, :57), which carry the full why (reasoning
  burn; incident #717's 64k output-token cliff). The copies can drift: a
  future max_tokens change edits translate.ts's constants and misses
  models.ts. Sweep 14's duplication findings did not cover this site.
- **Proposed:** import GLM_MIN_MAX_TOKENS/GLM_MAX_MAX_TOKENS (or per-model
  POOL_MODEL_MIN/MAX_MAX_TOKENS aliases) so the POOL entries derive, not
  restate.

### S46-F6. github/api.ts — listPullCommits page size — GLM-OK

- **File:** `src/github/api.ts:743` — `.../pulls/${pullNumber}/commits?per_page=100`.
- **Controls:** page size of listPullCommits — a PR's original pre-squash
  commit shas, consumed by promote-close.ts's squash fallback.
- **Evidence:** the module's other page sizes are named constants
  (INSTALLATION_REPOS_PAGE_SIZE at :303, BRANCH_NAMES_PAGE_SIZE at :1054) or
  value-explained comments (listOpenPullNumbers :583-586, listOpenPullFiles
  :603-616); listPullCommits' doc comment (:734-742) explains the
  squash-fallback purpose but says nothing about the page size. A PR with
  more than 100 original commits would truncate silently — the squash
  fallback would see fewer commits than exist.
- **Proposed constant:** `PULL_COMMITS_PAGE_SIZE = 100` beside the module's
  other page-size constants.

### S46-F7. github/app.ts — App JWT lifetime 540s — CLAUDE-ONLY

- **File:** `src/github/app.ts:35` — `const payload = { iat, exp: iat + 540, iss: appId }`.
- **Controls:** lifetime in seconds of the GitHub App JWT that mints every
  installation token (auth lane).
- **Evidence:** the skew adjustment on the very next token has an inline
  why-comment (`- 60 // clock skew allowance, per GitHub's docs` at :34) but
  the 540 lifetime has nothing at the site. GitHub documents a 10-minute
  maximum; 540s leaves 60s of headroom under it — reasoning that lives
  nowhere in the file. Auth/token lane: documented here per the task's tier
  rule, no follow-up filed (sweep 14 precedent).
- **Proposed constant (for the auth lane whenever it wants it):**
  `APP_JWT_LIFETIME_SECONDS = 540`.

### S46-F8. deploy/do.ts — deploy poll budget 1800s — CLAUDE-ONLY

- **File:** `src/deploy/do.ts:281` — `maxSeconds: 1800` in the pollDeployOnce deps.
- **Controls:** the wall-clock budget the deploy poll gives a running deploy
  job before declaring it expired (overBudget at :110; deploy lane).
- **Evidence:** the sibling bound MAX_FAILED_POLLS = 3 (:16) is a named
  constant with a why-comment; the 1800s budget is a bare literal at its one
  call site. Deploy lane: documented here per the tier rule, no follow-up
  filed (sweep 14 precedent).
- **Proposed constant (for the deploy lane):**
  `DEPLOY_POLL_BUDGET_SECONDS = 1800`.

## Follow-up

One board issue files F1-F6 for the GLM-OK lane: constant-extraction and
comment work only, six files, no behavior change (values unchanged). F7/F8
are CLAUDE-ONLY and are documented but not filed, per the task boundary and
sweep 14's precedent. Findings never edited in place by this sweep — doc-only
per task boundary.

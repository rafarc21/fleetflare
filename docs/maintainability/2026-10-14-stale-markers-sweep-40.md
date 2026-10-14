# Stale-markers sweep 40 — apps/fleet src + scripts (2026-10-14)

Ref #844. Analysis only, read-only, no code changed. Fortieth maintainability
sweep; scope apps/fleet/src/**, apps/fleet/scripts/**, scripts/**. Line refs =
physical lines at origin/main `414a3c91`, paths relative to repo root.
Successor to the marker audit of sweep 16 (docs/maintainability/2026-10-12-todo-audit-sweep-16.md),
which found zero literal TODO/FIXME/XXX/HACK tokens; this sweep widens the net
to conditional-removal comments — a marker need not carry the literal token to
be stale, it only needs to promise a change that has since landed.

Method: grep for the literal tokens (`\b(todo|fixme|xxx|hack)\b`, minus
mktemp `XXXXXX` templates and the `todo` local variable in
src/board/promote-close.ts), then for promise-shape comments: "once
<issue/PR/condition>", "until <X>", "not part of this PR", "deferred to X",
"separate, later change", "pending", "TBD", "follow-up #N". Every surviving
candidate hand-verified: issue/PR state via `gh issue view`/`gh pr view`,
code condition via grep + read against origin/main itself, git history via
`git log -S`/`git log --follow`.

**Ruled out (verified accurate, no finding):** src/ratelimit.ts:69 and
test/junior.ratelimit.test.ts:154 — "rather than gate behind a TODO" documents
the ABSENCE of a marker (rate-limit pruning was resolved as code,
`pruneStaleCounters`); src/studio/install-cache.ts:46 — "#350's own open
question, decided here" is self-aware history, the decision is recorded in
place; src/tasks/loop.ts:67 — "populated dedupe is deferred to Spec B" names a
genuinely-unfinished design (no escalation dedupe exists anywhere in src/tasks/
today), not a landed promise; scripts/sensors/run.ts:203 — "Rate cap: TBD,
pending operator decision" is live output text of a record-only sensor whose
filing gate is genuinely still unwired and undecided; the dozens of
`Issue #NNN`/`PR #NNN` cites across src/ that describe WHY code has its
current shape (board/types.ts, board/board.ts, studio/types.ts, github/api.ts,
studio/wake.ts, etc.) — history citations of closed work explaining present
design, accurate as written; env.ts:59's FLEET_DIRECTUS cite (#334, CLOSED) —
the Directus project card it names exists at src/directus/card.ts and runs
exactly as described; all mktemp `XXXXXX` hits — mktemp(1) templates, not
markers.

## Findings

Four stale promise-comments, one file each. None touches auth, secrets,
tokens, credentials, rescue, failover, accounts routing, deploy, migrations,
write-proxy, leak-gate or approvals — GLM-OK lane for all four.

| # | finding | lane |
|--:|---|---|
| 1 | src/board/close-action.ts:101 — "Portuguese until the #66 follow-up": the close comment is English since this repo began, and #66 is an unrelated merged PR | GLM-OK |
| 2 | src/llm/anthropic-route.ts:13-16 — three "separate, later change" items; parenthetical credits only two, the third (admission bypass + env wiring) landed in PR #255 | GLM-OK |
| 3 | apps/fleet/scripts/sensors/run.ts:35 — "intended once a scheduled workflow (not part of this PR) calls it": .github/workflows/sensors.yml has run it hourly since #187 (CLOSED) | GLM-OK |
| 4 | src/board/pr-landed.ts:43-44 — "projects ~186 once #163's listIssues pagination fix": pagination is already on main (BOARD_MAX_PAGES, board/api.ts:47), and both cites name different work than the public #163/#180 | GLM-OK |

### S40-F1. close-action.ts — "Portuguese until the #66 follow-up" — GLM-OK

- **File:** `apps/fleet/src/board/close-action.ts:101` — "(Portuguese until the
  #66 follow-up; dedup never read the comment text, so tasks closed under the
  old wording get no second comment.)"
- **Evidence:** the comment this parenthetical describes — the one
  `closeTaskOnPromote` actually posts — has been the English
  "closed by <sha>, promoted to <branch>" (close-action.ts:180) since this
  file first entered the repo (born whole in the public-release squash
  c7cf6a64 and PR #313, both already English; `git log -S "promovido" --all`
  across every commit on every branch: zero hits — no Portuguese close-comment
  text ever existed in this repo's history). In THIS repo, #66 is the merged
  "fleet ls: per-studio container restart count (RST)" PR
  (https://github.com/rafarc21/fleetflare/pull/66, merged 2026-09-29), which
  has nothing to do with close-comment wording. The parenthetical is a
  dangling private-repo cite describing a translation that predates the
  public export; on this repo it is false history: the condition "Portuguese
  until X" was already over when the file was born.
- **Proposed corrected comment:** "(Historical: pre-public-release comments
  were Portuguese; dedup never read the comment text, so tasks closed under
  the old wording get no second comment.)"

### S40-F2. anthropic-route.ts — "separate, later change" list one entry short — GLM-OK

- **File:** `apps/fleet/src/llm/anthropic-route.ts:13-16` — "The admission-gate
  bypass, container env wiring (`lead: glm`, no CLAUDE_CODE_OAUTH_TOKEN) and
  burn/usage accounting are a separate, later change on top of this one.
  (Since then: usage rows via logUsage below, and issue #335's pre-stream
  retry via runAiWithRetry.)"
- **Evidence:** the "(Since then: ...)" parenthetical credits only two of the
  three deferred items. The third landed the same day, in merged PR #255
  (https://github.com/rafarc21/fleetflare/pull/255, "GLM-led studio type v1 --
  Anthropic/Workers AI translation + admission bypass", merged 2026-10-08):
  the route's own admission is the spawn-token shape it imports at
  anthropic-route.ts:19 (isSpawnTokenShaped/resolveSpawnParent), the env
  wiring lives at src/studio/do.ts:4537-4545 (`leadType === "glm"` skips
  CLAUDE_CODE_OAUTH_TOKEN and sets ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL),
  and leadType is a live StudioStatus field (src/studio/types.ts:67). All
  three deferred items are done; the comment's remaining future-tense clause
  is stale for all of them, not just the two credited.
- **Proposed corrected comment:** "(Since then: all three landed — admission
  via the spawn-token parent check above, container env wiring in
  src/studio/do.ts studioEnvVars (leadType "glm" skips CLAUDE_CODE_OAUTH_TOKEN),
  and burn/usage rows via logUsage below; plus issue #335's pre-stream retry
  via runAiWithRetry.)"
### S40-F3. sensors/run.ts — "not part of this PR" workflow shipped with the PR — GLM-OK

- **File:** `apps/fleet/scripts/sensors/run.ts:35` — "Without the flag: writes
  for real — intended once a scheduled workflow (not part of this PR) calls
  it."
- **Evidence:** .github/workflows/sensors.yml exists on main, hourly
  `cron: '17 * * * *'` + workflow_dispatch, runs `bun run sensors` against
  scripts/sensors/run.ts, and is registered ACTIVE with GitHub
  (gh api .../actions/workflows lists it state:"active"). The sensors feature
  issue #187 is CLOSED. The parenthetical "(not part of this PR)" and the
  future-tense "intended once" both describe a state that ended before this
  repo's history began: the workflow was already wired when the file first
  appears (git log --follow on the workflow: present since its first commit
  in tree).
- **Proposed corrected comment:** "Without the flag: writes for real —
  called hourly by .github/workflows/sensors.yml (workflow_dispatch for
  manual runs)."

### S40-F4. pr-landed.ts — "once #163's pagination fix" names an already-landed fix — GLM-OK

- **File:** `apps/fleet/src/board/pr-landed.ts:43-44` — "measured 2026-09-24:
  ~41 candidates today; issue #180 projects ~186 once #163's `listIssues`
  pagination fix keeps a wider net visible."
- **Evidence:** `listIssues` pagination is on main: BOARD_MAX_PAGES = 20
  pages x BOARD_PAGE_SIZE = 100 (src/board/api.ts:32-47) — present since the
  public-release squash c7cf6a64, i.e. the "wider net" condition this
  comment writes as future ("once ... keeps") has been true for the repo's
  entire public history. The two cites also drift: public #163 is the closed
  "reviewer-only CODING_STANDARDS.md" standards chore and public #180 is the
  merged "test-lies phase 2" PR — neither is pagination work. Private
  pre-export numbers with private issue ids, both of which now name different
  work.
- **Proposed corrected comment:** "measured 2026-09-24: ~41 candidates today
  (BOARD_MAX_PAGES-bounded listTasks keeps the wider net visible; the ~186
  projection predates the public release)."

## Follow-up

One board issue files all four for the GLM-OK lane: comment-rewording only,
four files, no behavior change. Findings never edited in place by this sweep —
doc-only per task boundary.



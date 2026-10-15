# Gate runner browser lane — in-container Playwright vs CF Browser Run

Eval only (#715 operator 08:25Z directive, v2 fixed per #715 review).
Phase 1 gate list (typecheck/lint/invariants/rust/vitest shards) has no
browser test → no Phase 1 consumer. Doc exists so a later repo/phase with a
browser lane starts from this comparison, not from "whatever's in the image."

## Candidates

1. **In-container Chromium** (`apps/fleet/scripts/localci/Dockerfile` pattern,
   Playwright baked in) — PRIMARY. Proven today: this repo's `bun-test` lane
   runs it (`apps/fleet/scripts/localci/localci.sh:197`). Runs the real
   `playwright test` runner this repo's e2e suites use. Cost: each
   browser-touching shard is a GateRunnerDO container, competing with every
   other leg for the account cap
   (https://developers.cloudflare.com/containers/platform-details/limits/).
2. **CF Browser Run** (Workers binding, formerly "Browser Rendering";
   Puppeteer/Playwright-compatible REST + binding API) —
   https://developers.cloudflare.com/browser-rendering/. Limit: 200 concurrent
   sessions/account on Paid
   (https://developers.cloudflare.com/browser-rendering/platform/limits/).
   Per CF's Playwright page, only a Playwright-assertions fork and raw CDP
   connections are supported; Playwright Test runner "not yet fully
   supported." So it cannot run this repo's `playwright test` suites as-is
   today. SMOKE-ONLY addition (public URLs, no test-runner dependency), plus
   one open question below.

## Recommendation

Primary: in-container Chromium for any real e2e leg that needs the actual
`playwright test` runner. Proven, no new binding.
Addition, not replacement: Browser Run for smoke checks on public URLs. Doesn't
spend the container vCPU budget the other legs share; 200 sessions is well
above one PR's gate needs.
Fallback/future: if Browser Run gains Playwright Test runner support,
re-evaluate. Same posture as `fleet.json`'s per-repo `gate` block: config,
not a hard-coded choice.

## Open for the operator — the one spike this doc can't answer from docs alone

Does `playwright test` work over a raw CDP connection against Browser Run
today, for THIS repo's test suites? Run a real spike before any future plan
depends on it. This doc sets the primary/fallback ORDER only. It does not
establish that the fallback path is viable at all.

Browser Run needs its own wrangler.jsonc binding entry (another binding kind;
same "docs-only sketch now, real binding at image-window time" posture Task 1
takes for `workflows`). Not sketched here: no Phase 1 leg needs it.

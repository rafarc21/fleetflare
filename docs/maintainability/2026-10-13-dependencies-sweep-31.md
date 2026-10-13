# Dependencies sweep 31 — apps/fleet package.json vs imports (2026-10-13)

Ref #649. Analysis only, read-only, no code changed, no manifest or lockfile
touched. Thirty-first maintainability sweep. Scope: every entry in
`apps/fleet/package.json` (4 dependencies, 8 devDependencies) cross-referenced
against bare-specifier imports in `apps/fleet/src/**`, `cli/**`, `test/**`,
`test-integration/**`, `scripts/**`, `page/**`, `vitest.config.ts` —
`container/` read for rule-out only, never a finding source. Line refs =
physical lines at origin/main `33c0bae`, paths relative to `apps/fleet/`.
No root package.json or bun.lock exists in this repo; `apps/fleet/bun.lock`
is the only manifest, so every finding names the exact package.json line.

Method: clean bare-import census over the in-scope dirs (the only bare
specifiers found: vitest, bun:test, cloudflare:test, cloudflare:workers,
@cloudflare/sandbox, @cloudflare/containers, @cloudflare/vitest-pool-workers,
aws4fetch, miniflare, wrangler), then hand-verification of each package's
claim line: import sites, tsconfig `types` entries, wrangler-config
requirements, and non-import consumers (build-page.ts reads
`node_modules/@xterm/xterm` from disk; `container/ego-browser/` ships its own
package.json pinned to playwright-core 1.63.0, installed by
`bun install --production` inside the image, never resolving through the
root manifest; both Dockerfiles cite bun.lock's playwright-core version as
the pin their `bun x playwright@1.63.0` chromium layer must match).

**Tier rule:** GLM-OK = none of auth, secrets, credentials, rescue,
failover, accounts routing, deploy, migrations, write-proxy, leak-gate.
CLAUDE-ONLY = touches any of those. The findings below are doc-only either
way — the lane marks the follow-up issue that would edit package.json.
The task's own rule: no package.json or lockfile edit in this PR.

## Findings

| # | finding | evidence | proposed action | lane |
|--:|---|---|---|---|
| 1 | `playwright-core` (^1.63.0, dependencies:40) — zero bare imports in src, cli, test, test-integration, scripts, page; the only import site is `container/ego-browser/daemon.ts:11`, and ego-browser resolves it through its OWN minimal package.json (`container/ego-browser/package.json` pins 1.63.0, installed by `bun install --production` in Dockerfile.studio:272), never the root manifest | `grep -rn "playwright-core" src cli test test-integration scripts page` → 0 import hits; Dockerfile.studio:255-256 "pinned to the exact playwright-core version apps/fleet's own root package.json/bun.lock already resolve to" | remove from dependencies — the studio image's copy is the one that runs; keep bun.lock's 1.63.0 as the pin localci/Dockerfile:39 and Dockerfile.studio:237 cite only if they switch to reading it from the manifest (they hardcode `bun x playwright@1.63.0`, so nothing breaks) | GLM-OK |
| 2 | `aws4fetch` (^1.0.20, dependencies:39) — one direct import (`src/studio/install-cache.ts:97`, the R2 presign client) and it is also a transitive dep of @cloudflare/sandbox 0.12.7 (its own dependency, `node_modules/@cloudflare/sandbox/dist/sandbox-CcCJwCbh.js:4`), so it stays installed even after removal | install-cache.ts:97 is the only bare import in scope; bun.lock:30 records sandbox's dependency on it | KEEP as a direct dependency (correct classification, correct section); the finding records that the runtime import is real and the section placement is right — a future "dedupe to transitive" tidy-up would silently depend on sandbox's internals, so the direct dep is deliberate | GLM-OK |
| 3 | `miniflare` (4.20260730.0, devDependencies:31) — imported ONLY by `vitest.config.ts:5` (`createFetchMock`), never by src/cli; correct as a devDep. The finding: its exact pin 4.20260730.0 matches @cloudflare/vitest-pool-workers 0.19.1's own miniflare dependency (bun.lock:34) but NOT wrangler 4.141.0's (bun.lock:358 — miniflare 5.20260925.0-alpha), so three miniflare copies coexist in the tree | `grep -rn "from \"miniflare\"" src cli test scripts` → 0; vitest.config.ts:5 is the only import; bun.lock:34 vs :358 | keep as devDep; note for the record that the pin must keep matching vitest-pool-workers' own miniflare (createFetchMock's undici instanceof check at vitest.config.ts:149-150 is why) — a version-drift tidy-up belongs to the test-pool upgrade, not a dep sweep | GLM-OK |
| 4 | `typescript` (^5.7.0, devDependencies:32) — no file imports it; consumed via the `check` script (package.json:20, five tsc --noEmit invocations) and editor tooling. Correct section, nothing misplaced | package.json scripts.check; 0 `from "typescript"` hits | KEEP, no change — listed because the sweep counts "no file imports" and this is the canonical no-import-but-real consumer case | GLM-OK |
| 5 | `vitest` (^4.1.0, devDependencies:33) — imported by 192 test files (vitest + vitest/config), zero src/cli imports; `cloudflare:test` (81 files) and `@cloudflare/vitest-pool-workers` (vitest.config.ts:6, test/env.d.ts:2) are the pool wrappers. Correct section | 192 `from "vitest"` hits in test/; 0 in src/cli | KEEP, no change — recorded as verified-correct, the inverse of finding 1 | GLM-OK |
| 6 | `@types/bun` (^1.3.14, devDependencies:29) — no file imports it (impossible to import a @types package); consumed via `cli/tsconfig.json:4` and `test/tsconfig.json:10`, both `"types": ["bun"]`, while the root tsconfig uses workers-types. Correct section | 0 bare imports (expected); tsconfig "types" entries are the consumer | KEEP, no change — the canonical tsconfig-types consumer case | GLM-OK |
| 7 | `@cloudflare/workers-types` (^4.20260702.1, devDependencies:28) — no file imports it; consumed via root `tsconfig.json:7` `"types"`. Two lock-notes: wrangler 4.141.0 peers on ^5.x (bun.lock:358, unmet — wrangler ships its own types path) and vitest-pool-workers' nested wrangler 4.116.0 peers on ^5.20260730.1 (bun.lock:370, also unmet) — both are optionalPeers, so the ^4 pin is safe but 2 majors behind what the tooling peers | tsconfig.json:7; bun.lock:46 (^4.20260702.1), :358, :370 | KEEP at ^4; record the peer skew — bumping to ^5 is a deliberate test-pool upgrade decision (types shape changes), not a sweep action | GLM-OK |
| 8 | `@xterm/xterm` (^6.0.0, devDependencies:30) — no file imports it; consumed at BUILD time by `scripts/build-page.ts:28,78-79` which reads `node_modules/@xterm/xterm/lib/xterm.js` + `css/xterm.css` from DISK and inlines them into `page/terminal.html` (the artifact `src/studio/page.ts:6` text-imports). It is also an optionalPeers entry of @cloudflare/sandbox (bun.lock:30, deliberately not installed for the SDK) — the inlined UMD bundle is the served widget, so the runtime Worker needs the package never | build-page.ts:28 `XTERM_DIR = path.join(root, "node_modules", "@xterm", "xterm")`; page/terminal.template.html:15 | KEEP as devDep; the finding records the disk-read consumer class so a future knip-style tool is configured to count it as used (same class as finding 4) | GLM-OK |
| 9 | `wrangler` (^4.141.0, devDependencies:34) — two bare imports (`scripts/deploy-containers-changed.ts:31`, `scripts/deploy-target.ts:39`, both `unstable_readConfig`) and the `dev` script (package.json:12); deploy.sh refuses a PATH wrangler and insists on the local install. Correct section — deploy scripts are dev-time tooling, the deployed Worker never imports wrangler | deploy-containers-changed.ts:31, deploy-target.ts:39; deploy.sh:370,393,398 | KEEP, no change — the only surprise (a deploy script importing a devDep) is correct: deploys run from a dev checkout with devDeps installed, never inside the deployed Worker | GLM-OK |
| 10 | `@cloudflare/containers` (^0.0.20, dependencies:37) — three bare imports (`src/agents/do.ts:1`, `src/agents/runtime.ts:1` type-only, `src/deploy/do.ts:1`; AgentDO/DeployDO extend Container) BUT @cloudflare/sandbox 0.12.7 depends on ^0.3.5 and ships its own nested 0.3.7 (`node_modules/@cloudflare/sandbox/node_modules/@cloudflare/containers`, bun.lock:368) — two Container classes coexist; the direct 0.0.20 is what AgentDO/DeployDO compile against, StudioDO compiles against sandbox's 0.3.7. Version skew is invisible today (both satisfy the class extends) but a 0.0.x API drift would split the fleet | agents/do.ts:1, agents/runtime.ts:1, deploy/do.ts:1; bun.lock:26 (0.0.20) vs :368 (nested 0.3.7); sandbox dist imports @cloudflare/containers at its own top | KEEP the direct dep (correct — agents/deploy DOs do not import sandbox); record the two-copies skew as an upgrade note: aligning on one containers version is a deliberate sandbox-sdk upgrade, not a sweep action | GLM-OK |
| 11 | `@cloudflare/sandbox` (0.12.7 exact, dependencies:38) — eight bare imports (src/studio/sandbox-api.ts:32, src/studio/do.ts:1, six test files extending Sandbox), StudioDO extends Sandbox<Env> at src/studio/do.ts:5747. Correct section, exact-pinned per sandbox-api.ts's own header. Nothing to move | 8 import sites; do.ts:5747 | KEEP, no change — verified correct; the exact pin is load-bearing (sandbox-api.ts:2-5 records d.ts-name fidelity against 0.12.7) | GLM-OK |
| 12 | `@cloudflare/vitest-pool-workers` (0.19.1, devDependencies:27) — consumed by vitest.config.ts:6 (`cloudflareTest`, `readD1Migrations`), test/env.d.ts:2 (D1Migration type), root tsconfig.json:7 (`types`), and every `cloudflare:test` import through the pool (81 files). Correct section | vitest.config.ts:6; tsconfig.json:7; test/env.d.ts:2 | KEEP, no change — verified correct | GLM-OK |
| 13 | Inverse check passed: every bare specifier imported in scope resolves to a manifest entry or a builtin (node:*, bun, bun:test, cloudflare:test, cloudflare:workers) — no hidden runtime dependency riding the tree undeclared. The census's apparent bare imports `from "none"`, `from "human"`, `from "maestro"`, `from "truncated"`, `from "operator"`, `from "unifying"` are string literals inside backtick templates (board.ts:537, agents/do.test.ts:21, cli.fleet.test.ts:1305...), not imports | census + re-grep of each false positive | no action — recorded so a future tool run does not flag them | GLM-OK |
| 14 | `skills/release-verification-checklist/worker/package.json` declares wrangler ^3.80.0 + vitest ^2.0.0 + playwright (imported by its worker src) but no `playwright` entry in devDependencies — a hidden undeclared runtime dep in a skill fixture outside apps/fleet; out of the task's manifest scope (apps/fleet/package.json + root), recorded for the record | `grep "playwright" skills/release-verification-checklist/worker/` → import hits, manifest has no entry | no issue from this sweep (out of scope); note for the operator: the skill worker's manifest predates its playwright use | GLM-OK |

## Counts

14 findings. 1 actionable removal (F1, playwright-core — one line in
dependencies, plus the bun.lock regen); 13 verified-correct or record-only
(F2-F14: correct sections, tsconfig/build-time/disk-read consumer classes,
version-skew notes for the test-pool upgrade, false-positive census entries).
One follow-up issue filed: F1. No package.json or lockfile edit in this PR —
per the task's own boundary, the removal lands as its own chore issue.

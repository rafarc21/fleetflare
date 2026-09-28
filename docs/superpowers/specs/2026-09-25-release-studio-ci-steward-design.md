# Release Studio as CI steward — design

Issue: https://github.com/rafarc21/fleetflare/issues/267 (item 7). Date 2026-09-25. Status: proposal. No code. No studio.md edit.

## Why

GitHub Actions off on rafarc21/fleetflare (billing). the operator: no GH CI spend.
This PR ships Mac-local CI: `apps/fleet/scripts/localci/` + launchd daemon.
the operator: "Feel free to improve the Release Studio's role. Maybe it can do CI."
Three options compared. One recommended.

- **A.** release-studio runs same localci lanes inside its cloud container.
- **B.** dedicated non-LLM CI container in Worker, fired by `pull_request` webhook.
- **C.** Mac daemon only (this PR). Mac asleep = no CI.

## Recommendation: A, as merge gate of staging train

Release-studio runs localci lanes on each PR head before batch-merge.
It posts `local-ci/*` statuses from its container. Mac daemon (C) stays as fast feedback while Mac awake.
Merge authority needs no Mac. No new Worker code, no new image, no webhook.
B is correct long term. It costs a new DO class, image, webhook and exec-deadline work. Revisit when CI must run on every push, not per train.

## Measured evidence

### 1. bun-test lane is safe inside a studio — PROVEN, one condition

Condition: runner has `TMUX` and `TMUX_PANE` unset. Lead already launches without them.

**tmux.** Studio session lives on private socket.
- `apps/fleet/container/studio-bringup.sh:38-40`: every bring-up tmux call is `command tmux -L fleet-studio "$@"`.
- `studio-bringup.sh:1548-1553`: lead launches as `env -u TMUX -u TMUX_PANE claude …`. Lead's Bash, members and their tests inherit no `TMUX`.
- Merged on main: e35dc12e (#177), 225027a0 (#223).

Audit of all 24 tmux-touching files in `test/bun/` (grep `tmux`, `TMUX_TMPDIR`, `kill-server`, `fleet-studio`):
- Real-tmux files each set throwaway `TMUX_TMPDIR` (tmux-socket: random `-L` sockets under `/tmp/ff117-*`, :173-201) and strip `TMUX`/`TMUX_PANE`: bringup-claude-relaunch (:129-134), studio-tmux-socket (:71-88), pane-probe-lead (:124-148, refuses empty or system `TMUX_TMPDIR`), bringup-tmux-render (:53-56), incarnation-newline (:25-26), inspect-cmd (:25-26), pane-probe (:22-23), wake-cmd (:30-31), account-switch-swallow (:43, :63-68; throws if `TMUX` set, `describe.skip` at :105).
- `-L fleet-studio` in a test resolves under that throwaway `TMUX_TMPDIR`. It never reaches real `/tmp/tmux-0/fleet-studio`.
- Stub-only (fake `tmux` binary or static text): tmux-socket-pin, claude-account-switch, wake-guard, memguard-select, cmd-syntax.
- **One near-hazard, guarded.** `tmux-socket.test.ts:201` keeps `process.env` whole. Its wrapper forwards plain `tmux` to real tmux when `$TMUX` is set (:190). `box.sh("tmux kill-server")` (:282) would then kill server named in `$TMUX` (from an attach pane: the studio). Guard: suite throws in `beforeAll` when `TMUX` set (:225). Runner still strips `TMUX`/`TMUX_PANE`: belt and braces, and suites that refuse would otherwise report errors, not passes.

**HOME.** Every bun test that spawns with `HOME` passes a temp dir: blueprint-credential, attach-liveness, bringup-claude-launch, bringup-session-adopt, bringup-claude-relaunch, bringup-hooks, bringup-tmux-render, exec-deadline, ff-no-tty, studio-tmux-socket, worktree-session-adopt, studio-adopt, account-switch-swallow. bringup-log uses fake-HOME helper (:83-105). session-tar-budget uses `mkdtemp` base (:64). ego-browser tests set `EGO_BROWSER_HOME` temp (`ego-browser-cli-helpers.ts:51`); default `/root/.ego-browser` (`container/ego-browser/paths.ts:21`) untouched. No test writes real `~/.claude`.

**Chromium reap** is direct-child scoped (`container/ego-browser/process-reap.ts`). It cannot kill studio's own browser.

### 2. memguard vs lane processes

`apps/fleet/container/memguard.ts`:
- Fires only below 6% available (`:407`, TERM) / 3% (`:408`, KILL). 6% of 11.65 GiB ≈ 716 MiB free.
- Victim = largest RSS ≥ 64 MiB outside protected set (`:160-171`). Preferred regex `vitest|vite|bun test|esbuild|chrom|playwright|node|tsc|jest` (`:86`).
- Protected by comm: `claude`, `tmux: server`, `tailscaled`, `sshd`, plus ancestors (`:85`, `:135-156`).
- Consequence: lane `bun test` and chromium are FIRST victims under pressure. Correct: lane dies, lead lives. Runner must map signal death to status `error`, not `failure`.
- Side effect: test-spawned tmux servers also carry comm `tmux: server`. They get protected. Harmless; they hold ~5 MiB.

### 3. Memory: lane peak vs 11.65 GiB ceiling

Measured 2026-09-25, `docker stats --no-stream` every ~2-4 s on `localci:u24` Linux-lane containers other sessions ran (no extra load added; Mac load avg 20-26, 12 CPU, docker VM 11.73 GiB):
- Lane `awesome_colden` sampled from start (28 MiB, install) to exit, 76 samples over ~340 s: **peak 869 MiB**, 326 PIDs max. Late phase 755 MiB.
- Lane `friendly_payne`, joined mid-run, 23 samples: peak 624 MiB. `agitated_sanderson`, tail only: 439 MiB.
- Caveat: 2-4 s sampling can miss sub-second spikes. docker stats excludes page cache. Order of magnitude holds: < 1 GiB.
- Lane wall time, prior logs (`bun run bun-test`, 761-764 tests, 58 files): 225 s, 246 s, 282 s, 298 s, 368 s, 429 s, 614 s (last one loaded, 5 fails = #256 family).
- Only skip: `memguard in docker --memory=1g` (no docker in lane). Studio also has no docker → same skip. Parity kept.

Studio budget: ceiling 11.65 GiB (standard-4, `wrangler.jsonc` StudioDO `instance_type`). Lane peak well under 1 GiB. Wedges came from 3 concurrent gates (studio.md:37), not one. Rule holds: lane takes `flock /tmp/fleet-gate.lock`, one at a time.
Vitest lane peak not measured here. Members already run vitest in studios (memguard.ts:9-10 names it a wedge driver). Treat as heavy gate; same lock.

### 4. Other studio prerequisites

| Need | Studio today | Evidence |
|---|---|---|
| docker | absent → Linux lane runs natively, no docker-in-docker | `Dockerfile.studio` installs none; base `cloudflare/sandbox:0.12.7` |
| bun | yes | `Dockerfile.studio:43-45` |
| tmux, git, python3 | yes | `Dockerfile.studio:32`, `:86-87` |
| chromium at `/usr/local/bin/chromium` | yes | `Dockerfile.studio:126-127` |
| workerd for vitest-pool-workers | yes, linux-64 + linux-arm64 in lock | `apps/fleet/bun.lock`: `@cloudflare/workerd-linux-64@1.20260801.1` |
| OS | Ubuntu jammy (tmux 3.2a) vs localci noble 24.04 | `Dockerfile.studio:93-99` comment |
| gh auth | yes, token written Worker-side | `src/studio/credentials.ts:49-57` |
| flock | yes | `studio-bringup.sh:218` |

OS drift jammy vs noble: real risk for tmux render tests. First studio run must diff results against a Mac-docker run of same tree hash.

### 5. Posting commit statuses from a studio

`POST repos/{o}/{r}/statuses/{sha}` needs Commit statuses: write.
- rafarc21/fleetflare uses PAT `GITHUB_TOKEN`, resource owner rafarc21 (`wrangler.jsonc:20-28`, `src/github/auth.ts:36-47`). PAT scopes are a secret. **UNVERIFIED.** Test: from studio, `gh api -X POST repos/rafarc21/fleetflare/statuses/<sha> -f state=pending -f context=local-ci/probe`. 403 "Resource not accessible by personal access token" → the operator adds Commit statuses: Read and write to PAT.
- App `example-org-fleet` (id 1111111), measured via `gh api orgs/acme-org/installations`: permissions = issues, actions, contents, metadata, workflows, issue_types, issue_fields, pull_requests, repository_hooks, organization_projects. **No `statuses`.** App-auth repos (acme-org, demositeltda, acme-hq per `GITHUB_REPO_AUTH`, `wrangler.jsonc:71`) cannot post statuses until the operator adds Commit statuses: write to App.

## Option B: dedicated CI container in Worker

Hook points exist:
- Route `POST /gh` → `handleGithubWebhook` (`src/index.ts:67`).
- Event dispatch `x-github-event`; non-push events go to `wakeMaestro` (`src/github/webhook.ts:451-454`). CI trigger slots in there.
- `pull_request` already in `WAKE_EVENTS` (`src/github/wake-events.ts:31`, handled :141-149).
- Non-LLM container precedent: `AgentDO` on `container/Dockerfile`, standard-1, max 3 (`wrangler.jsonc` containers[0]).

Blockers, measured:
- **No delivery for fleetflare.** `gh api repos/rafarc21/fleetflare/hooks` → `[]`. App installed on acme-org only (`src/github/auth.ts:23-25`: App cannot see personal repos). New repo webhook needed.
- New DO class + migration + container entry + CI image (localci image 1.46 GB) + deploy.
- Exec deadlines: lane runs 4-10 min. Every exec shares `sandbox-default` session, untimed (wedge memo; #104). CI exec needs own session + deadline.
- Cold start: studio provision ~5 min. Adds to each run unless kept warm.

Cost (CF pricing page, 2026-09-25: memory $0.0000025/GiB-s, CPU $0.000020/vCPU-s active only, disk $0.00000007/GB-s; Workers Paid includes 25 GiB-h, 375 vCPU-min, 200 GB-h per month):
- standard-3 (2 vCPU, 8 GiB), 15 min/run: mem $0.018 + CPU ≤$0.036 + disk $0.001 ≈ **$0.05/run**. 30 runs/day ≈ $45/month.
- Kept warm 24/7 on standard-3: mem alone 8 × 2 592 000 × 2.5e-6 ≈ **$52/month**.

Complexity: highest. Days of Worker + image work, one container deploy window.

## Option C: Mac daemon only

- Zero incremental work; ships in this PR.
- Mac asleep or lid shut → no status → merge gate blocks or gets skipped by hand.
- Shares Mac with 84 worktrees and interactive work. Mac load 20-31 measured today. #256 flake fires under that load (`test/bun/session-memory.test.ts:26`, BUDGET 16 MiB; issue: 31.3 MiB loaded vs 1.0 MiB alone).
- Keep as fast feedback, not sole authority.

## Option A detail

Cost: lanes run inside release-studio already up for train. standard-4, 10 min/PR: mem 12 × 600 × 2.5e-6 = $0.018 + CPU ≤ 4 × 600 × 2e-5 = $0.048 → **≤ $0.07/PR**. No always-on cost (`keep_alive: false` stays).
LLM cost: lead calls one script per PR. Lanes are non-LLM. Few tokens.

Work needed (follow-up PR, not this one):
1. `localci.sh --native`: Linux lane runs `bun run bun-test` directly, no docker. Wrap with `env -u TMUX -u TMUX_PANE` and `flock /tmp/fleet-gate.lock`.
2. Same script, same tree rule: `git merge-tree` PR head onto origin/main, detached worktree, tree hash in result JSON.
3. Signal death (memguard) → status `error`, description names memguard.
4. Status contexts identical to Mac: `local-ci/fleet-check`, `local-ci/english`. Description adds `runner=studio` or `runner=mac`.
5. Verify PAT statuses permission (section 5) before first train.
6. First run: compare pass/fail set to Mac-docker run of same tree hash. Any diff = OS drift bug, filed before trusting studio.

Risks:
- Studio busy with QA member browser + lane → still one gate. Lock serializes.
- Studio wedge mid-lane → no status. Train sees missing status, never "green". Fails closed.
- Rate-limit on single Claude account (fleet memo) stalls lead, not lanes.
- Role creep toward implementation (memo release-studio-is-qa-only). Text below keeps "never implement": running tests is verification.

## Proposed studio.md change — NOT applied

File: `fleet/blueprint/studios/release-studio/studio.md`. the operator approves first.

```diff
-allowedTools: Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Read Glob Grep
+allowedTools: Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Bash(flock /tmp/fleet-gate.lock apps/fleet/scripts/localci/localci.sh *) Read Glob Grep
@@
-Staging train: batch-merge every green PR with one `fleet` call, deploy staging. Intersection breaks: write a fix-task issue before the operator ever looks, linked to its source PR.
+CI steward. GitHub Actions is off. CI = `local-ci/*` commit statuses on PR head SHA. Read them: `gh api repos/<o>/<r>/commits/<sha>/status`.
+Green = `local-ci/fleet-check` and `local-ci/english` both `success` on CURRENT head SHA, tested tree = head merged onto current main.
+Missing or stale status: run it yourself, one PR at a time, `flock /tmp/fleet-gate.lock apps/fleet/scripts/localci/localci.sh --native <pr>`. It posts statuses. Never in parallel. Never with TMUX set.
+Status `error` = runner died (memguard, wedge), not a test failure. Rerun once. Second `error`: write a fix-task, hold that PR.
+Failure in a known-flaky test (list file in localci/) reruns that file once; both results in status. Real failure: fix-task on source PR, hold it. Never fix it yourself.
+Staging train: batch-merge every PR green by the rule above with one `fleet` call, deploy staging. Intersection breaks: write a fix-task issue before the operator ever looks, linked to its source PR.
```

## Decision asked of the operator

1. Approve A as merge gate, C kept as feedback. Or pick B now.
2. Add Commit statuses: write to fleet PAT (and App, for org repos) if section 5 probe returns 403.

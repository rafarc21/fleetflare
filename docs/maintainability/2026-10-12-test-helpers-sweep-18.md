# Test-helpers sweep 18 — apps/fleet/test (2026-10-12)

Ref #537. Eighteenth maintainability sweep; scope: duplicated test helpers — fixtures/fakes copy-pasted across `apps/fleet/test`. Doc-only, read-only, no code changed, no test edited. Line refs = physical lines at `origin/main` 13f445f, paths relative to `apps/fleet/test/`. Lane rule (same as sweep 3, #375/#371): a file is CLAUDE-ONLY if ANY of its describes touches rescue/failover/auth/credential/deploy subjects; otherwise GLM-OK.

Method: grep census of helper-shaped definitions (`function`/`const` declarations with test-fixture bodies) across `apps/fleet/test`, grouped by md5 body-hash at `origin/main` 13f445f on 2026-10-12; identical hashes = byte-identical copies, near-misses read by hand to classify as genuine divergence vs copy-paste drift. Read-only, no code changed.

## Findings

| # | finding | copies | tier |
|--:|---|---|---|
| F1 | `extractRegion(src, marker)` region puller from studio-bringup.sh | 9 | GLM-OK |
| F2 | `const BRINGUP = readFileSync(...studio-bringup.sh)` | 15 | GLM-OK |
| F3 | `writeCredentials(home, workerUrl)` fixture credentials writer | 5 | GLM-OK |
| F4 | `isolatedTmuxEnv(dir)` tmux isolation env builder | 6 | GLM-OK |
| F5 | `captured(first, second)` pane-capture stringer | 16 sites / 11 files | CLAUDE-ONLY |
| F6 | `fakeApi(overrides)` BoardApi fake + co-traveling `task(overrides)` builder | 11 + 13 | GLM-OK with carve-outs |
| F7 | `envelopeDoc` + `envelopeComment` builder pair | 3 | GLM-OK |
| F8 | `sign(body)` webhook HMAC signer | 2 | not filed (below bar) |
| F9 | `status(overrides)` StudioStatus builder — adoption gap | 20 | GLM-OK with carve-outs |
| F10 | `fakeStorage(initial)` clones — adoption gap | 5 | CLAUDE-ONLY |
| F11 | `waitFor(predicate, timeoutMs)` poll loop | 4 | GLM-OK |
| F12 | `TIMEOUT_SHIM_DIR` gtimeout→timeout shim IIFE | 3 | CLAUDE-ONLY |

### F1 — `extractRegion(src, marker)` — GLM-OK

Byte-identical 9-file copy, identical md5 across all 9: `bun/bringup-active-window.test.ts:22`, `bun/memguard-docker.test.ts:41`, `bun/bringup-mcp-config.test.ts:23`, `bun/studio-tmux-socket.test.ts:30`, `bun/bringup-tailscale-up.test.ts:45`, `bun/bringup-tmux-render.test.ts:29`, `bun/bringup-session-adopt.test.ts:27`, `bun/bringup-claude-relaunch.test.ts:32`, `bun/bringup-fresh-session.test.ts:23`. Pulls a `# >>> marker >>>` .. `# <<< marker <<<` region from container/studio-bringup.sh. Proposed home: `bun/exec-snippet.ts` — it already exports `extractHeredoc`/`extractShellFunc` (25 importers) and is the bun-lane shell-source helper; `helpers/` is the vitest lane. Add `extractRegion` there.

### F2 — `const BRINGUP = readFileSync(...)` — GLM-OK

The read of container/studio-bringup.sh appears 15 times: 14 identical spellings of `const BRINGUP = readFileSync(join(import.meta.dir, "../../container/studio-bringup.sh"), "utf8")` (`bun/bringup-active-window.test.ts:20`, `bun/bringup-blueprint-sync.test.ts:19`, `bun/bringup-claude-launch.test.ts:17`, `bun/bringup-claude-relaunch-hermetic.test.ts:25`, `bun/bringup-claude-relaunch.test.ts:29`, `bun/bringup-fresh-session.test.ts:20`, `bun/bringup-hooks.test.ts:22`, `bun/bringup-launch-line.test.ts:22`, `bun/bringup-log.test.ts:25`, `bun/bringup-mcp-config.test.ts:20`, `bun/bringup-session-adopt.test.ts:24`, `bun/bringup-tailscale-up.test.ts:43`, `bun/bringup-tmux-render.test.ts:19`, `bun/studio-tmux-socket.test.ts:26`) plus `bun/memguard-docker.test.ts:38` with the same read spelled via `CONTAINER_DIR`. Proposed: `export const BRINGUP` from `bun/exec-snippet.ts`. Divergence to note: one spelling variant (memguard-docker).

### F3 — `writeCredentials(home, workerUrl)` — GLM-OK

5 byte-identical copies: `bun/junior-stats-cli.test.ts:14`, `bun/task-state-cli.test.ts:29`, `bun/cli.task-verify.test.ts:40`, `bun/cli.task-reap.test.ts:33`, `bun/accounts-cli.test.ts:31`. Body: mkdir ~/.fleet, write credentials JSON `{workerUrl, accessClientId: "id", accessClientSecret: "secret"}`, chmod 0600. Proposed home: new `bun/helpers/credentials.ts`. Divergent siblings listed, NOT folded: `bun/attach-liveness.test.ts:34` (inline, "x"/"y"), `bun/cli-destroy-unmerged.test.ts:213` (inline, "cid"/"csecret"), `bun/deploy-rescue-gate.test.ts:207` (inline, mode option not chmod), `bun/ff-new-main.test.ts:41`, `bun/ff-no-tty.test.ts:61` (inline, other key spellings). These are fixture secrets, not real credentials; the suites test CLI print loops, not auth behavior — GLM-OK with that reasoning stated.

### F4 — `isolatedTmuxEnv(dir)` — GLM-OK

6 copies: 5 byte-identical (`bun/wake-cmd.test.ts:29`, `bun/pane-probe.test.ts:21`, `bun/inspect-cmd.test.ts:24`, `bun/wake-submit-check.test.ts:26`, `bun/incarnation-newline.test.ts:31`) plus `bun/pane-probe-lead.test.ts:146` which DIVERGES (prepends `${dir}/bin` to PATH + isolation assert). Each copy carries the safety comment: TMUX/TMUX_PANE stripping is required, TMUX_TMPDIR alone is NOT isolation — three studio leads died probing the live lead's tmux. That comment must move with the helper verbatim. Proposed home: new `bun/helpers/tmux-env.ts`. Cousins listed not folded: `bun/bringup-active-window.test.ts:41` harness(), `bun/bringup-tmux-render.test.ts:49` isolated() — same strip pattern inline but different env shapes (HOME under dir); folding changes behavior, left local.

### F5 — `captured(first, second=first)` pane-capture stringer — CLAUDE-ONLY

16 sites / 11 files: `studio.failover-fixtures.test.ts:20`, `studio.failover-real-panes.test.ts:22`, `studio.failover-106.test.ts:21`, `studio.failover-dead-account.test.ts:21`, `studio.rate-limited.test.ts:55,190,450` (3 inline arrows), `studio.account-failover.test.ts:137`, `studio.failover-214.test.ts:48`, `studio.session.test.ts:1300` (inline), `studio.auto-continue.test.ts:78`, `studio.survival-delivery.test.ts:75`, `studio.parked-auto-resume.test.ts:100`, `studio.spend-cap.test.ts:18` (plus `studio.start-gate-writeback.test.ts:181` inline). All build `${first}\n${PANE_CAPTURE_MARKER}\n${second}\n`. Two shapes: single-arg mirrors the pane; two-arg allows before/after. The divergence is load-bearing: dead-account/failover files use two-arg for genuinely-different captures; folding to one-arg silently weakens them. Whole subject failover → CLAUDE-ONLY per lane rule.

### F6 — `fakeApi(overrides)` BoardApi fake — GLM-OK with carve-outs

×11 files: `board.close-action.test.ts:22`, `board.read-repos.test.ts:34`, `board.verify.test.ts:23`, `board.board.test.ts:27`, `board.pr-landed.test.ts:23`, `board.open-prs.test.ts:42`, `board.open-prs-route.test.ts:48`, `board.fleet-directs.test.ts:36`, `board.fleet-routes.test.ts:35`, `board.leak.test.ts:40`, `board.routes.test.ts:34`. Divergences (state — do not fold silently): `board.board:27`/`board.routes:34`/`board.fleet-routes:35` seed `listMilestones [{number:3,title:"Sprint 1"}]`, the rest return `[]`; `createComment` URL issue-number differs per file (12/71/109); `board.open-prs:42` keys `getIssue`/`getPullRequest` on the passed number. Plus co-traveling `task(overrides)` BoardTask builder ×13: `board.close-action.test.ts:14`, `board.read-repos.test.ts:26`, `board.verify.test.ts:15`, `board.routes.test.ts:26`, `board.leak.test.ts:32`, `board.board.test.ts:19`, `board.pr-landed.test.ts:11`, `board.open-prs.test.ts:26`, `board.open-prs-route.test.ts:40`, `board.fleet-directs.test.ts:28`, `board.fleet-routes.test.ts:27`, `cli.columns.test.ts:21`, `cli.task-format.test.ts:11` — same 9-field literal, only fixture values differ. Proposed home: new `helpers/board-api.ts` exporting `fakeApi(overrides)` (defaults: `listMilestones []`, issue 12) + `task(overrides)` (defaults: number 12, state "submitted", labels ["submitted"], milestone null). Lane carve-outs within F6: `board.routes.test.ts`, `board.fleet-routes.test.ts` and `board.read-repos.test.ts` carry auth/token describes → those 3 files CLAUDE-ONLY; the other 8+13 siblings migrate. Sibling, not a copy: `github.promote-close.test.ts:13` fakeApi is a different PromoteCloseApi type.

### F7 — `envelopeDoc` + `envelopeComment` builder pair — GLM-OK

×3: `board.verify.test.ts:44`, `board.pr-landed.test.ts:44`, `board.open-prs.test.ts:63` (`envelopeComment` at :61/:62/:81). `envelopeComment` is byte-identical in all 3 modulo the createdAt fixture → foldable. `envelopeDoc` DIVERGES genuinely: `board.verify` takes `{intent, verification}`; pr-landed/open-prs take `{intent, artifacts}` and only attach verification when intent is result/default — different fixture semantics. Proposed home: `helpers/board-api.ts` exports `envelopeComment(doc, overrides)` only; `envelopeDoc` stays local (or folds later with an options design). Siblings listed: `board.open-prs-route.test.ts:93` envelopeCommentWithPr, `cli.task-format.test.ts:65`.

### F8 — `sign(body)` webhook HMAC-SHA256 signer — not filed

×2: `public-flags.test.ts:36`, `github.webhook.test.ts:15` — identical logic, different secret const. Below the 3+ copy bar — recorded, no issue filed. (2026-10-13, #790: `github.webhook.test.ts` split by #720 into `github.webhook-core.test.ts` + `github.webhook-autoclose.test.ts`; both halves and `public-flags.test.ts` now share `helpers/webhook-sign.ts`'s `sign()` since #824.)

### F9 — `status(overrides)` StudioStatus builder — GLM-OK with carve-outs (adoption gap)

×20 files — an adoption gap, not a missing helper: `helpers/studio-row.ts` `row()` exists from sweep 3 (#372, 11 importers) but these 20 hand-roll the same 11-null literal: `studio.account-by-repo.test.ts:41`, `studio.account-failover.test.ts:64`, `studio.account-launched.test.ts:54`, `studio.auto-continue.test.ts:61`, `studio.burn.test.ts:1166`, `studio.burn-window-expiry.test.ts:60`, `cli.fleet.test.ts:38`, `studio.do.test.ts:30,238`, `studio.fleet-resume.test.ts:23`, `studio.grid.test.ts:23`, `studio.observation-tick.test.ts:82`, `studio.parked-auto-resume.test.ts:83`, `studio.rate-limited.test.ts:160,443`, `studio.readiness.test.ts:27`, `studio.refresh.test.ts:76`, `studio.registry.test.ts:14`, `studio.replacement.test.ts:70`, `studio.spawn.test.ts:138`, `studio.spawn-atomic.test.ts:22`, `studio.worktree-session.test.ts:27`. Divergences: `grid` pins lastRefresh to a moving now; `studio.do.test.ts` has two (:30, :238). Co-traveling `burn(overrides)` Burn builder ×2: `studio.grid.test.ts:37`, `cli.fleet.test.ts:30` — identical except `window5hStart: new Date().toISOString()` vs frozen `"2026-08-16"` (divergent; note). Fix: adopt `helpers/studio-row.ts` (add a burnRow export); do NOT create a new home. Lane carve-outs (CLAUDE-ONLY, failover/auth subjects per describes): account-by-repo, account-failover, account-launched, auto-continue, parked-auto-resume, rate-limited, registry (limited-account reroute describe), refresh (credentialWriteCmd describes), replacement, spawn (auth-mocking per sweep-3 S3-F3 precedent), worktree-session. GLM-OK set: burn, burn-window-expiry, cli.fleet, do, fleet-resume, grid, observation-tick, readiness, spawn-atomic.

### F10 — `fakeStorage(initial)` clones — CLAUDE-ONLY (adoption gap)

5 byte-identical (md5-identical) clones of `function fakeStorage(initial?: StudioStatus)`: `studio.account-by-repo.test.ts:39`, `studio.account-launched.test.ts:50`, `studio.account-unmapped.test.ts:39`, `studio.auto-continue.test.ts:69`, `studio.parked-auto-resume.test.ts:91` — exactly what `helpers/do-storage.ts` `fakeStorage(seed)` does via `fakeStorage(initial ? {[STATUS_KEY]: initial} : undefined)` (the wrapper pattern `studio.wake-gate.test.ts:34` already uses). 4 of 5 failover-lane. Census note: the other ~20 local fakeStorage variants are genuinely divergent (multi-key seeds, write-failure injection, single-method Pick shapes, multi-port unions) and stay local BY DESIGN per #371's helper header. CLAUDE-ONLY.

### F11 — `waitFor(predicate, timeoutMs, intervalMs=50)` — GLM-OK

Byte-identical ×4 (md5-identical 7-line deadline loop): `bun/ego-browser-launch-timeout.test.ts:87`, `bun/ego-browser-idle-shutdown.test.ts:54`, `bun/ego-browser-idle-shutdown-launch-failure.test.ts:51`, `bun/ego-browser-idle-shutdown-container.test.ts:97`. Proposed home: new `bun/helpers/poll.ts`. Cousins listed not folded: `bun/pane-probe-lead.test.ts:273` waitForPane (command-polling), `bun/studio-tmux-socket.test.ts:242` waitForFile (file-polling).

### F12 — `TIMEOUT_SHIM_DIR` gtimeout→timeout shim IIFE — CLAUDE-ONLY

×3: `bun/rescue-push.test.ts:67`, `bun/git-wrapper.test.ts:91`, `bun/rescue-leak-gate.test.ts:26` — Bun.which, mkdtemp, `#!/bin/sh exec gtimeout "$@"`, chmod 755. DIVERGENCE: `rescue-push` additionally reimplements `timeout -k` in perl when no gtimeout exists (proven on stock macOS, PR #359 round 3) — a naive fold loses the perl fallback. All 3 files rescue/git-push lane → CLAUDE-ONLY; the fold design (e.g. `timeoutShimDir({perl: boolean})`) is a judgment, flagged not mechanical.

## Skipped — already filed in sweep 3

Not re-filed: #375 fixedNow/b64/sh (`helpers/datetime.ts`, `bun/helpers/shell.ts` exist and are adopted); #371 fakeStorage; #372 studio-row; #373 fake-namespace; S3-F4 authorizedReq (`helpers/http.ts`). F9/F10 here are the adoption GAPS those filed helpers left — new work, not re-files.

## Not filed

- F8 `sign(body)` — ×2, below the 3+ copy bar; recorded above.
- F4 cousins (`bringup-active-window` harness(), `bringup-tmux-render` isolated()) and F11 cousins (waitForPane, waitForFile) — same idiom, different behavior; folding changes behavior, left local.
- F7 `envelopeDoc` — genuinely divergent fixture semantics between verify and pr-landed/open-prs shapes; folding needs an options design, not a copy-paste extraction.

## Summary

12 findings: 8 GLM-OK with proposed shared homes (`bun/exec-snippet.ts`, new `bun/helpers/` modules, `helpers/board-api.ts`, `helpers/studio-row.ts` adoption), 3 CLAUDE-ONLY lane findings (F5, F10, F12), 1 below-bar observation (F8). Two are adoption gaps (F9, F10) — helpers already filed in sweep 3 exist; the work is migrating files to them, not building new homes.

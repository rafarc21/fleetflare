# S31-F1 — playwright-core out of apps/fleet root deps (refs #681, refs #649)

Sweep 31 F1: root manifest declares playwright-core ^1.63.0; zero files
under src, cli, test, test-integration, scripts, page import it. Only
import site is container/ego-browser/daemon.ts:11, resolved through
ego-browser's own manifest (pinned 1.63.0, installed in-image by
Dockerfile.studio's `bun install --production`).

## Trap the sweep missed (mutation-proven 2026-10-13)

`bun run check` runs `tsc -p container`; container/tsconfig includes
`**/*.ts`, so daemon.ts is typechecked, and the root manifest is the
lock's SOLE playwright-core importer. Plain removal + fresh `bun install`
prunes the hoisted node_modules/playwright-core and check goes red
(TS7006/TS2322 in daemon.ts, seen in a detached worktree).

## Fix: register ego-browser as the root's one workspace

- package.json: drop the dependencies line; add
  `"workspaces": ["container/ego-browser"]`.
- `bun install` regenerates bun.lock: root deps entry gone; workspace
  entry added; playwright-core stays in the lock only as ego-browser's
  own dep, installed at container/ego-browser/node_modules — where
  daemon.ts resolves it for typecheck and local runs. Studio image
  unchanged: apps/fleet/.dockerignore already carries `**/node_modules`,
  and AgentDO/DeployDO contexts COPY named files only.
- Comment sync (task ask): Dockerfile.studio:255-256 and
  scripts/localci/Dockerfile:39 point their "pinned to the exact
  playwright-core version" wording at ego-browser's own package.json,
  the pin's only source now.

## Verification

- import grep across src/cli/test/test-integration/scripts/page: 0 hits
- `bun run check` → 0 (the gate plain removal broke)
- `bun run english-check` → clean
- `bun run test-lies-check` → 0
- lock diff: root deps line removed, workspace entry added, no version churn

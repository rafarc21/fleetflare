# Skip-Permissions + CTO Effort Default — Report

Operator directive 2026-08-19. Two changes. Not deployed — controller deploys after review.

Branch: `35-terminal-watch`. Commits: `1a0655e`, `0ba2e67`, `06ac324` (feat, all three, `apps/fleet`).

## Status

Both changes done. Full suite green. Type-check clean. Image smoke PASS.

## Change 1 — skip-permissions on every claude launch

Precondition (controller-verified, not re-litigated): `IS_SANDBOX=1` unlocks `--dangerously-skip-permissions` as root on pinned `@anthropic-ai/claude-code@2.1.224`. Without it: refused. With it: launches, stops at `/login`.

### Files

- `container/studio-bringup.sh` — `claude_args+=(--dangerously-skip-permissions)`, unconditional. Added right after `claude_args=()`, before the `--continue` guard. Security comment above it (condensed operator text). `--allowedTools` line untouched, still passed after.
- `container/server.ts` — `"--dangerously-skip-permissions"` appended to `runClaude`'s argv (after `--allowedTools`). Comment above rewritten: kept the historical "rejected as root" finding, added a new paragraph for the `IS_SANDBOX=1` unlock, reframed `--allowedTools` as belt-and-braces, not the sole guard. Historical insight preserved, not deleted.
- `container/Dockerfile.studio` — `ENV IS_SANDBOX=1`, right after `FROM`, before the first `RUN`. Security comment above it.
- `container/Dockerfile` — `ENV IS_SANDBOX=1`, right before the existing `ENV PORT=8080`. Security comment above it.
- `container/Dockerfile.deploy` — untouched (no claude in that image; per instruction).

Condensed security comment (operator's text, placed at both claude-launch sites — studio-bringup.sh and server.ts): IS_SANDBOX=1 unlocks the flag as root, verified on pinned 2.1.224. Honest: Firecracker microVM. Safe: no Cloudflare creds in-container, only a 1h-scoped GitHub App token; merge/deploy gated by the Worker's approval flow, never claude's own prompts.

## Change 2 — CTO effort defaults to max

### Files

- `src/studio/blueprint.ts`:
  - `Role.effort?: string` added. Doc comment: validated when present, cto→max default applied downstream (roleBringupEnv), not here.
  - `parseRoleFile`: new `VALID_EFFORT_LEVELS` (`low|medium|high|xhigh|max`). Present-and-invalid (including blank, since `""` isn't a valid level) → `BlueprintError("effort", ...)`. Absent → `undefined`, no error.
  - `roleBringupEnv`: now returns three keys. `ROLE_EFFORT: role.effort ?? (role.name === "cto" ? "max" : "")`. Doc comment updated ("two env vars" → "three").
- `src/studio/provision.ts`:
  - `RoleEnv` type gains `ROLE_EFFORT: string`. Doc comment updated ("fixed pair" → "fixed triple").
  - Verified the flow-through by hand: `resolveBringupEnv` returns `roleBringupEnv(role)` whole, no destructuring. `runProvision` passes `resolved.bringupEnv` whole to `deps.sbExec(BRINGUP_CMD, ...)` and to `storage.put(ROLE_ENV_KEY, roleEnv)`. `restartWithStorage` reads `ROLE_ENV_KEY` back whole and passes it straight to `runRestart` → `sbExec(BRINGUP_CMD, roleEnv)`. Nothing enumerates the three keys anywhere on this path — ROLE_EFFORT survives provision AND restart by construction, not by extra plumbing.
- `container/studio-bringup.sh` — after the `--allowedTools` line: `[ -n "${ROLE_EFFORT:-}" ] && claude_args+=(--effort "$ROLE_EFFORT")`. Empty → no flag → claude's own default.

No real blueprint content changed. `fleet.json` has no `"cto"` role yet (checked: `roles: ["pilot", "scratch"]`), and no `fleet/blueprint/roles/cto.md` exists. Out of scope here — operator's file list never named `fleet.json` or a new role file. This PR ships the mechanism only; a real cto role provisions with `ROLE_EFFORT=max` automatically once one is added, with zero further code change.

## Tests

40 files, 817 tests, all green (`bun run test`, exit 0). `bun run check` clean (`tsc --noEmit` root + `-p container` + `-p cli` + `-p test-integration`, zero errors).

New/changed, by file:

- `test/studio.blueprint.test.ts` — new describe `optional role field: effort`: absent→undefined, all 5 valid levels parse, invalid→`BlueprintError` naming `"effort"`, blank→same. New describe `roleBringupEnv — ROLE_EFFORT`: cto absent→`"max"`, non-cto absent→`""`, cto explicit `"high"`→`"high"` (wins over default), non-cto explicit→that value.
- `test/studio.routes.test.ts` — extended the Task-11 provision test with a `ROLE_EFFORT === ""` assertion (pilot, non-cto). New describe `provisionWithStorage resolves ROLE_EFFORT`: a synthetic cto role provisions end-to-end through the real `provisionWithStorage`, `ROLE_EFFORT` lands `"max"` in the bring-up exec env AND in persisted `ROLE_ENV_KEY`. Two pre-existing `RoleEnv` literals (restart tests) gained `ROLE_EFFORT: ""`.
- `test/studio.refresh.test.ts` — `seedRoleEnv` helper and one inline literal gained `ROLE_EFFORT: ""` (compile-required, `RoleEnv` is now a 3-key type).
- `test/studio.session.test.ts` — two `fakeCombinedStorage` seeds gained `ROLE_EFFORT: ""`. New describe `container/studio-bringup.sh — claude launch: skip-permissions + effort`: `--dangerously-skip-permissions` present unconditionally; `--effort` present behind the `${ROLE_EFFORT:-}` guard; `--allowedTools` line unchanged; ordering check (skip-permissions before `--continue` guard, effort after allowedTools, both inside `claude_args` before `cmd_str` assembly).
- `test/container.args.test.ts` — flipped the old "never passes a permission bypass" test (asserted absence) to assert presence of `--dangerously-skip-permissions`, still asserts absence of the unverified `bypassPermissions` spelling. New describe `container images pin ENV IS_SANDBOX=1`: both Dockerfile and Dockerfile.studio source text contain the line. Backing wiring: `vitest.config.ts` reads both Dockerfiles as text (`TEST_DOCKERFILE_STUDIO_SRC`, `TEST_DOCKERFILE_TASK_SRC`, same "no filesystem in workerd" pattern as the existing `TEST_CONTAINER_SERVER_SRC`/`TEST_STUDIO_BRINGUP_SRC`), `test/env.d.ts` typed.
- `test-integration/attach.e2e.ts` — NOT touched. It's outside `bun run test` (`vitest run`); it's a separate real-infra e2e suite (`bun run test:integration`, needs a live container + tailscale) I cannot run here. It asserts presence of `ROLE_PROMPT_B64`/`ROLE_ALLOWED_TOOLS` in the tmux server env but not `ROLE_EFFORT` — flagged below as a gap, not silently skipped.

## Image smoke test (required)

```
cd apps/fleet
docker build -f container/Dockerfile.studio -t studio-skipperm .
docker run --rm --entrypoint bash studio-skipperm -c 'echo IS_SANDBOX=$IS_SANDBOX; claude --dangerously-skip-permissions -p "hi" 2>&1 | head -3'
```

Build: succeeded (one warning, harmless — host is arm64/OrbStack, base image `cloudflare/sandbox:0.12.7` is amd64-only, so the run below is under emulation; no bearing on the result).

Run output (verbatim):

```
WARNING: The requested image's platform (linux/amd64) does not match the detected host platform (linux/arm64/v8) and no specific platform was requested
IS_SANDBOX=1
Not logged in · Please run /login
```

PASS. `IS_SANDBOX=1` confirmed baked in. No "cannot be used with root/sudo privileges" refusal — claude passed the root-permission check and stopped only at auth, exactly the documented pass condition.

## Self-review

- Both changes implemented exactly as specified, file by file, line by line.
- Scope held: `src/agents/`, `src/deploy/`, `src/tasks/`, `container/deploy-server.ts`, `container/Dockerfile.deploy` — all untouched (checked via `git diff --stat`, confirmed absent).
- `bun` only throughout (`bun install`, `bun run test`, `bun run check`); `docker` for the smoke test only (not a JS toolchain call).
- Historical comment in `server.ts` rewritten, not deleted — the old "rejected under root" finding stays on record with today's date next to the superseding one.
- Condensed security comment placed at both claude-launch sites (studio-bringup.sh, server.ts), as instructed.
- `RoleEnv` gaining a required (non-optional) `ROLE_EFFORT: string` field meant every existing test literal of that shape needed the key added, or `bun run check` fails. Found and fixed all six sites (grepped `ROLE_PROMPT_B64` across `src/` and `test/` twice, before and after, to confirm none left).
- Three commits, each `feat(fleet)`, conventional format. Commit 1 = pure Change 1 (six files, zero Change-2 content). Commit 2 = pure Change 2 core logic (five files). Commit 3 = the one file that legitimately carries both (`studio-bringup.sh` — the two new lines sit three lines apart in the same block) plus its matching source-pin test. No interactive git tooling available in this environment to hunk-split a single file across commits more finely than that; three commits was the cleanest honest split.

## Concerns

- `test-integration/attach.e2e.ts` doesn't check for `ROLE_EFFORT` in the container's tmux-server environment (only the original two vars). Not fixed — out of the operator's explicit file list, needs live infra to run/verify, and I have none here. Low risk: it's an existence check, not a negative one, so it doesn't fail; a future task should add it while touching that file for something else.
- No real `cto` role exists yet in `fleet.json` / `fleet/blueprint/roles/`. The `--effort max` default is fully implemented and unit/integration-tested against synthetic fixtures, but has never resolved against real blueprint content because there is no real cto role to provision. Confirmed deliberately out of scope (operator's file list never named `fleet.json` or a new role file) — flagging so it isn't mistaken for "CTO studios already get max effort in production today."
- Docker image smoke ran under amd64 emulation on an arm64 host (OrbStack warning). Functionally irrelevant to what's being proven (the root/IS_SANDBOX permission check, not performance), but noting for the record since the operator asked for the real image, not a substitute.
- `--effort` itself (as a claude CLI flag) is pre-existing in this codebase (`server.ts` already used `"--effort", "high"` before this task) — its acceptance of `low/medium/high/xhigh/max` is trusted from that prior usage and the operator's own spec, not independently re-verified against a live claude binary in this task (the image smoke test only exercises `--dangerously-skip-permissions`, not `--effort`, per the operator's given smoke command).

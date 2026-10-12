# Fix #519: nine silent catches gain one log line each (sweep 13, S13-F5)

Refs #482, closes #519. One log line or narrowed catch per site, zero control-flow change, zero new deps.

## Problem
Sweep 13 (issue #482) flagged nine deliberate-but-silent catches. Each keeps its current behavior and gains only a log line (or, where the task says so, a narrowed catch / comment only).

## Sites and exact treatment
1. apps/fleet/src/github/webhook.ts:166 — wakeMaestro's JSON.parse(body) catch drops unparseable payloads silently → add `console.warn("board: wake skipped: webhook body not JSON", ...)` inside the catch before `return`. Keep swallow.
2. apps/fleet/src/studio/terminal.ts:211 — `void pending?.then((pty) => pty.close()).catch(() => {})` → log the real close error: `.catch((err) => console.error("studio terminal pty close failed", err))`. No `.catch` at all when `pending` is undefined — keep optional-chain shape.
3. apps/fleet/src/llm/anthropic-route.ts:567 — `.finally(() => { writer.close().catch(() => {}); })` → `.catch((e) => console.error("[glm-lead] writer close failed after stream end", e instanceof Error ? e.message : String(e)))`. Keep swallow.
4. apps/fleet/src/llm/anthropic-route.ts:462 — logUsage's `insertJuniorUsage(...).catch(() => {})` → `.catch((e) => console.error("[glm-lead] usage insert failed", e instanceof Error ? e.message : String(e)))`. Keep swallow, keep `ctx.waitUntil`.
5. apps/fleet/src/junior/route.ts:222 — same treatment as 4: log insert failure in the `.catch`, keep swallow, keep `ctx.waitUntil`. Update the stale comment block above it that still says "The insert's own `.catch(() => {})` still means..." to match.
6. apps/fleet/cli/paste-mac.ts:30 — `await file.delete().catch(() => {})` → log every cause EXCEPT ENOENT (ENOENT = the tmp file never existed / already gone = silent, matching the task's "keep ENOENT silent"). The line-32 outer catch (Bun.spawn ENOENT) stays silent — that is the pngpaste-missing case the brief's ctrl-v policy explicitly treats as "no image".
7. apps/fleet/cli/orca-workspace.ts:1267 — fileLockAt release `unlinkSync(path)` catch → log every error EXCEPT ENOENT (the raced stale-lock steal, already commented). Keep swallow.
8. apps/fleet/src/board/board.ts:508 — addStateAfterRemove first addLabels attempt catch → add `console.warn(\`board: task #${number} add "${to}" failed, retrying once\`, err)` before falling through to the retry. Keep swallow of the first attempt.
9. apps/fleet/src/studio/frames.ts:10 — bare `catch {}` is deliberate (non-JSON resize frame = "ignore" frame). Comment only: annotate the catch as deliberate. No behavior change.

## Skipped (operator order, task reassignment comment)
- apps/fleet/cli/fleet.ts:2138 — rescue-all runner catch. Operator reassignment: "SKIP any catch in auth/credentials/rescue/failover/accounts/deploy/approvals/wake-gate files — list skipped in PR body."

## Tests (RED first, one per site, all pin the log call and unchanged behavior)
All vitest files spy console.warn/console.error via `vi.spyOn`, restore in afterEach (file-local pattern already used in github.webhook.test.ts / board.board.test.ts).
- test/github.webhook.test.ts: post a validly-signed non-JSON body with event "push" → status 200, one `console.warn` call, zero wakes. (There is an existing test asserting 200-no-crash at line ~205; extend, don't duplicate.)
- test/board.board.test.ts: fakeApi addLabels rejects once then succeeds → transition still completes, one warn before the retry. Existing retry test exists; add the warn pin to it.
- test/studio.frames.test.ts: parseFrame("{not json") → still `{type: "ignore"}` (comment-only site — pin the unchanged contract only if not already pinned; grep first, skip if pinned).
- test/llm.anthropic-route.test.ts: 3 = logUsage insert fails (mock insertJuniorUsage to reject) → response unaffected, one console.error; 4 = writer.close rejects after pump → stream response still fine, one console.error.
- test/junior.route.test.ts: insertJuniorUsage rejects → 200 response with error body intact, one console.error.
- test/bun/ — terminal.ts, paste-mac.ts, orca-workspace.ts are bun tests: add pins to test/bun/ harnesses (find existing: studio.ws-close-idempotent, orca-workspace.test, any paste test). terminal.ts close: call close(ws) with a pty promise rejecting on .close() → one console.error, no unhandled rejection. paste-mac: delete rejects non-ENOENT → one stderr line, still returns bytes. orca-workspace: release unlink fails EPERM → logs, fn still resolves.

## Verification (one heavy gate at a time, never parallel)
1. `cd apps/fleet && bun test test/bun/` for the three bun-touched harnesses + `vitest run` for the vitest-touched files (targeted: github.webhook, board.board, studio.frames, llm.anthropic-route, junior.route, studio.ws-close-idempotent, orca-workspace, paste tests). Run each targeted suite green.
2. `bun run check` (tsc x5, one gate) — exit 0.
3. `bun run english-check` — clean.
4. Full suite belongs to CI/merge gate; never run alongside a build.

## Boundaries
- Log line only, no control-flow change, no new deps, no test-framework swap.
- Every console line: repo-style lowercase prefix, no secrets, no tokens, no client names.
- Heavy gates serial: tests → check → english-check. Never parallel.

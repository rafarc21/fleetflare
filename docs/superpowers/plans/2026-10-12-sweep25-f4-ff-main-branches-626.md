# Sweep 25 F4: extract main() branches in apps/fleet/cli/ff.ts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink module-private `main` in apps/fleet/cli/ff.ts (135-line body, `:449-583` in this tree; sweep-25 census cited `:448` at base `30bceb7` — a `#580` help-header line shifted it by one) by lifting the two named branches into same-module private helpers, zero behavior change, byte-identical output order.

**Architecture:** Same-module extraction ONLY — `attachFastOrProvision` and `spawnNewStudio` become new module-private functions in cli/ff.ts, placed with the other helpers just before the "entry point" section. No new files, no new exports (main is import-guarded; helpers stay private). `fileTask` and `ffSpawnNew` stay exported and untouched.

**Spec:** board issue https://github.com/rafarc21/fleetflare/issues/626 and finding S25-F4 in docs/maintainability/2026-10-12-oversized-functions-sweep-25.md (Batch D).

## Global Constraints

- Zero behavior change: every `say`/`fail` line, exact text, exact ORDER, and every exit path (`fail` and the explicit `process.exit(1)`s) moves verbatim into the lifted function; comments move with their code.
- `attachFastOrProvision(...)` — lifts the `decision.kind === "attach"` branch (this tree `:513-551`): readOutcome container check; provisioned/unverified → `${id}: ${note} — attaching` say + the two wake-hint lines when task !== null → final attach itself; else "provisioning it" say + provisionStudio, returning the id so main falls through to the shared wait. Return type `Promise<{ handedOff: true } | { id: string }>`: `{ handedOff: true }` when the helper did the final attachOrHandOff itself (main just returns), `{ id }` when it provisioned instead (main falls through to waitProvisioned + attachOrHandOff). This shape keeps every output line and exit path byte-identical — main's return paths stay the same two they are today.
- `spawnNewStudio(...)` — lifts the `isNew` sub-branch (this tree `:553-565`): the `--new: spawning the next free ...` say, the ffSpawnNew call with its four wired deps closures (spawn/wait/file/adopt), `if (spawned === null) process.exit(1)`, the `if that said NO WAKE` task-hint say, and the final attach itself. Same `{ handedOff: true } | { id: string }` shape (it always attaches itself or exits, so it always returns `{ handedOff: true }`; uniform type keeps main's dispatch one shape). Signature: creds, decision (spawn kind), parsed.role, parsed.task, detected.slug, startedAt.
- main keeps: parse/creds/repo-detect/decision/pre-spawn filing/startedAt anchor + thin dispatch (`if attach → await attachFastOrProvision(...)`, if handedOff return; else id = ...; same for spawn/--new; plain-spawn and exists-but-not-provisioned branches stay inline — they are 2 and 3 lines) + final waitProvisioned/attachOrHandOff.
- No new tests (fold-only): the net is the 4 existing ff suites. Baseline measured 2026-10-12 on this branch: `bun test test/bun/ff-no-tty.test.ts test/bun/ff-new-main.test.ts test/bun/ff-new-race.test.ts test/bun/ff-file-task-retry.test.ts` → 10 pass, 0 fail, 35 expect() calls, 4 files. Must reproduce EXACTLY post-extraction.
- Guardrails from the issue: keep output ORDER — test/bun/ff-new-main.test.ts pins filing-after-spawn POST order; test/bun/ff-no-tty.test.ts pins stderr content + WS never opened.
- Heavy-gate budget: `bun run check` (repo tsc) runs ONCE at the end, under `flock /tmp/fleet-gate.lock`, never alongside another gate. RED mutations of pinned output run alone, one at a time.
- All repository content English. Conventional Commits, `refs #626` trailer.

---

### Task 1: this plan doc
- [ ] Commit this file alone: `docs(fleet): S25-F4 plan — ff.ts main branch extraction (refs #626)`.

### Task 2: extraction in apps/fleet/cli/ff.ts
- [ ] Step 1: run the 4-suite baseline command above; confirm 10 pass / 0 fail / 35 expect() calls.
- [ ] Step 2: add `attachFastOrProvision` before the entry-point section, moving the attach-branch body verbatim with its comments; main's attach arm becomes `const a = await attachFastOrProvision(...); if ("handedOff" in a) return; id = a.id;`.
- [ ] Step 3: add `spawnNewStudio` the same way; main's `--new` arm becomes the same dispatch shape.
- [ ] Step 4: run the 4 suites again → identical counts (10/0/35, 4 files).
- [ ] Step 5 (RED, run alone): temporarily drop the `if that said NO WAKE, tell it:` hint line from the lifted spawnNewStudio → run test/bun/ff-no-tty.test.ts and confirm the stderr-content test still passes (the no-task form does not print the hint) but test/bun/ff-new-main.test.ts still passes too — the hint is only printed with a task, so the honest mutation is instead to drop the wake-hint lines inside attachFastOrProvision when task !== null, and the honest pinning suite for spawnNewStudio's wiring is ff-new-main itself: mutate the spawned.task-hint condition to fire even when null (a say added where none belongs does not fail that suite, so the wiring proof is typecheck + the byte-identical POST order). State plainly in the commit-adjacent notes: ffSpawnNew's own race suite (ff-new-race.test.ts, 4 tests) owns the filed-after-spawn contract; the lift only re-wires deps, so the RED proof is the pinned ff-new-main subprocess run passing with the wiring intact plus the typecheck. Revert every mutation; re-run 4 suites → 10/0/35.
- [ ] Step 6: commit `refactor(fleet): S25-F4 extract attachFastOrProvision + spawnNewStudio from ff.ts main (refs #626)`; push `LEFTHOOK=0 git push`.

### Task 3: full gate (one at a time)
- [ ] `flock /tmp/fleet-gate.lock bun run check` (from apps/fleet) → exit 0.
- [ ] `bun run scripts/english-check.ts` → `english-check: clean`.
- [ ] `bun run scripts/test-lies-check.ts` → clean.
- [ ] Record the three real outputs verbatim for the completion record.

### Task 4: verification evidence
- [ ] Collect for the done record: the 4-suite run output, the three gate outputs, plus git log of the two commits.

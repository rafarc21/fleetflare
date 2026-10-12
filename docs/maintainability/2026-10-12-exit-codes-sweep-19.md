# Exit-codes sweep 19 — apps/fleet/cli (2026-10-12)

Ref #539. Analysis only, read-only, no code changed. Nineteenth maintainability sweep: failure paths that print and exit 0; success output on stderr; error output on stdout (breaks `fleet ls | jq`); inconsistent exit codes for the same failure class across commands. Scope `apps/fleet/cli/**`. Line refs = physical lines at `origin/main` 13f445f, paths relative to repo root.

Sweeps 1-18 (docs/maintainability/*.md) and the issues they filed are NOT repeated here.

**Tier rule (from #539):** GLM-OK = none of auth, secrets, credentials, rescue, failover, accounts routing, deploy. CLAUDE-ONLY = touches any of those.

## Method

Every command-carrying file in cli/ read in full: fleet.ts (all 3076 lines), ff.ts, accounts.ts, junior.ts, orca-workspace.ts, reap.ts, destroy-outcome.ts, recycle-outcome.ts, status-poll.ts, inspect-request.ts, task-new-retry.ts, repair-failure.ts, diag.ts, reap-terminal.ts, junior-sweep.ts, poll.ts, context-salvage.ts, task-format.ts. For every exit site (`process.exit`, `process.exitCode`, an `exitCode` field a caller passes through), the writer (stdout vs stderr) and the non-zero-vs-zero decision were read; test pins were grepped in test/ and test/bun/ (`exitCode`, `exit(1)`, `r.code`). The codebase is largely disciplined — several candidate findings were verified CLEAN and are recorded as such so the next sweep does not re-derive them.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | `cli/fleet.ts:1797` — task verify: all-attempted-failed envelope exits 0 | GLM-OK |
| 2 | `cli/fleet.ts:1899` + `src/studio/task-reap.ts:189` — reap --terminal: failed closes print as `skipped`, exit 0 | GLM-OK |
| 3 | `cli/fleet.ts:2649` — paste: one-shot failure line owned by main()'s generic catch, no `fleet paste:` prefix | GLM-OK |
| 4 | `cli/fleet.ts:2629` — memory compact: 200-non-JSON body crashes through JSON.parse, PR outcome never named | GLM-OK |
| 5 | `cli/fleet.ts:2578` — memory ls: unguarded `res.json()` + bare cast on the 200 path | GLM-OK |
| 6 | `cli/junior.ts:72` — junior status: foreign symlink prints "no (foreign dir in the way)" as ok:true, exit 0 | GLM-OK |

Verified-clean (recorded, nothing filed): `fleet ls --json` stdout contract (one blob, every degrade warning on stderr) — the `fleet ls | jq` surface is clean; `fleet onboard` FAIL lines on stdout with exit 1 on !allPass (report IS the output); `fleet tabs` cancelled = ok:true/exit 0 (a y/N refusal is a successful command); `ff` say() lines on stderr (stdout belongs to the attached pty stream, file header states the contract); `fleet accounts --watch` no-change heartbeat on stderr (keeps --json stdout valid); the check/clear-session-guard/inspect trio's refusal handling; destroy/recycle outcome modules' exit-code contracts (1 = verdict, 2 = recycle unknown, pinned by test/cli.destroy-outcome.test.ts:154, test/cli.recycle-outcome.test.ts:117,296).

### F1. cli/fleet.ts:1797-1811 — task verify: a fully-failed envelope exits 0 — GLM-OK

- **Site:** cmdTaskVerify prints the envelope header, one icon line per result (`✅ attempted-ok`, `❌ attempted-failed`, `➖` other), then `comment: <url>` — and returns. No exit decision anywhere in the function.
- **Risk:** `fleet task verify` is the mechanical check of a §6 envelope — the same envelope a board gate reads as FAILED. An operator (or script) running it gets the ❌ lines on stdout and `$? = 0`. Every other check verb in this CLI exits non-zero when the thing it checked failed: `fleet reap` (board floor/refusals, exit 1), `fleet rescue-all` (UNSAFE, exit 1), `fleet onboard` (!allPass, exit 1), `fleet check` (refused route, exit 1).
- **Current:** exit 0 always; verdicts on stdout (right — they are the report).
- **Proposed:** after the print loop, exit 1 when any `r.verdict === "attempted-failed"`; an only-`not-mechanically-checkable` result stays 0 (that is "no check ran", not "check failed").
- **Test pin:** test/bun/cli.task-verify.test.ts pins exit 0 + lines on the happy path (:101) and 500→exit 1 (:133). NO test pins a failed-verdict exit — the gap this issue owns.

### F2. cli/fleet.ts:1899-1916 + src/studio/task-reap.ts:189 — reap --terminal: a failed close prints as `skipped`, exit 0 — GLM-OK

- **Site:** the `--terminal` branch prints `  #<n> (state): <outcome> as <reason> — <error>` per row. runTaskReap folds a close that THREW or answered `ok:false` into `outcome: "skipped"` with the error text in `reason` (task-reap.ts:189) — the same word as a deliberate skip ("parked input_required", task-reap.ts:106). A GitHub-side close failure and an intentional park are indistinguishable both in the line and in `$?`: cmdTaskReap's terminal branch always exits 0, and reapTerminalAll (cli/reap-terminal.ts) stops at the first non-progressing page either way.
- **Risk:** the `--terminal` half exists to close issues a studio left in a terminal state; a batch where every close failed with `close failed: <github 5xx>` prints five lines an operator can mistake for handled rows, with a green exit code. The route names the error — the CLI gives no machine signal any close failed.
- **Proposed:** task-reap.ts marks a real close failure with its own outcome value (e.g. `failed`) instead of overloading `skipped` — pure, already unit-tested at test/studio.task-reap.test.ts, which would be extended — and cmdTaskReap's terminal branch exits 1 when any row is `failed`, mirroring rescue-all's failures counter. Deliberate skips stay 0. Non-terminal `task reap` keeps its current all-outcomes-on-stdout exit-0 shape (which rows count as failures there is the Worker's policy call, out of this sweep).
- **Test pin:** test/cli.reap-terminal.test.ts pins paging only; test/studio.task-reap.test.ts pins outcomes but not the CLI exit. Nothing pins a failed-close exit.

### F3. cli/fleet.ts:2649-2656 — paste: the one-shot failure line has no owner — GLM-OK

- **Site:** cmdPaste calls `uploadPaste` with no catch; on failure the throw propagates to main()'s generic catch (fleet.ts:3072), which prints `fleet: <message>` and exits 1.
- **Risk:** behavior today is correct (stderr, exit 1), but the actionable line is owned by a catch 400 lines away. The attach path's identical failure prints a DIFFERENT shape (`\r\n[fleet] paste upload failed: ...\r\n`, fleet.ts:2754 — deliberate, alt-screen), and a paste is the one verb where `fleet paste:` cannot be grepped for because no frame owns it. Same class as S19-F4: a decode/failure line that belongs to the command, not the top-level net.
- **Proposed:** catch inside cmdPaste, print `fleet paste: ${errText(err)}` to stderr, exit 1 — the same posture cmdMemoryCompact takes for its own fetch (fleet.ts:2625). Low priority.
- **Test pin:** none — no test file touches cmdPaste.

### F4. cli/fleet.ts:2629 — memory compact: 200-but-not-JSON crashes with no command name, PR outcome never prints — GLM-OK

- **Site:** `const body = JSON.parse(text) as {...}` — no try/catch after the `!res.ok` branch exited. A 200 with a non-JSON body (a proxy error page, a truncated response) throws into main()'s catch: `fleet: <SyntaxError>`, exit 1.
- **Risk:** the compact is the one memory verb with a durable artifact — the Worker already opened the PR server-side; the CLI merely failed to read the answer. The generic line names neither the command nor that the pass may have landed, and the actionable half (check the repo's open PRs) never prints. Every sibling decode in this file owns its own 200-guard: cmdLs (parseStudioStatusArray → named line + exit 1, fleet.ts:892-896), cmdSpawn/cmdProvision, destroy/recycle reports (parseStudioStatus null → named line inside the report).
- **Proposed:** guard it: on parse failure print `fleet memory compact: 200 but the body was not JSON — the pass may have landed; check the board repo's open PRs` and exit 1.
- **Test pin:** test/bun/memory-cmd.test.ts pins the compact success lines and the !res.ok exit-1; nothing pins the 200-non-JSON case.

### F5. cli/fleet.ts:2578-2581 — memory ls: same unguarded 200-decode on the read half — GLM-OK

- **Site:** `const body = (await res.json()) as {...}` — res.json() throws on non-JSON (generic main() catch line), and the bare cast means a wrong-shaped 200 body (missing `files`) makes `formatMemoryTable(body.files)` throw a TypeError into the same catch.
- **Risk:** identical crash shape to F4 on the survey verb; the operator reads `fleet: Cannot read properties of undefined` with no command name. This is the read an agent runs BEFORE proposing anything (the file's own header says so), i.e. the path most likely to run inside a script.
- **Proposed:** mirror cmdLs exactly — a shape check printing `fleet memory ls: answered 200 but the body was not the survey shape` + exit 1. One guard, same line shape as every other read verb.
- **Test pin:** test/bun/memory-cmd.test.ts pins survey rendering and the 500 path (:166); nothing pins a malformed-200.

### F6. cli/junior.ts:72-81 + 93 — junior status: a foreign symlink is a healthy exit — GLM-OK

- **Site:** `juniorStatus` returns `ok: true` unconditionally; a foreign dir in the way prints `enabled: no (foreign dir in the way)` through the ok-branch's `console.log`, and `fleet junior status` exits 0.
- **Risk:** status is the DIAGNOSTIC verb — the one a script would call to check junior's health, and the only one that cannot say unhealthy. `enable` and `disable` return `ok: false` for the identical foreign-dir condition (stderr + exit 1). A broken installation reads as a successful status query.
- **Proposed:** juniorStatus returns `ok: state === "ours"`; the foreign case's line prints via console.error and exits 1. `state === "absent"` (disabled cleanly) stays ok — that is healthy-and-off, the ordinary case.
- **Test pin:** test/bun/junior-local-cli.test.ts pins enable/disable outcomes and the config path; nothing pins status's exit code on a foreign dir.

## CLAUDE-ONLY (read, nothing filed)

- Credentials trio `loadCredentials`/`loadCredentialsIfPresent`/`tryLoadCredentials` (cli/fleet.ts:92-220): exit-1 / null / {error} contracts all correct and documented. No defect.
- accounts.ts: fetch failures throw with `fleet accounts`-prefixed messages, caught at the command edge → stderr + exit 1, consistently; the `--watch` loop's per-iteration catch is deliberate (issue #232 item 4). No defect.
- rescue-all (#20/#359): exit 1 + UNSAFE on stderr is the pre-deploy gate contract, pinned by test/bun/rescue-all-scope.test.ts:465. Not in this sweep's filed set.

## Proposed follow-ups

One issue per batch, `fix(GLM-OK): S19-Fn <short>`, refs #539, no closing keywords:

- **S19-F1** task verify: exit 1 when any verdict is attempted-failed (finding 1)
- **S19-F2** task reap --terminal: real close failures get their own outcome value + exit 1 (finding 2)
- **S19-F3** paste: own the failure line inside cmdPaste (finding 3)
- **S19-F4** memory compact + ls: guard both 200-body decodes (findings 4+5, one issue — same guard shape both halves)
- **S19-F5** junior status: foreign symlink returns ok:false, exit 1 (finding 6)

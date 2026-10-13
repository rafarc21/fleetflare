# Test-names-vs-assertions sweep 38 — apps/fleet test (2026-10-13)

Ref #741. Analysis only, read-only, no code changed. Thirty-eighth
maintainability sweep; scope `apps/fleet/test/**` and `apps/fleet/test/bun/**`
(364 test files, 8,304 it()/test() calls). Line refs = physical lines at
origin/main `0cd438f`, paths relative to `apps/fleet/test/` unless rooted.

Method: machine pass first (awk-extracted every it()/test() block whose title
carries a refusal/negation/never/always/only/naming/universal claim — 450 raw
candidates from 2,248 strong-verb titles), then hand-read of ~95 full test
bodies across board, github, studio, cli, approvals, creds, leak, deploy,
write-proxy, rescue and bun/ modules. Each candidate checked for: the claimed
refusal actually asserted (status/error/mock-not-called), the claimed
"never X" clause backed by its own assertion, named values asserted by
content, and fixture values matching the title's stated condition.

**Ruled out (verified accurate, no finding):** ~85 strong-claim titles whose
bodies fully back every clause — board.assign's refusal chain (58: closed-
issue 409 + addLabels/removeLabel not called; 79/89: vocabulary 400 with
getIssue not called; 120/130: 409 naming the labels found; 107: 409 naming
both states; 974: getIssue never called; 980: two-state loop, addLabels not
called), board.brief 26/35/42/53 (each missing section named in the message,
title fixture `TASK_TITLE_MAX + 1` correct), github.api's throw family
(79/133/151/165/218/249/333/388/515/532/1239/1398 all assert the throw and
its message; 388/554 "never the token" backed by message-content checks
elsewhere in the file), approvals.gates 52/111/142/165/268/278 (non-operator:
executed empty + state pending; poisoned-UPDATE cases assert the exact
notice), junior/llm ratelimit blocking tests assert `{ok:false, limit:...}`,
creds.route 170/262 (503 + zero Infisical calls; audit rows checked for
secret absence), board.leak 72/80/154/184/195, destroy/recycle-guard
compound "NEVER attempts" titles (all four ports asserted uncalled),
studio.spawn 587/625/631/1339, studio.cli-args refusal family (usage result
asserted with the exact message), git-wrapper/leak-gate/wake-guard bun
refusals (exit codes + ref-state asserted), quiescence fail-CLOSED trio
(quiescent:false + reason content), install-cache command-text pins (their
titles describe command TEXT and the comments say so explicitly).

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | board.brief.test.ts:60 — "refuses a body over GitHub's limit": fixture AT the limit, not over it | GLM-OK |
| 2 | junior.ratelimit.test.ts:29 — "blocks the (default + 1)th call": body configures 2/min, not the default | GLM-OK |
| 3 | github.api.test.ts:554 — "token never in the message": no assertion checks the token | GLM-OK |
| 4 | board.assign.test.ts:541 — "never deletes a comment": only proves the fake lacks a deleteComment key | GLM-OK |
| 5 | container.studio-fleet.test.ts:169 — "no request is even built": nothing asserts request-building | GLM-OK |
| 6 | cli.fleet.test.ts:1285 — "ignores a rateLimited record entirely": asserts only the rendered dash | GLM-OK |
| 7 | state.test.ts:70 — "startsWith is what rejects it": decoy rejection asserted, startsWith never exercised | GLM-OK |

### S38-F1. board.brief.test.ts — "over GitHub's limit" tested AT the limit, not over it — GLM-OK

- **File:** `board.brief.test.ts:60` — it("refuses a body over GitHub's own issue body limit, naming the limit").
- **Actually asserted:** fixture is `"x".repeat(TASK_BODY_MAX)` — the objective section is EXACTLY 65,536 chars, the body only goes over the cap after renderTaskBody adds its section headers and footer. The refusal fires, but via template overhead the test never chose. The sibling title test at :53 spells the intended shape correctly with `TASK_TITLE_MAX + 1`.
- **Proposed fix:** fixture `"x".repeat(TASK_BODY_MAX + 1)` (same one-over shape as the title test), or retitle to "refuses a body at GitHub's own issue body limit once rendered".

### S38-F2. junior.ratelimit.test.ts — "(default + 1)th" claim against a configured limit — GLM-OK

- **File:** `junior.ratelimit.test.ts:29` — it("blocks the (default + 1)th call within the same minute").
- **Actually asserted:** body sets `JUNIOR_RATE_PER_MINUTE: "2"` and blocks the 3rd call — a CONFIGURED limit of 2, not the default of 5 (DEFAULT_JUNIOR_RATE_PER_MINUTE, src/junior/ratelimit.ts:22). The default IS driven for real elsewhere (llm.ratelimit.test.ts:38 loops the actual default), so the wording is borrowed, not the behavior. Title promises default-driven; body proves configured-driven.
- **Proposed fix:** retitle "blocks the (configured + 1)th call within the same minute" (matching its sibling at :73's honest spelling) — or drop the env override and loop the real default like llm.ratelimit.test.ts:38 does.

### S38-F3. github.api.test.ts — "token never in the message" never checked — GLM-OK

- **File:** `github.api.test.ts:554` — it("throws GitHub's own words on a non-2xx, token never in the message").
- **Actually asserted:** only `rejects.toThrow(/503/)`. No assertion inspects the thrown message for the token ("tok" is the literal token used at this call site). The twin at :388 makes the same claim and DOES check (`github.auth.test.ts:434` proves the pattern exists in this codebase).
- **Proposed fix:** add `await expect(...).rejects.toThrow` + catch and `expect(err.message).not.toContain("tok")` — the exact shape github.auth.test.ts's "never puts the token in the thrown message" uses — or drop the second clause from the title.

### S38-F4. board.assign.test.ts — "never deletes a comment" proven by the fake's key set, not by behavior — GLM-OK

- **File:** `board.assign.test.ts:541` — it("never deletes a comment — the dead studio's envelopes are the history").
- **Actually asserted:** `expect(Object.keys(api)).not.toContain("deleteComment")` — a statement about the TEST FIXTURE's shape (the BoardApi fake has no delete verb), plus createComment called once. The production type having no delete verb is real, but the test body never demonstrates anything about the code under test refusing a deletion; a reader of the title expects a deletion attempt to be refused.
- **Proposed fix:** retitle "the BoardApi port has no delete verb — history cannot be removed by this path", or assert against the type-level fact deliberately (e.g. an `expectTypeOf<BoardApi>()` shape pin) so the title names what is proven.

### S38-F5. container.studio-fleet.test.ts — "no request is even built" with nothing watching the request path — GLM-OK

- **File:** `container.studio-fleet.test.ts:169` — it("refuses `completed` in the CLI itself, naming who owns that verdict — no request is even built").
- **Actually asserted:** three `src()` substring checks against the CLI's bundled source text (the message, and the comment "the Worker refuses it too"). No harness intercepts the request layer, so "no request is even built" is an inference from prose, not an assertion. A future refactor that builds the request before refusing would still pass.
- **Proposed fix:** either drop the clause ("refuses `completed` in the CLI itself, naming who owns that verdict") or back it with a request-layer assert the way sibling tests in this file pin `env.token` headers.

### S38-F6. cli.fleet.test.ts — "ignores ... entirely" proven only by a rendered dash — GLM-OK

- **File:** `cli.fleet.test.ts:1285` — it("#403 table: a stopped studio ignores a rateLimited record entirely").
- **Actually asserted:** `formatActivity(s, NOW)` returns "—" for a stopped studio with a rateLimited record. "Entirely" claims more than one rendered cell can show: the row-level twin at :1504 checks lead/leadSince/limitResetsAt, but THIS test never inspects the record's absence from any other field. The word "entirely" is the claim; one string equality is the proof.
- **Proposed fix:** retitle "#403 table: a stopped studio renders — for its activity regardless of a rateLimited record" — or assert the row shape here the way :1504 does.

### S38-F7. state.test.ts — "startsWith is what rejects it" with the named mechanism never exercised — GLM-OK

- **File:** `state.test.ts:70` — it("LIKE's `_` wildcard hands back a same-length decoy; startsWith is what rejects it").
- **Actually asserted:** scanStateTaskKeys with prefix `ns:acme-org/we_bsite:` returns only the true row — the decoy is rejected, and the LIKE-wildcard explanation in the body's comment is real. But the second clause names the MECHANISM ("startsWith is what rejects it") and the body never exercises a startsWith check, distinguishes it from the exact-prefix compare actually in scanStateTaskKeys's impl, or proves which comparison killed the decoy — only that the final output excludes it.
- **Proposed fix:** retitle "LIKE's `_` wildcard hands back a same-length decoy; the exact-prefix re-check rejects it" (mechanism-free), or add a second assertion proving the rejection is the prefix compare (e.g. a decoy row that differs only after the prefix).

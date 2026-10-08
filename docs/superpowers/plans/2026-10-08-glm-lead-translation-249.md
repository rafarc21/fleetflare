# GLM-led studio: Anthropic<->OpenAI translation route (#249)

**Issue:** https://github.com/rafarc21/fleetflare/issues/249

**Scope of this dispatch:** route + translation only. Admission-gate bypass,
container env wiring (studioEnvVars, launchAccountOrRefuse call sites,
`lead: glm` studio field) is a separate, later dispatch on this same branch.
Not touching do.ts/accounts.ts/types.ts here.

## Goal

New route `POST /fleet/llm/anthropic/v1/messages`. Claude Code binary points
`ANTHROPIC_BASE_URL` here instead of real Anthropic. Translates both ways:

- in: Anthropic Messages API request (text/tool_use/tool_result blocks,
  top-level `system`, `tools` with `input_schema`).
- out: Workers AI GLM (`env.AI.run("@cf/zai-org/glm-5.3", ...)`), OpenAI
  chat-completions shape (`messages` role/content, `tools` function/parameters,
  `tool_choice`, `stream`).
- back: Anthropic Messages API response (non-stream JSON) or Anthropic SSE
  event sequence (stream).

## Auth

Spawn-token auth, same shape as `/fleet/junior` (`isSpawnTokenShaped` +
`resolveSpawnParent`, both reused from `studio/spawn.ts`, no reimplementation).
Difference: token arrives as `Authorization: Bearer <token>` (maestro decision
1) OR `x-api-key: <token>` (maestro's follow-up comment: accept both, cheap,
robust to client variance) instead of junior's custom header.

Not done in this dispatch: capturing the real header Claude Code's own binary
sends (the issue asks for this as part of the wider PR's live-proof
requirement) — flagged in the final report, not blocking the translation
work itself.

## Files

- `apps/fleet/src/http/capped-body.ts` — `readCappedBody` extracted verbatim
  out of `junior/route.ts` (mechanical, same cap-then-stream logic) so both
  routes import one copy instead of carrying two.
- `apps/fleet/src/llm/translate.ts` — pure functions, no `env`/`fetch`:
  - `anthropicRequestToOpenAI` (Anthropic request -> OpenAI chat body)
  - `openAIResponseToAnthropic` (OpenAI response -> Anthropic response)
  - `classifyAiError` (thrown message -> Anthropic error type/status, same
    unscoped substring match `junior/route.ts`'s `aiErrorCode` uses, adapted
    rather than imported since the two map to different output shapes)
  - stream state machine: `createStreamState`, `streamPrelude`,
    `applyOpenAIStreamChunk`, `closeStream` — OpenAI SSE delta chunks in,
    Anthropic SSE event strings out.
  - `parseSseDataLine` — split one `data: ...` line into a parsed chunk, the
    `"[DONE]"` sentinel, or null.
- `apps/fleet/src/llm/anthropic-route.ts` — `handleFleetAnthropicMessages`,
  mirrors `junior/route.ts`'s own shape: method/path checks, Content-Length
  cap, spawn-token auth, capped body read, JSON parse, translate, call
  `env.AI.run`, translate back, stream or single JSON response.
- Tests: `apps/fleet/test/bun/llm-translate.test.ts` (pure, bun:test, every
  translation direction + edge case) and `apps/fleet/test/llm.anthropic-route.test.ts`
  (vitest + cloudflare:test, HTTP/auth/framing layer, same convention as
  `apps/fleet/test/junior.route.test.ts`).

## Shape mapping (concrete)

Text: Anthropic `{role, content: "hi"}` <-> OpenAI `{role, content: "hi"}`.
`system` (string or text-block array) becomes one leading OpenAI
`{role:"system", content}` message.

tool_use (assistant turn): Anthropic content block `{type:"tool_use", id,
name, input}` -> OpenAI `tool_calls: [{id, type:"function", function:{name,
arguments: JSON.stringify(input)}}]` on that assistant message.

tool_result (user turn): Anthropic content block `{type:"tool_result",
tool_use_id, content, is_error?}` -> OpenAI `{role:"tool", tool_call_id,
content: <flattened text>}`. `is_error` has no OpenAI tool-message field;
flagged uncertain, prefixed into content as `"[error] "` rather than dropped.

Response: OpenAI `choices[0].message.content` -> Anthropic `content: [{type:
"text", text}]`; `tool_calls` -> `{type:"tool_use", id, name, input:
JSON.parse(arguments)}` blocks. `finish_reason` -> `stop_reason`: stop/
function_call -> end_turn/tool_use, length -> max_tokens, tool_calls ->
tool_use, content_filter -> end_turn (flagged uncertain — Anthropic has no
content_filter equivalent). `usage.prompt_tokens`/`completion_tokens` ->
`input_tokens`/`output_tokens`.

Streaming: `message_start` once, `content_block_start`/`content_block_delta`
(text_delta or input_json_delta)/`content_block_stop` per block (text block
first if any content arrives before the first tool call, one block per
OpenAI `tool_calls[].index`), `message_delta` (stop_reason + usage) then
`message_stop` once at stream end.

Errors: `env.AI.run` throw -> Anthropic `{type:"error", error:{type,
message}}`, status+type from `classifyAiError` (timeout -> 504/
`api_error`... see code comment for the exact table — kept deliberately
loose, same "unscoped substring, not a contract" posture `aiErrorCode`
documents for itself).

## Explicitly out of scope here (flagged, not silently dropped)

- The spec's "optional Anthropic-compatible passthrough" backend (provider
  base URL + key from a Worker secret) — this dispatch wires the Workers AI
  GLM path only.
- Image content blocks — Claude Code rarely sends them from a studio
  terminal; dropped with a code comment rather than guessed at.
- Admission gate / container env / `lead: glm` field — next dispatch.

## Dispatch 2 (2026-10-08, same branch): admission/lifecycle half

HEAD at start: f367c01. 5 commits, pushed after each.

### leadType field (studio-level, sticky)

`StudioStatus.leadType?: "claude"|"glm"` + `ProvisionConfig.leadType?: same`
(types.ts). Absent=claude, zero existing-test breakage. `resolveLeadType
(existing, cfgLeadType)` (do.ts): existing row wins, cfg only fills a first-
ever-provision gap (same shape ensureSpawnToken already uses for doClass).
`runProvision` (provision.ts) seeds it into the status spread with the
identical "existing wins" guard.

### ANTHROPIC_BASE_URL — verified live, NOT what the brief said

Maestro brief said `ANTHROPIC_BASE_URL = WORKER_PUBLIC_URL +
ANTHROPIC_MESSAGES_PATH` (the full `/v1/messages` path). Ran the REAL claude
binary (claude-cli 2.1.224) against a local echo server with
`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` — it requested
`POST /v1/messages?beta=true`. The Anthropic SDK inside claude appends
`/v1/messages` to the base URL ITSELF. Handing it the full route path would
double it to `.../v1/messages/v1/messages` — a 404. Fix: `glmAnthropicBaseUrl
(env)` (do.ts) = `WORKER_PUBLIC_URL + ANTHROPIC_MESSAGES_PATH.replace(/\/v1\
/messages$/, "")` — slices the known suffix off the IMPORTED constant (no
re-typed literal, no drift possible). Auth header confirmed too:
`Authorization: Bearer <token>` — matches what the prior dispatch already
built, no change needed there.

### studioEnvVars / launchFields — glm branch

Both gain a `leadType?: "claude"|"glm"` 5th param. glm: no
CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN=spawnToken,
ANTHROPIC_BASE_URL=glmAnthropicBaseUrl(env). launchFields's glm branch
ignores `name` (no claude account to derive one from), envAccount undefined.

### 4 admission-bypass call sites (do.ts)

provisionUngated (~6962), restartUngated (~7230), recycle's entry call
(discard-only, ~7418) and recycle's post-destroy closure (~7557) — each now
branches on `resolveLeadType(...)` BEFORE calling launchAccountOrRefuse at
all (not a no-op inside it — the call itself never happens for a glm
studio, confirmed by making the call textually absent from that branch, not
by a spy — DO can't be constructed under vitest-pool-workers, so the
existing convention here is source-pinning, same as every other
untestable-class test in studio.account-launched.test.ts).

Updated that file's own pinned source-grep tests to match the new branch
shape (6-space indent inside `else`, glm siblings beside each claude-path
call) — same invariants (ordering, pairing counts), new structure. Did NOT
relax any assertion to dodge the new shape.

### CLI/creation-path threading (design decision 3, resolved)

Chose `fleet spawn <role> [--new] [--lead claude|glm]` — spawn is THE studio-
creation verb (both `/studio/spawn` operator body and `/fleet/spawn` machine
body share one `runSpawn` core in spawn.ts, so one wire field covers both
callers). `readLeadTypeRequest(body)`: absent->undefined, "claude"/"glm"
pass through, anything else->null (400, before any org.json fetch). Threaded
into `provisionChild`'s cfg, omitted when absent (byte-identical request for
every pre-#249 caller). `fleet provision <id>` was NOT given the flag — it
re-provisions an EXISTING id, and leadType is sticky from creation, so there
is no legitimate "I forgot the flag, flip it now" use case. `ff`'s own spawn
wrapper also untouched (same reasoning, out of scope — `fleet spawn --lead
glm` covers the real creation path).

### Security-label refusal (maestro spec point 5)

`SECURITY_LABEL="security"` (board/types.ts) + `TaskBrief.security?:boolean`
(brief.ts, same boolean-only shape `junior` already has). createTask/
assignTask (board.ts) both gain an optional `GetLeadType` port; refuse (400,
before any write) exactly when the task carries SECURITY_LABEL AND the
target studio's own leadType resolves to "glm". Wired in routes.ts via
`AssignWakeDeps.studioState` (now also answers `leadType` — same D1 read
every create/assign call already makes, zero extra query) through a new
`getLeadTypeFrom()` adapter, at all 4 create/assign call sites (operator
`/studio/board/tasks` + studio-directed `/fleet/tasks`, create AND
assign/adopt each).

Did NOT add a `--security` CLI flag to `fleet task new` — not in the
required-changes list (unlike the leadType CLI flag), and the Worker API
already accepts `security: true` in the POST body today. Flagged as a cheap
follow-up if an operator-facing flag is wanted later.

### Verification discipline

Mutation-killed the createTask security refusal (removed the check, ran the
new test, confirmed it failed for the right reason, restored, reran green)
before trusting the suite — same rigor as every RED-first step, applied
retroactively to the one piece written ahead of its test.

Ran ONLY the touched test files + tsc throughout (never the full bun-test/
check gate — reserved for the lead's own final verification).

## Process

RED (bun:test for translate.ts) -> GREEN -> RED (vitest for the route) ->
GREEN. Caveman-compressed commit messages. Push after every commit.

## Round 1 maestro review fixes (route-level)

Real maestro review on PR #255 (round 1 of 2). Fixed the BLOCKER + 4 MAJORs
+ 2 cheap MINORs, all route/translation-layer. Round 2 will be the last.

### BLOCKER — route never mounted

`handleFleetAnthropicMessages` existed but index.ts never called it —
every request to `/fleet/llm/anthropic/*` fell through to the `/fleet/`
catch-all (handleFleetSpawn) and 404'd. Mounted at index.ts, right after
`/fleet/junior`'s own mount, before the `/fleet/` catch-all (confirmed real
line: 122-123, not the maestro's cited ~135, which is the catch-all itself).

Test (test/index.test.ts, through worker.fetch — the real entry point, not
just the handler in isolation): a GET to the path. handleFleetSpawn's own
method check runs AFTER its path check, so it still 404s a GET; the
anthropic handler's method check runs after ITS OWN path/flag/AI checks and
answers 405 — 405 is only reachable if the route is genuinely mounted ahead
of the catch-all. RED confirmed by temporarily gating the mount line with
`false &&` — both new tests failed with 404 (not 405/401), for the right
reason; restored, GREEN.

### MAJOR 2 — no spend controls

Any studio's spawn token, any leadType, could reach `env.AI.run` with zero
flag, rate limit, or usage row. Fixed in anthropic-route.ts:
- Feature flag: reuses junior's own `env.FLEET_JUNIOR !== "on"` check
  verbatim (not the fuller `juniorEnabled` with its JUNIOR_REPOS narrowing —
  the maestro's instruction named the flag check at junior/route.ts:142
  specifically, not the repo-scoping wrapper around it).
- leadType gate: `SpawnParent` (spawn.ts) carries no `leadType` field (it's
  a `StudioStatus` registry-row field, not part of what every OTHER spawn-
  token route needs) — so the route now looks the calling studio's own row
  up in the SAME `rows()` array `resolveSpawnParent` already scanned, and
  403s unless `leadType === "glm"` (absent/claude both refused).
- Rate limit: `checkAndConsumeJuniorRateLimit` (junior/ratelimit.ts), same
  call shape junior/route.ts makes, keyed by studio id — same D1 counters,
  same budget, both routes draw from one pool.
- Usage: `insertJuniorUsage` (junior/usage.ts) via `ctx.waitUntil`, same
  table junior writes to, new `mode: "lead"` literal so a GLM-lead row is
  visibly distinct from a junior-delegation row in the same table.

### MAJOR 3 — mid-stream error faked as a normal end

`pumpAnthropicStream`'s old `try { ... } finally { closeStream }` ran
`closeStream` unconditionally — a `reader.read()` throw after `message_start`
and a content block already reached the client got silently reported as
`end_turn` + `message_stop`. Fixed: the read is now awaited inside its own
try/catch, INSIDE the loop; a throw there writes `translate.ts`'s new
`streamErrorFrame` (a genuine Anthropic `event: error`) and returns early —
`closeStream`'s frames and the error frame are now mutually exclusive, never
both. Also threads real token counts (see MAJOR 4) out of the pump via a new
`PumpResult` return value, since the usage row can only be logged once the
stream actually resolves.

RED confirmed: reverted pumpAnthropicStream to the old unconditional
try/finally shape, ran the new mid-stream test — failed exactly as the
original bug would (`content_block_stop`/`message_delta`/`message_stop`
instead of `error`). Restored, GREEN.

### MAJOR 4 — usage always 0; context overflow maps to a retried 500

- `translate.ts`'s `anthropicRequestToOpenAI` now sets
  `stream_options: {include_usage: true}` whenever `stream: true` — without
  it, no chunk this backend sends (including the final one) ever carries a
  `usage` field. `applyOpenAIStreamChunk` now also tracks `state.inputTokens`
  off that chunk's `usage.prompt_tokens` (output was already tracked, just
  never fed by a real usage chunk before this fix). The route logs these
  real counts into the SAME `junior_usage_log` row MAJOR 2 added.
- `classifyAiError` gained a context-overflow case: `invalid_request_error`/
  400, fixed message `"prompt is too long"` (never the raw upstream text) —
  the one shape Claude Code's client treats as "compact, don't retry".
  FLAGGED UNCERTAINTY (stated in the function's own doc comment, not
  silently assumed): the real Workers AI wording for an overflowed context
  has not been observed firsthand; the regex matches the common OpenAI-
  compatible phrasings ("maximum context length", "context_length_exceeded",
  "context window"). A wrong guess here falls through to the generic 500
  bucket, never a worse outcome than before.

### MINOR (both fixed — cheap)

1. `toolUseId()` helper in translate.ts: generates a `toolu_`-prefixed id
   whenever GLM's own tool-call response omits one (undefined, null, or
   empty string) — applied at both the non-streaming tool_use block AND the
   streaming `content_block_start`'s tool_use block. A real id from the
   upstream is kept as-is.
2. `stop_reason`/streaming `message_delta`'s `stop_reason` are now derived
   from whether a tool_use block was ACTUALLY produced this turn (non-stream:
   `anyToolUseBlocks(content)`; stream: `state.toolIndexByOpenAiIndex.size >
   0`), not only from the upstream's self-reported finish_reason — this
   backend is not reliably observed to always set that field correctly even
   when it did emit a tool call.

### Not touched (separate dispatch, per the lead's scope)

`studio/provision.ts` (leadType-set-once hardening), `studio/do.ts`
(security-label-added-after-assignment refusal, restoring the removed
history comments), `board/*` — all explicitly out of scope for this
dispatch.

### Verification discipline

RED-confirmed the two highest-value fixes by reverting them locally and
re-running just the affected test (BLOCKER mount line gated with `false &&`;
MAJOR 3's pumpAnthropicStream reverted to the old try/finally shape),
confirmed each failed for the right reason, restored, reran GREEN. Ran only
the touched test files throughout: `test/bun/llm-translate.test.ts` (50
pass), `test/llm.anthropic-route.test.ts` + `test/index.test.ts` (45 pass),
`test/junior.route.test.ts` + `test/junior.ratelimit.test.ts` +
`test/junior.usage.test.ts` + `test/junior.authz.test.ts` +
`test/junior.provision.test.ts` (77 pass, no regression from reusing
junior's rate-limit/usage machinery) — 172 tests total. Also ran a single
scoped `tsc --noEmit` (this app's own root project only, not the 5-project
`bun run check` gate) — zero errors. Did NOT run `bun-test`/`check`/the full
suite — reserved for the lead's own final verification.

## Round 1 maestro review fixes (admission-level)

The 3 remaining MINORs from the same round-1 review, all admission/board-side
(the route-level BLOCKER/MAJORs/2 MINORs above were a separate dispatch; HEAD
at start here: 6b47af6). RED-first for the two real fixes; the third turned
out to already be correct on inspection -- see below. 3 commits, pushed after
each.

### MINOR -- leadType not truly set-once

Gap: `runProvision`'s seed guard was `cfg.leadType !== undefined &&
existing?.leadType === undefined`. `existing?.leadType === undefined` is true
for TWO different things: (a) no row has ever existed (genuine first-ever
provision -- the only case that should seed from cfg) and (b) a row that
already exists, already ran, and simply never wrote this field (every studio
provisioned before #249 shipped, and every claude-lead studio since). A
re-provision/restart/recycle of an EXISTING studio in case (b), carrying
`cfg.leadType: "glm"` for any reason, silently flipped a real running claude
studio to glm.

Fix: key the seed off `existing === null` instead -- "no row at all" is the
only "first-ever" signal; once a row exists (whatever it carries, including
nothing) the field is frozen, carried forward via the `...existing` spread.

RED: new test -- existing row (`state: "running"`, no `leadType` field),
`runProvision` called again with `cfg.leadType: "glm"` -- asserted
`status.leadType` stays `undefined`. Failed with `"glm"` before the fix
(`studio.provision.test.ts`). Fixed, 107/107 pass.

### MINOR -- security label added AFTER assignment, not caught

Gap: `securityRefusesGlmLead` (board.ts) only ran inside createTask/assignTask
-- refuses a security task going IN. A task assigned to a glm-lead studio
WITHOUT the label, then relabelled `security` later by anything other than
those two functions (GitHub UI, a hand-run `gh issue edit --add-label
security`), stayed silently owned by that studio with nothing watching for
the label's arrival.

Mechanism chosen: revoke-and-write, not refuse-per-request -- `/fleet/llm/
anthropic/v1/messages` is STUDIO-scoped (leadType gate only), carries no task
number, so "recheck labels fresh on the next call" has no call site to hang
off. The board-level precedent (junior/authz.ts's header: "revoking only,
never granting" for its own reopened-task case) fits better: a task's
assignment IS its studio label, so revoking means removing it, the same way
assignTask's own reassignment write sequence does.

New `revokeGlmLeadOnSecurityLabel(api, repo, number, getLeadType)` (board.ts):
fresh `api.getIssue` read (not the caller's own payload labels -- same
defensive posture assignTask already takes), no-ops unless the task carries
`SECURITY_LABEL`, then for every CURRENT owner whose leadType resolves
`"glm"`: removes their studio label, resets backlog state to `submitted` if
it wasn't already, posts one comment naming why. Wired into webhook.ts's
`issues`-event branch (`revokeGlmLeadOnSecurityLabelEvent`, cheapest early-out
first: only `action === "labeled"` + `label.name === SECURITY_LABEL` is ever
worth a GitHub read), same shape as the existing `revokeJuniorOnIssueEvent`
call right beside it -- `getLeadType` built straight off `listStudios(env)`,
not routes.ts's `AssignWakeDeps`-based adapter (no `AssignWakeDeps` in hand
at this call site, no reason to build one just for this field). Once
revoked, nothing (a later unlabel/relabel) brings it back on its own -- a
human has to reassign through assignTask, which already refuses to hand a
security task back to a glm-lead studio.

RED: new tests in `board.board.test.ts` calling the not-yet-existing function
-- `TypeError: revokeGlmLeadOnSecurityLabel is not a function`. Implemented,
169/169 pass. Added two more tests in `github.webhook.test.ts` (inside the
existing auto-close-on-promote describe block, reusing its real
`githubBoardApi` fetch fixture) proving the real `issues` `labeled` delivery
reaches the function end-to-end -- not just the pure unit; 74/74 pass. Also
added a narrative test chaining revoke -> a later identical re-adoption call
that would have succeeded before the label landed, now refuses (the exact
"next call against this task's own assignment" the dispatch asked to prove).

### MINOR -- history comments "removed" from do.ts (#110, #134, #211)

Investigated, found nothing to restore. `git diff d94ce15 HEAD -- do.ts`
(`d94ce15` = the commit immediately before #249 first touched do.ts) shows
every `-` line referencing #110/#134/#211 (2 + 9 + 3 lines, across
provisionUngated/restartStudio/recycle's post-destroy closure) has an exact
verbatim `+` match in the SAME commit (`1d764d5`, the glm-admission-bypass
refactor) -- reindented one level deeper, now inside the new `else` branch
alongside the claude-path code the comment always described, never deleted
and left behind. Confirmed by reading the current file at all three sites
(do.ts:7080-7150, :7360-7420ish, recycle's closure) end to end: the "see
provisionUngated's identical comment above its own call" cross-references
still point at comments that are still actually there, and the
"studio.exec-deadlines.test.ts's own pinned... exact standalone conditional
statement" the #134 comment describes is still the literal next line. The
maestro's citation is accurate for the per-commit diff (deletion in one hunk)
but not for the branch's own final, cumulative state -- the restoring `+` was
already part of the same commit that moved the code, not a later one. No
code change made; verified via `git diff`, not guessed.

## Fresh-context review fixes (round 2, backend dispatch)

### Finding 1 -- streaming usage still reported 0 to the CLIENT

MAJOR 4 above only fixed `state.inputTokens` internally (the D1 usage-log
row read it back fine) -- it never reached any outbound SSE frame Claude
Code itself reads. `message_start`'s usage stays `{input_tokens: 0,
output_tokens: 0}` on purpose: it fires before any upstream chunk is even
read, and this OpenAI-compatible backend only reports `usage.prompt_tokens`
on the FINAL chunk, long after `message_start` already hit the wire -- 0 is
the real, honest value at that point, not a bug. `message_delta` is the one
remaining client-visible frame with a real number to put it in, so
`closeStream` now emits `usage: {input_tokens: state.inputTokens,
output_tokens: state.outputTokens}` there -- a deliberate, flagged deviation
from Anthropic's strict wire shape (the real API never puts input_tokens on
message_delta; it's already known up front on message_start, which this
backend cannot replicate). An extra key on a JSON object message_delta
already carries is not a shape Claude Code's own SSE parsing has a reason to
reject.

RED: new test in `llm-translate.test.ts` -- asserted the closeStream
message_delta frame's usage object equals `{input_tokens: 5, output_tokens:
9}` after a final chunk carrying both. Failed (`input_tokens` missing,
`output_tokens` only) before the fix. Fixed, 51/51 pass
(`bun test apps/fleet/test/bun/llm-translate.test.ts`); 24/24 pass
(`test/llm.anthropic-route.test.ts`, vitest).

### Finding 2 -- glm-lead usage silently conflated with the junior-adoption dashboard

`anthropic-route.ts`'s `logUsage` writes into the SAME `junior_usage_log`
table `/fleet/junior` uses, tagged `mode: "lead"`. `aggregateJuniorUsage`
(backing `GET /studio/junior/usage`) grouped/summed EVERY row with no mode
filter, despite this module's own header doc comment stating its purpose is
specifically "measure GLM (junior) adoption vs Claude" -- a studio running
its entire lead on GLM had that whole volume folded into "junior adoption".

Fix: `aggregateJuniorUsage`'s SQL gained `AND mode != 'lead'` -- the minimum
fix the dispatch asked for. Lead-mode rows are still written (still real
usage/billing data, still raw-queryable), just excluded from this one
aggregate. No `JUNIOR_MODES` import from route.ts (would create a route.ts
<-> usage.ts import cycle; route.ts already imports `insertJuniorUsage` from
usage.ts) -- the literal `"lead"` is usage.ts's own exclusion, not an
enumeration of route.ts's modes.

RED: new test in `junior.usage.test.ts` -- one "edit" row + one "lead" row
inserted, asserted the aggregate's rows/totals reflect only the "edit" row,
and a raw `SELECT ... WHERE mode = 'lead'` still finds the lead row (proving
it's excluded from the aggregate, not deleted). Failed (`calls: 2`,
`inputTokens: 1010`) before the fix. Fixed, 13/13 pass
(`test/junior.usage.test.ts`); re-ran `test/llm.anthropic-route.test.ts`
alongside it (shares the same table) -- 37/37 pass across both files.

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

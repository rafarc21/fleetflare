# Spike: lead tool-restriction mechanism (throwaway)

Task 0 of P4a-1 studio harness. Question: how to block Edit/Write for
studio LEAD while members keep them (decision 11: leads never implement).

**Ruling: (b) PreToolUse hook.** Key field: `agent_id` (also `agent_type`).
Present only on member (subagent) tool calls. Absent on lead's own calls.

**`--disallowedTools`/`--allowedTools` flag: unusable.** Global to session
tree, not lead-scoped. Strips the tool name from the WHOLE registry —
lead and every dispatched subagent lose it.

## Versions

Container pinned: `claude` 2.1.224 (Dockerfile.studio, verified via
`docker exec ... claude --version`). Local Mac: 2.1.235. 11-version delta —
see caveats.

## Step 1: build image

Brief's literal command fails:
```
docker build -f apps/fleet/container/Dockerfile.studio -t studio-spike apps/fleet/container
# ERROR: "/container/studio-fleet": not found (and 2 more COPY misses)
```
Cause: Dockerfile.studio's `COPY container/studio-bringup.sh ...` etc are
relative to `apps/fleet`, not `apps/fleet/container`. Confirmed against
`apps/fleet/vitest.config.ts` (`rootDir` + its own `readFile(rootDir,
"container", "Dockerfile.studio")` calls) — brief's context arg is stale.
Corrected command, builds clean (all layers cached from earlier build
today):
```
docker build -f apps/fleet/container/Dockerfile.studio -t studio-spike apps/fleet
```
Pre-existing unrelated warning: amd64 image on arm64 host. Doesn't block.

Methodology note: brief's `docker run --rm -it studio-spike bash` needs a
real TTY, not available non-interactively. Used `docker run --rm
studio-spike <cmd>` — base image's own entrypoint (Cloudflare sandbox
server) keeps the container alive as a daemon after userCmd exits despite
`--rm` — then `docker exec <container> bash -c '...'` per probe step.
Same image, same env, same commands, different invocation mechanics.

## Step 2: Probe A — does `--disallowedTools` starve subagents?

### Container (2.1.224, no API key) — INCONCLUSIVE, pre-auth wall

```
claude --dangerously-skip-permissions --disallowedTools "Edit Write NotebookEdit" \
  -p 'Dispatch the writer subagent to create hello.txt containing "hi". Do not write it yourself.' \
  --output-format json
```
Raw output:
```json
{"is_error":true,"duration_api_ms":0,"num_turns":1,"stop_reason":"stop_sequence","session_id":"726a138d-6bf3-4b80-84ad-ce9e879eb23c","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"","iterations":[],"speed":"standard"},"modelUsage":{},"permission_denials":[],"terminal_reason":"api_error","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","subtype":"success","api_error_status":null,"result":"Not logged in · Please run /login","type":"result","duration_ms":1774,"uuid":"63737ee2-d384-43c6-856b-22138df10f6e"}
```
`ls hello.txt`: missing. Zero turns of real work (`iterations: []`). No
tool ever ran. Expected per brief's own context note — no API key in this
image. Not a "flag is global" signal — just never got past login.

### Local Mac (2.1.235, authed) — DECISIVE

Same command, same `writer.md` agent def, throwaway dir under scratchpad
(`/private/tmp/claude-501/.../scratchpad/probe`).

Raw output:
```json
{"is_error":false,"duration_api_ms":180765,"num_turns":8,"stop_reason":"end_turn","session_id":"f9ec68e6-f74f-4663-8a4f-21eff0adce3f","total_cost_usd":1.832825,"usage":{"input_tokens":16,"cache_creation_input_tokens":45940,"cache_read_input_tokens":304103,"output_tokens":2467,"output_tokens_details":{"thinking_tokens":748},"permission_denials":[],"terminal_reason":"completed","subtype":"success","api_error_status":null,"result":"Done. hello.txt exists, contains `hi`. Verified.\n\nCaveat: `writer` agent broken in this harness — its `tools: Write` frontmatter fails resolve (\"unrecognized [Write]\"), spawn refused even after edit (registry cached at session start). Dispatched general-purpose subagent instead; it also lacked Write tool, used `printf` via Bash. File byte-verified: `hi` + newline.\n\nFix for writer agent: restart session after frontmatter change, or check what tool names this harness accepts in agent `tools:` lists.","ttft_ms":60002,"duration_ms":463870,"uuid":"89d56e64-3718-47a0-84c5-cb0f854946d7"}
```

Naive read: `hello.txt` exists → looks like outcome (a), flag is
lead-scoped. **Wrong.** Dug into the transcript
(`~/.claude/projects/.../f9ec68e6-....jsonl` + subagent sidechain
`.../subagents/agent-af2e0df584fef059d.jsonl`, meta:
`{"agentType":"general-purpose","spawnDepth":1}`):

- Lead attempted `subagent_type: "writer"` **3 times**. Every attempt,
  identical error:
  > "would be spawned with zero tools — refusing. Its tools list resolved
  > to nothing: unrecognized [Write]. Fix the agent's tools frontmatter or
  > pass a different subagent_type."
- `permission_denials: []` everywhere in the full transcript. Never
  populated, not once.
- Fallback general-purpose subagent's own tool calls: `Agent`, `Bash`,
  `ToolSearch` only. Never called `Write`. Never got denied — `Write`
  simply wasn't in its resolvable tool set to begin with.
- It wrote the file via `printf` through `Bash` instead.

Conclusion: `--disallowedTools` removes the tool name from the **entire
session's tool registry** — lead AND every dispatched subagent, at every
depth tried. Not a permission-check-time denial (that would show up as a
`permission_denials` entry or a blocked `Write` tool_use). A registry-time
removal: the name becomes unrecognized, so even a custom agent's own
`tools: Write` frontmatter can't resolve it anywhere in the tree.
`hello.txt` exists only because the model routed around the missing tool
via Bash — not because Write worked for the subagent.

**Outcome: (b), by a stronger mechanism than the brief anticipated (registry
removal, not a per-call denial). Flag is session-global. Unusable for
decision 11 — it would starve members too.**

## Step 3: Probe B — can a PreToolUse hook distinguish lead from member?

### Container (2.1.224, no API key) — INCONCLUSIVE, same pre-auth wall

Raw output:
```json
{"is_error":true,"duration_api_ms":0,"num_turns":1,"stop_reason":"stop_sequence","session_id":"24f0481e-a24a-4e31-95cc-fdfe845b19f5","total_cost_usd":0,"permission_denials":[],"terminal_reason":"api_error","subtype":"success","result":"Not logged in · Please run /login","duration_ms":4066,"uuid":"a27edc97-6aac-4caf-bf1a-e6f9a241de79"}
```
`/tmp/hookcalls.jsonl`: never created. Hook never fires pre-auth —
consistent with Probe A: no agent loop starts at all, so no tool call is
ever attempted, so PreToolUse never triggers.

### Local Mac (2.1.235, authed) — DECISIVE

Setup per brief verbatim (matcher `Write|Edit`, hook = `cat >>
/tmp/local-hookcalls.jsonl; exit 0`). No `--disallowedTools` this run —
`writer` custom agent resolved fine (confirms the "unrecognized [Write]"
above was `--disallowedTools`-caused, not a general 2.1.235 custom-agent
bug).

Raw output:
```json
{"is_error":false,"duration_api_ms":51811,"num_turns":1,"stop_reason":"end_turn","session_id":"976d7bf4-aee7-4e21-ac45-f258aad739c4","total_cost_usd":0.852312,"permission_denials":[],"terminal_reason":"completed","subtype":"success","result":"Both done. lead.txt has \"lead\", writer agent created member.txt with \"member\".","duration_ms":17577,"uuid":"478cce8e-0792-4e50-96d9-1ae906614c99"}
```
Both files created. Two hook payloads captured in
`/tmp/local-hookcalls.jsonl`:

Lead's Write (`lead.txt`):
```json
{"session_id":"976d7bf4-aee7-4e21-ac45-f258aad739c4","transcript_path":"/Users/you/.claude/projects/-private-tmp-claude-501--Users-example-code-fleetflare-fleetflare-agency-worktrees-35-terminal-watch-6278510d-956c-463e-bdcc-2b39e9138717-scratchpad-probe2/976d7bf4-aee7-4e21-ac45-f258aad739c4.jsonl","cwd":"/private/tmp/claude-501/-Users-example-code-fleetflare-fleetflare-agency-worktrees-35-terminal-watch/6278510d-956c-463e-bdcc-2b39e9138717/scratchpad/probe2","prompt_id":"e1be1589-faf6-4299-a9c0-a1c06a015f36","permission_mode":"bypassPermissions","effort":{"level":"medium"},"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":".../probe2/lead.txt","content":"lead"},"tool_use_id":"toolu_017zUBtDXqzUce1pHx3FpAyu"}
```

Member's Write (`member.txt`, via `writer` subagent):
```json
{"session_id":"976d7bf4-aee7-4e21-ac45-f258aad739c4","transcript_path":"/Users/you/.claude/projects/-private-tmp-claude-501--Users-example-code-fleetflare-fleetflare-agency-worktrees-35-terminal-watch-6278510d-956c-463e-bdcc-2b39e9138717-scratchpad-probe2/976d7bf4-aee7-4e21-ac45-f258aad739c4.jsonl","cwd":"/private/tmp/claude-501/-Users-example-code-fleetflare-fleetflare-agency-worktrees-35-terminal-watch/6278510d-956c-463e-bdcc-2b39e9138717/scratchpad/probe2","prompt_id":"e1be1589-faf6-4299-a9c0-a1c06a015f36","permission_mode":"bypassPermissions","agent_id":"aa057bc519e96c4e9","agent_type":"writer","effort":{"level":"medium"},"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":".../probe2/member.txt","content":"member"},"tool_use_id":"toolu_014C7xVVzDpuaLQSpAYyAHFH"}
```

Field-by-field diff:
- `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`,
  `effort`, `hook_event_name`, `tool_name`, `tool_use_id`: **identical
  both calls, same values.** Brief's `transcript_path` sidechain-path
  hypothesis is **wrong** — both point to the same top-level `.jsonl`.
- `agent_id`: absent on lead. `"aa057bc519e96c4e9"` on member.
- `agent_type`: absent on lead. `"writer"` on member.

**Stable discriminator: `agent_id` (equivalently `agent_type`) key
presence — presence, not value.**

## Real-system generalization check (not a brief step; done to de-risk the ruling)

`apps/fleet/container/studio-bringup.sh` ~L279-280: studio lead is
launched as a plain top-level `claude --dangerously-skip-permissions ...`
sent via `tmux send-keys` — same shape as the probe's lead (`claude -p
...` from bash). Not itself a dispatched subagent. So the real lead
session's own tool calls will also lack `agent_id`/`agent_type`, same as
probed. Members are dispatched via the Agent/Task tool from that lead,
same as the probed `writer`. **Ruling generalizes to production.**

Side observation, **not tested directly**: `studio-bringup.sh` already
passes `--allowedTools "${ROLE_ALLOWED_TOOLS}"` to the lead. Same
tool-registry mechanism as `--disallowedTools`, inverse list. If so,
`ROLE_ALLOWED_TOOLS` today likely also restricts members to the lead's
role allowlist — same bug, opposite flag. Inferred from Probe A's
registry-removal mechanism, not independently probed. Flag to Task 4.

## Ruling

**(b) PreToolUse hook.** Matcher: `Edit|Write|NotebookEdit` (brief's probe
only matched `Write|Edit`; production should add NotebookEdit — matches
decision 11's full disallow list).

**Amended by the P4a-1 fix wave (2026-08-19): the shipped matcher is
`Edit|Write|NotebookEdit|Bash`.** Step 2's own transcript above (see "It
wrote the file via `printf` through `Bash` instead") is the evidence: with
the write tools gone, the model routes around them through Bash, which
every studio grants. Blocking only the three named tools would have left
decision 11 structural for three tools and prompt-only for the one tool
that can do everything. Shipped gate therefore also inspects Bash payloads
and blocks file-WRITE forms from the lead — a blocklist of the observed
escape, not a general sandbox. See `apps/fleet/container/studio-bringup.sh`
for the real list and its honest limits.

Logic: read hook JSON from stdin. `agent_id` absent → lead's own call →
exit 2, stderr `"dispatch a member — leads never implement"`. `agent_id`
present → member call → exit 0.

Illustrative only (Task 4 owns real implementation):
```bash
#!/usr/bin/env bash
payload="$(cat)"
agent_id="$(jq -r '.agent_id // empty' <<<"$payload")"
if [ -z "$agent_id" ]; then
  echo "dispatch a member — leads never implement" >&2
  exit 2
fi
exit 0
```

Consumed by:
- **Task 3**: the CLI flag is unused; the hook carries the restriction
  instead. Correction (fix wave): `STUDIO_LEAD_DISALLOWED` does NOT resolve
  to `""` — this line predicted a value the implementation never used. As
  shipped it is a non-empty INSTALL SWITCH read as a boolean by bringup
  ("is there a lead restriction to enforce"), never as a matcher and never
  as a flag value. See `StudioBringupEnv`'s own doc comment.
- **Task 4**: bringup installs the hook (settings.json `PreToolUse`,
  matcher above) rather than a CLI flag.

## Caveats

1. Container probes never ran authed (no API key baked into the image).
   Both container runs prove only pre-auth behavior (no tools, no hook
   fires) — expected per brief, not a gap in the ruling itself.
2. Local probes ran on 2.1.235; container pins 2.1.224. 11 versions
   apart. `agent_id`/`agent_type` hook fields unlikely to appear/vanish
   across a patch range this small, but not verified on 2.1.224 directly
   (no changelog check — out of scope for this spike). Task 4 should
   re-confirm the field name once an authed 2.1.224 run is possible.
3. `--allowedTools` global-scope claim is inferred from
   `--disallowedTools` behavior (same underlying mechanism), not directly
   probed.
4. Step 1's literal build command in the brief is stale (build context
   arg). Corrected command captured above; not an apps/fleet source
   change, a docker invocation fix only.

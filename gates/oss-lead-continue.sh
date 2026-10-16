#!/usr/bin/env bash
# Issue #1112 layer 2: an OSS lead (glm/kimi/deepseek on the glm-lead route)
# ended its turn after every step with its TodoWrite list still open, so each
# step waited for an external wake. This Stop hook blocks that stop while the
# lead's last TodoWrite still has pending or in_progress items, and tells the
# lead to continue with the first open one.
#
# Layer 1 (the router's system-prompt rule, llm/lead-rule.ts) is the primary
# fix. This is the backstop, for when the model ignores the rule anyway.
#
# Scope, same posture as lead-gate.sh: no STUDIO_ID -> no-op (never fires on
# an operator's Mac). A Claude-led studio has no fleet-route ANTHROPIC_BASE_URL
# -> no-op. Stop fires for the lead's own turn end only; members emit
# SubagentStop and are not registered on it. Subagent (sidechain) transcript
# lines are ignored: a member's TodoWrite is not the lead's list.
#
# Decision (Claude Code Stop hook protocol: stdout JSON, exit 0):
#   - no TodoWrite, or the last one has no pending/in_progress item -> allow
#   - the last assistant text asks the operator something -> allow. A question
#     line ending in "?", a numbered option list, or a confirm/approve/which/
#     "should I" phrase all count.
#   - 8 blocks already made for this user prompt -> allow (loop guard)
#   - otherwise -> {"decision":"block","reason":"continue with <first open todo>"}
#
# The loop guard counts per real user prompt (the last transcript user entry
# that is neither a tool result nor CLI-injected isMeta feedback), not per
# stop_hook_active flag. The count lives in
# ~/.claude/state, one file per session, and is persisted BEFORE any block.
#
# FAIL OPEN. Any error (no python3, unreadable transcript, bad JSON, unreadable
# or unwritable counter) allows the stop. A broken hook must never wedge a lead
# mid-task, and a block that cannot be counted could never be capped.

[ -n "${STUDIO_ID:-}" ] || exit 0

case "${ANTHROPIC_BASE_URL:-}" in
  */fleet/llm/anthropic|*/fleet/llm/anthropic/*) ;;
  *) exit 0 ;;
esac

command -v python3 >/dev/null 2>&1 || exit 0

PY=$(cat <<'PYEOF'
import hashlib, json, os, re, sys

MAX_BLOCKS_PER_PROMPT = 8
OPEN = ("pending", "in_progress")
NUMBERED = re.compile(r"^\d+[.)]\s")
ASK_WORDS = re.compile(r"\b(approve|confirm|which|should i)\b", re.I)

payload = json.load(sys.stdin)
sid = re.sub(r"[^A-Za-z0-9_.-]", "_", str(payload.get("session_id") or "unknown"))
state_dir = os.path.join(os.path.expanduser("~"), ".claude", "state")
state_file = os.path.join(state_dir, "oss-lead-continue-" + sid)


def save(key, count):
    # Best effort. A counter that cannot be written must not produce a block.
    try:
        os.makedirs(state_dir, exist_ok=True)
        with open(state_file, "w") as f:
            f.write("%s\t%d" % (key, count))
        return True
    except OSError:
        return False


def allow(key="", count=0):
    save(key, count)
    sys.exit(0)


def is_real_prompt(entry):
    # isMeta entries are CLI-injected (e.g. "Stop hook feedback" after each block),
    # not something the user typed, so they never start a new count.
    if entry.get("isMeta") is True:
        return False
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return True
    return isinstance(content, list) and not any(
        isinstance(b, dict) and b.get("type") == "tool_result" for b in content)


def asks_operator(text):
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    if any(l.endswith("?") for l in lines):
        return True
    if any(NUMBERED.match(l) for l in lines):
        return True
    return bool(ASK_WORDS.search(text))


todos, last_text, prompt_key = None, "", ""
try:
    with open(payload["transcript_path"]) as f:
        for line in f:
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if m.get("isSidechain") is True:
                continue
            if m.get("type") == "user" and is_real_prompt(m):
                prompt_key = m.get("uuid") or hashlib.sha1(
                    json.dumps(m.get("message"), sort_keys=True).encode()).hexdigest()
            if m.get("type") != "assistant":
                continue
            blocks = (m.get("message") or {}).get("content") or []
            text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
            if text.strip():
                last_text = text
            for b in blocks:
                if b.get("type") == "tool_use" and b.get("name") == "TodoWrite":
                    todos = (b.get("input") or {}).get("todos") or []
except (OSError, KeyError, TypeError):
    allow()

open_items = [t for t in (todos or []) if isinstance(t, dict) and t.get("status") in OPEN]
if not open_items or asks_operator(last_text):
    allow(prompt_key, 0)

count = 0
try:
    with open(state_file) as f:
        key, _, n = f.read().strip().partition("\t")
    if key == prompt_key:
        count = int(n or 0)
except FileNotFoundError:
    count = 0
except (OSError, ValueError):
    allow(prompt_key, 0)

if count >= MAX_BLOCKS_PER_PROMPT:
    allow(prompt_key, 0)

# Persist the count first: a block is only issued once it is recorded.
if not save(prompt_key, count + 1):
    sys.exit(0)

reason = "continue with " + str(open_items[0].get("content", "the next open todo"))
sys.stdout.write(json.dumps({"decision": "block", "reason": reason}))
PYEOF
)

python3 -c "$PY" 2>/dev/null || true
exit 0

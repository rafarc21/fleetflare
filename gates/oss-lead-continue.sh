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
# SubagentStop and are not registered on it.
#
# Decision (Claude Code Stop hook protocol: stdout JSON, exit 0):
#   - last TodoWrite has no pending/in_progress item    -> allow
#   - no TodoWrite in the transcript                    -> allow
#   - last assistant text asks the operator (a line ending "?", a numbered
#     option list, or approve/confirm/which/should I)   -> allow
#   - 8 blocks already for this user prompt             -> allow (loop guard)
#   - otherwise -> {"decision":"block","reason":"continue with <first open todo>"}
# The loop guard counts per real user prompt (uuid, or line index), not per
# stop_hook_active: that flag is not reliable on every CLI build. The counter
# lives in ~/.claude/state, one file per session, as "<prompt-key>\n<count>".
# A block is emitted only after the counter write succeeded.
#
# FAIL OPEN. Any error (no python3, unreadable transcript or counter, unwritable
# state dir, bad JSON) allows the stop. A broken hook must never wedge a lead
# mid-task.

[ -n "${STUDIO_ID:-}" ] || exit 0

case "${ANTHROPIC_BASE_URL:-}" in
  */fleet/llm/anthropic|*/fleet/llm/anthropic/*) ;;
  *) exit 0 ;;
esac

command -v python3 >/dev/null 2>&1 || exit 0

PY=$(cat <<'PYEOF'
import json, os, re, sys

MAX_CHAIN = 8
OPEN = ("pending", "in_progress")
ASK_WORDS = re.compile(r"\b(approve|confirm|which|should i)\b", re.I)
OPTION_LINE = re.compile(r"^\s*\d+[.)]\s+\S")

def asks_operator(text):
    lines = [l.rstrip() for l in text.splitlines() if l.strip()]
    if any(l.endswith("?") for l in lines):
        return True
    if any(OPTION_LINE.match(l) for l in lines):
        return True
    return ASK_WORDS.search(text) is not None

def read_count(path, key):
    # None = counter exists but cannot be read -> caller allows the stop.
    try:
        with open(path) as f:
            parts = f.read().split("\n")
    except FileNotFoundError:
        return 0
    except OSError:
        return None
    if len(parts) < 2 or parts[0] != key:
        return 0
    try:
        return int(parts[1])
    except ValueError:
        return 0

def write_state(path, key, count):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(key + "\n" + str(count))
    os.replace(tmp, path)

def allow(state_file, key, count):
    try:
        write_state(state_file, key, count)
    except OSError:
        pass
    sys.exit(0)

payload = json.load(sys.stdin)
sid = re.sub(r"[^A-Za-z0-9_.-]", "_", str(payload.get("session_id") or "unknown"))
state_file = os.path.join(os.path.expanduser("~"), ".claude", "state", "oss-lead-continue-" + sid)

todos, last_text, prompt_key = None, "", "none"
with open(payload["transcript_path"]) as f:
    for n, line in enumerate(f):
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if not isinstance(m, dict) or m.get("isSidechain") is True:
            continue
        kind = m.get("type")
        content = (m.get("message") or {}).get("content") or []
        if kind == "user":
            if isinstance(content, str) or not any(
                isinstance(b, dict) and b.get("type") == "tool_result" for b in content
            ):
                prompt_key = str(m.get("uuid") or n)
            continue
        if kind != "assistant":
            continue
        blocks = content if isinstance(content, list) else []
        text = "".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
        if text.strip():
            last_text = text
        for b in blocks:
            if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") == "TodoWrite":
                todos = (b.get("input") or {}).get("todos") or []

open_items = [t for t in (todos or []) if t.get("status") in OPEN]
if not open_items:
    allow(state_file, prompt_key, 0)
if asks_operator(last_text):
    allow(state_file, prompt_key, 0)

count = read_count(state_file, prompt_key)
if count is None or count >= MAX_CHAIN:
    allow(state_file, prompt_key, count or 0)

block = {"decision": "block", "reason": "continue with " + str(open_items[0].get("content", "the next open todo"))}
try:
    write_state(state_file, prompt_key, count + 1)
except OSError:
    sys.exit(0)  # no counter, no block: fail open
sys.stdout.write(json.dumps(block))
PYEOF
)

python3 -c "$PY" 2>/dev/null || true
exit 0

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
#   - last assistant text ends in "?" (asks operator)   -> allow
#   - 8 consecutive blocks already in this turn chain   -> allow (loop guard)
#   - otherwise -> {"decision":"block","reason":"continue with <first open todo>"}
# stop_hook_active=false marks a fresh turn and resets the chain counter. The
# counter lives in ~/.claude/state, one file per session.
#
# FAIL OPEN. Any error (no python3, unreadable transcript, bad JSON) allows the
# stop. A broken hook must never wedge a lead mid-task.

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

def allow(state_file=None, count=0):
    if state_file is not None:
        try:
            os.makedirs(os.path.dirname(state_file), exist_ok=True)
            with open(state_file, "w") as f:
                f.write(str(count))
        except OSError:
            pass
    sys.exit(0)

payload = json.load(sys.stdin)
sid = re.sub(r"[^A-Za-z0-9_.-]", "_", str(payload.get("session_id") or "unknown"))
state_file = os.path.join(os.path.expanduser("~"), ".claude", "state", "oss-lead-continue-" + sid)
active = payload.get("stop_hook_active") is True

todos, last_text = None, ""
with open(payload["transcript_path"]) as f:
    for line in f:
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if m.get("type") != "assistant":
            continue
        blocks = (m.get("message") or {}).get("content") or []
        text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
        if text.strip():
            last_text = text
        for b in blocks:
            if b.get("type") == "tool_use" and b.get("name") == "TodoWrite":
                todos = (b.get("input") or {}).get("todos") or []

open_items = [t for t in (todos or []) if t.get("status") in OPEN]
if not open_items:
    allow(state_file, 0)
if last_text.rstrip().endswith("?"):
    allow(state_file, 0)

count = 0
if active:
    try:
        with open(state_file) as f:
            count = int(f.read().strip() or 0)
    except (OSError, ValueError):
        count = 0
if count >= MAX_CHAIN:
    allow(state_file, 0)

allow_block = {"decision": "block", "reason": "continue with " + str(open_items[0].get("content", "the next open todo"))}
try:
    os.makedirs(os.path.dirname(state_file), exist_ok=True)
    with open(state_file, "w") as f:
        f.write(str(count + 1))
except OSError:
    pass
sys.stdout.write(json.dumps(allow_block))
PYEOF
)

python3 -c "$PY" 2>/dev/null || true
exit 0

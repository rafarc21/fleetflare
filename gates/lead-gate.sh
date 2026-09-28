#!/usr/bin/env bash
# Defense in depth (board issue #20, the operator 2026-09-21: "I don't want any of
# these locks... CTO can do research and save md files for example" -- the
# Mac `fleet gates install` verb this file's install path served is gone).
# STUDIO_ID is set in every cloud studio's own process environment (used
# throughout src/studio/do.ts / provision.ts) and is inherited by any hook
# subprocess Claude Code spawns as a child of that environment. It is NEVER
# set on the operator's Mac. So even if someone hand-copies this file into
# ~/.claude/hooks/ on a Mac by mistake, it does nothing at all outside a
# real cloud studio, regardless of how it got onto disk.
[ -n "${STUDIO_ID:-}" ] || exit 0

# Decision 11: leads never implement.
#
# agent_id ABSENT on the hook payload = the lead's own call -> gate it.
# PRESENT = a dispatched member placed it -> never gated, at all, for any
# tool. Field name is not a guess: both real captured payloads sit side by
# side in .superpowers/spike-lead-tools.md's Probe B.
#
# ONE exception (board issue #16): Maestro Studio's own roster has always
# been zero members, so inside a maestro session a PRESENT agent_id/
# agent_type is never a "real member" -- it is, by construction, a
# subagent Maestro itself spawned. Exempting that call would let Maestro
# implement BY PROXY, exactly what decision 11 forbids. The hook tells a
# maestro session apart from every other studio by a value BAKED INTO
# THIS SCRIPT'S OWN ON-DISK BYTES at materialization time (see the
# `sed -i` substitution studio-bringup.sh runs against the COPIED file
# right after it `cp`s this one to ~/.claude/hooks/lead-gate.sh, and
# IS_MAESTRO's assignment further down) -- not by reading any separate
# file at decision time. An earlier revision read ~/.claude/.fleet-studio
# at runtime instead; a maestro subagent refused on a real Write could
# overwrite that plain, subagent-writable marker via Bash (e.g. a
# `python3 -c "open(...).write(...)"` one-liner -- not caught by the
# FORMS scan below, which is exactly why that scan's own comment already
# discloses `python3 -c` as an unclosed gap) and flip every LATER hook
# call in the session to non-maestro, defeating this whole exception
# after one successful tamper. Baking the value into the hook script's
# OWN bytes closes that: tampering with it now requires rewriting
# ~/.claude/hooks/lead-gate.sh itself, the same trust anchor every other
# rule in this hook already depends on (decision 11's accepted boundary
# -- see the settings.json fail-closed block in studio-bringup.sh). Falls
# a maestro subagent call through into the SAME write-shape checks below
# instead of exempting it. Every other studio keeps the unconditional
# exemption.
#
# Two rules, one gate:
#   Any tool that LOOKS like a write from the lead -> always blocked. Shape,
#     not a fixed name: a writeish NAME (edit/write/notebook/patch/apply)
#     pointed at a LOCATOR (file_path/path/notebook_path), OR tool_input
#     itself carrying write CONTENT (content/contents/edits/new_string/
#     new_str/patch) even without either -- so a tool never named here
#     before (MultiEdit today, whatever ships next) is still caught (P7a
#     Task 5; firstmate lost 73 minutes of supervision to exactly this gap,
#     docs/subagent-guard.md:15-27). Locator alone is NOT enough: Read's
#     only required param is file_path, Grep/Glob take path as their
#     directory scope -- round 1 of this gate refused all three (review
#     Finding 1, Critical). Name alone is NOT enough either: TodoWrite
#     matches the name regex but carries no locator, so it passes.
#   Bash from the lead -> blocked ONLY when the command carries a known
#     file-WRITE form. git, gh, fleet, bun, ls, cat, grep and every other
#     read/coordination command pass untouched; a lead that cannot run those
#     cannot lead (spec §4 exempts coordination artifacts explicitly).
#   Everything else -> passes. An unknown tool is not a write; blocking on
#     uncertainty under a `.*` matcher would make the studio unusable.
#
# A THIRD rule joined these two in board issue #45, and the heading above
# deliberately still says "Two" -- studio-bringup.sh cites this section by
# that exact name, twice (its lead-gate materialization block and its
# settings.json merge block), and renaming a heading another file quotes
# buys a stale cross-reference and nothing else. The rule:
#   SendMessage from a NON-MAESTRO lead -> always passes, decided by name
#     before any write-shape check runs. A lead redirecting the subagent it
#     dispatched itself is coordination, not implementation; blocking it
#     makes work the lead already knows is wrong run to completion (measured
#     2026-09-23, demosite-life--release-studio). Named permit, not a shape
#     match, and maestro is excluded -- the full reasoning, including what
#     this permit does NOT buy and why the line cannot be drawn on the
#     message text, sits on the rule itself in the python body below.
#
# HONEST SCOPE -- read before trusting this. The Bash half is a BLOCKLIST of
# escapes this project has actually OBSERVED, not a sandbox. The Task 0 spike
# recorded the first one directly: with Write blocked, the model "wrote the
# file via printf through Bash instead" (spike-lead-tools.md, Step 2). Every
# studio grants Bash, and --dangerously-skip-permissions means allowedTools
# gates nothing, so blocking only the three write tools left decision 11
# structural for three tools and prompt-only for the one tool that can do
# everything.
#
# CLOSED here: redirection into a path, tee, sed -i, mv/cp, dd of=, plus the
# shell wrappers that hide every one of those inside a quoted payload the
# quote-strip below erases -- `bash -c`, `sh -c`, `eval`, and `xargs`/`env`
# spawning either. The wrappers are not hypothetical: `bash -c` is the
# obvious next reach after `printf >`, and all five forms were measured
# passing before this list grew.
#
# STILL OPEN, named on purpose -- this paragraph is worthless if it flatters
# the gate. Every one of these writes files and none is blocked: `python3
# -c` (or any interpreter taking a program on argv), `ed`, `curl -o`,
# `wget -O`, `git apply`, `install`, `truncate`, `touch`, and any
# sufficiently obfuscated redirect. `xargs` ITSELF is deliberately not
# blocked either -- only `xargs ... sh -c` is; refusing it outright would
# break the read-side pipelines a lead legitimately needs.
#
# Add forms as they are observed. Never describe this as an absolute
# guarantee.
#
# MCP SURFACE, honest about the OTHER half too (I3): has_write_content
# above matches on tool_input KEYS, never on tool_name, so under the `.*`
# matcher it now reaches every MCP server this fleet mounts, not just the
# four built-in tools named throughout this file's own comments. A lead
# call to any mcp__*__* tool whose input carries content/contents/edits/
# new_string/new_str/patch is refused exactly like a real Write -- verified
# against mcp__notion__API-patch-page. Deliberate (this is what catches a
# future tool this list has never seen), and a false refusal costs one
# turn -- but an operator debugging "why can the lead not call Notion"
# should find the answer here, not have to re-derive it.
#
# python3, not sed: extracting a shell command out of JSON with sed breaks on
# exactly the payloads that matter (embedded quotes, escapes, newlines), and
# a gate that misreads its input is worse than no gate. python3 is already a
# hard boot requirement of this whole materialization block (see its refusal
# check above), so this adds no new dependency -- and its absence is handled
# fail-CLOSED right here rather than assumed away.
command -v python3 >/dev/null 2>&1 || {
  echo "lead-gate: python3 missing -- refusing the call rather than waving it through (decision 11)" >&2
  exit 2
}
# `python3 -c` reads its program from argv, so the hook payload stays on
# stdin, undisturbed -- the same conflict this script's member-bundle block
# documents for the `decode | python3 - <<EOF` form it had to avoid.
exec python3 -c '
import json, re, sys

def refuse(msg):
    sys.stderr.write(msg + "\n")
    sys.exit(2)

# Maestro Studio has a declared roster of zero -- its studio.md has never
# listed a member to dispatch. So inside a maestro session, ANY tool call
# carrying agent_id/agent_type is, by construction, a subagent MAESTRO
# ITSELF spawned for coordination work, never a real member -- exempting
# it from the write-block below would let maestro implement BY PROXY
# through that subagent, exactly what decision 11 forbids (board issue
# 16).
#
# The placeholder assigned right below is not a bug -- it is replaced with
# the literal Python token `True` or `False` by a one-time `sed -i` run by
# studio-bringup.sh against the COPIED file at
# ~/.claude/hooks/lead-gate.sh, right after that copy lands (see the
# bring-up block that follows the `chmod 0755` on the copy), so the value
# below is baked into the bytes of the INSTALLED script, on disk, before
# it is ever executed, never re-derived from a separate file at decision
# time. This repo-tracked file (gates/lead-gate.sh) always keeps the
# placeholder literally -- only the per-container COPY gets the value
# baked in. See the ONE-exception paragraph in the comment above this
# hook for why that distinction is the entire fix (board issue #16).
# Deliberately not spelled out literally up here in prose (unlike the
# line right below it) -- the `sed -i` substitution matches the
# assignment line only, and a second mention up here would leave a
# stray, never-substituted copy of it sitting in this comment after
# bring-up bakes the real assignment in. No apostrophes in this comment
# on purpose -- this whole block is one bash single-quoted string opened
# at `exec python3 -c` above; a literal quote character here ends that
# string early and breaks everything after it into raw bash tokens (see
# the fuller warning on this same rule further down, before the D1 fix).
IS_MAESTRO = __IS_MAESTRO_BOOL__

try:
    payload = json.load(sys.stdin)
except Exception:
    # Unreadable payload -> fail CLOSED. A gate that cannot read its input
    # must not wave the call through.
    refuse("lead-gate: unreadable hook payload -- refusing")

# Dispatched member: exempt entirely, every tool, for every OTHER studio.
# This is the whole reason the gate is a hook and not --disallowedTools
# (which is session-global and starves members -- spike Probe A).
if payload.get("agent_id") or payload.get("agent_type"):
    if not IS_MAESTRO:
        sys.exit(0)
    # Falls through into the SAME write-shape checks below instead of
    # being exempted -- closing the by-proxy hole a maestro subagent would
    # otherwise open (board issue 16). A maestro subagent write call now
    # receives the same scrutiny a lead call already gets below; a
    # genuinely read-shaped call (Read, Grep, a status check) still
    # passes through untouched.

tool = payload.get("tool_name", "")

# Board issue 45: a lead sending a message to the subagent it dispatched
# itself is coordination, not implementation -- it is the single thing a
# lead exists to do. Measured 2026-09-23 in demosite-life--release-studio: a
# correction arrived mid-flight, the lead agreed with it, could not forward
# it, and a whole worker-context was spent building against a brief the
# lead already knew was defective. The failure direction of a refusal here
# is MORE spend and LATER detection, which is the opposite of what every
# other rule in this gate buys.
#
# What this permit actually changes, stated exactly, because the honest
# answer is smaller than it looks: the canonical SendMessage shape
# (to/message/summary) was ALREADY permitted before this rule existed --
# the name does not match the writeish-name regex and none of those three
# keys is a locator or a write-content key. That permit was an accident of
# parameter naming, not a rule. has_write_content matches on tool_input
# KEYS with no reference to the tool carrying them, so the moment a message
# body parameter is named content/contents/edits/new_string/new_str/patch
# -- true today of other messaging surfaces this fleet mounts, per the MCP
# SURFACE paragraph in the comment block above -- the same coordination
# message was refused for the NAME of its body field. This rule states the
# permit instead of leaving it to luck.
#
# Exact tool names, never a regex over shapes. Every other list in this
# file is a BLOCKLIST, where over-narrow costs a miss; this one is a
# PERMIT, where over-broad IS the hole. So it names one tool and grows only
# when a real messaging tool is observed being refused.
#
# NOT IS_MAESTRO -- the narrower of the two rules board issue 45 offered,
# taken deliberately. Board issue 23 closed maestro implementing BY PROXY
# through a subagent, and a message is the exact channel a proxied write
# would use. This hook cannot tell a redirect from a proxied write by
# reading the message: both are free-form English, and any text rule over
# the body is defeated by rephrasing while also refusing legitimate
# redirects that merely mention a file. Since the line cannot be drawn on
# content, it is drawn on roster: every non-maestro studio has real
# declared members who ARE supposed to implement, so their lead telling
# them what to build adds no authority the dispatch prompt did not already
# carry. Maestro has a roster of zero, so it keeps exactly the treatment it
# had before this rule -- a message-shaped call from a maestro falls
# through into the same write-shape checks below, and a maestro handing a
# subagent literal content or a patch through that channel still refuses.
#
# Honest about what this does NOT buy, in the same spirit as the HONEST
# SCOPE paragraph above. The recipient is not verified: this hook has no
# roster of who was dispatched in this session, so the permit is on the
# TOOL, not on the claim that the target is the leads own subagent -- a
# lead can message any agent the harness will route to, including a peer
# session. And a plain-language instruction to write a file stays
# indistinguishable from a redirect for every non-maestro lead. What keeps
# that from being a proxy hole is that it was never the enforcement point:
# a lead can already put the same instruction in a Task prompt today (Task
# is permitted, and always has been), and in a studio with real members
# their writing files is the entire point. For maestro, where it is NOT the
# point, enforcement stays on the subagent write call itself, which board
# issue 16 already routes through these same checks.
MESSAGE_TOOLS = ("SendMessage",)
if tool in MESSAGE_TOOLS and not IS_MAESTRO:
    sys.exit(0)

if tool != "Bash":
    # Shape, not a fixed tool list (P7a Task 5): a lead is blocked when the
    # tool LOOKS like a write. `file_path`/`path` alone is a LOCATOR, not a
    # write signal -- the only required param of Read IS file_path, Grep/Glob take
    # `path` as their directory scope, and round 1 of this gate refused all
    # three (review Finding 1, Critical: "the lead cannot Read"). A write
    # needs a writeish NAME pointed at a locator, OR content to write even
    # without either -- so a name match alone (TodoWrite) is not enough, and
    # neither is a locator alone (Read/Grep/Glob).
    #
    # `isinstance(x, dict)`, not `or {}` -- Review Finding 2 (Important)
    # fixed the CRASH (null tool_input raised, uncaught, exit 1) but not the
    # HOLE: `or {}` and an absent-or-non-dict `tool_input` both land on the
    # SAME empty {}, so a writeish name with no locator/content still came
    # out not-write-shaped and PERMITTED -- same outcome as the crash, just
    # via a clean exit 0 instead of an accidental one (review round 3,
    # Important, a defect in the ruling that fixed Finding 2).
    #
    # Ruling: a writeish NAME whose input is unreadable (absent, null, or
    # not even a dict) REFUSES outright, same fail-CLOSED reasoning the
    # unparseable-whole-payload guard above already uses -- cannot verify
    # the call is safe, and the call is NAMED like a write, so it blocks. A
    # false refusal costs the lead one turn (dispatch a member); a false
    # permit is a silent write, found later or never. A non-writeish name
    # (Read/Grep/Glob/Task/WebFetch, and Bash -- handled in its own branch
    # above this one) keeps passing on ANY input shape: `name_writeish and
    # tool_input_unreadable` short-circuits False the moment the name does
    # not match, before this refusal is ever reached.
    raw_tool_input = payload.get("tool_input")
    tool_input_unreadable = not isinstance(raw_tool_input, dict)
    tool_input = raw_tool_input if isinstance(raw_tool_input, dict) else {}
    name_writeish = bool(re.search(r"(?i)(edit|write|notebook|patch|apply)", tool))
    if name_writeish and tool_input_unreadable:
        refuse("leads never implement -- dispatch a member")
    has_locator = any(key in tool_input for key in ("file_path", "path", "notebook_path"))
    has_write_content = any(
        key in tool_input for key in ("content", "contents", "edits", "new_string", "new_str", "patch")
    )
    write_shaped = (name_writeish and has_locator) or has_write_content
    if write_shaped:
        refuse("leads never implement -- dispatch a member")
    sys.exit(0)

# D1 (deferred finding, taken now): `or {}` above substituted only on
# FALSY, so a PRESENT but non-dict tool_input (a string, a list, a number --
# not None, which stays a permit below, same reasoning already used for the
# non-Bash branch None case) reached `.get("command", "")` directly, raised
# AttributeError uncaught, and exited 1 -- which PERMITS (only exit 2
# blocks). Same isinstance normalisation the non-Bash branch above uses,
# with the same fail-CLOSED ruling: a value that IS there but cannot be
# read as an object means the command cannot be verified safe, so refuse
# rather than let a crash decide.
#
# No apostrophes past this point in this file -- this whole block is one
# bash single-quoted string (opened at exec python3 -c above); a literal
# quote character here ends that string early and breaks everything after
# it into raw bash tokens.
raw_tool_input = payload.get("tool_input")
if raw_tool_input is not None and not isinstance(raw_tool_input, dict):
    refuse("leads never implement -- this Bash tool_input is not a readable object, cannot verify the command is safe. Dispatch a member.")
tool_input = raw_tool_input if isinstance(raw_tool_input, dict) else {}
cmd = tool_input.get("command", "")

# Quoted spans are stripped BEFORE scanning. Without this, a board comment
# body carrying a markdown blockquote (gh issue comment --body "> like
# this") reads as an output redirection and the lead loses its single most
# important coordination command. Stripping leaves real operators -- they
# live outside quotes by definition.
bare = re.sub(r"\x27[^\x27]*\x27|\"(?:\\.|[^\"\\])*\"", " ", cmd, flags=re.S)

# Redirection into a path. /dev/null and fd dups (2>&1, >&2) are not writes
# to the tree and stay allowed. Heredoc-into-file needs no rule of its own:
# every form of it (cat > f <<EOF, cat <<EOF > f, tee f <<EOF) carries a
# redirect or a tee, so it is already covered here.
for m in re.finditer(r"(?<![<>&])>{1,2}\|?(?!&)\s*([^\s;|&<>]+)", bare):
    if not m.group(1).startswith("/dev/"):
        refuse("leads never implement -- this Bash command redirects output into a file (" + m.group(1) + "). Dispatch a member to write it.")

FORMS = [
    (r"(?<![\w-])tee\b", "tee writes a file"),
    (r"(?<![\w-])sed\b[^;&|]*(?:-i\b|--in-place)", "sed -i edits in place"),
    (r"(?<![\w-])(?:mv|cp)\b", "mv/cp moves file content"),
    (r"(?<![\w-])dd\b[^;&|]*\bof=", "dd of= writes a file"),
    # Shell wrappers. These are what the quote-strip above costs: `bash -c
    # "printf x > /workspace/f"` carries its ENTIRE payload inside quotes,
    # so `bare` sees only `bash -c` and every rule above finds nothing.
    # Re-parsing a nested shell is unbounded; refusing the wrapper is not,
    # and it costs the lead nothing -- the Bash tool it already holds IS a
    # shell, so nesting one buys only a way around this gate. Anchored at
    # command position, so `grep -rn eval src` and `cat scripts/deploy.sh`
    # still pass.
    (r"(?:^|[;&|(]|\$\(|`)\s*(?:[\w./-]*/)?(?:ba|z|k|da)?sh[ \t]+(?:[^\s;&|]+[ \t]+)*?-[a-zA-Z]*c(?![\w-])",
     "bash -c / sh -c hides its payload from this gate"),
    # Same wrapper, one hop further out. xargs/env take flags before the
    # command they spawn, so the command-position anchor above cannot see
    # it. Note this blocks `xargs ... sh -c` ONLY -- never xargs itself.
    (r"(?<![\w-])(?:xargs|env)\b[^;&|]*?(?:[\w./-]*/)?(?:ba|z|k|da)?sh[ \t]+(?:[^\s;&|]+[ \t]+)*?-[a-zA-Z]*c(?![\w-])",
     "xargs/env spawning a shell hides its payload from this gate"),
    (r"(?:^|[;&|(]|\$\(|`)\s*eval(?![\w-])", "eval hides its payload from this gate"),
]
for pat, why in FORMS:
    if re.search(pat, bare):
        refuse("leads never implement -- this Bash command writes files (" + why + "). Dispatch a member.")

sys.exit(0)
'

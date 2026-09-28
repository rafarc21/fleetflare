#!/usr/bin/env bash
# Board #350, round 5 review, item 1 — the install-cache feature's own "is an
# install still running" signal (install-cache.ts's bunInstallRunningCmd)
# used to scan /proc for ANY live bun/node/npm/npx/yarn/pnpm process with a
# matching cwd/argv (round 4 review, item 2's own fix). Measured OVER-BROAD:
# a long-lived dev server or an MCP server started via `bun x` from the repo
# root (real on fleetflare--web-studio) matches identically to a genuine
# in-progress package-manager install, so a repo with a root lockfile whose
# studio ALSO runs a dev server never saves its install cache at all — the
# process scan can never tell "installing" apart from "an unrelated bun
# process sitting in this directory".
#
# Fixed by dropping the process scan entirely in favor of a COMPLETION
# MARKER this hook writes: `node_modules/.fleet-install-complete`, touched
# right after a real package-manager install command finishes in a
# directory, IF it looks like it actually succeeded. install-cache.ts's
# bunInstallRunningCmd then asks a purely filesystem-shaped question --
# "does this marker exist, and is it newer than every lockfile in the
# directory" -- with no /proc scan of any kind (see that function's own doc
# comment for exactly how it reads this marker).
#
# WHY A HOOK, NOT FLEET'S OWN CODE: installs run inside the lead's own
# interactive/agentic container session -- fleet's Worker/DO code has no
# invocation site of its own to wrap (install-cache.ts's own file header,
# round 4 review). The ONE place that reliably sees every `bun install` (or
# npm/yarn/pnpm equivalent) a lead or member ever runs is the Bash tool call
# itself, which is exactly what a PostToolUse hook observes.
#
# HONEST LIMITATION, read before trusting this too far: Claude Code's own
# PostToolUse hook payload for the Bash tool does NOT carry the command's
# exit code -- verified against Claude Code's own hooks documentation, which
# lists exactly four fields on a Bash tool_response: stdout, stderr,
# interrupted, isImage. There is no fifth exit-code field to read. So
# "succeeded" below is a best-effort triangulation, not a certainty:
# `interrupted` is false (not killed/timed out), NEITHER stdout NOR stderr
# carries any of a short, curated set of well-known package-manager
# hard-failure prefixes, and the target directory's own node_modules exists
# and is non-empty afterward. This is deliberately biased toward FALSE
# NEGATIVES (a marker not written, leaving the directory looking "still
# running"/unsettled for one more save-tick) over false positives (a marker
# wrongly written after a real failure): a missed marker costs one skipped
# save tick, exactly install-cache.ts's own file-wide "biased toward false
# positives [on the install-running check specifically] over false
# negatives" posture already accepts for the OLD process-scan design (round
# 3 review, item 2's own doc comment) -- restated here as "biased toward NOT
# marking settled" for the new, inverted signal this hook now produces. And
# even a wrongly-written marker is no worse than the OLD design's own risk
# here: neither design ever verified the install actually SUCCEEDED before
# allowing a save -- installCacheSaveCmd's own zstd/tar integrity checks
# (install-cache.ts) are the actual, independent safety net against
# uploading a broken archive, exactly as they already are today.
#
# Round 6 review, item 4 -- BOTH stdout AND stderr, not stderr alone. The
# maestro measured this live: a real Bash tool call shaped like
# `bun install 2>&1 | tail` -- an ordinary, common shell idiom that redirects
# a command's own stderr into stdout before piping onward -- lands its own
# failure text in tool_response.stdout, with tool_response.stderr genuinely
# EMPTY. This hook checked only stderr for a long time, so a genuinely
# failed install run through exactly that shape wrongly got marked complete
# -- the maestro own words, "wrote marker live", not a theoretical gap. Fixed
# by reading tool_response.stdout the same defensive way stderr already is
# (isinstance check, default to empty string) and running the identical
# FAILURE_RE check against both -- a match in EITHER one refuses to write
# the marker.
#
# DIRECTORY RESOLUTION: the payload's own `cwd` field (Claude Code updates
# this per real `cd` activity within a session, so `cd apps/site-a && bun
# install` run as ONE Bash call already lands here as apps/site-a by the
# time this hook fires), UNLESS the command itself names an explicit target
# directory that does NOT require moving the shell's own cwd at all
# (`bun install --cwd <dir>` / `pnpm install --cwd <dir>` / `npm install
# --prefix <dir>`) -- those change what the package manager installs into
# WITHOUT moving the shell's own cwd, so trusting payload cwd alone would
# silently miss every one of them.
#
# STUDIO_ID fail-closed, same reasoning/wording as every other gate in this
# directory (see lead-gate.sh/completion-gate.sh's own identical comment):
# set in every cloud studio's own process environment, inherited by any hook
# subprocess Claude Code spawns, never set on a developer's own Mac.
[ -n "${STUDIO_ID:-}" ] || exit 0

# python3 for the same reason every other gate in this directory uses it:
# the payload is JSON, and misreading it is worse than doing nothing. This
# hook is purely best-effort (see the HONEST LIMITATION paragraph above), so
# its own absence fails OPEN (a quiet no-op, exit 0) rather than refusing
# anything -- unlike lead-gate.sh/completion-gate.sh, there is no security or
# completion invariant here for a missing interpreter to violate; a missed
# marker costs one skipped save tick, nothing more.
command -v python3 >/dev/null 2>&1 || exit 0
exec python3 -c '
import json, os, re, sys

try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)

if payload.get("tool_name") != "Bash":
    sys.exit(0)

raw_tool_input = payload.get("tool_input")
tool_input = raw_tool_input if isinstance(raw_tool_input, dict) else {}
cmd = tool_input.get("command")
if not isinstance(cmd, str) or not cmd.strip():
    sys.exit(0)

raw_tool_response = payload.get("tool_response")
tool_response = raw_tool_response if isinstance(raw_tool_response, dict) else {}

# Claude Code hooks documentation lists exactly these four fields on a Bash
# tool_response -- no exit code. See this file own header comment.
if tool_response.get("interrupted"):
    sys.exit(0)
stderr = tool_response.get("stderr")
stderr = stderr if isinstance(stderr, str) else ""
# Round 6 review, item 4 -- checked the same defensive way as stderr, never
# trusted alone: a command shaped like `bun install 2>&1 | tail` lands its
# own failure text in stdout, with stderr genuinely empty. See this file own
# header for the maestro own live-observed case this closes.
stdout = tool_response.get("stdout")
stdout = stdout if isinstance(stdout, str) else ""

# One segment at a time (split on &&/;/|), so a compound command like
# `cd apps/site-a && bun install` still matches on its own "bun install"
# segment even though the WHOLE string does not start with it. `bun i` is
# bun own documented shorthand for `bun install`; a bare `yarn` (no
# subcommand) is yarn classic own default install; `npm ci`/`npm i` are
# npm own aliases -- named explicitly, per the maestro own review comment,
# rather than matched by a generic "install" substring.
segments = re.split(r"&&|;|\|", cmd)
INSTALL_RE = re.compile(
    r"^\s*(?:bun\s+(?:install|i)\b|npm\s+(?:install|ci|i)\b|yarn(?:\s+install)?\s*$|yarn\s+install\b|pnpm\s+(?:install|i)\b)"
)
if not any(INSTALL_RE.search(seg) for seg in segments):
    sys.exit(0)

# Known, unambiguous hard-failure prefixes -- kept deliberately short and
# specific (never a generic "error" substring, which a dependency own
# build-time log output can carry on a perfectly successful install).
# Best-effort, exactly like the rest of this heuristic -- see this file own
# header for why this is not, and cannot be, a certainty.
#
# `failed to resolve` is bun own terminal error line for an unresolvable
# dependency -- verified live against real bun 1.3.12 (this container own
# version): `error: <spec>@<version> failed to resolve` for a 404/missing
# version, `error: GET <url> - 404` immediately above it. Added because the
# original pattern here was npm/pnpm-only and a real, ordinary bun failure
# (add a dependency that cannot resolve to an EXISTING node_modules from a
# prior successful install) reproduced live: node_modules stayed non-empty
# (the settled check alone did not catch it) and the old FAILURE_RE missed
# bun own error text entirely, which would have wrongly marked a broken
# install "complete" -- exactly the false positive this heuristic is
# supposed to be biased against.
FAILURE_RE = re.compile(
    r"npm error|npm ERR!|ERR_PNPM|error: (?:Failed|Cannot|EACCES|ENOENT)|error:.*failed to resolve",
    re.IGNORECASE,
)
# Round 6 review, item 4 -- checked against BOTH fields, never stderr alone:
# a `2>&1 | tail`-shaped command (or anything else that folds stderr into
# stdout before this hook ever sees it) lands its own real failure text in
# stdout, with stderr left genuinely empty. A match in EITHER field refuses
# to write the marker.
if FAILURE_RE.search(stderr) or FAILURE_RE.search(stdout):
    sys.exit(0)

# Directory: payload cwd, unless the command itself names an explicit
# --cwd/--prefix target (see this file own header, DIRECTORY RESOLUTION).
cwd = payload.get("cwd")
cwd = cwd if isinstance(cwd, str) and cwd else os.getcwd()

m = re.search(r"--(?:cwd|prefix)[= ]+([^\s\x27\"]+|\x27[^\x27]*\x27|\"[^\"]*\")", cmd)
target = cwd
if m:
    raw = m.group(1)
    if (raw.startswith("\x27") and raw.endswith("\x27")) or (raw.startswith("\"") and raw.endswith("\"")):
        raw = raw[1:-1]
    target = raw if os.path.isabs(raw) else os.path.join(cwd, raw)

node_modules = os.path.join(target, "node_modules")
try:
    settled = os.path.isdir(node_modules) and len(os.listdir(node_modules)) > 0
except Exception:
    settled = False
if not settled:
    sys.exit(0)

try:
    open(os.path.join(node_modules, ".fleet-install-complete"), "w").close()
except Exception:
    pass
sys.exit(0)
'

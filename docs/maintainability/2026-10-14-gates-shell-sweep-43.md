# Gates shell sweep 43 — gates/**/*.sh (2026-10-14)

Ref #855. Analysis only, read-only, no code changed. Forty-third
maintainability sweep; scope `gates/**/*.sh` — which is exactly
`gates/*.sh`: gates/ has no subdirectories, five scripts, 1142 lines
(activity-heartbeat 283, completion-gate 276, install-marker 192,
lead-gate 354, session-reemit 37). Line refs = physical lines at
`origin/main` `c7407c44`.

Method: every script read line-by-line in full. Three mechanical scans,
then hand verification of every hit: (1) unquoted `$`-expansions — quote
state walked character-by-character up to each expansion, any expansion
outside single/double quotes listed; (2) `set -e`/`set -u`/
`set -o pipefail` presence per script; (3) every `grep -q` occurrence,
checked for pipe membership (SIGPIPE false-fail class, #393/#395).
shellcheck is absent from this image (`command -v shellcheck` fails), so
every ruling below is by hand, not tool output.

**Ruled out (verified clean, no finding):**

- **Missing `set -euo pipefail` — all five scripts, all deliberate.**
  activity-heartbeat.sh:35-37 states it outright ("Deliberately no
  `set -e`"): every guarded command degrades to a silent no-op and the
  last line is an unconditional `exit 0`, because a nonzero
  UserPromptSubmit hook exit BLOCKS the turn. completion-gate.sh,
  lead-gate.sh and install-marker.sh run at most two guarded shell
  lines (the `STUDIO_ID` guard, a `command -v python3` check) and then
  `exec python3 -c` — nothing fallible executes in bash, so `set -e`
  has nothing to bite on; all policy lives in the python body's
  explicit try/except. session-reemit.sh:8-9 ("Silent on every failure.
  This is a CHECK, not a gate") guards every command by hand
  (`|| true`, `|| exit 0`); `set -e` would turn a benign failure into
  a nonzero exit whose stderr lands in the lead's own context.
- **`grep -q` in pipes — none in scope.** Exactly one `grep -q` exists
  across the five scripts (session-reemit.sh:34) and it takes a FILE
  argument, never a pipe — no SIGPIPE surface. The repo's
  capture-then-check convention (#393/#395) is followed at the other
  pipefail sites — apps/fleet/scripts/localci/localci.sh:366-372,
  apps/fleet/container/studio-bringup.sh:266,
  apps/fleet/scripts/deploy.sh:114 — though
  scripts/test/public-export.test.sh still carries 18 bare
  pipes into `grep -q` (17 echo-shaped, e.g. :197, :224, :275, :568,
  plus one `git log | grep -q` at :526) under its own
  `set -uo pipefail` (line 59), out of this sweep's gates-only
  scope. activity-heartbeat.sh:174-176
  pipes `printf | sed -n` with no pipefail in effect and sed never
  early-exits, so no race either way.
- **Unquoted expansions — one instance in 1142 lines** (F1 below).
  Everything else is quoted, including the classic hot spots:
  `/proc/$1/comm` and `/proc/$1/stat` (activity-heartbeat.sh:82,85),
  the tmp-then-mv path pair (activity-heartbeat.sh:243-245), `$ws`
  (session-reemit.sh:25,34,36), every `"${STUDIO_ID:-}"` guard (the
  four gate headers; session-reemit.sh carries none). No `$@`/`$*`
  use exists anywhere in the scope.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | gates/activity-heartbeat.sh:88 — `set -- $rest` glob-exposed word-split | GLM-OK |
| 2 | gates/session-reemit.sh:31-33 — grep-dependency comment cites a check that lives in another file | GLM-OK |

### S43-F1. activity-heartbeat.sh — `ppid_of` splits unquoted, so the intended word-split is also a glob — GLM-OK

- **File:** `gates/activity-heartbeat.sh:88` — `set -- $rest` inside `ppid_of()`.
- **Pattern:** unquoted variable expansion in a word-split context.
- **Evidence:** `$rest` is the `/proc/<pid>/stat` tail after the last `") "` (line 87). The split is INTENDED — the comment on line 89 explains `$1` is the state field and `$2` the ppid — but an unquoted expansion both word-splits AND glob-expands: any `*?[` in the fields would replace the positionals with filename matches, silently corrupting the parsed ppid. In practice the kernel-generated fields cannot carry glob characters (state is one char, ppid numeric), so this is hardening, not a live bug — LOW severity, and `ppid_of` already fails closed on an empty `$2` (line 90).
- **Smallest fix:** disable globbing around the split — `set -f` before line 88, `set +f` after — or parse without positional mutation: `read -r _ ppid _ <<<"$rest"` into a local, keeping the empty-check.

### S43-F2. session-reemit.sh — grep-dependency comment cites a settings.json check that is not in this file — GLM-OK

- **File:** `gates/session-reemit.sh:31-33` — "grep is already a dependency of this same script (the settings.json hook-presence check further down uses it), so this adds nothing new to the image."
- **Evidence:** this file is 37 lines and holds no settings.json check; grep's only use is the very next line (line 34, the whitespace check on the working-set file). The hook-presence check the comment means lives in `apps/fleet/container/studio-bringup.sh:1207` — a different file this hook never reads. Stale since birth: the claim landed with the file in PR #308 (2026-10-09) and `git log -S 'settings.json' -- gates/session-reemit.sh` shows no later touch.
- **Smallest fix:** drop the parenthetical, or reword to what is true — line 34 is grep's first use in this script; the dependency claim can cite studio-bringup.sh:1207 as a same-image consumer instead.

Follow-ups land as separate issues (one per batch), refs #855.
This PR ships only this analysis doc.

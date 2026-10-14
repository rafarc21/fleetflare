# #875 plan — S43-F1 activity-heartbeat ppid_of: no glob on the stat split

Refs #855 (sweep 43 census, gates/ shell scripts). Refs #875.
Census doc: docs/maintainability/2026-10-14-gates-shell-sweep-43.md (on the sweep-43 branch; this
branch carries only the fix).

## What

`gates/activity-heartbeat.sh:88` — `ppid_of()` does `set -- $rest` to split the
/proc/<pid>/stat tail (everything after the last `) `) into positionals: `$1` =
state (one char), `$2` = ppid (numeric). The unquoted expansion word-splits —
intended — but bash ALSO glob-expands it: any `*`, `?` or `[` in a field would
replace the positionals with filename matches from the hook's own cwd,
silently corrupting the parsed ppid. Kernel-generated stat fields cannot carry
glob characters, so this is hardening, LOW severity, no live bug.

## Why `set -f` and not `read`

Both candidates from the task work. `set -f` / `set +f` around the split keeps
the existing positional-mutation idiom and its empty-check comment untouched
(diff = 2 lines + comment); `read -r _ ppid _ <<<"$rest"` needs a new local,
changes the empty-check, and a here-string adds a stdin-redirection edge.
Smallest fix wins for a file this comment-dense.

## Steps

1. RED test: one new linuxOnly test in apps/fleet/test/bun/bringup-heartbeat-core.test.ts.
2. GREEN: `set -f` / `set +f` bracketing the split in gates/activity-heartbeat.sh.
3. Fresh-context review, then QA, PR, envelope (lead handles 3-5; you do 1-2).

## Verification (gate budget)

`cd apps/fleet && bun test test/bun/bringup-heartbeat-core.test.ts` — execs the
real script, including the is_lead_session walk-up tests exercising ppid_of.
Plus `bun run english-check` (comment change touches the English-only rule).
NO heavy gates: no full suite, no vite build, no repo-wide tsc. One bun test
file + one script = light, runs alone, nothing parallel.

## Boundaries (from #875)

- `gates/activity-heartbeat.sh` ONLY (test file touched for the new test).
- Fail-open posture + always-exit-0 contract (header, lines 29-37) survive:
  no `set -e`, no new stderr output, no new tool dependency.
- Do NOT touch `gates/session-reemit.sh` (F2, separate issue).
- `set -f`/`set +f` bracket ONLY the split; `set +f` unconditional so
  globbing is never left off for the rest of the script.

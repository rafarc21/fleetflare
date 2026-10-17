# Plan — non-list Stop in settings.json fails open, never truncates (#1131, refs #1116)

## Root cause (confirmed: live probe of the three merge regions)

- ~/.claude/settings.json written by an OUTSIDE writer can carry `"Stop": {}` (object), a string, or null. Bring-up itself only ever writes lists.
- The settings-merge python does `stop[:] = [...]` (lead-gate/oss-lead-continue, completion-gate) and `arr[:] = [...]` (activity-heartbeat loop). Slice-assign on a non-list raises TypeError.
- Lead-gate region already catches it (try/except, #1116) → exit 0. Heartbeat + completion regions do NOT: TypeError → python3 exit 1 → `set -euo pipefail` aborts bring-up.
- Severity: lead-gate lost / bring-up aborts. Fix must fail OPEN + write atomically.

## Fix (apps/fleet/container/studio-bringup.sh, three regions)

- isinstance(stop/arr, list) guard before every slice-assign. Non-list → log "Stop not a list, <hook> hook not registered -- leaving settings untouched", leave the value untouched, continue.
- Every settings.json write goes through temp file + rename (tmp = path + ".tmp"; write; os.replace) so a crash mid-dump never truncates the live file. Keeps the pinned `json.dump(cfg, f, indent=2)` byte-identical.
- Add `>>> completion-gate-settings-merge >>>` region markers around the completion python (matches the other two), so a behavior test can extract it.

## RED test (apps/fleet/test/bun/bringup-stop-guard.test.ts, new)

test.each over Stop = object / string / null, per region (lead-gate, heartbeat, completion): extract region, run with fake HOME, assert exit 0, file parses as valid JSON, Stop value left untouched, and (lead-gate region) PreToolUse still references lead-gate.sh, (heartbeat region) the other three events still registered. RED now: heartbeat + completion exit 1 (crash); lead-gate stderr lacks "Stop not a list".

## Steps

1. Plan doc (this file).
2. RED: bringup-stop-guard.test.ts; run `bun test apps/fleet/test/bun/bringup-stop-guard.test.ts` → fails; commit + push.
3. GREEN: three-region fix in studio-bringup.sh; run the same test → green; commit + push.
4. Verify affected suites (one at a time): the new file + bringup-gates + oss-lead-continue-gate + bringup-heartbeat-core (bun); `bun run check`; `bun run english-check`; `bun run test-lies-check`; vitest `test/studio.session.test.ts` (pins the edited fragments).
5. Review (fresh context) → QA → PR refs #1131 + #1116 → envelope.

## Boundaries

Touch only: apps/fleet/container/studio-bringup.sh, apps/fleet/test/bun/bringup-stop-guard.test.ts, this plan doc. Keep pinned fragments byte-identical: `setdefault("Stop", [])`, `stop[:] = [e for e in stop if "completion-gate.sh"...`, `json.dump(cfg, f, indent=2)`. No TS, no image, no other hooks. Heavy gate: `bun run check` is repo-wide tsc — run alone, never alongside another gate.
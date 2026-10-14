# Plan — sweep 40: stale TODO/FIXME/XXX markers (refs #844)

Ref #844. Doc-only sweep: find comment markers whose cited issue is closed,
PR merged, or condition already true on origin/main @ 414a3c91.

1. Grep scope apps/fleet/src/**, apps/fleet/scripts/**, scripts/** for
   TODO/FIXME/XXX/HACK tokens and promise-shape comments ("once X",
   "until X", "not part of this PR", "separate, later change").
2. Classify every hit: genuine marker vs prose vs identifier vs fixture.
3. Verify each candidate: issue state via `gh issue view`, PR state via
   `gh pr view`, code condition via grep/read at origin/main.
4. Write findings doc docs/maintainability/2026-10-14-stale-markers-sweep-40.md.
5. No code changes — findings become one follow-up board issue, fixed later.

Out of scope: apps/fleet/container/, test fixtures, mktemp XXXXXX templates.

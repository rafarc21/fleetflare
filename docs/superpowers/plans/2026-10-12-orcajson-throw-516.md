# Fix #516: orcaJson throws on unparseable output (sweep 13, finding S13-F2)

Refs #482, closes #516.

## Problem

`orcaJson` (apps/fleet/cli/orca-workspace.ts:419) documents "Throws on every
failure — timeout, non-zero exit, unparseable output", but the JSON.parse catch
returns `{}`. The timeout and exit-code branches above it throw. An Orca upgrade
that prints non-JSON beside a 0 exit decodes as an empty envelope: `ensure` sees
`[]` worktrees and creates a duplicate; a successful `terminal create` decodes no
handle so the rename is skipped and the next ensure stacks a second attach
terminal.

## Steps

1. RED: in test/bun/orca-workspace.test.ts, flip the pinned test at line ~1953
   ("#124/#299: readStudioRows — unparseable orca output reads '?', never
   'none', and says why") to expect the new error text `orca worktree list
   printed unparseable JSON`, and add one new test pinning the throw contract
   directly: unparseable output with ok:true exit 0 makes `ensureStudioWorkspace`
   return `{kind:"failed"}` whose why contains `printed unparseable JSON`, and no
   `worktree create` call is made (fake's calls array proves absence).
2. GREEN: in cli/orca-workspace.ts, replace the catch's `return {};` with
   `throw new Error(\`${what} printed unparseable JSON\`);` and update the stale
   `fullList` doc comment (lines ~401-404) which still says "(unparseable output
   decodes to `{}`)" — unparseable output now throws at orcaJson, fullList's
   remaining check is the shape check (truncated / missing array).
3. Verify: cd apps/fleet && bun test test/bun/orca-workspace.test.ts
   then bun test test/bun/fleet-tabs-scope.test.ts test/bun/print-attach-handle.test.ts
   then bun run check, then bun run english-check.

## Boundaries

Only cli/orca-workspace.ts and test/bun/orca-workspace.test.ts may change (plus
this plan doc). No new deps. `bun run check` runs repo tsc twice-equivalent —
run it alone, never alongside another gate. All orcaJson callers sit inside
try/catch boundaries (ensureStudioWorkspace, removeStudioWorkspace,
readStudioRows, findAttachHandle, previewStudioWorkspace), so the throw is safe.

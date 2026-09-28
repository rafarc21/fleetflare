# Orca Terminal Idempotency Fix

**Problem (board issue #6):** `ensure()` in `apps/fleet/cli/orca-workspace.ts`
checks `terms.result?.terminals?.some(t => t.title === id)` to decide whether
a studio already has its attach terminal. Measured against real Orca 1.4.198
(`orca terminal list --worktree id:<wt> --json`): every terminal's `title`
field always reads `"fleet"` — the RUNNING PROCESS's name, never the studio
id, and never the custom label `terminal rename --title <id>` sets either.
The rename holds on the visible tab label (measured), but `list`'s own
`title` field never reflects it. So `t.title === id` compares against a
value the API can never produce — it never matches. Every `fleet
spawn`/`provision`/`recycle`/`ff` call therefore believes the studio has no
attach terminal yet and opens ANOTHER one: unbounded duplicate Orca tabs,
each an independent tmux client on the SAME remote session, which is also
what pins `window-size latest` to the wrong size (the corrupted render /
white band the operator is seeing).

Real terminal-list JSON shape (measured, two duplicate tabs on one studio's
worktree):

```json
[
  {"handle":"term_531b9051-...","title":"fleet","tabId":"98ad143e-...","connected":true},
  {"handle":"term_07c8a97e-...","title":"fleet","tabId":"934e8ecd-...","connected":true}
]
```

Full key set (same measurement): `branch, connected, executionHostId,
handle, incarnationId, lastOutputAt, leafId, orphaned, preview, ptyId,
tabId, title, worktreeId, worktreePath, writable`. No custom-title field
distinct from `title` is exposed by `list` at all.

## Fix 1 — idempotency by `connected`, not by `title`

Switch the check to: any terminal in this worktree's list with `connected
=== true` counts as "this studio already has its attach terminal."
`title` is structurally unusable (proven above — the API never reports
what we set). The studio's Orca worktree is single-purpose by design
(this file's own header: "this checkout exists to host one attach
terminal") — nothing else is expected to open a terminal there, so
treating any live terminal in it as proof-of-existence is a correct
reading of that design intent, not a hack. Tradeoff, documented in a code
comment: if an operator manually opens an extra shell in that dedicated
worktree, this would (harmlessly) treat it as satisfying the idempotency
check too — acceptable given the worktree's single-purpose design.

Requires adding `connected?: boolean` to the `terminals` array entry type
on `OrcaEnvelope` (currently only `handle`/`title`).

## Fix 2 — defensive handling for an UNCONFIRMED hypothesis

Separate report (Acme CTO): sometimes the extra tab is an EMPTY shell,
not a `fleet attach` session. Hypothesis, NOT confirmed (no Orca inside
this container to measure): `orca worktree create` might open its own
default terminal as a side effect, before this code's own `terminal
create --command "fleet attach <id>"` call ever runs.

If Fix 1 were applied uniformly, a brand-new worktree's own possible
default terminal would ALSO read `connected: true`, and a naive "any
connected terminal = exists" rule would then skip creating the REAL
`fleet attach <id>` terminal entirely — an empty shell forever. Worse than
today, not better.

Mitigation, using only Orca subcommands this file already knows exist
(`worktree list/create`, `terminal list/create/rename` — no invented
`terminal close`; calling a nonexistent subcommand would just fail inside
the existing single try/catch, degrading to `{kind: "failed"}` without
ever creating the real terminal either): **the "any connected terminal
counts as existing" shortcut only applies on the `existing`
(repeat-call) worktree path.** On the `created` path (this call just made
a brand-new worktree), ALWAYS proceed to create the `fleet attach <id>`
terminal and rename it, unconditionally — never skip based on what's
already listed there.

Worst case if the CTO's hypothesis is true: one call in the studio's
whole lifetime (its very first) might leave one extra, harmless, empty
stray tab next to the real one. It does not recur on every call (that's
the bug being fixed) and never blocks the real attach terminal from being
created. This residual, unverified-either-way tradeoff is noted in a code
comment.

Implementation shape: the `existing` and brand-new-worktree branches both
converge on a shared `selector` variable, and one `terminal list` call
runs unconditionally after that convergence point; the idempotency
shortcut itself is gated by a `!created` check
(`if (!created && terms.result?.terminals?.some(t => t.connected === true))`)
rather than living structurally only inside the `existing` branch. On the
brand-new-worktree path this means the `terminal list` result is fetched
but discarded — a known, accepted minor cost (one extra network
round-trip against a container that's already mid-provisioning); a future
cleanup could skip that fetch entirely on the `created` path if it ever
matters, but this PR doesn't do that. Every other piece of behavior is
preserved exactly: `--no-parent --setup skip` create flags, the
rename-after-create title stamp, the `created` return-kind semantics, the
repo-resolution error path.

## The five properties, preserved

1. Never fails its caller — same single try/catch in
   `ensureStudioWorkspace`, untouched.
2. No-op outside Orca — `orcaPresent` untouched.
3. Idempotent at both levels — worktree by displayName (untouched);
   terminal by `connected` instead of `title` (this fix), still checked
   separately from the worktree's existence.
4. Never steals focus — no `--focus`/`--activate` added anywhere.
5. Bounded — every orca call still carries its existing timeout; no new
   unbounded call added.

## Boundary

Only two files touched: `apps/fleet/cli/orca-workspace.ts` and
`apps/fleet/test/bun/orca-workspace.test.ts`. Nothing in `container/`,
`src/github/`, `skills/`, or the paused `origin/fix/gates-single-source`
branch (`gates/`, board issue #2) is read or touched.

## Verification plan

`cd apps/fleet && bun run test` (vitest lane) and `cd apps/fleet && bun
run bun-test` (bun:test lane, which is what actually runs
`test/bun/orca-workspace.test.ts` — excluded from vitest's own
`exclude` list in `vitest.config.ts`). The vitest lane is known to hit a
pre-existing, unrelated failure in `test/studio.blueprint.test.ts`
(`fleet.json (repo root)` expects `acme-org/websites`, this fork's
`fleet.json` says `rafarc21/fleetflare`) — confirmed pre-existing on
`main` itself, already documented in a prior task's `.fleet/done.json`
learnings entry. Not in scope for a task boundaried to
`cli/orca-workspace.ts`; will run a scoped vitest invocation instead of
relying on the full-suite command for the "both lanes green" claim.

Real Orca verification (does the fix actually stop duplicate tabs on a
live studio) is NOT possible from inside this container — no Orca here.
Deferred to the operator/the coordinator after merge.

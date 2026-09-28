# Lead-gate: close Maestro-by-proxy (board issue #16)

**v2 note, read this first.** This is the SAME fix as the original PR #18,
ported onto a different file. The original branch (`fix/lead-gate-
maestro-no-proxy`) edited the `HOOKEOF` heredoc inside
`container/studio-bringup.sh` because that heredoc was, at the time, the
ONLY place the lead-gate hook's source existed. In the meantime, board
issue #2 (`fix/gates-single-source`, PR #17) extracted that heredoc body
into a real, repo-tracked file, `gates/lead-gate.sh`, and changed
`studio-bringup.sh` to `cp` from it instead of writing it inline. Per
the operator's own review comment on #18
(https://github.com/rafarc21/fleetflare/pull/18#issuecomment-5731879044),
merging #18 as originally written would have re-created the heredoc write
path #17 just deleted — mergeable without conflict, but silently reverting
#17's own extraction with no error anywhere. This branch is based on
`fix/gates-single-source` (#17) and lands the identical logic in
`gates/lead-gate.sh` — the "where this lives" sections below are the only
parts that changed from the original plan; the security reasoning,
mechanism, and test intent are unchanged and already independently
reviewed (see the Addendum below, carried forward verbatim).

## Gap

Lead-gate hook (`gates/lead-gate.sh`, materialized into
`~/.claude/hooks/lead-gate.sh` by a guarded `cp` in
`container/studio-bringup.sh` — see #17's single-source design,
`docs/superpowers/plans/2026-09-16-gates-single-source.md`) exempts ANY
tool call carrying `agent_id`/`agent_type` from the whole write-block,
unconditionally, for every studio:

```python
if payload.get("agent_id") or payload.get("agent_type"):
    sys.exit(0)
```

Correct for a studio with real declared members (web-studio: Frontend Dev,
Backend Dev) — they legitimately need Edit/Write. Wrong for maestro: its
roster has always been zero members. So inside a maestro session, ANY call
carrying `agent_id`/`agent_type` is, by construction, a subagent MAESTRO
ITSELF spawned — never a "real member" — and exempting it lets maestro
implement BY PROXY through that subagent. PR #15 (open, not yet merged)
lets maestro dispatch subagents for coordination; this closes the gap that
would open before that PR can safely merge.

## Fix (as shipped — see Addendum for how this superseded an earlier,
rejected runtime-marker design)

`IS_MAESTRO` is baked into `gates/lead-gate.sh`'s own on-disk bytes at
materialization time, never re-derived from a separate file at decision
(PreToolUse) time. The file carries a placeholder,
`IS_MAESTRO = __IS_MAESTRO_BOOL__` (no quotes — after substitution this
must be valid Python literally: `True` or `False`), assigned at module
scope before `payload = json.load(sys.stdin)`. `gates/lead-gate.sh` itself
— the repo-tracked template — always keeps the placeholder literally; only
the per-container COPY at `~/.claude/hooks/lead-gate.sh` gets the value
baked in.

`container/studio-bringup.sh`, right after the guarded
`cp /opt/blueprint/gates/lead-gate.sh ~/.claude/hooks/lead-gate.sh` and its
`chmod 0755` (the same bash block that has `$STUDIO_NAME` in its
environment — #17 replaced the old heredoc-write with this `cp`, and the
bake-in step now lives immediately after it instead of after the old
heredoc's own `chmod`), runs a one-time `sed -i` anchored to that exact
assignment line, against the COPIED file:

```bash
if [ "$STUDIO_NAME" = "maestro" ]; then
  sed -i 's/^IS_MAESTRO = __IS_MAESTRO_BOOL__$/IS_MAESTRO = True/' ~/.claude/hooks/lead-gate.sh
else
  sed -i 's/^IS_MAESTRO = __IS_MAESTRO_BOOL__$/IS_MAESTRO = False/' ~/.claude/hooks/lead-gate.sh
fi
```

Exemption logic in the hook itself:

```python
if payload.get("agent_id") or payload.get("agent_type"):
    if not IS_MAESTRO:
        sys.exit(0)
    # falls through into the SAME write-shape checks below
```

Exemption still applies unconditionally for every other studio. For
maestro, a subagent call falls through into the identical write-shape
scrutiny the lead's own calls already get — no duplicated detection logic,
only the exemption's applicability changes.

**Constraint respected:** whole python program is `exec python3 -c '...'`
inside a single-quoted bash string — zero apostrophes added anywhere in
the new python code or its comments (double quotes throughout, matching
the file's own convention; verified by slicing the same `exec python3 -c
'` .. closing `'` boundary #17's own drift-guard/session tests already
use).

## Tests (`test/bun/bringup-hooks.test.ts`, ported onto #17's file-based
sourcing convention)

`bringup-hooks.test.ts` (per #17) reads `gates/lead-gate.sh` DIRECTLY off
disk (`readFileSync`) instead of extracting a heredoc out of
`studio-bringup.sh` text. `bakeIsMaestro(isMaestro)` performs the same
anchored `.replace()` substitution the real `sed -i` does against that raw
file text, and `leadGateAsStudio(payload, isMaestro)` runs the result
through `runSnippet` — same mechanism the original PR #18 branch used
against its extracted heredoc string, just sourced from the real file
#17 already made the single source of truth. No heredoc-extraction is
reintroduced.

1. Maestro + subagent (`agent_id` present) + Write → exit 2. Core fix;
   old code exits 0 here.
2. Non-maestro + member (`agent_id` present) + Write → exit 0. No
   regression for the legitimate case every other studio relies on.
3. Maestro + lead's own call (no `agent_id`) + Write → exit 2. Existing
   lead-blocking behavior unchanged.
4. Maestro + subagent + a read-shaped call (Read) → exit 0. New scrutiny
   only catches write-shaped calls, not all subagent activity.
5. The raw `gates/lead-gate.sh` file still carries the unsubstituted
   placeholder (proves the repo-tracked template is never itself mutated).
6. + 7. Substituting the placeholder for `True`/`False` leaves no stray
   token and produces syntactically valid Python (compile-only check via
   `python3 -c "compile(...)"`, no execution) — `test.each` over both
   outcomes.

Same 7 tests, same 5 behaviors + 2 mechanism checks, as the original PR
#18 branch — only the sourcing convention changed (real file, not a
heredoc extraction), per #17's own retarget.

## Scope

This branch (stacked on `fix/gates-single-source`, #17) only touches:
`gates/lead-gate.sh`, `container/studio-bringup.sh` (the new `sed -i`
bake-in step, right after the existing lead-gate `cp` + `chmod` — nothing
else in that file), `test/bun/bringup-hooks.test.ts`, this plan doc,
`.fleet/done.json`. Does NOT touch anything #17 already built:
`gates/session-reemit.sh`, `gates/completion-gate.sh`,
`src/studio/gates.ts`, `cli/fleet.ts`'s `cmdGatesInstall`,
`src/studio/cli-args.ts`. `test/studio.session.test.ts` and
`test/studio.gates.test.ts` (#17's own cross-runtime drift guard) checked
after the change — both pass untouched, since neither the `IS_MAESTRO`
assignment line nor the write-shape exemption logic overlaps the guarded
settings.json merge-command strings that drift guard compares. Not
touched: `fleet/blueprint/studios/maestro/studio.md`,
`src/studio/studio-blueprint.ts`.

## Addendum: runtime marker read was itself the residual gap (board issue
#16, follow-up — carried forward from the original PR #18 branch,
unchanged, still fully relevant to this v2 port)

A fresh-context security review found an EARLIER version of this fix, as
first shipped, still had a real hole: `IS_MAESTRO` was computed by READING
`~/.claude/.fleet-studio` on every single PreToolUse invocation — a plain,
unprotected file, writable by the exact actor class this whole fix exists
to constrain. A maestro subagent refused on a real Write could instead run,
via Bash, `python3 -c "open('/root/.claude/.fleet-studio','w').write
('web-studio')"` — not caught by the hook's own FORMS scan (`tee`,
`sed -i`, `mv/cp`, `dd of=`, shell-wrapper detection all miss an
interpreter's own internal `open(...).write(...)`; the FORMS scan's own
"STILL OPEN" comment already discloses `python3 -c` as an unclosed gap for
this exact reason). Once tampered, `IS_MAESTRO` reads `False` on every
LATER hook call in that session — the container is `keep_alive: true`,
persistent — and the subagent can implement by proxy again, one successful
one-liner defeating the entire fix.

The bake-at-materialization design ("Fix" section above) is exactly the
fix that closes this — this v2 port lands that SAME, already-corrected
design; it never re-introduces the runtime-marker-read version. The
reasoning is unchanged by moving from a heredoc to a real file: baking the
value into the hook script's own on-disk bytes (now `gates/lead-gate.sh`'s
materialized COPY) closes the hole exactly the same way regardless of
which file holds the placeholder before it is substituted.

**Accepted residual trust boundary, unchanged from everywhere else in this
file:** tampering with IS_MAESTRO now requires rewriting
`~/.claude/hooks/lead-gate.sh` itself, the same file every other rule in
this hook already trusts (it is `0755` and re-executed on every
subsequent PreToolUse call via `exec "$S"`, per the settings.json
fail-closed block in `studio-bringup.sh`). If a subagent can rewrite the
hook script directly, decision 11 was already compromised regardless of
this fix — that is a pre-existing, accepted boundary this codebase relies
on everywhere, not a new one this introduces. What this fix removes is the
CHEAPER, quieter path: a one-line marker-file overwrite that never touches
the hook script's own trust anchor at all.

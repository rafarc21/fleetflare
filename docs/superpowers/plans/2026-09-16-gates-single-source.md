# Gates Single Source

**Problem (board issue #2):** the three hook scripts that make a studio
safe — lead-gate, session-reemit, completion-gate — exist in exactly ONE
place: three bash heredocs inside `apps/fleet/container/studio-bringup.sh`.
A heredoc cannot travel. It only ever gets written to disk INSIDE a fresh
cloud container, at bring-up time. the operator's own Mac has zero gates today —
nothing local ever ran that heredoc. Worse, his real
`~/.claude/settings.json` already carries a stray pointer at
`~/.claude/hooks/lead-gate.sh` that nothing ever put there — a leftover
from some earlier attempt, pointing at a file that has never existed on
that machine. One rule, enforced in one place, with no way to reach the
other place it's needed.

**Fix:** make `gates/*.sh` real files at the repo root — the ONE source of
truth — and have both sides READ from them instead of one side GENERATING
them inline:
- Cloud bring-up already shallow-clones this same repo into
  `/opt/blueprint` for skills (guarded, tolerant of failure). Since this
  monorepo's own `fleet.json` points `blueprint.repo` at itself,
  `/opt/blueprint/gates/*.sh` is already sitting there the moment that
  clone finishes — bring-up just `cp`s from it instead of `cat > ...
  <<'HEREDOC'`.
- A new Mac verb, `fleet gates install`, copies the same three files into
  `~/.claude/hooks/` and merges the same three hook-command strings into
  `~/.claude/settings.json` — same merge-never-clobber, drop-prior-entry
  idiom bring-up's own python already uses, so the cloud and Mac copies of
  the rule cannot silently drift apart. It also removes the operator's one known
  stray garbage entry (`matcher: "SomeOtherTool"` → `/some/other/hook.sh`),
  a targeted one-time cleanup, not a general sweep.

Zero behavior change to the three hook scripts themselves. This PR is
"make the existing rules travel," nothing more — no new gate logic.

## The trap: two test files assert on heredoc TEXT, not just behavior

`test/bun/bringup-hooks.test.ts` extracts each heredoc body out of raw
`studio-bringup.sh` text and EXECUTES it (`runSnippet`) — real bash/python,
real assertions on exit codes and stderr. Moving the heredoc body to a
real file changes nothing about what runs; only WHERE the string comes
from. Retarget: `readFileSync` the three `gates/*.sh` files directly
instead of `extractHeredoc(BRINGUP, ...)`. Every behavioral test stays
exactly as written.

`test/studio.session.test.ts` reads the WHOLE `studio-bringup.sh` text via
a workerd-injected env binding (`TEST_STUDIO_BRINGUP_SRC` —
`vitest.config.ts`'s own comments explain why: workerd has no filesystem)
and does plain `.toContain(...)` checks against source lines that live
INSIDE the heredoc bodies. Three spots need retargeting, and ONLY these
three — everything else in that file checks code that never moves
(settings.json merge/dedupe, the post-install "did the hook actually
land" refusal, the blueprint clone itself):
1. The "lead gate covers Bash" describe block — every assertion targets
   text inside the `HOOKEOF` body. Retarget `src()` to a new
   `TEST_LEAD_GATE_SRC` binding, sourced from `gates/lead-gate.sh`.
2. The "Tier-0 completion gate" describe block — same shape, `GATEEOF`
   body. Retarget to `TEST_COMPLETION_GATE_SRC`, sourced from
   `gates/completion-gate.sh`.
3. Inside the C2 session-reemit wiring block, ONE test ("the path the
   re-emit hook reads is EXACTLY the path bring-up persists to") compares
   two literals from TWO different sources: the `printf` write line stays
   in bring-up's own body (untouched), the `ws="..."` read line moves into
   `gates/session-reemit.sh`. Added `TEST_SESSION_REEMIT_SRC` binding so
   this one test can pull its second half from the new location.

Two more tests locate the heredoc's own open/close markers in
`studio-bringup.sh` text to slice out the inner `python3 -c '...'` program
and assert it carries no bare single quote (a real hazard: one loose `'`
here silently truncates the whole embedded python program). Once the
heredoc is gone there is no marker to slice on. Rewritten to slice the
SAME boundary (`exec python3 -c '` ... closing `'` before the file's own
end) directly out of the `gates/*.sh` file's own text instead — identical
assertion (`not.toContain("'")`), different source string. This is a
source-relocation of the check, not a behavior change; see "What changed
in the assertions" below for the exact diff.

Every other string literal asserted on anywhere in this task is verified
byte-identical to what it was before — proven by an actual `diff` between
the pre-refactor heredoc body (extracted from `main`) and the new
`gates/*.sh` file, pasted into the implementation report.

## Numbered plan

1. `gates/lead-gate.sh`, `gates/session-reemit.sh`, `gates/completion-gate.sh`
   at the repo root (NOT under `apps/fleet/`) — byte-for-byte the heredoc
   bodies, extracted with the exact same `extractHeredoc` helper the test
   suite already uses, plus the trailing newline a real
   `cat > file <<'MARKER'` heredoc always leaves.
2. `studio-bringup.sh`: each `cat > ~/.claude/hooks/X <<'MARKER' ... MARKER`
   becomes a guarded `cp /opt/blueprint/gates/X ~/.claude/hooks/X` (warn
   loudly on stderr and continue when the source file is missing, same
   posture the skills-symlink block just above it already takes), followed
   by the same `chmod 0755` that already runs today. The settings.json
   merge-never-clobber logic right after stays untouched — only "how the
   file lands on disk" changes, never "how it gets registered."
3. `vitest.config.ts`: three new source bindings
   (`TEST_LEAD_GATE_SRC`/`TEST_COMPLETION_GATE_SRC`/`TEST_SESSION_REEMIT_SRC`),
   read the same `readFile(path.join(rootDir, ...))` way every other
   binding in that file already is.
4. `test/studio.session.test.ts`: retarget exactly the three spots named
   above. No other block touched.
5. `test/bun/bringup-hooks.test.ts`: `LEAD_GATE`/`COMPLETION_GATE`/`REEMIT`
   become `readFileSync` of the new `gates/*.sh` files. `BRINGUP` itself
   stays for the two tests that check text OUTSIDE any heredoc.
6. New verb `fleet gates install`:
   - `src/studio/cli-args.ts`: `{ cmd: "gates-install" }` on the
     `CliCommand` union, a `VERBS["gates-install"]` help entry, a
     `case "gates":` requiring the literal sub-word `install` (no silent
     default — this verb writes to a real settings.json).
   - `src/studio/gates.ts` (new, pure): the three guarded hook-command
     strings read verbatim out of `studio-bringup.sh`'s own merge blocks,
     exported as named constants; a merge function per hook (drop any
     entry whose `json.dumps` contains the hook's filename, append fresh —
     same de-dupe idiom bring-up's own python uses; running it twice is a
     no-op beyond drop-and-reappend); the one narrow, literal
     `SomeOtherTool` / `/some/other/hook.sh` removal; malformed-JSON
     handling that DELIBERATELY diverges from bring-up's own
     `except: cfg = {}` — file absent starts from `{}`, file present but
     invalid JSON THROWS (never silently clobbers a hand-edited file).
   - `cli/fleet.ts`: `cmdGatesInstall()`, the impure half — reads
     `gates/*.sh` off disk relative to `import.meta.dir` (three levels up
     from `cli/`), writes each to `~/.claude/hooks/<name>` with
     `chmod 0755`, skipping the write when the file already matches
     byte-for-byte; reads-or-starts-fresh `~/.claude/settings.json`, runs
     it through `gates.ts`'s merge + prune, writes back only if changed;
     prints one line per outcome. Wired into `main()` BEFORE
     `loadCredentials()` — purely local, no Fleet credentials needed, same
     as `help`/`onboard`.
7. Tests for the new verb, TDD: byte-identity proof (see above), merge
   never deletes an unrelated hook, running install twice never
   duplicates, malformed settings.json fails loud and writes nothing, the
   `SomeOtherTool` garbage entry is removed and ONLY it, and a
   cross-runtime drift guard that extracts the guarded command strings out
   of `studio-bringup.sh`'s own python and compares them BYTE-IDENTICAL to
   `gates.ts`'s exported constants (not each to an independent hardcoded
   string — a real comparison, same technique the C2 session-reemit
   path-consistency test already uses).

## Boundaries

Only touches: `gates/` (new), `apps/fleet/container/studio-bringup.sh`,
`apps/fleet/cli/fleet.ts`, `apps/fleet/src/studio/cli-args.ts`,
`apps/fleet/src/studio/gates.ts` (new), `apps/fleet/vitest.config.ts`,
`apps/fleet/test/bun/bringup-hooks.test.ts`,
`apps/fleet/test/studio.session.test.ts`,
`apps/fleet/test/studio.cli-args.test.ts`,
`apps/fleet/test/studio.gates.test.ts` (new), this plan doc.
`src/github/*` is a different board task's area — untouched. No
ego-browser/dev-server sweepers land in this PR (future gates, per the
issue). `fleet gates install` is never invoked against a real
`~/.claude/settings.json` or `~/.claude/hooks/` during this task — every
exercise runs against a temp `$HOME` (`mkdtempSync`), same discipline
`bringup-hooks.test.ts`'s completion-gate tests already use.

## Step 0 findings (filled in after the baseline run and the retarget)

Baseline, unmodified `main`:
- `bun test test/bun/bringup-hooks.test.ts` — 48 pass, 0 fail.
- `bun x vitest run test/studio.session.test.ts` — 160 tests passed (1
  file).

After the refactor:
- `bringup-hooks.test.ts` — same 48 pass, 0 fail. `LEAD_GATE` /
  `COMPLETION_GATE` / `REEMIT` are now `readFileSync` of `gates/*.sh`
  instead of `extractHeredoc(BRINGUP, ...)`; every behavioral assertion
  (exit codes, stderr text) is untouched, because the snippet content
  itself is byte-identical (proven by `diff`, pasted in the implementation
  report).
- `studio.session.test.ts` — same 160 tests, only their SOURCE binding
  changed for the three spots named above:
  - "lead gate covers Bash" describe block: `src()` now reads
    `env.TEST_LEAD_GATE_SRC` instead of `env.TEST_STUDIO_BRINGUP_SRC`. No
    assertion text changed except the two "carries no single quote" tests,
    whose slicing boundary moved from the heredoc's `<<'HOOKEOF'`/
    `<<'GATEEOF'` shell markers to the standalone file's own
    `exec python3 -c '` opener and closing quote before EOF — same
    assertion (`not.toContain("'")`), same intent, new source string
    because there is no longer a heredoc marker to anchor on.
  - "Tier-0 completion gate" describe block: same swap, `TEST_COMPLETION_GATE_SRC`.
  - C2 "the path the re-emit hook reads is EXACTLY the path bring-up
    persists to": `writeMatch` still reads `env.TEST_STUDIO_BRINGUP_SRC`
    (the `printf` line never moved); `readMatch` now reads
    `env.TEST_SESSION_REEMIT_SRC` (the `ws="..."` line, which did move).
    Same two-literal comparison, same assertion.
  - Every other describe block in the file — settings.json merge/dedupe,
    the post-install verification refusal, blueprint clone, `.mcp.json`
    cwd resolution, tailscaleHost writer, claude-launch args — untouched,
    same source binding, same assertions.

## Verification

See the implementation report for the actual captured command output
(scoped to the files this task touches — the pre-existing, unrelated
`fleet.json`/`test/studio.blueprint.test.ts` owner-name mismatch on this
fork is out of this task's boundary, confirmed pre-existing on `main`, not
fixed here) and the byte-identity diff proving the extraction changed
nothing.

## Addendum (board issue #20, 2026-09-21): the Mac-install half is cancelled

the operator, 2026-09-21, on the brainstorm that produced board issue #20 (quoted
verbatim): **"I don't want any of these locks. there's useful and legit
usage of both of these. CTO can do research and save md files for
example."**

This cancels everything the numbered plan's step 6/7 above describe: the
`fleet gates install` Mac verb, `src/studio/gates.ts` (the pure settings.json
merge logic it depended on), and `test/studio.gates.test.ts` (which tested
only that file). All three are deleted. `cli/fleet.ts`'s `cmdGatesInstall`
and its dispatch in `main()`, the `{ cmd: "gates-install" }` `CliCommand`
variant, the `VERBS["gates-install"]` help entry, and the `case "gates":`
parse branch in `src/studio/cli-args.ts` are removed along with it (and the
`gates install` parsing tests in `test/studio.cli-args.test.ts`).

Why: the whole point of that half was to let a lead-gate/completion-gate
style refusal run on the operator's own Mac. the operator does not want that constraint on
his own machine — he does legitimate work there (including the "CTO does
research, saves md files" example above) that these locks would have
gotten in the way of. There is no safe, generally-useful version of "refuse
a local Write/Stop on a human's own laptop" once the human doing the work
has said explicitly he does not want it.

As defense in depth against the file surviving by accident (e.g. a stray
hand-copy of `gates/lead-gate.sh` or `gates/completion-gate.sh` into
`~/.claude/hooks/` from some earlier attempt — see this doc's own opening
paragraph about the stray entry already found once), both scripts now
refuse to do anything at all unless `STUDIO_ID` is set in the process
environment: `[ -n "${STUDIO_ID:-}" ] || exit 0`, as the very first check,
before even the `python3` availability check. `STUDIO_ID` is set in every
cloud studio's own process environment (`src/studio/do.ts` / `provision.ts`)
and inherited by any hook subprocess Claude Code spawns as a child of it —
and it is never set on the operator's Mac. `gates/session-reemit.sh` gets no such
guard: it only injects context on SessionStart, it can never block anything,
and it is explicitly not one of "these locks" the operator is objecting to.

The surviving value of this whole plan is now cloud-only: `gates/*.sh` at
the repo root remains the single source of truth for the three hook
scripts, and cloud bring-up still `cp`s from it (`apps/fleet/container/
studio-bringup.sh`) instead of generating them inline. That mechanism is
unchanged and still solves the original problem for the cloud side, which
is the only side that ever runs these locks now.

Also untracked in the same pass, unrelated to the locks but bundled into
board issue #20's cleanup: `apps/fleet/.mcp.json` (local MCP server config,
not a repo artifact) is now `git rm --cached` and listed in the root
`.gitignore`; the file itself is untouched on disk.

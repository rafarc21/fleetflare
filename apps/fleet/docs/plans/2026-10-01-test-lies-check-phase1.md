# A report-only check for test lies (board issue #164, Phase 1)

## What a "test lie" is

A test that passes, looks like it is exercising behavior, but is structured
so it cannot actually catch a real bug. Three shapes of this keep recurring
in review and are worth a repo-wide, repeatable scan rather than catching
them one at a time:

- **Tautological**: `expect(SOME_CONST).toBe(<literal>)` where the literal
  is just the constant's own declared value, copied back. It always passes,
  forever, including if the code using `SOME_CONST` elsewhere is wrong — the
  test asserts the import mirrors itself, not that any behavior is correct.
- **Source-reading**: reading a `src/` file as raw text and string-matching
  it (`toContain`/`toMatch`/`includes`), instead of importing and calling it.
  Passes as long as the SOURCE TEXT contains a substring, regardless of
  whether the code actually does what the substring implies — a comment, a
  dead branch, or a string literal inside a template would satisfy it too.
- **Own-module mocks**: `vi.mock`/`jest.mock`/`mock.module` pointed at one
  of this repo's own `src/` modules. Mocking should stop at the system
  boundary (network, filesystem, subprocess, an external SDK) — mocking your
  own implementation means the test no longer exercises it at all.

None of these are exotic; `SWEEP_SECONDS`/`PASTE_MAX_BYTES`-shaped
`expect(CONST).toBe(<its own value>)` assertions are real and common in this
repo today (confirmed ~45 hits for the bare `expect(IDENT).toBe(` shape
across `apps/fleet/test`). The point of this check is not to shame any one
test — most of these are harmless restatements sitting next to a real
assertion — but to make the SHAPE visible and countable, the same way
`english-check` (#66) made stray Portuguese visible and countable before
anyone tried to gate on it.

## Design: `apps/fleet/scripts/test-lies-check.ts`

Modeled directly on `scripts/english-check.ts`: exported, mostly-pure
detector functions; a `scanFile`/`scanRepo` aggregation layer that walks
`git ls-files`; an `ALLOWLIST: Record<path, reason>` for whole-file
exemptions; a trailing `test-lies-check: allow` comment to exempt one
flagged line; a `formatFinding()`; and an `if (import.meta.main)` CLI block.

Only `*.test.ts` / `*.test.tsx` files are scanned (found via `git ls-files`,
filtered by filename suffix — not the blanket "every tracked file" scan
`english-check` does, since the three detectors only make sense on test
code).

### 1. Tautological

Parses the test file's own relative (`./`, `../`) `import { A, B as C }`
statements into a local-name → `{modulePath, exportedName}` map. Resolves
each referenced module against the test file's directory (exact path,
`.ts`, `.tsx`, `/index.ts`, `/index.tsx`, first one found, read once and
cached by resolved path). Scans for `expect(<bareIdentifier>).toBe(<arg>)`
— bare identifiers only, so `expect(foo.bar).toBe(...)` (a member
expression, a different risk, out of scope here) is never touched — using a
paren-depth-balanced scanner to extract the `.toBe(...)` argument text,
because that argument can itself contain parens (`20 * 60`) or span
multiple lines (seen for real in `cli.recycle-outcome.test.ts`'s
`RECYCLE_CLIENT_TIMEOUT_MS` assertion). When the identifier resolves to a
known import, the resolved module's source is regex-matched for
`export const <exportedName>(?:\s*:[^=]+)?\s*=\s*([^;]+);` to recover the
declared value, both sides have their whitespace stripped, and an exact
string match flags the line.

Any failure to resolve — unknown import, module file not found, export not
found by that regex, or the declared value containing a top-level comma
outside brackets/parens/braces (the `export const A = 1, B = 2;`
multi-declaration shape, genuinely ambiguous from regex alone) — is a
silent skip, never a flag. This is deliberate and conservative by the same
reasoning `english-check` documents in its own header: a noisy check gets
disabled, which is worse than no check, so every uncertain case resolves to
"don't flag" rather than "flag and hope."

### 2. Source-reading

Finds `readFileSync(...)` / `readFile(...)` / `Bun.file(...).text()` calls
(via the same paren-depth-balanced extraction) whose literal first argument
contains a `src/` path segment. Two shapes are flagged:

- **Inline**: the read call sits directly inside `expect(...)`, which is
  itself followed (allowing an intervening `.toString()`) by `.toContain(`
  or `.toMatch(` — e.g. `expect(readFileSync(p).toString()).toContain(...)`.
  Checked first, since it needs no variable tracking at all.
- **Captured variable**: the read call is the right-hand side of a
  `const`/`let`/plain assignment, and that variable name is later used —
  anywhere forward in the same file — in `X.toContain(`/`.toMatch(`/
  `.includes(`, or `expect(X)` followed shortly by `.toContain(`/`.toMatch(`.

A `src/` read that is never matched this way (used to drive real imported
code, or snapshotted via `toMatchSnapshot()`) is not flagged, and neither is
a read whose path has no `src/` segment (fixtures under `test/fixtures/`,
for instance).

Known, documented limitation: the captured-variable forward scan is
file-scoped, not block-scoped — it does not understand `describe`/`test`
boundaries. It can false-positive if the same variable name is reused,
unrelated, later in a large test file. Accepted as a simplification; it
will not miss a genuine match, only (rarely) over-flag one.

### 3. Own-module mocks

Matches `vi.mock(`, `jest.mock(`, `mock.module(` calls with a string
literal first argument. A bare specifier (`"react"`, `"node:fs"`,
`"playwright-core"`) is never flagged — that is exactly the legitimate,
system-boundary case. A relative (`./`, `../`) specifier is resolved with
the same resolver the tautology detector uses; if the resolved path
contains a `/src/` segment, it is flagged as mocking this repo's own
implementation.

This repo's real suite currently has zero `vi.mock`/`jest.mock`/
`mock.module` calls at all (confirmed by grep), so this detector's count
is expected to read 0 today. It exists for whatever creeps in later, and
still needs real test coverage now.

## Why conservative-by-design, everywhere

Every detector above is written to skip silently on any uncertainty rather
than guess and flag. This is the same design choice `english-check` already
made and documented for the same reason: false positives are what get a
check turned off, and a disabled check catches nothing at all. None of the
three detectors attempts real parsing (no AST) — they are plain,
line/regex-oriented text scans, same spirit as `findPortuguese`, so "skip
when unsure" is not just philosophy but a practical necessity: a text scan
genuinely cannot always tell.

## Phase 1 vs Phase 2

This PR is **Phase 1 only**: the checker runs, scans the real repo, and
prints counts and findings — it **never fails CI**, regardless of what it
finds (`process.exit(0)` unconditionally in the CLI block). No workflow
file is added or touched, and `apps/fleet/scripts/localci/` is untouched.
The point of Phase 1 is to get real, honest counts against this repo before
anyone commits to a failing gate.

Phase 2 — wiring this into `fleet-check` as an actual failing gate, with
whatever threshold or allowlist that needs once the Phase 1 counts are
known — is explicitly out of scope here and left for a future PR.

## Test plan

`apps/fleet/test/bun/test-lies-check.test.ts`, mirroring
`test/bun/english-only.test.ts`'s shape: a `describe` block per detector
exercising the pure detector functions directly against synthetic
fixtures (tautology and own-module-mock need a real file on disk to resolve
against, so those use a throwaway `mkdtempSync` directory, same pattern
several other `test/bun/*.test.ts` files already use), covering both the
real repeated shapes this repo has today and the documented false-positive
guards (unresolved import, local variable instead of an import, a `src/`
read never string-matched, a bare-specifier mock, the escape comment). A
final "the repository itself" block runs `scanRepo()` for real and logs its
counts — report-only, so there is no pass/fail threshold here, only a
"doesn't throw" assertion.

Run alone: `bun test apps/fleet/test/bun/test-lies-check.test.ts` (or `cd
apps/fleet && bun test test/bun/test-lies-check.test.ts`).

The deliverable for Phase 1 itself is `bun run scripts/test-lies-check.ts`
run directly from `apps/fleet/`, read for its real counts against today's
repo.

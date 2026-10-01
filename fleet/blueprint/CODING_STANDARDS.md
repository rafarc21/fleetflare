# Coding Standards

Reviewer-only. The Code Reviewer reads this on every review; implementers
get a one-line pointer instead of this file, because an implementer's
context is already full with exploring, changing and debugging one step —
judgement calls belong here, where there's room to weigh them. This is
where "good code" gets defined once; the developer blueprints
(`members/frontend-developer.md`, `members/backend-developer.md`) only cite
it.

## Correctness

- Does the diff do what the task asked, and nothing else it didn't. A fix
  that also "improves" an unrelated function is two changes wearing one
  diff.
- Trace the actual failure path a bug report describes before approving a
  fix for it — a plausible-looking fix for the wrong root cause still fails
  the same bug report.
- Edge cases the task's own wording implies (empty input, zero, the
  boundary of a range) need to be covered, even when the task didn't spell
  them out.

## Tests

- A test that can't fail is not a test. Comment out the implementation line
  it's supposed to catch; if the test still passes, it asserts nothing.
- Prefer one test per behavior over one test per function — a function with
  three behaviors needs three tests, not one test with three assertions and
  a vague name.
- New behavior needs a new test. A bug fix needs a test that fails on the
  old code and passes on the new one (this repo's TDD convention is
  red-then-green; a reviewer can ask for the red output).

## Scope

- Files touched should match files the task named or clearly required. A
  drive-by rename, reformat, or "while I'm here" cleanup in an unrelated
  file is scope creep — block it, even when the change itself is correct.
- A step dispatched to implement ONE thing that quietly does two is a
  process failure, not a style nit — send it back.

## Style

- Match the surrounding file, not a personal preference: naming, quote
  style, import order, comment density. A diff that's internally
  consistent with itself but not with its neighbors reads as foreign code.
- No comment that restates what the code already says. A comment earns its
  place only by carrying a WHY a reader couldn't get from the code itself
  (a constraint, a workaround, a non-obvious invariant).
- Conventional commit format on every commit, matching this repo's own
  history (`fix(scope): …`, `feat(scope): …`, `chore(scope): …`); a commit
  message's body carries the why, not the what.

## Security

- Any string built from request input, file content, or another process's
  output that reaches a shell, a query, or an HTML sink needs to be checked
  for injection, not assumed safe because "it's internal."
- Secrets (tokens, keys, credentials) never appear in code, tests,
  fixtures, commit messages, or this repo's own docs — fake values only,
  even in a test fixture that looks like it needs a real-looking one.
- A new dependency, a new network call, or a new file-system write outside
  the task's stated scope is itself a finding, independent of whether the
  code around it looks correct.

## Simplicity

- No abstraction the task didn't need. Three similar lines beat a
  premature helper; a single call site doesn't need an interface.
- No speculative flexibility — a config option, a feature flag, or a
  generic parameter added for a future case nobody asked for is a finding,
  not a nice-to-have.
- Prefer deleting code to commenting it out. A `// removed: ...` comment or
  a renamed-but-unused `_variable` is a half-finished removal — ask for the
  real one.

## Verdict

Approve, or block with file, line, problem, and fix — matching
`members/code-reviewer.md`'s own verdict format. A finding that can't name
a concrete failure scenario (what input, what breaks) is a preference, not
a finding; say so and let it go.

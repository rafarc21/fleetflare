# Evidence culture lessons

Specific traps on top of the main `SKILL.md`'s evidence-culture section —
each measured against a real incident.

- **A fix that shrinks a fixture can neuter the scale guard it was meant to
  keep green.** A flaky test "fixed" by shrinking its fixture (e.g. 500x50 to
  26x2) can report the same assertion passing for the wrong reason — a
  per-item leak that GROWS with n stays under the bound at small n and only
  surfaces at scale; the gate approved exactly this once, caught only one
  level up. Before shrinking any fixture to de-flake a test, ask "does this
  property depend on n?" If yes: keep the scale, make the slow part of the
  fixture fast instead (an O(1) lookup, not a smaller n), and when mutating
  the guard to prove it still catches real damage, mutate with damage that
  GROWS with n — never a constant one.

- **A `{} as Interface` test double blinds the type checker to an interface
  change.** A new required interface method has shipped green on typecheck
  plus every targeted test, only for the full suite to surface a runtime
  TypeError in a completely untouched test whose fake was `{} as Interface`
  (or `as unknown as Interface`, or `Partial<Interface>`, or a `vi.mock(...)`
  stub) — none of which the compiler can check against the new method. On any
  interface change, grep every double for that interface specifically before
  trusting typecheck-green; fix the double itself, never optional-chain the
  real call site to dodge it — optional-chaining just silently skips the new
  behavior instead of exercising it.

- **No toolchain in the container does not mean untested.** A studio lacking
  the compiler for a pure function's language reported "did not run" as a
  final answer; the fix was to compile and run the single file standalone
  outside the full project build (e.g. `rustc --edition 2021 --test file.rs`)
  — seconds, no crate build — then mutate the guard inside it to confirm it
  actually goes red. Keep logic like this in pure, dependency-free functions
  with an injected flag (an `is_debug`-style parameter, never a compile-time
  check buried inside the function itself) specifically so it stays testable
  this way regardless of what toolchain the current container has. The same
  review found the one route a guard failed to cover by reading every call
  site of the relevant pattern directly (every call to a given helper, not
  just the PR's own list of what it touched) — the uncovered route was a
  legacy path nobody had thought to list.

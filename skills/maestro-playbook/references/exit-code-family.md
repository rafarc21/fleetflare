# Exit-code family pitfalls

Patterns that have each produced a false green in a merge gate or a verification
script. All bit a real run.

- **Empty output ≠ clean.** A broken command produces empty output, which reads
  exactly like a clean pass. Assert that something actually RAN, not just that
  nothing printed.
- **`cmd | tail; echo $?` reports `tail`'s exit code, not `cmd`'s.** Use
  `set -o pipefail`, and prefer not piping the command you are checking at all.
- **A filter matching nothing still exits 0.** The runner ran, found zero
  matching files, and reports success. Assert WHICH file ran, not just that the
  runner exited clean.
- **Non-zero exit with no result line printed is DID-NOT-RUN, never red.** A
  crash before the test framework even starts is not a failing test; treat it
  as a different failure mode and say so.
- **A green summary with a buried failure is still a fail.** "12 passed, 0
  failed, Unhandled Errors: 1" is a fail. Trust the exit code over the pretty
  summary line.
- **Never `2>/dev/null` a probe you are about to compare against anything.**
  Swallowing stderr on the one command whose output decides the verdict throws
  away the evidence you need when it disagrees with you.
- **zsh quoting traps:** `"$T:path"` triggers the `:a`-style modifier and
  mangles the string — write `"${T}:path"`. zsh also does not word-split a
  bare `$var` inside a loop the way bash does; quote and array-expand
  explicitly.
- **zsh `set --` inside a loop silently breaks the positional args** for
  the rest of that iteration — it has bitten a fleet-management loop (assign,
  then destroy) twice the same way. Write explicit per-item commands instead
  of relying on `set --`/`$1`/`$2` surviving across loop iterations in zsh.
- **A merge script that prints "merged" without checking the PR's state
  afterward is lying some of the time.** The host can refuse an out-of-date or
  conflicting merge silently inside a pipe. Assert `state == MERGED` as a
  separate, explicit check after the merge call returns, never trust its exit
  code alone for this one.

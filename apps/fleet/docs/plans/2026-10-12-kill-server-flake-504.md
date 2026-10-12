# Plan — #504: flaky kill-server test in studio-tmux-socket.test.ts

## Scope
Bounded: one test-side flake fix in `apps/fleet/test/bun/studio-tmux-socket.test.ts` plus this plan. No production code changes, no other test files.

## The flake (root-caused)
The test "a default-server kill-server … leaves the studio session and its lead alive" (`studio-tmux-socket.test.ts:138-154`) sends `lead-sleep 300` into the studio pane and then asserts the pane's command is the same before and after a default-server `kill-server`. The harness `TwoServers` pins `SHELL: "/bin/sh"` (`studio-tmux-socket.test.ts:90`), so the pane's shell is dash, not the production bash. The poll at `studio-tmux-socket.test.ts:144` is calibrated for production's bash pane:

```ts
expect(b.waitFor(() => lead() !== "bash" && lead() !== "")).toBe(true);
```

On the sh pane the very first probe reads `sh`, so the negative condition is true immediately — before the pane's dash has even read the sent `lead-sleep 300` line. `const before = lead()` (line 145) then snapshots the transitional pre-exec state ("sh"). The pane's dash execs `lead-sleep` somewhere inside the following decoy-create + kill-server window (4 subprocess spawns); under CI load that exec lands there, and the final `expect(lead()).toBe(before)` (line 153) reads "lead-sleep" !== "sh" and fails. Same exec-latency-under-load family as the :220 flake fixed by #460, but inverted: #460's poll window was too small; here the negative poll exits too early. Probe evidence: on an sh pane, `display-message -p '#{pane_current_command}'` reads `sh` before send-keys and `sleep` after exec. Not a production race — socket separation (lines 151-152) is intact; production's pane is bash and production code is untouched.

## Fix
In that one test only, change the `waitFor` condition to the positive state — wait until the pane actually runs the sent command:

```ts
expect(b.waitFor(() => lead() === "lead-sleep")).toBe(true);
```

This mirrors production's own `claude_launch_landed` positive poll (`container/studio-bringup.sh:1437-1442`). Then `before` deterministically reads "lead-sleep" and the final compare is stable across the exec transition. Plus an inline comment at the changed line explaining the transitional-state trap.

## Verification (targeted only)
- RED demonstration: temporarily hard-code the final assertion to expect the transitional "sh" reading (a stand-in for the assumption the old poll baked in), run the suite, record output (the RED is probabilistic locally; the CI failure is the canonical evidence), revert. Also loop the unchanged test up to 20x under light CPU pressure if time allows.
- GREEN: apply the one-line fix + comment, then `bun test test/bun/studio-tmux-socket.test.ts` 5x — all runs 12/12.
- Gates one at a time: `bun run check`, then `bun run english-check`. No full suite, no bundler build — those belong to CI.

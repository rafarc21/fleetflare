# Plan: #1117 — reap board read times out on big repos

## Problem
`fleet reap --nudge` board read timed out at 20 s on a big repo (~25 s listing),
3 passes in a row, zero nudges.

## Fix (already shipped, verified against origin/main)
- CLI (PR #1120, 5e1bbbd): REAP_READ_TIMEOUT_MS 20s -> 60s; `--read-timeout
  <dur>` override (min 5s); every board read logs `board read <ms> ms`.
- Worker (PR #1189, 94d19f7): reap lists `state=open` (one flag) instead of a
  full all-state paginated walk; the floor check uses `countIssues`, one
  GraphQL count. Big-repo listing 8.3s -> ~2s (target < 5s).

## Status
Done before this task was reassigned. Nothing to implement; both commits are
ancestors of origin/main.

## Blast radius
`fleet reap` board read. Wrong = a big repo still times out and nudges/reaps
silently skip.
# Plan: #1110 — reap footer hint text blocks every nudge

## Problem
`fleet reap --nudge` refused every footer on ANY digit or `tasks?` word.
Chrome hints (`ctrl+t to hide tasks`, `PR #4343`) matched, so a lead with a
todo list or open PR was never nudged or reaped.

## Fix
Parse the footer by `·` segments. Drop known chrome hints first (`⏵⏵ bypass
permissions on (shift+tab to cycle)`, `ctrl+t to hide|show tasks`, `← for
agents`, `PR #<n>`). Refuse the remainder on `esc to interrupt`,
BACKGROUND_COUNTER (`N shells|monitors|background tasks|tasks`), `still
running`, or an unknown segment with a digit.

## Status
Already shipped on main: PR #1113 (babb3d8), merged 2026-10-16. This task
(#1110) was filed after the fact; nothing to implement.

## Blast radius
`fleet reap` nudge/reap gating. Wrong = a stalled OSS lead is never nudged,
or a working lead is reaped.
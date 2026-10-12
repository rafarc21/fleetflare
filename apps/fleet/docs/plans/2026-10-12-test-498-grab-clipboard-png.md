# Plan — #498: test grabClipboardPng (S11-F10)

## Scope
Bounded, tests only. One new bun-lane test file; no src changes. Refs #467, sweep 11 doc `docs/maintainability/2026-10-12-cli-coverage-sweep-11.md` finding S11-F10.

## Why
`grabClipboardPng` (cli/paste-mac.ts:20) has zero coverage. It is the Mac clipboard probe behind `fleet paste` (cli/fleet.ts:2650) and attach's ctrl-v intercept (:2733). Worker paste storage is tested (test/studio.paste.test.ts); the probe is not.

## Test design
`apps/fleet/test/bun/paste-mac.test.ts`, importing `grabClipboardPng` from `../../cli/paste-mac` and calling it in-process — the module's only platform trick is `Bun.spawn(["pngpaste", "/tmp/fleet-paste.png"])` plus `Bun.file`, both live in Bun, so no Mac needed. Because Bun.spawn's env defaults to the parent's and the module passes no env override, each test wraps the call with the parent's own PATH controlled:

- ENOENT lane: strip pngpaste — spawn the test file under a PATH that has no pngpaste (a temp bin dir with nothing in it plus essentials, or a stripped copy of process.env.PATH with every entry lacking pngpaste). Assert result is null.
- no-image lane: same, but temp bin holds an executable `pngpaste` shell script that exits 1. Assert null. Also assert the tmp file at /tmp/fleet-paste.png was not created by this call (unlink any pre-existing one first).
- happy-path lane: the script copies a fixture PNG payload to "$1" and exits 0. Assert returned bytes equal the fixture exactly, and the tmp file no longer exists afterward.

PATH control: resolve a clean PATH BEFORE any mutation, then set `process.env.PATH` per test and restore in afterEach. Known Bun caveat (git-wrapper.test.ts issue #353 note): `Bun.which` no-args snapshots PATH at startup — irrelevant here IF Bun.spawn's argv resolution is live; verify empirically first (a tiny pre-check that the fake pngpaste is actually invoked). If spawn resolution turns out snapshot-based, fall back to spawning a child `bun` process per lane with the controlled env, importing the module there and printing the result — same assertions, process boundary instead of env mutation. Keep whichever works, delete the pre-check scaffolding.

## TDD / mutation
Test green against current source; mutation checks (transient, reverted, never committed): (a) make the ENOENT catch rethrow → ENOENT lane red; (b) skip the `code !== 0` early return → no-image lane red; (c) drop the `file.delete()` call → happy-path lane red on tmp-gone assertion. Revert each, rerun green.

## Verification
- `cd apps/fleet && bun test test/bun/paste-mac.test.ts` green
- `cd apps/fleet && bun run english-check`
- `cd apps/fleet && bun run check`
Full suite belongs to CI.

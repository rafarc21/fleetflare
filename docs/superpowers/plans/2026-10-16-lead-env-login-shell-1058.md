# Plan — harness test survives a PATH-resetting login pane (#1058, refs #715)

## Root cause (confirmed: issue body + live tmux probe)

- `tmux new-session` with no command starts default-shell as a LOGIN shell ($0 = `-sh`).
- Gate image (Debian, uid 0): login dash reads /etc/profile → root branch resets PATH to system dirs. Pane PATH loses the harness bin dir (fake `claude`) → `env -u TMUX -u TMUX_PANE claude` not found → lead-env never written → #117 lead-launch test dies in waitFor after 10 s.
- Studio (Ubuntu) passes: /etc/profile sets no PATH, pane keeps harness PATH (proved with live tmux probe). Gate-image RED evidence: e03119e6 bun-5, 6f8aa814 bun-2, 93a8bce7 bun-2.

## Fix (harness only, one file: test/bun/studio-tmux-socket.test.ts)

TwoServers writes `<dir>/home/.profile` = `PATH=<bin>:$PATH; export PATH`. Login dash reads $HOME/.profile AFTER /etc/profile, so the harness bin survives any system-wide PATH reset. Never touch bring-up or the studio image.

## RED test (deterministic in studio, not only the gate image)

New case in the #117 describe: pin SHELL to a wrapper that plays /etc/profile's part (reset PATH, then `exec /bin/sh -l`), start the bare session, send `command -v claude > <probe>` into the pane, waitFor probe content = the harness claude path. Before the fix: claude not on the pane PATH, probe stays empty, waitFor times out — RED. After: .profile restores PATH — GREEN.

## Steps

1. Plan doc (this file).
2. RED: wrapper-shell test; run file, new case fails; commit.
3. GREEN: TwoServers writes home/.profile; whole file green; commit.
4. Verify (one at a time): bun test test/bun/studio-tmux-socket.test.ts; bun run check; bun run test-lies-check; bun run english-check.
5. PR refs #1058 + #715; envelope; awaiting_merge.

## Boundaries

Touch only apps/fleet/test/bun/studio-tmux-socket.test.ts + this plan doc. Harness fix only, never bring-up. Other bare-session tmux-pane tests: none — relaunch harnesses pass explicit pane commands (non-login). No closing keywords.

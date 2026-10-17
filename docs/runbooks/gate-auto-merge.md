# Gate auto-merge: arm `gh pr merge --auto`

Issue #1169, refs #1168. Precheck gate = piece (a). This runbook documents
invocation only. Identity watcher = piece (d), separate, not here.

## Verify before arming

1. `gate/verdict` green on the PR head sha — not the branch tip, the sha.
2. No closing keyword in PR title or body (`close/fix/resolve #N`). Precheck
   turns the gate red on one. Regex: `(^|[^a-z])(close[sd]?|fix(es|ed)?|resolve[sd]?) #[0-9]`.
3. `--match-head-commit` value equals the PR head sha, character for character.

## Invocation

```sh
gh pr merge <pr> --auto --squash \
  --match-head-commit <head-sha> \
  --author-email 'fleet-studio@users.noreply.github.com'
```

Why each flag:

- `--auto`: defers merge until `gate/verdict` (and every other required
  context) green. Merge happens when GitHub sees the head green, no human
  awake needed.
- `--squash`: one commit on the base. No merge-bubble in history, bisect
  stays linear.
- `--match-head-commit`: pins the arm to that head sha. Any later push moves
  the head, auto-merge disables itself, unseen code never lands. This is the
  flag that makes `--auto` safe.
- `--author-email`: sets merge commit author email to the public-safe
  noreply identity. `gh` sends `authorEmail` in the auto-merge mutation, so
  the merge commit carries it from arm time.

## Post-merge audit boundary

Pre-merge gate CANNOT check the merge commit's identity. It does not exist
until GitHub creates it at merge time. No precheck reads it; none can.

So the identity check lives post-merge: the monitor (#1168 piece (d), out of
scope here) reads the merge commit's author email and alerts when it is not a
noreply identity. This runbook documents the invocation. The watcher is
piece (d).

## Fail closed

Precheck runs before the gate's skip return. Missing denylist, denylist with
zero patterns, scanner error, or a precheck step crash: red verdict
("gate precheck: ..." / "gate precheck failed closed"), never a silent pass.

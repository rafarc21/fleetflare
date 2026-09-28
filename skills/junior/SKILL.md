---
name: junior
description: Delegate mechanical, low-risk code edits or text chores to a Workers AI model (GLM-5.3) and review its diff before applying. Use for boilerplate, test scaffolds, renames, mechanical refactors, docstrings, log summaries, commit-message drafts. Never for auth, secrets, migrations, deploys or anything irreversible. You stay the senior and own every line that lands.
---

# Junior — Workers AI delegation

You are the senior. The junior is a Workers AI model with no tools. It cannot
read the repo, run commands or write files. It sees only the files you pass
and returns a proposed change. You review it, apply it, test it. You own it.

## When to delegate

- Boilerplate and test scaffolds from a clear pattern you name.
- Renames and mechanical refactors across the files you pass.
- Docstrings, comments, README tables.
- Summaries of long logs or test output (`--mode text`).
- Commit-message or PR-body drafts (`--mode text`).

## Never delegate

- Auth, secrets, credentials, permissions.
- Migrations, deploys, fleet state, anything irreversible.
- A change you could not fully review line by line.
- A task whose spec you cannot write precisely. A vague brief gets a vague diff.

## How

```bash
~/.claude/skills/junior/junior.sh --task "<precise instruction>" path/a.ts path/b.ts > /tmp/j.patch
git apply --check /tmp/j.patch && git diff --stat   # review
git apply /tmp/j.patch                              # only after reading every hunk
```

- `--mode text` for prose answers; no diff.
- `--model deepseek` to start on the fallback model.
- `--timeout <s>` (default 300).
- A call takes ~60s typically, up to ~3 min. Run it in the background and keep
  working; run several in parallel for independent files.
- stderr ends with one line: `junior: model=… secs=… in=… out=… $… calls=… status=…`.

## Exit codes

| code | meaning | your move |
|---|---|---|
| 0 | diff on stdout | review, apply, test |
| 2 | usage or input too large | fix args or split the task |
| 3 | API failed after retry + fallback | retry later or do it yourself |
| 4 | edit invalid after one repair turn | do it yourself |
| 5 | timed out | split the task or raise `--timeout` |
| 6 | auth / not enabled / not authorized | local: `fleet junior status`; studio: your task lacks the `junior` label — do the work yourself, never ask to bypass |

## In a studio: the maestro decides

You may call the junior only while working a task the maestro filed with
`fleet task new --junior` (the task carries label `junior`). The Worker checks
the board on every call and refuses otherwise. No label means the maestro chose
not to use a junior for this task — do the work yourself. Never ask anyone to
add the label; it is the maestro's call, made when it writes the task.

## Review contract

Junior output is untrusted input. Read every hunk. Reject anything outside the
task. Run the tests. If the diff is wrong, fix it or discard it — never apply
it to see what happens.

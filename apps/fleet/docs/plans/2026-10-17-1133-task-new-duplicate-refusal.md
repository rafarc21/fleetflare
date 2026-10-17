# Refuse a second open task for the same issue (#1133)

A new board task filed for an issue that already has an open task (live studio, open PR)
burned capacity quietly. `fleet task new`, `ff <role> "<task>"` and the in-studio `task new`
all funnel through board.ts's `createTask`, so one check there covers every surface.

## Detection
`refsInBrief(title, objective)` (brief.ts): the issue numbers a brief references — `#N`
anywhere in its title, or the board's canonical `refs #N` in title or objective (the same
form pr-awaiting-merge.ts reads on PRs). `continues` ("Continues #7." in an objective) is
NOT a reference to refuse on: a follow-up legitimately reopens work on the issue a merge
just closed.

## Check (createTask)
After parseBrief, before any write: for each referenced number, `getIssue` reads the task
whose OWN number is that issue. GitHub-open AND not a terminal board state = the existing
task this new one would duplicate. Refuse 409 naming the task, its assignee, and (best
effort, from its newest result envelope) its PR. `--allow-duplicate` (brief.allowDuplicate)
skips. Fails OPEN on an unreadable issue — the create is about to need GitHub anyway.

## Files
`src/board/brief.ts`, `src/board/board.ts`, `src/studio/cli-args.ts`,
`test/board.brief.test.ts`, `test/board.create.test.ts`, `test/studio.cli-args-parse.test.ts`.

## Verification
RED-first TDD. `bun run test test/board.brief.test.ts test/board.create.test.ts test/studio.cli-args-parse.test.ts`
then `bun run check`, `bun run english-check`, `bun run test-lies-check`.
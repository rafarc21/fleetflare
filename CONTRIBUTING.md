# Contributing

Thanks for looking. Fleetflare is small and opinionated; these rules keep it
working.

## Before you start

- Open an issue first for anything beyond a small fix, so the approach can be
  agreed before you spend time on it.
- Security issues go through [SECURITY.md](SECURITY.md), never a public issue.

## Development

```bash
cd apps/fleet
bun install
bun run check       # types, all tsconfig projects
bun run test        # vitest-pool-workers
bun run bun-test    # container-level tests; needs tmux and Chromium
```

Both test lanes matter: `bun run test` alone is half the suite. The
`bun-test` lane executes real shell and a real tmux server. Run it inside a
Linux container (see the CI section of the README), never on a machine where
`TMUX` is set to a session you care about.

From the repository root:

```bash
bun run apps/fleet/scripts/english-check.ts
```

## Pull requests

- Tests first: a change in behavior comes with a test that fails without it.
- One concern per pull request. Keep diffs surgical; match the surrounding
  code and comment style.
- All repository content is English: code, comments, docs, issues, commit
  messages and pull request text.
- CI is the `local-ci/*` commit status on your pull request head (see the
  README's CI section). A maintainer runs it; there is no hosted CI.

## License

By contributing, you agree that your contributions are licensed under the
Apache License, Version 2.0 (see [LICENSE](LICENSE)).

# Plan — S39-F4 git identity vars in setup.md (refs #763)

Sweep 39 finding 4: `FLEET_BOT_NAME`/`FLEET_BOT_EMAIL` (task container
git identity) and `FLEET_STUDIO_GIT_NAME`/`FLEET_STUDIO_GIT_EMAIL`
(studios' git identity) are vars in `wrangler.example.jsonc` and `env.ts`,
but docs/setup.md's "Secrets vs. vars" enumeration (section 5) never names them.
docs/env-vars.md:61-62 already documents all four — setup.md is the only
gap.

Change: docs/setup.md only, in section 5's vars list. Add the four names after
`FLEET_REQUIRE_ACCOUNT_MAP`, keeping the parenthetical-defaults sentence
shape the list already uses. All four optional; built-in defaults:
`fleetflare[bot]` for FLEET_BOT_*, `fleet-studio
<fleet-studio@users.noreply.github.com>` for FLEET_STUDIO_GIT_*.
FLEET_STUDIO_GIT_* is both-or-neither and refuses `[bot]` shapes — a
one-line parenthetical, full rules stay in env-vars.md (linked already).
No code, no wrangler.example.jsonc, no env-vars.md edits.

Verify: english-check and test-lies-check (both cover docs), zero exit.
Docs-only diff — full vitest/bun lanes and tsc untouched by it.

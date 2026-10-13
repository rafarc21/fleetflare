# Sweep 28 — stale code comments (refs #643)

Plan doc for a comment-accuracy audit of apps/fleet/src + apps/fleet/cli.

1. Extract every comment-embedded reference (file path, test path, function
   name, CLI flag, env var, constant) from src+cli (test files excluded).
2. Cross-check each against the tree: `find`/`grep` prove presence; absence is
   hand-verified (name variants, sibling dirs, git history) before counting.
3. Verification classes ruled OUT (all checked, none stale): ~60 cited
   function/constant names, ~30 test-path citations, all CLI flags including
   --allow-unrescued (deploy.sh:128), SDK-internal names (TIMEOUT_TO_GET_*_MS,
   syncPendingStoppedEvents, DEFAULT_CONTAINER_TIMEOUTS — correct against the
   pinned @cloudflare/sandbox's OWN nested containers copy), frontmatter keys
   (skills/gates etc. — not paths), operator-machine paths (~/.fleet/probe,
   ~/.claude), gitignored-local wrangler.jsonc.
4. Findings: 3 hard (grep-proven) + 1 class. Write
   docs/maintainability/2026-10-13-stale-comments-sweep-28.md (content below).
5. File follow-up issues titled `docs(GLM-OK): S28-Fn <short>` (refs #643),
   one per batch, no closing keywords. Open the doc-only PR, push before PR.

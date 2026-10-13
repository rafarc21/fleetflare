# Plan — sweep 31: unused + misplaced dependencies (#649)

Doc-only sweep, no code changes. Dependencies cross-referenced by hand: every
entry in apps/fleet/package.json (4 dependencies, 8 devDependencies) against
bare-specifier imports in src, cli, test, test-integration, scripts, page,
vitest.config.ts (container/ read for rule-out only). No root package.json
or bun.lock exists — apps/fleet/bun.lock is the only manifest.

## Steps

1. Branch sweep-649-dependencies off origin/main 33c0bae (done).
2. Inventory: clean bare-import census over in-scope dirs (vitest, bun:test, cloudflare:test, cloudflare:workers, @cloudflare/sandbox, @cloudflare/containers, @cloudflare/vitest-pool-workers, aws4fetch, miniflare, wrangler); false positives (string literals like from "none") ruled out by re-grep. Banned lanes excluded.
3. Hand-verify each candidate: import sites, tsconfig "types" entries, wrangler-config requirements, non-import consumers (build-page.ts reads node_modules/@xterm/xterm from disk; container/ego-browser has own package.json pinned to playwright-core 1.63.0; Dockerfiles cite bun.lock's playwright-core version).
4. Write docs/maintainability/2026-10-13-dependencies-sweep-31.md — findings, each: package, evidence, proposed action, lane.
5. Commit both docs, push branch (LEFTHOOK=0 git push -u origin sweep-649-dependencies).
6. File follow-up issues per actionable batch: chore(GLM-OK): S31-Fn <short>, refs #649, never closing keywords.
7. Open doc-only PR referencing #649, no closing keywords.

## Verification

- No build/test gate: doc-only diff. git diff origin/main --stat = 2 new .md files only.
- Every file:line ref re-checked against working tree before commit.
- cd apps/fleet && bun run english-check exit 0 (doc text is repo content).

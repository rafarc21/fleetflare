# 374 — shared authorizedReq test helper (S3-F4)

Sweep-3 finding S3-F4: byte-identical `authorizedReq(path, init)` request
builder (adds `Cf-Access-Jwt-Assertion: test-jwt`, a literal fixture token)
hand-written 4 times. Issue scope: extract one helper, migrate 3 copies.

## Plan

1. Create `apps/fleet/test/helpers/http.ts` exporting the builder verbatim
   (same signature, same spread, same header merge, same `https://x` base).
2. Migrate 3 copies — delete local fn, add `import { authorizedReq } from "./helpers/http";`:
   - `test/studio.grid.test.ts:75`
   - `test/studio.paste.test.ts:50`
   - `test/studio.burn-window-expiry.test.ts:140`
3. OUT of scope: `test/studio.routes.test.ts:405` (CLAUDE-ONLY file per
   S3-F7 — its copy migrates in the Claude lane). Do NOT touch that file.

## Verification

- `vitest run` on the 3 touched suites — pass counts unchanged.
- 401-without-header tests green (they build requests without the helper).
- `tsc --noEmit -p test`, english-check, test-lies-check — all clean.

Behavior-preserving extraction. No src/ change, no runtime code touched.

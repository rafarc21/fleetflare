# S47-F3 install-cache unshare probe — skip not throw under CI (refs #964, refs #944, refs #715)

`install-cache-security-disk.test.ts:722-739` reads `canUnshareMount` (spawnSync
probe) and `process.env.CI` at module load to pick the round-7 ENOSPC suite
wrapper. Under CI with a failed probe it currently registers a THROWING
placeholder test — failing the whole file — while a capable container with CI
unset silently skips. The #715 gate splits this suite across containers with
different capabilities, so the throw path fails the shard and the silent-skip
path hides a real proof.

## Change
- `test/bun/install-cache-security-disk.test.ts` only. Keep the module-load
  probe (still correct: probe per run at file load). When `CI=true` and the
  probe fails, register the suite via `describe` with a single `test.skip`
  marker (visible in the shard report) instead of a throwing placeholder.
  Non-CI failed probe keeps `describe.skip` (unchanged). Update the comment
  tail to name the new skip-not-throw behavior.

## Steps (TDD)
1. Plan doc commit + push.
2. RED (unmodified): `CI=true PATH=/nonexistent bun test ...` → 1 fail (throwing
   placeholder). Already observed on origin/main.
3. GREEN: swap throw → `test.skip` marker; same command → 0 fail, skip visible.
4. Real lane: `bun test ...` (no CI) → 16 pass.

## Verify (sequential, one gate at a time)
- `bun test test/bun/install-cache-security-disk.test.ts` — 16 pass, 0 fail.
- `CI=true PATH=/nonexistent bun test ...` — 0 fail, marker skip visible.
- `npx tsc --noEmit -p test` — exit 0.
- `bun run english-check` — clean.

## Boundaries
- One test file only. No src/, cli/, container/. No closing keywords for #944/#715.
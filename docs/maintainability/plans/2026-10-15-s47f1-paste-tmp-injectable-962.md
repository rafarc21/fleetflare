# S47-F1 paste tmp injectable — plan (refs #962, refs #944, refs #715)

Make grabClipboardPng's fixed /tmp/fleet-paste.png an env-overridable seam so
paste-cmd + paste-mac test lanes each own a private file — no cross-file
cleanup race when sharded.

## Change
- cli/paste-mac.ts: replace `const PASTE_TMP_PATH = "/tmp/fleet-paste.png"`
  with `function pasteTmpPath() { return process.env.FLEET_PASTE_TMP ?? "/tmp/fleet-paste.png"; }`.
  grabClipboardPng computes `const tmp = pasteTmpPath()` once per call and uses
  `tmp` for both Bun.spawn and Bun.file. Call-time read, not module-load — no
  import-order hazard for in-process mock lanes.
- test/bun/paste-cmd.test.ts: drop fixed PASTE_TMP const. Module-level
  `let pasteTmp`; beforeEach sets `pasteTmp = join(tmpDir("paste-cmd-tmp-"),
  "fleet-paste.png")`. run() passes `FLEET_PASTE_TMP: pasteTmp` in child env.
  afterEach keeps cleanupTempDirs() (rmSync of the fixed path removed — the
  mkdtemp dir is cleaned recursively).
- test/bun/paste-mac.test.ts: same `let pasteTmp` seam. #498 real-lane
  grabUnderPath passes FLEET_PASTE_TMP in child env; PASTE_TMP refs in
  write/assert swap to pasteTmp. #519 mock-lane beforeEach sets
  process.env.FLEET_PASTE_TMP = pasteTmp (restore in afterEach); fakeBun
  asserts against pasteTmp.

## Steps (TDD)
1. Plan doc commit + push.
2. RED: update both tests to inject; `bun test` the two files → paste-mac
   success/exit1 lanes fail (file lands in /tmp, not the injected dir).
3. GREEN: add pasteTmpPath() to cli/paste-mac.ts; re-run → green.

## Verify (sequential, one gate at a time, under flock)
- bun test test/bun/paste-cmd.test.ts test/bun/paste-mac.test.ts — all pass.
- npx tsc --noEmit -p cli && npx tsc --noEmit -p test — exit 0.
- bun run english-check — clean.

## Boundaries
- cli/paste-mac.ts + the two test files only. No src/, container/, other cli.
- No closing keywords for #944/#715.
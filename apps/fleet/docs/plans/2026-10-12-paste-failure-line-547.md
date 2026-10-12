# S19-F3: fleet paste owns its failure line — plan (board issue #547)

Refs #539 (sweep 19, finding F3). cmdPaste (cli/fleet.ts:2649) lets uploadPaste's throw propagate to main()'s generic catch, so a failed upload prints `fleet: paste upload failed: ...` — no `fleet paste:` frame owns the line. Behavior today is right (stderr, exit 1); only the frame is missing. Sibling of S19-F4's decode guards; the attach path (handlePaste, :2732) already catches its own and is untouched.

## Steps
1. RED: new test/bun/paste-cmd.test.ts — Bun.spawn of the real CLI under a temp HOME + credentials naming a local Bun.serve stand-in, a fake `pngpaste` on the child's PATH (pattern of test/bun/paste-mac.test.ts + memory-cmd.test.ts). A 500 from POST /studio/:id/paste must exit 1 with `fleet paste: paste upload failed: 500 ...` on stderr; a 200 prints the path. Fails at RED because the line reads `fleet: paste upload failed: ...` today.
2. GREEN: wrap cmdPaste's `console.log(await uploadPaste(...))` in try/catch — `console.error(\`fleet paste: ${errText(err)}\`); process.exit(1);` — same posture as cmdMemoryCompact (:2625). uploadPaste itself and handlePaste untouched.
3. Targeted gates only, one at a time: bun test test/bun/paste-cmd.test.ts, paste-mac.test.ts, memory-cmd.test.ts; bun run check; bun run english-check. Never the full suite.

## Constraints
- Two files total besides this doc: the new test file, the cmdPaste fix in cli/fleet.ts. No other edits.
- Test comment header cites issue #547 like sibling files cite theirs.

## Verification
Record at /workspace/.fleet/done/547.json (never committed): plan path + one entry per gate with real output tails, exit 0 each.

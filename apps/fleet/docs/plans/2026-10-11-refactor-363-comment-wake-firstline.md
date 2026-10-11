# comment-wake firstLine() extraction — board #363

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract one private `firstLine(body)` helper in `apps/fleet/src/board/comment-wake.ts` and reduce `hasWakeMarker` and `isDoneRecordComment` to single-line comparisons, pinning the CRLF handling with new tests first.

**Architecture:** Pure refactor of one module, behavior-preserving. The split+trim fold `(body.split(/\r?\n/)[0] ?? "").trim()` is re-typed twice in comment-wake.ts (issue #363, deep-modules sweep 4 finding F3, doc `docs/maintainability/2026-10-11-deep-modules-sweep-4.md` on branch sweep-361-glm-maintainability-4, parent #361). A fourth marker would re-type it a third time and can drift on `\r` handling. `oneLine` from `github/wake-events.ts` is NOT reusable here: it flattens ALL newlines, while the marker rule is first-line-ONLY — the mutant pin `'/wake' present but NOT on the first line never wakes` (apps/fleet/test/github.webhook.test.ts:732, body `"hi\n/wake"`) depends on that difference. No interface change: `qualifiesForCommentWake` and all other exports keep their exact signatures.

**Tech Stack:** TypeScript, vitest (module tests), no Wrangler/D1/DO — comment-wake.ts is pure over the `AssignWakeDeps` port.

**Spec:** GitHub issue https://github.com/rafarc21/fleetflare/issues/363 (board task; the issue body IS the spec) — find F3 of the sweep-4 maintainability doc.

## Global Constraints

- Tier GLM-OK: no auth, tokens, rescue, failover, deploy, migrations or credentials may be touched.
- All repo content in English.
- Never re-type the split+trim fold; never weaken the first-line-only rule.
- Two-way door: code-only, revertable, zero behavior change.

---

### Task 1: Pin CRLF and first-line behavior in the module tests (RED first for the new CRLF pin, then GREEN by extraction)

**Files:**
- Modify: `apps/fleet/test/board.comment-wake.test.ts` (add one describe block after the existing completion-record describe at the file's end)
- Modify: `apps/fleet/src/board/comment-wake.ts:51-53` (`hasWakeMarker`) and `apps/fleet/src/board/comment-wake.ts:66-68` (`isDoneRecordComment`)

**Interfaces:**
- Consumes: `qualifiesForCommentWake(taskState, commentBody, authorLogin)` (exported, unchanged), `doneRecordComment(studio, body, why)` from `src/studio/do`.
- Produces: one private, non-exported `firstLine(body: string): string` in comment-wake.ts, used by both predicates. All existing exports unchanged.

- [ ] **Step 1: Write the failing test — CRLF-marker pin**

Append to `apps/fleet/test/board.comment-wake.test.ts`:

```typescript
// #363: the first-line fold is shared, so its CRLF handling gets pinned
// ONCE here instead of per predicate. A comment body carrying Windows
// line endings must still match the marker rules: GitHub bodies can and
// do arrive with \r\n, and a fold that split on "\n" alone would leave a
// trailing "\r" that breaks the exact-match against "/wake".
describe("first-line marker rules survive CRLF bodies (issue #363)", () => {
  it("/wake with leading space and CRLF newline still qualifies, for any task state", () => {
    expect(qualifiesForCommentWake("working", "\r\nplain reply text\r\n", "rafarc21")).toBe(false);
    expect(qualifiesForCommentWake("working", "/wake \r\nsecond line", "rafarc21")).toBe(true);
    expect(qualifiesForCommentWake("working", "/wake\r\nsecond line", "rafarc21")).toBe(true);
  });

  it("a CRLF completion record still never wakes — first line matches the marker exactly", () => {
    const record = doneRecordComment("websites--pilot", "{}");
    expect(qualifiesForCommentWake("input_required", record + "\r", "rafarc21")).toBe(false);
  });
});
```

Note: the `"/wake \r\nsecond line"` case is the load-bearing one — `" /wake "` with trailing `\r` must trim to exactly `/wake`, proving the fold's `.trim()` handles carriage returns.

- [ ] **Step 2: Run the new tests to confirm they already pass (they pin current behavior, not new behavior)**

Run from `apps/fleet`: `bun x vitest run test/board.comment-wake.test.ts`
Expected: ALL PASS including the new describe. If any FAIL, STOP and report — that means current behavior differs from what the issue assumed.

- [ ] **Step 3: Extract `firstLine` and reduce both predicates**

In `apps/fleet/src/board/comment-wake.ts`, add this private helper between `WAKE_MARKER` and `hasWakeMarker`:

```typescript
/** The comment's first line, trimmed — the marker surface every predicate
 *  below reads. One fold, not one per predicate: a fourth marker would
 *  otherwise re-type the split+trim and drift on \r handling (issue #363).
 *  NOT `oneLine`: that flattens every newline, while the marker rule is
 *  first-line only — see hasWakeMarker's own mid-comment spoof pin. */
function firstLine(body: string): string {
  return (body.split(/\r?\n/)[0] ?? "").trim();
}
```

Then reduce the two predicates to:

```typescript
export function hasWakeMarker(body: string): boolean {
  const line = firstLine(body);
  return line === WAKE_MARKER || line.startsWith(`${WAKE_MARKER} `);
}
```

```typescript
export function isDoneRecordComment(body: string): boolean {
  return firstLine(body) === DONE_RECORD_COMMENT_MARKER;
}
```

Keep every existing doc comment on both predicates exactly as-is.

- [ ] **Step 4: Run the module test file — GREEN**

Run from `apps/fleet`: `bun x vitest run test/board.comment-wake.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Run the webhook characterize suite (the issue's named characterization)**

Run from `apps/fleet`: `bun x vitest run test/github.webhook.test.ts`
Expected: ALL PASS, including mutant pin `'/wake' present but NOT on the first line never wakes` and the #236 describe block.

- [ ] **Step 6: Typecheck (HEAVY GATE — run alone, nothing else in parallel)**

Run from `apps/fleet`: `bun run check` — expects `tsc --noEmit` for main, container, cli, test-integration and test projects, all clean, exit 0.

- [ ] **Step 7: Commit and push**

```bash
git add apps/fleet/src/board/comment-wake.ts apps/fleet/test/board.comment-wake.test.ts
git commit -m "refactor(fleet): comment-wake firstLine() — one fold, two predicates (refs #363)"
LEFTHOOK=0 git push origin sweep-363-comment-wake-firstline
```

## Self-Review checklist (lead runs this, executor ignores)

- Both predicates reduced to single-line comparisons? Both call sites of the fold gone?
- `oneLine` NOT used inside the predicates (import stays for `commentDigest`)?
- New tests green, all pre-existing tests in both files green, `bun run check` exit 0?
- Completion record `/workspace/.fleet/done/363.json` written by a Developer (not the lead) after gates pass?

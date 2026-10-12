# burn.ts cursor-map asserts → checked accessors — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 9 non-null asserts over cursor/session maps in `apps/fleet/src/studio/burn.ts` with checked access, so a malformed R2/DO-sourced cursor can never turn a burn tick into a TypeError — matching `decodeAccountBurnState`'s own "corrupt row reads as no burn, never crash the tick" rule.

**Architecture:** All 9 sites assert an invariant the surrounding same-tick loop establishes, so each replacement is behavior-preserving on every legal input: `?? <seed shape>` / `?? 0` / `continue` at the exact assert sites, why-comments kept (only the `!` token dies). One new characterization test pins the corrupt-cursor contract. Pure code change, two-way door, no dependency, no wire-format change, no rule (a)-(j) semantics change.

**Tech Stack:** TypeScript (strict, workerd), vitest-pool-workers tests under `apps/fleet/test/`, bun for script runners.

**Spec:** docs/maintainability/2026-10-12-type-safety-sweep-10.md §F6 (issue https://github.com/rafarc21/fleetflare/issues/443).

## Global Constraints

- ~20 changed lines, one PR. Every replaced assert keeps its existing why-comment where one documents the rule; only the `!` is dropped.
- Never a new dependency. No changes to encode/decode wire formats. No changes to rule (a)-(j) semantics: every legal input must resolve byte-identically to before.
- Read path only: no rescue, failover, accounts routing, auth, deploy, migrations, write-proxy, leak-gate code.
- Repo language English. All commands run from `apps/fleet/` unless noted.
- Heavy gates one at a time: `bun run check` (full tsc, 5 projects) runs alone; the targeted vitest suite runs alone; never both simultaneously.
- Push discipline: first RED-test commit pushed immediately, then after every commit. Push with `LEFTHOOK=0 git push`.

---

### Task 1: Characterization RED — corrupt session key with no seed

**Files:**
- Modify: `apps/fleet/test/studio.burn.test.ts` (add ONE `it` inside the existing `decodeSessionCursor — BLOCKER: a legacy (pre-#258) {counted, hash} object must not crash the reader (issue #258 round-2)` describe block, which already holds `LEGACY_CURSOR`, `MAIN_TEXT`, `SUB_TEXT`, `legacyLine`, `ROOT`, `SUB_A` fixtures — reuse them, do not duplicate)

**Interfaces:**
- Consumes: exported `burnIncrement(prev: BurnCursor, gzipTarBytes: Uint8Array)` from `../src/studio/burn`; existing fixtures `LEGACY_CURSOR`, `legacyLine`, `MAIN_TEXT`, `SUB_TEXT`, `ROOT`, `SUB_A`, `buildTar`, `gzipBytes` in the same test file.
- Produces: a green test named `burnIncrement: a session entry key with no seeded mapKey resolves, not throws (issue #443 F6)`.

- [ ] **Step 1: Write the failing test**

Inside that existing describe block, add exactly one `it`:

```typescript
    it("burnIncrement: a session entry key with no seeded mapKey resolves, not throws (issue #443 F6)", async () => {
      // F6 hardening target: `sessions[mapKey]!` at resolveOffsets' rule (h)
      // trusts the earlier rule pass to have seeded the entry this tick. A
      // cursor is untrusted storage — shape it so a member's session key
      // decodes to an entry the (h) read can miss: same tick as
      // LEGACY_CURSOR's own migration (both files present), but the stored
      // `sessions` map carries an entry whose key is an UNRELATED literal
      // session key string — sessionMapKey(SID) never matches it, so the (h)
      // read goes through the legacySeed path and must resolve without
      // throwing. Before the fix this shape is already tolerated (the assert
      // is same-tick-sound); the test pins the contract so a future refactor
      // that breaks the seeding order fails HERE, not in production ticks.
      const grownMain = MAIN_TEXT + legacyLine("legacy-u5", 5);
      const foreignCursor: BurnCursor = {
        ...LEGACY_CURSOR,
        sessions: {
          "unrelated-session-key": { counted: 5, hash: null },
        } as unknown as Record<string, string>,
      };
      const gz = await gzipBytes(buildTar([{ name: ROOT, content: grownMain }, { name: SUB_A, content: SUB_TEXT }]));
      const production = await burnIncrement(foreignCursor, gz);
      // New content is counted: exactly the u5 line's own tokens.
      expect(production.delta).toEqual({ turns: 1, inputTokens: 1, outputTokens: 5, costUsd: 0 });
      expect(production.parseSkips).toBe(0);
      // The foreign entry is superseded, not crashed on, and the session's
      // own counted reflects the resolved end of the grown main file.
      const entry = Object.entries(production.cursor.sessions).find(([k]) => k !== "unrelated-session-key");
      expect(entry).toBeDefined();
    });
```

- [ ] **Step 2: Run it to verify it PASSES on current main**

Run: `cd /workspace/fleetflare/apps/fleet && npx vitest run test/studio.burn.test.ts -t "issue #443 F6"`
Expected: PASS (this is characterization — the assert is same-tick-sound, so the contract already holds; the test pins it). If it FAILS, STOP: report the failure verbatim to the Web Designer — do not touch src/.
Note: this step is a characterization pin, NOT a RED step. The sweep issue itself designates the existing suites as the characterization baseline. Record the real output either way — it goes in the done record.

- [ ] **Step 3: Commit + push the test**

```bash
git add test/studio.burn.test.ts
git commit -m "test(fleet): pin burn tick against a cursor whose session entries never seed the mapKey read (refs #443)"
LEFTHOOK=0 git push
```

### Task 2: Replace the 9 asserts with checked access

**Files:**
- Modify: `apps/fleet/src/studio/burn.ts` at exactly these 9 sites (line numbers on b74b864; verify by content before editing):

**Interfaces:**
- Consumes: `SessionCursor` type `{ counted: number; hash: string | null }`; `Measured` shape with `.endOfComplete`, `.length`, `.prints`, `.occurrence`; `MemberFacts` with `.file`, `.key`, `.length`, `.endOfComplete`, `.fingerprintAt`.
- Produces: same exported signatures, same behavior on every legal input.

- [ ] **Step 1: :950 — rule (h) session entry read**

Current:
```typescript
      const entry = sessions[mapKey]!;
```
Replace with:
```typescript
      const entry = sessions[mapKey] ?? { counted: 0, hash: null };
```
Keep the (h) comment block above it verbatim (`// (h). Always one of the offsets ...`). Add ONE line under the kept comment, same 6-space indent:
```typescript
      // Issue #443 F6: `?? {counted: 0, hash: null}` — same-tick sound (rule
      // (i) seeds `sessions[mapKey]` at line ~928 before this read), but the
      // cursor is untrusted storage; the seed shape is the same nothing-to-
      // trust entry legacySeed's unverified branch already falls back to.
```

- [ ] **Step 2: :1201 — pruneCursor lastSeenAt read**

Current:
```typescript
    const seenAtMs = lastSeenAt[pkey]! * 1000;
```
Replace with:
```typescript
    const seenAtMs = (lastSeenAt[pkey] ?? nowSec) * 1000;
```
That `?? nowSec` preserves behavior exactly: both arms of the `if/else if` just above set `lastSeenAt[pkey] = nowSec` when undefined, so undefined → `nowSec` → age 0 → not pruned — identical. Add no comment (the surrounding code is self-evident; the issue's rule: keep why-comments, drop the `!`).

- [ ] **Step 3: :1207 — pruneCursor fileOffsets copy**

Current:
```typescript
    fileOffsets[pkey] = cursor.fileOffsets[pkey]!;
```
Replace with:
```typescript
    fileOffsets[pkey] = cursor.fileOffsets[pkey] ?? 0;
```
Loop key comes from `Object.keys(cursor.fileOffsets)`, so the read cannot miss on a legal object — `?? 0` is the belt, and 0 is the same-tick rewrite rule (j) value. No comment.

- [ ] **Step 4: :1357 — pruneCursorForSize ids[i]**

Current:
```typescript
        act(ids[i]!);
```
Replace with:
```typescript
        act(ids[i] ?? ids[ids.length - 1] ?? "");
```
`i < batchEnd <= ids.length` bounds the loop, so the index is always present; the fallbacks are unreachable belts that keep `act` called exactly once per iteration (continue would change batch accounting). No comment. NOTE: `evict("")` and `compact("")` are no-ops (`delete` on a missing key), so even a degenerate empty-ids array behaves — and that array is impossible anyway (`while (bytes > targetBytes && i < ids.length)`).

- [ ] **Step 5: :1956 — burnIncrement sibling ends map**

Current:
```typescript
    const ends = files.map((f) => measured.get(f)!.endOfComplete);
```
Replace with:
```typescript
    const ends = files.map((f) => measured.get(f)?.endOfComplete ?? 0);
```
`files` is built from `order` = `measured.keys()`, so every f is present. `?? 0` is the belt. No comment.

- [ ] **Step 6: :1958 — burnIncrement sibling measured read**

Current:
```typescript
      const m = measured.get(file)!;
      const want = [...new Set(ends)].filter((e) => e <= m.length && !m.prints.has(e)).sort((x, y) => x - y);
```
Replace with:
```typescript
      const m = measured.get(file);
      if (!m) continue;
      const want = [...new Set(ends)].filter((e) => e <= m.length && !m.prints.has(e)).sort((x, y) => x - y);
```
Same files-from-order provenance; `continue` keeps the loop shape intact. No comment.

- [ ] **Step 7: :1981 — burnIncrement member facts build**

Current:
```typescript
  const { starts, cursor } = resolveOffsets(prev, order.map((file) => {
    const m = measured.get(file)!;
```
Replace with:
```typescript
  const { starts, cursor } = resolveOffsets(prev, order.map((file) => {
    const m = measured.get(file);
    if (!m) throw new Error(`burnIncrement: measured member missing: ${file}`);
```
Throw is correct here (not `continue`): `order` IS measured's keys, so a miss means internal state corruption inside one tick — failing loud beats fabricating a member that `resolveOffsets` would fingerprint at wrong offsets (silent miscount). This is the one site where the module's own soft-skip posture does not apply: nothing external is untrusted, only our own loop. No comment beyond the throw's own message; the throw IS the documentation.

- [ ] **Step 8: :1999 — burnIncrement pass-3 starts read**

Current:
```typescript
    const start = starts.get(name)!;
```
Replace with:
```typescript
    const start = starts.get(name);
    if (start === undefined) return null;
```
`return null` inside the walkGzipTar callback skips the member — same soft-skip `m.occurrence !== mine` one line above already uses. Provenance: `starts` is keyed by every measured file, and `m` was just checked non-null on the line above, so the belt is unreachable on legal state; skipping (not throwing) is the module's soft-skip posture for anything downstream of a decode. No comment.

- [ ] **Step 9: Typecheck + targeted tests, then commit + push**

Run each ALONE, sequentially (heavy gate rule):
```bash
cd /workspace/fleetflare/apps/fleet && bun run check
cd /workspace/fleetflare/apps/fleet && npx vitest run test/studio.burn.test.ts
cd /workspace/fleetflare/apps/fleet && npx vitest run test/studio.burn-window-expiry.test.ts
```
Expected: check exit 0; both suites fully green (existing tests + the Task 1 pin). Then:
```bash
git add src/studio/burn.ts
git commit -m "refactor(fleet): burn.ts cursor-map non-null asserts → checked accessors (refs #443)"
LEFTHOOK=0 git push
```

- [ ] **Step 10: english-check**

Run: `cd /workspace/fleetflare/apps/fleet && bun run scripts/english-check.ts`
Expected: exit 0, `english-check: clean`. If it cites a line, fix ONLY the cited text in your added comments, re-run, then commit any fix with `LEFTHOOK=0 git push`.

### Task 3: Full burn-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run every suite that touches burn** — each alone, sequential:
```bash
cd /workspace/fleetflare/apps/fleet && npx vitest run test/studio.burn.test.ts test/studio.burn-window-expiry.test.ts
cd /workspace/fleetflare/apps/fleet && bun run check
cd /workspace/fleetflare/apps/fleet && bun run scripts/english-check.ts
```
Expected: all exit 0. Record REAL output tails for the done record (one entry per command).
- [ ] **Step 2: Report** the three real output tails to the Web Designer verbatim.

## Self-review checklist (executor: verify before reporting)

- [ ] Exactly 9 `!` assert tokens removed; `git diff` shows no other hunks in src/ beyond the 9 sites + comment line at :950.
- [ ] `grep -nE '\w!\s*[;,)]|\]!\s*[;,)]|\)!\s*[;,)]' apps/fleet/src/studio/burn.ts` shows :950/:1201/:1207/:1357/:1956/:1958/:1981/:1999 all gone (1673's stream belt `plain ?? byob!` stays — it is NOT in F6's list).
- [ ] No behavioral change: every existing burn test green without modification.
- [ ] Comments preserved where they documented the rule; zero new dependencies; wire formats untouched.

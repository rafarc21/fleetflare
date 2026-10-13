# Plan — S38-F3 github.api test asserts the "token never in the message" clause (refs #777)

Issue: apps/fleet/test/github.api.test.ts:554 — it("throws GitHub's own
words on a non-2xx, token never in the message") asserts only
rejects.toThrow(/503/). Nothing inspects the thrown message for the
token, so the second title clause is unasserted. Sweep doc section
S38-F3 (docs/maintainability/2026-10-13-test-names-vs-assertions-sweep-38.md).
The twin at :388 ("and never the token") has the same gap but is NOT in
this task's scope — #777 names only :554.

Fix: make the body prove both clauses, using the shape this same file
already uses three times (:122, :315, :1352 — "never leaks the token
into the thrown error message"): call with token "super-secret-token",
catch, expect(err.message).not.toContain("super-secret-token"). Keep
the 503 assertion. One test body, one file, no src/ change.

New body for the it at :554:

  it("throws GitHub's own words on a non-2xx, token never in the message", async () => {
    respond = () => new Response("boom", { status: 503 });
    try {
      await listAllBranchNames("super-secret-token", "o/r");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/503/);
      expect((err as Error).message).not.toContain("super-secret-token");
    }
  });

(try/catch instead of rejects.toThrow because the message must be
inspected twice; the /503/ check moves into the catch. Same pattern as
:122/:315/:1352.)

Verify: cd apps/fleet && npx vitest run test/github.api.test.ts — green,
exit 0. Then bun run english-check and bun run test-lies-check — both
clean. These are the verification cmds for the done record.

TDD note: RED step is the plan-doc commit; the test change is GREEN by
construction (the thrown message provably lacks the token — ghRequest
at src/github/api.ts:59-60 builds "list branches for o/r failed (503):
boom", no token). If the new assertion ever fails, that is a real
token-leak regression caught.

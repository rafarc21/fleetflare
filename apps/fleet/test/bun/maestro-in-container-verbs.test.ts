import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Issue #59 (superseded by #250, scope add 1): a cloud maestro's brief used
// to assume the operator's Mac verbs (`provision --fresh-session`, `destroy`,
// `task new --studio` with a junior flag) while actually running in a
// container with the limited `fleet` studio binary instead, and this file
// used to pin the rulebook text that told it which verbs it actually had.
//
// Board issue #250 (operator ruling, 2026-10-06): maestro is ALWAYS LOCAL —
// a cloud studio is never a valid substrate for this role at all, so the
// whole "which in-container verbs does a cloud maestro have" question is
// moot. `fleet/blueprint/studios/maestro/studio.md` is now a stub: any cloud
// studio provisioned with this role stops before touching any verb and
// escalates to the operator instead. This file now pins THAT shape — the
// rulebook no longer promises any in-container verb at all.

const MAESTRO = readFileSync(join(import.meta.dir, "../../../../fleet/blueprint/studios/maestro/studio.md"), "utf8");

test("the stub promises no in-container verb a cloud studio would need to operate", () => {
  for (const verb of ["fleet task new --studio", "fleet task assign", "fleet resume", "fleet spawn"]) {
    expect(MAESTRO).not.toContain(verb);
  }
});

test("the stub never claims to spawn, gate, merge, or deploy", () => {
  expect(MAESTRO).toContain("Do not dispatch, spawn, gate, merge, or deploy anything");
});

test("the stub's only action is the escalation envelope, then stop", () => {
  expect(MAESTRO).toContain("fleet task report");
  expect(MAESTRO).toContain("intent: escalate");
  expect(MAESTRO).toContain("status: blocked");
  expect(MAESTRO).toContain("Stop. Do not retry");
});

test("the stub points the operator at the local maestro instead", () => {
  expect(MAESTRO).toContain("docs/setup.md");
  expect(MAESTRO).toContain("local maestro session");
});

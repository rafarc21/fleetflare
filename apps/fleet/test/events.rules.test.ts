import { describe, expect, it } from "vitest";
import { makeEvent } from "../src/events/schema";
import { dedupeKey, routeDecision } from "../src/events/rules";

const ev = (over: Partial<Parameters<typeof makeEvent>[0]> = {}, ts = 1) =>
  makeEvent(
    { from: "cto", to: "human", kind: "human", project: "websites", body: "hi", ...over },
    ts,
    String(ts),
  );

describe("routeDecision", () => {
  it("lets the CTO reach the human", () => {
    const d = routeDecision(ev(), []);
    expect(d).toEqual({ allow: true, toHuman: true });
  });

  it("blocks a non-CTO agent from reaching the human", () => {
    const d = routeDecision(ev({ from: "dev-42" }), []);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/only the cto/i);
  });

  it("blocks a non-CTO escalation addressed to the human", () => {
    // Was {allow:true, toHuman:false} — the escalation branch returned before
    // the addressed-to-human check, so this passed silently. Now the same
    // shared gate that blocks a non-CTO "human"-kind event blocks this too,
    // with a reason recorded instead of a silent pass-through.
    const d = routeDecision(ev({ from: "dev-42", kind: "escalation", to: "human" }), []);
    expect(d).toEqual({ allow: false, reason: "only the CTO may address the human" });
  });

  it("allows normal agent-to-agent traffic", () => {
    const d = routeDecision(ev({ from: "manager", to: "dev-42", kind: "task" }), []);
    expect(d).toEqual({ allow: true, toHuman: false });
  });

  it("suppresses a duplicate escalation on the same thread", () => {
    const first = ev({ from: "dev-1", kind: "escalation", thread: "IS#54", body: "which font?" }, 1);
    const second = ev({ from: "dev-2", kind: "escalation", thread: "IS#54", body: "Which font?  " }, 2);
    const d = routeDecision(second, [first]);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/duplicate/i);
  });

  it("does not treat a different question on the same thread as a duplicate", () => {
    // from: "cto" on both isolates this to dedupeKey behaviour: with a
    // non-CTO author the "only the CTO may address the human" gate would
    // also produce allow:false, for an unrelated reason, and mask a dedup
    // regression instead of catching one.
    const first = ev({ from: "cto", kind: "escalation", thread: "IS#54", body: "which font?" }, 1);
    const second = ev({ from: "cto", kind: "escalation", thread: "IS#54", body: "which colour?" }, 2);
    expect(routeDecision(second, [first]).allow).toBe(true);
  });

  it("does not count a non-escalation event as a prior duplicate", () => {
    // Same key, different kind. Without the kind filter in the dup predicate,
    // an ordinary task message would silently suppress a real escalation.
    // from: "cto" on esc isolates this to the dedup predicate, same reason as
    // the test above.
    const task = ev({ from: "manager", to: "dev-1", kind: "task", thread: "IS#54", body: "which font?" }, 1);
    const esc = ev({ from: "cto", kind: "escalation", thread: "IS#54", body: "which font?" }, 2);
    expect(routeDecision(esc, [task]).allow).toBe(true);
  });
});

describe("dedupeKey", () => {
  it("ignores case and surrounding whitespace", () => {
    expect(dedupeKey(ev({ kind: "escalation", thread: "T", body: " Hello " })))
      .toBe(dedupeKey(ev({ kind: "escalation", thread: "T", body: "hello" })));
  });

  it("separates different threads", () => {
    expect(dedupeKey(ev({ kind: "escalation", thread: "A", body: "x" })))
      .not.toBe(dedupeKey(ev({ kind: "escalation", thread: "B", body: "x" })));
  });

  it("separates the same question asked on different projects", () => {
    expect(dedupeKey(ev({ kind: "escalation", project: "websites", thread: "T", body: "which font?" })))
      .not.toBe(dedupeKey(ev({ kind: "escalation", project: "beta", thread: "T", body: "which font?" })));
  });

  it("does not let a separator inside the thread forge a collision", () => {
    // Concatenation with a bare "::" would make these two identical.
    expect(dedupeKey(ev({ kind: "escalation", thread: "T1", body: "x::y broke" })))
      .not.toBe(dedupeKey(ev({ kind: "escalation", thread: "T1::x", body: "y broke" })));
  });
});

it("lets a CTO-authored escalation reach the human", () => {
  const e = makeEvent(
    { from: "cto", to: "human", kind: "escalation", project: "websites", body: "price call" },
    1, "a",
  );
  const d = routeDecision(e, []);
  expect(d).toEqual({ allow: true, toHuman: true });
});

it("still keeps a non-CTO escalation away from the human", () => {
  const e = makeEvent(
    { from: "dev-42", to: "human", kind: "escalation", project: "websites", body: "price call" },
    1, "a",
  );
  const d = routeDecision(e, []);
  expect(d).toEqual({ allow: false, reason: "only the CTO may address the human" });
});

it("still dedupes a CTO escalation against an identical recent one", () => {
  const mk = (id: string) => makeEvent(
    { from: "cto", to: "human", kind: "escalation", project: "websites", thread: "T1", body: "Price?" },
    1, id,
  );
  expect(routeDecision(mk("b"), [mk("a")])).toEqual({
    allow: false, reason: "duplicate escalation on this thread",
  });
});

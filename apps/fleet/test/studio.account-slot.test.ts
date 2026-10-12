import { describe, it, expect } from "vitest";
import { slotSecretName, slotNumberOf, labelVarName } from "../src/studio/account-slot";
import { accountLabel, type ClaudeAccountEnv } from "../src/studio/accounts";

// ---------------------------------------------------------------------------
// Issue #405 (sweep #394, finding F7) — the slot-name grammar round-trip
// table. Both directions of the CLAUDE_CODE_OAUTH_TOKEN / _<n> grammar used
// to live hand-kept in TWO homes, symmetric by discipline alone:
// src/studio/accounts.ts's claudeAccountVarName (position -> secret name,
// line 72) with its private slotOf (name -> position), and
// cli/accounts-format.ts's slotNumber (regex parse-back) + labelVarName
// (name -> CLAUDE_ACCOUNT_<n>_LABEL) — so a rename of the token secret shape
// had to land twice. The fold (see #405 and
// docs/plans/2026-10-11-deepen-405-account-slot-grammar.md) moves both
// directions into one imports-NOTHING module, src/studio/account-slot.ts, and
// this table pins that move byte-for-byte: every spelling below is the exact
// string an operator types into `wrangler secret put` and reads back in
// `fleet ls` output.
//
// Names only, never credential VALUES: these functions map a secret's NAME
// to another NAME (a label var, a slot number), the same names-only rule
// src/studio/accounts.ts's own header already states for ClaudeAccount.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Direction 1 — position -> secret name.
// ---------------------------------------------------------------------------
describe("slotSecretName", () => {
  // Slot 1 keeps the UNSUFFIXED name every existing deploy already has:
  // renaming it would have made multi-account support (#53) a
  // redeploy-and-re-secret migration for every studio, which is exactly the
  // "code change" the feature's own requirement rules out. Every later slot
  // appends _<position>. 9 is MAX_CLAUDE_ACCOUNTS (accounts.ts) — the top of
  // the scanned window, so the grammar's own boundary is pinned here too.
  // Byte-exact, because these strings are what `wrangler secret put` keys
  // on: one character of drift strands an account outside the window.
  it("position -> secret name: slot 1 unsuffixed, every later slot _N, through the MAX_CLAUDE_ACCOUNTS boundary", () => {
    expect(slotSecretName(1)).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(slotSecretName(2)).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(slotSecretName(3)).toBe("CLAUDE_CODE_OAUTH_TOKEN_3");
    expect(slotSecretName(9)).toBe("CLAUDE_CODE_OAUTH_TOKEN_9");
  });
});

// ---------------------------------------------------------------------------
// Direction 2 — secret name -> position.
// ---------------------------------------------------------------------------
describe("slotNumberOf", () => {
  // The parse-back, spelled today only in cli/accounts-format.ts's regex:
  // the unsuffixed name reads as slot 1 — the first account predates the
  // suffix convention entirely, so every pre-#53 deploy's one and only
  // secret is, by construction, slot 1.
  it("secret name -> position: the unsuffixed name is slot 1, suffixed names their N", () => {
    expect(slotNumberOf("CLAUDE_CODE_OAUTH_TOKEN")).toBe(1);
    expect(slotNumberOf("CLAUDE_CODE_OAUTH_TOKEN_2")).toBe(2);
    expect(slotNumberOf("CLAUDE_CODE_OAUTH_TOKEN_9")).toBe(9);
  });

  // Foreign names -> null, never a guess. The grammar is uppercase-exact and
  // complete: a lowercase spelling, an empty suffix, trailing garbage after
  // the digits, an unrelated secret name, and the empty string are all
  // outside it. null (not NaN, not 0, not -1) is the "not a slot" signal
  // both homes already use — accounts.ts's slotOf and cli's slotNumber —
  // and it is what keeps a typo'd config key from silently aliasing some
  // real account's slot.
  it("foreign names -> null, never a guessed slot", () => {
    for (const name of [
      "GITHUB_TOKEN",
      "",
      "CLAUDE_CODE_OAUTH_TOKEN_",
      "claude_code_oauth_token_2",
      "CLAUDE_CODE_OAUTH_TOKEN_2X",
    ]) {
      expect(slotNumberOf(name)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The round trip — the fold's whole point.
// ---------------------------------------------------------------------------
describe("the slot-name grammar round trip", () => {
  // ONE grammar, both directions from one module, is what lets a rename of
  // the token secret shape land in ONE place. Every position inside the
  // scanned window must survive the full round trip: the two halves of the
  // table above are two views of the same relation, and this property is
  // what keeps them from ever drifting apart again — the exact hand-kept
  // symmetry that motivated #405 in the first place.
  it("slotNumberOf(slotSecretName(position)) === position for every real slot", () => {
    for (const position of [1, 2, 3, 9]) {
      expect(slotNumberOf(slotSecretName(position))).toBe(position);
    }
  });
});

// ---------------------------------------------------------------------------
// The label variable name.
// ---------------------------------------------------------------------------
describe("labelVarName", () => {
  // Secret name -> CLAUDE_ACCOUNT_<n>_LABEL (accounts.ts's own label
  // convention, spelled from the cli side today). The defensive fallback for
  // a name outside the grammar — CLAUDE_ACCOUNT_<secretName>_LABEL — must
  // stay byte-identical to the pre-#405 cli/accounts-format.ts labelVarName
  // fallback (deleted by this PR — the defensive foreign-name spelling
  // CLAUDE_ACCOUNT_<name>_LABEL): `--write-labels`
  // builds a paste-able config line from whatever name it was handed, so a
  // foreign name must still produce a well-formed (if never-set) variable
  // name, never a crash and never a blank.
  it("secret name -> CLAUDE_ACCOUNT_<n>_LABEL; a foreign name falls back to naming the secret itself", () => {
    expect(labelVarName("CLAUDE_CODE_OAUTH_TOKEN")).toBe("CLAUDE_ACCOUNT_1_LABEL");
    expect(labelVarName("CLAUDE_CODE_OAUTH_TOKEN_2")).toBe("CLAUDE_ACCOUNT_2_LABEL");
    expect(labelVarName("SOMETHING_ELSE")).toBe("CLAUDE_ACCOUNT_SOMETHING_ELSE_LABEL");
  });
});

// ---------------------------------------------------------------------------
// PR #441 maestro review findings 2/3 — the canonical-spelling rule, pinned
// through accountLabel.
// ---------------------------------------------------------------------------
describe("slotOf's canonical-spelling rule, via accountLabel (PR #441 findings 2/3)", () => {
  // accounts.ts's private slotOf (name -> position) used to be a loop over
  // 1..MAX comparing slotSecretName(p) === name, so a name only ever read as
  // the position whose own canonical spelling it IS. The #405 fold replaced
  // that loop with slotNumberOf(name) plus a 1..MAX window check — but
  // slotNumberOf parses ANY _<n> suffix (PR #441 maestro review finding 2),
  // so CLAUDE_CODE_OAUTH_TOKEN_1 (NOT slot 1's name — that is the unsuffixed
  // CLAUDE_CODE_OAUTH_TOKEN), _01 and _09 all parsed into window slots, and
  // accountLabel would read a FOREIGN secret's spelling off slot 1's or
  // slot 9's label. The fix re-imposes the scan's own rule: a parsed n
  // counts only when the name IS slot n's canonical spelling
  // (slotSecretName(n) === name), keeping slotOf byte-identical to the
  // pre-#405 scan for EVERY input. slotOf itself is private, so these pin
  // the rule through accountLabel — the public function whose result
  // depends on it: it returns the label only for canonical slot names,
  // null otherwise. The label vars are read through ClaudeAccountEnv's
  // structural unknown cast (the same envWith shape
  // test/studio.account-failover.test.ts already uses for Env), so the
  // env object below carries label keys the interface itself does not name.
  const env = {
    CLAUDE_CODE_OAUTH_TOKEN: "t",
    CLAUDE_ACCOUNT_1_LABEL: "primary@example.com",
    CLAUDE_ACCOUNT_9_LABEL: "nine@example.com",
  } as unknown as ClaudeAccountEnv;

  // Non-canonical in-window spellings -> null, never a real slot's label.
  // The env deliberately sets slot 1's and slot 9's labels so the old buggy
  // behavior is VISIBLE here rather than a silent null: _1 and _01 parsed
  // as slot 1 and would have read "primary@example.com", _09 parsed as
  // slot 9 and would have read "nine@example.com" — the old scan gave null
  // for all three, and so must the fold.
  it("non-canonical in-window spellings (_1, _01, _09) read null, never slot 1's or slot 9's label", () => {
    expect(accountLabel(env, "CLAUDE_CODE_OAUTH_TOKEN_1")).toBeNull();
    expect(accountLabel(env, "CLAUDE_CODE_OAUTH_TOKEN_01")).toBeNull();
    expect(accountLabel(env, "CLAUDE_CODE_OAUTH_TOKEN_09")).toBeNull();
  });

  // Out-of-window and out-of-grammar spellings -> null, matching the old
  // scan in every one of these cases already: _0 parses as 0 (below the
  // 1..MAX window), a double underscore fails the grammar's regex
  // entirely, and the bare empty string is as foreign as any name can be.
  // The window's two edges are pinned here by behavior — the last in-window
  // slot's canonical name reads its own label, one slot past it reads null
  // (slot 9 in, slot 10 out) — never by restating the constant's value,
  // the mirror test-lies-check's tautological rule refuses.
  it("out-of-window and out-of-grammar spellings (_0, _10, __2, empty) read null", () => {
    expect(accountLabel(env, "CLAUDE_CODE_OAUTH_TOKEN_0")).toBeNull();
    expect(accountLabel(env, "CLAUDE_CODE_OAUTH_TOKEN_9")).toBe("nine@example.com");
    expect(accountLabel(env, "CLAUDE_CODE_OAUTH_TOKEN_10")).toBeNull();
    expect(accountLabel(env, "CLAUDE_CODE_OAUTH_TOKEN__2")).toBeNull();
    expect(accountLabel(env, "")).toBeNull();
  });

  // The canonical spellings still read their OWN slots: the unsuffixed
  // name is slot 1 (every pre-#53 deploy's one and only secret), and a
  // canonical slot with NO label set reads null too — accountLabel's
  // documented behavior for an unset label var, not a slotOf rejection.
  it("canonical spellings read their own slot: the unsuffixed name is slot 1; a label-less slot reads null", () => {
    expect(accountLabel(env, "CLAUDE_CODE_OAUTH_TOKEN")).toBe("primary@example.com");
    expect(accountLabel(env, "CLAUDE_CODE_OAUTH_TOKEN_2")).toBeNull();
  });
});

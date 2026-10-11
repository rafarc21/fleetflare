import { describe, it, expect } from "vitest";
import { slotSecretName, slotNumberOf, labelVarName } from "../src/studio/account-slot";

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
  // stay byte-identical to cli/accounts-format.ts:286-289: `--write-labels`
  // builds a paste-able config line from whatever name it was handed, so a
  // foreign name must still produce a well-formed (if never-set) variable
  // name, never a crash and never a blank.
  it("secret name -> CLAUDE_ACCOUNT_<n>_LABEL; a foreign name falls back to naming the secret itself", () => {
    expect(labelVarName("CLAUDE_CODE_OAUTH_TOKEN")).toBe("CLAUDE_ACCOUNT_1_LABEL");
    expect(labelVarName("CLAUDE_CODE_OAUTH_TOKEN_2")).toBe("CLAUDE_ACCOUNT_2_LABEL");
    expect(labelVarName("SOMETHING_ELSE")).toBe("CLAUDE_ACCOUNT_SOMETHING_ELSE_LABEL");
  });
});

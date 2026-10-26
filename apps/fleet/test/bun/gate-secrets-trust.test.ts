// #1346 security review r1: sameRepo alone let any same-repo pusher (or a
// same-repo PR against a self-created base branch) through. trustedForSecrets
// is the real gate: same-repo AND a trusted collaborator AND a human AND the
// PR's base is the repo's actual default branch.
import { describe, it, expect } from "bun:test";
import { trustedForSecrets, type SecretsTrustInput } from "../../src/gate/secrets-scope";

const TRUSTED: SecretsTrustInput = {
  sameRepo: true, authorAssociation: "COLLABORATOR", authorIsBot: false, baseRef: "main", defaultBranch: "main",
};

describe("trustedForSecrets: the trusted case", () => {
  it("OWNER, MEMBER and COLLABORATOR on the default branch are all trusted", () => {
    expect(trustedForSecrets(TRUSTED)).toBe(true);
    expect(trustedForSecrets({ ...TRUSTED, authorAssociation: "OWNER" })).toBe(true);
    expect(trustedForSecrets({ ...TRUSTED, authorAssociation: "MEMBER" })).toBe(true);
  });
});

describe("trustedForSecrets: same-repo guard", () => {
  it("a fork PR is never trusted, whatever else is true", () => {
    expect(trustedForSecrets({ ...TRUSTED, sameRepo: false })).toBe(false);
  });
});

describe("trustedForSecrets: association guard", () => {
  it("CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR and NONE are refused", () => {
    expect(trustedForSecrets({ ...TRUSTED, authorAssociation: "CONTRIBUTOR" })).toBe(false);
    expect(trustedForSecrets({ ...TRUSTED, authorAssociation: "FIRST_TIME_CONTRIBUTOR" })).toBe(false);
    expect(trustedForSecrets({ ...TRUSTED, authorAssociation: "NONE" })).toBe(false);
  });
});

describe("trustedForSecrets: bot guard", () => {
  it("a bot account (dependabot[bot] etc) is never trusted, even as a COLLABORATOR", () => {
    expect(trustedForSecrets({ ...TRUSTED, authorIsBot: true })).toBe(false);
  });
});

describe("trustedForSecrets: default-base guard", () => {
  it("a PR against a non-default base (one the author could have created themselves) is refused", () => {
    expect(trustedForSecrets({ ...TRUSTED, baseRef: "attacker-created-base", defaultBranch: "main" })).toBe(false);
  });
});

// #1346 security review r1: sameRepo alone let any same-repo pusher (or a
// same-repo PR against a self-created base branch) through. trustedForSecrets
// is the real gate: same-repo AND a trusted collaborator AND a human AND the
// PR's base is the repo's actual default branch -- OR (#1380) same-repo AND
// this fleet's own opted-in GitHub App AND the PR's base is the default branch.
import { describe, it, expect } from "bun:test";
import { trustedAppLogin, trustedForSecrets, type SecretsTrustInput } from "../../src/gate/secrets-scope";

const TRUSTED: SecretsTrustInput = {
  sameRepo: true, authorAssociation: "COLLABORATOR", authorIsBot: false, authorLogin: "a-human",
  baseRef: "main", defaultBranch: "main", trustApps: [],
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

describe("trustedForSecrets: bot guard (default off, #1346)", () => {
  it("a bot account (dependabot[bot] etc) is never trusted when trustApps is empty, even as a COLLABORATOR", () => {
    expect(trustedForSecrets({ ...TRUSTED, authorIsBot: true, authorLogin: "dependabot[bot]" })).toBe(false);
  });
});

describe("trustedForSecrets: default-base guard", () => {
  it("a PR against a non-default base (one the author could have created themselves) is refused", () => {
    expect(trustedForSecrets({ ...TRUSTED, baseRef: "attacker-created-base", defaultBranch: "main" })).toBe(false);
  });
});

// #1380: measured 10-26 -- every studio PR is opened by the fleet's own
// GitHub App (user.type=Bot, author_association=NONE), so the pre-#1380
// trust filter denied ALL studio PRs. This opt-in (default off) lets an
// OPS-configured App slug through, under the exact same same-repo/default-
// base checks, never a looser filter.
const TRUSTED_BOT: SecretsTrustInput = {
  sameRepo: true, authorAssociation: "NONE", authorIsBot: true, authorLogin: "fleetflare-bot[bot]",
  baseRef: "main", defaultBranch: "main", trustApps: ["fleetflare-bot"],
};

describe("trustedForSecrets: app-bot opt-in trusted when configured (#1380)", () => {
  it("the fleet's own App, exact login match, is trusted when opted in", () => {
    expect(trustedForSecrets(TRUSTED_BOT)).toBe(true);
  });

  it("default off: the SAME bot is refused when trustApps is empty (the #1346 default, unchanged)", () => {
    expect(trustedForSecrets({ ...TRUSTED_BOT, trustApps: [] })).toBe(false);
  });
});

describe("trustedForSecrets: app-bot opt-in still requires same-repo and default-base (#1380)", () => {
  it("a fork PR from the opted-in App's login is still refused", () => {
    expect(trustedForSecrets({ ...TRUSTED_BOT, sameRepo: false })).toBe(false);
  });

  it("a non-default base is still refused, even for the opted-in App", () => {
    expect(trustedForSecrets({ ...TRUSTED_BOT, baseRef: "attacker-created-base" })).toBe(false);
  });
});

describe("trustedForSecrets: app-bot opt-in denies every OTHER bot (#1380)", () => {
  it("dependabot[bot] stays denied even when trustApps opts a DIFFERENT app in", () => {
    expect(trustedForSecrets({ ...TRUSTED_BOT, authorLogin: "dependabot[bot]" })).toBe(false);
  });
});

// #1380 lookalike logins: exact match only, never a prefix/substring check.
describe("trustedAppLogin / trustedForSecrets: lookalike logins are denied (#1380)", () => {
  it("'<slug>-x[bot]' is denied", () => {
    expect(trustedAppLogin("fleetflare-bot-x[bot]", ["fleetflare-bot"])).toBe(false);
    expect(trustedForSecrets({ ...TRUSTED_BOT, authorLogin: "fleetflare-bot-x[bot]" })).toBe(false);
  });

  it("the bare slug with no [bot] suffix at all is denied", () => {
    expect(trustedAppLogin("fleetflare-bot", ["fleetflare-bot"])).toBe(false);
    expect(trustedForSecrets({ ...TRUSTED_BOT, authorLogin: "fleetflare-bot" })).toBe(false);
  });

  it("a different app's own [bot] login is denied", () => {
    expect(trustedAppLogin("other-app[bot]", ["fleetflare-bot"])).toBe(false);
    expect(trustedForSecrets({ ...TRUSTED_BOT, authorLogin: "other-app[bot]" })).toBe(false);
  });

  it("a slug that is a prefix or suffix of the real one is denied", () => {
    expect(trustedAppLogin("fleetflare[bot]", ["fleetflare-bot"])).toBe(false);
    expect(trustedAppLogin("flare-bot[bot]", ["fleetflare-bot"])).toBe(false);
  });

  it("an empty-string slug in trustApps matches nothing", () => {
    expect(trustedAppLogin("[bot]", [""])).toBe(false);
  });
});

// #1380 "(if available)" App-id cross-check: skipped (never a refusal) when
// either id is missing; refuses on an actual mismatch when both are present.
describe("trustedForSecrets: optional App-id cross-check (#1380)", () => {
  it("trusted when both ids are present and match", () => {
    expect(trustedForSecrets({ ...TRUSTED_BOT, installationAppId: 123456, configuredAppId: "123456" })).toBe(true);
  });

  it("refused when both ids are present and DO NOT match", () => {
    expect(trustedForSecrets({ ...TRUSTED_BOT, installationAppId: 999999, configuredAppId: "123456" })).toBe(false);
  });

  it("the cross-check is skipped (still trusted) when installationAppId alone is missing", () => {
    expect(trustedForSecrets({ ...TRUSTED_BOT, installationAppId: undefined, configuredAppId: "123456" })).toBe(true);
  });

  it("the cross-check is skipped (still trusted) when configuredAppId alone is missing", () => {
    expect(trustedForSecrets({ ...TRUSTED_BOT, installationAppId: 123456, configuredAppId: undefined })).toBe(true);
  });

  it("the cross-check is skipped (still trusted) when NEITHER id is available", () => {
    expect(trustedForSecrets({ ...TRUSTED_BOT, installationAppId: undefined, configuredAppId: undefined })).toBe(true);
  });
});

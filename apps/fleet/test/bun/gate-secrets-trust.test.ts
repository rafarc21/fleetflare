// #1346 security review r1: sameRepo alone let any same-repo pusher (or a
// same-repo PR against a self-created base branch) through. trustedForSecrets
// is the real gate: same-repo AND a trusted collaborator AND a human AND the
// PR's base is the repo's actual default branch -- OR (#1380) same-repo AND
// this fleet's own opted-in GitHub App AND the PR's base is the default branch.
import { describe, it, expect } from "bun:test";
import { trustedForSecrets, type SecretsTrustInput } from "../../src/gate/secrets-scope";

const TRUSTED: SecretsTrustInput = {
  sameRepo: true, authorAssociation: "COLLABORATOR", authorIsBot: false, authorLogin: "a-human",
  baseRef: "main", defaultBranch: "main", trustOwnApp: false,
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
  it("a bot account (dependabot[bot] etc) is never trusted when trustOwnApp is off, even as a COLLABORATOR", () => {
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
// trust filter denied ALL studio PRs. This opt-in (default off) lets THIS
// Worker's own App (its slug read fresh from `GET /app`, never operator
// input) through, under the exact same same-repo/default-base checks, never
// a looser filter.
//
// #1380 security review r1 MED: an earlier design took a free-form OPS slug
// list (`trustApps: string[]`) plus an "if available" App-id cross-check.
// That cross-check was dead code -- the only JWT-authenticated endpoint
// available could only ever confirm this Worker's own App id, never verify
// which App opened a given PR -- so a config mistake naming any other real
// bot's slug (e.g. "dependabot") would have granted it trust with nothing to
// catch it. Replaced with a boolean `trustOwnApp` plus `ownAppSlug` sourced
// ONLY from `GET /app`: there is no slug left for an OPS typo to mistype.
const TRUSTED_BOT: SecretsTrustInput = {
  sameRepo: true, authorAssociation: "NONE", authorIsBot: true, authorLogin: "fleetflare-bot[bot]",
  baseRef: "main", defaultBranch: "main", trustOwnApp: true, ownAppSlug: "fleetflare-bot",
};

describe("trustedForSecrets: app-bot opt-in trusted when configured (#1380)", () => {
  it("the fleet's own App, exact login match, is trusted when opted in", () => {
    expect(trustedForSecrets(TRUSTED_BOT)).toBe(true);
  });

  it("default off: the SAME bot is refused when trustOwnApp is false (the #1346 default, unchanged)", () => {
    expect(trustedForSecrets({ ...TRUSTED_BOT, trustOwnApp: false })).toBe(false);
  });

  it("refused when trustOwnApp is on but ownAppSlug could not be read (GET /app failed -- fails closed)", () => {
    expect(trustedForSecrets({ ...TRUSTED_BOT, ownAppSlug: undefined })).toBe(false);
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
  it("dependabot[bot] stays denied even when trustOwnApp opts THIS Worker's own App in", () => {
    expect(trustedForSecrets({ ...TRUSTED_BOT, authorLogin: "dependabot[bot]" })).toBe(false);
  });
});

// #1380 security review r1 LOW item 2: the author-type branch must actually
// be selected by `authorIsBot`, not an accidental OR -- a human-typed account
// whose login merely LOOKS like the bot's must never slip through the app-bot
// path. (Mutant "authorIsBot || <app-bot check>" survives without this test.)
describe("trustedForSecrets: a non-bot author is never evaluated on the app-bot path (#1380)", () => {
  it("authorIsBot: false with a bot-shaped login and association NONE is refused", () => {
    expect(trustedForSecrets({
      ...TRUSTED_BOT, authorIsBot: false, authorAssociation: "NONE",
    })).toBe(false);
  });
});

// #1380 lookalike logins: exact match only, never a prefix/substring check.
describe("trustedForSecrets: lookalike logins are denied (#1380)", () => {
  it("'<slug>-x[bot]' is denied", () => {
    expect(trustedForSecrets({ ...TRUSTED_BOT, authorLogin: "fleetflare-bot-x[bot]" })).toBe(false);
  });

  it("the bare slug with no [bot] suffix at all is denied", () => {
    expect(trustedForSecrets({ ...TRUSTED_BOT, authorLogin: "fleetflare-bot" })).toBe(false);
  });

  it("a different app's own [bot] login is denied", () => {
    expect(trustedForSecrets({ ...TRUSTED_BOT, authorLogin: "other-app[bot]" })).toBe(false);
  });

  it("a slug that is a prefix or suffix of the real one is denied", () => {
    expect(trustedForSecrets({ ...TRUSTED_BOT, authorLogin: "fleetflare[bot]" })).toBe(false);
    expect(trustedForSecrets({ ...TRUSTED_BOT, authorLogin: "flare-bot[bot]" })).toBe(false);
  });

  it("an empty-string ownAppSlug matches nothing", () => {
    expect(trustedForSecrets({ ...TRUSTED_BOT, ownAppSlug: "", authorLogin: "[bot]" })).toBe(false);
  });
});

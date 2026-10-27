// #715: a PR's private flag reaches the leg container as GATE_PRIVATE, and the
// git proxy's one repo is the PR's own owner/repo.
import { describe, it, expect } from "bun:test";
import { legRequest, legRequestContext } from "../../src/gate/leg-run";
import { buildLegEnvVars, evidenceKeyFor, gateOutboundProps } from "../../src/gate/leg-env";
import type { PlannedLeg } from "../../src/gate/fanout";
import { parseGateSecretsAllowlist } from "../../src/gate/secrets-config";

const PLANNED: PlannedLeg = {
  leg: "lint", commit: "b..h", installCmd: "bun install", legCmd: "bun run lint",
  resultKey: "gate/acme/example/runs/7/run-a/shard-lint.json", baselineKeys: [],
};

describe("legRequest", () => {
  it("carries the PR's private flag as true in the request body", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: true });
    expect(body.private).toBe(true);
  });

  it("a private PR's leg env gets GATE_PRIVATE=1", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: true });
    expect(buildLegEnvVars(body).GATE_PRIVATE).toBe("1");
  });

  it("a public PR's leg env gets GATE_PRIVATE=0", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: false });
    expect(buildLegEnvVars(body).GATE_PRIVATE).toBe("0");
  });

  it("the git proxy's one repo is the PR's own owner/repo, with the minted token", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: true });
    expect(gateOutboundProps(body, "tok")).toEqual({
      resultKey: PLANNED.resultKey, repo: "acme/example", gitToken: "tok",
    });
  });

  it("the planned leg's timeoutMin reaches the /run-leg body", () => {
    const body = legRequest("acme", "example", { ...PLANNED, timeoutMin: 9 }, { baseRef: "main", pr: "7", private: false });
    expect(body.timeoutMin).toBe(9);
  });

  it("the request keeps the planned leg's command and result key unchanged", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: false });
    expect(body).toMatchObject({
      owner: "acme", repo: "example", commit: "b..h", leg: "lint",
      installCmd: "bun install", legCmd: "bun run lint", resultKey: PLANNED.resultKey,
      baseRef: "main", pr: "7",
    });
  });
});

// #1398: the per-instance leg-mode pin. Default "sync-legacy" keeps every
// existing caller on the old path; only an explicit async-poll call carries
// mode + instanceId to the DO.
describe("legRequest: leg-mode pin (#1398)", () => {
  it("defaults to sync-legacy: no mode and no instanceId on the body", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: false });
    expect(Object.hasOwn(body, "mode")).toBe(false);
    expect(Object.hasOwn(body, "instanceId")).toBe(false);
  });

  it("an explicit async-poll call carries mode AND instanceId", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: false }, "async-poll", "run-a");
    expect(body.mode).toBe("async-poll");
    expect(body.instanceId).toBe("run-a");
  });

  it("an explicit sync-legacy call still carries nothing", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: false }, "sync-legacy", "run-a");
    expect(Object.hasOwn(body, "mode")).toBe(false);
    expect(Object.hasOwn(body, "instanceId")).toBe(false);
  });
});

// #1066: the run's image key rides the leg request, and is absent when unset.
describe("legRequest: image key", () => {
  it("carries the run's image key in the request body", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: false, image: "desktop" });
    expect(body.image).toBe("desktop");
  });
  it("no image key on the body when the run names none", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: false });
    expect(Object.hasOwn(body, "image")).toBe(false);
  });
});

// #1343: a browser leg carries its evidence dir (env + outbound props), a
// plain leg carries none — a plain leg's container never learns an evidence
// path to write.
describe("legRequest: browser flag + evidence key (#1343)", () => {
  const RESULT = "gate/acme/example/runs/7/run-a/shard-e2e.json";
  const BROWSER: PlannedLeg = { ...PLANNED, leg: "e2e", resultKey: RESULT, browser: true };

  it("the request body carries browser:true for a browser leg, absent for a plain leg", () => {
    const body = legRequest("acme", "example", BROWSER, { baseRef: "main", pr: "7", private: false });
    expect(body.browser).toBe(true);
    const plain = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: false });
    expect(Object.hasOwn(plain, "browser")).toBe(false);
  });

  it("a browser leg's env carries GATE_EVIDENCE_DIR; a plain leg's does not", () => {
    expect(buildLegEnvVars(legRequest("acme", "example", BROWSER, { baseRef: "main", pr: "7", private: false })).GATE_EVIDENCE_DIR)
      .toBe("gate/acme/example/runs/7/run-a/evidence/shard-e2e/");
    expect(Object.hasOwn(buildLegEnvVars(legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: false })), "GATE_EVIDENCE_DIR")).toBe(false);
  });

  it("the browser leg's outbound props carry its evidence dir; a plain leg's carry none", () => {
    expect(gateOutboundProps(legRequest("acme", "example", BROWSER, { baseRef: "main", pr: "7", private: false })).evidenceKey)
      .toBe("gate/acme/example/runs/7/run-a/evidence/shard-e2e/");
    expect(Object.hasOwn(gateOutboundProps(legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: false })), "evidenceKey")).toBe(false);
  });

  it("evidenceKeyFor derives the sibling evidence dir from a result key, keyed run+leg+attempt", () => {
    expect(evidenceKeyFor(RESULT)).toBe("gate/acme/example/runs/7/run-a/evidence/shard-e2e/");
    // The ATTEMPT variant is part of the dir: an earlier attempt's files never
    // green a later zero-spec retry, and a retry's re-upload never 412s (MED4).
    expect(evidenceKeyFor("gate/acme/example/runs/7/run-a/shard-e2e.retry.json")).toBe("gate/acme/example/runs/7/run-a/evidence/shard-e2e.retry/");
    expect(evidenceKeyFor("gate/acme/example/runs/7/run-a/shard-e2e-try2.json")).toBe("gate/acme/example/runs/7/run-a/evidence/shard-e2e-try2/");
    expect(evidenceKeyFor("not-a-result-key")).toBeNull();
  });
});

// #1346: legRequest is the ONLY place a secret grant is decided -- every
// guard lives in grantedSecretNames (secrets-scope.ts), exercised here end to
// end from a parsed OPS allowlist through to the request body.
describe("legRequest: gate-scoped secrets (#1346)", () => {
  const ALLOWLIST = parseGateSecretsAllowlist({ "acme/example": { lint: ["staging-login"] } });

  it("a same-repo PR for an allowlisted leg gets its granted secret names", () => {
    const body = legRequest("acme", "example", PLANNED, {
      baseRef: "main", pr: "7", private: false, trusted: true, secretsAllowlist: ALLOWLIST,
    });
    expect(body.secretNames).toEqual(["staging-login"]);
  });

  it("an untrusted PR (trusted: false) gets no secretNames at all, even for an allowlisted leg", () => {
    const body = legRequest("acme", "example", PLANNED, {
      baseRef: "main", pr: "7", private: false, trusted: false, secretsAllowlist: ALLOWLIST,
    });
    expect(Object.hasOwn(body, "secretNames")).toBe(false);
  });

  it("omitting trusted entirely fails closed, same as trusted: false", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: false, secretsAllowlist: ALLOWLIST });
    expect(Object.hasOwn(body, "secretNames")).toBe(false);
  });

  it("a leg absent from the allowlist gets no secretNames key", () => {
    const other: PlannedLeg = { ...PLANNED, leg: "not-lint" };
    const body = legRequest("acme", "example", other, { baseRef: "main", pr: "7", private: false, trusted: true, secretsAllowlist: ALLOWLIST });
    expect(Object.hasOwn(body, "secretNames")).toBe(false);
  });

  it("no secretsAllowlist at all (OPS repo unset) gets no secretNames key", () => {
    const body = legRequest("acme", "example", PLANNED, { baseRef: "main", pr: "7", private: false, trusted: true });
    expect(Object.hasOwn(body, "secretNames")).toBe(false);
  });
});

// #1346 correctness review r1 item 1: workflow.ts (which computes `trusted`
// and fetches the OPS allowlist) imports cloudflare:workers, so bun test can
// never exercise its own glue directly -- legRequestContext is what moved
// that computation into a file this CAN test, closing the "dropping the
// sameRepo/trusted pass-through survives every test" gap.
describe("legRequestContext (#1346)", () => {
  const ALLOWLIST = parseGateSecretsAllowlist({ "acme/example": { lint: ["staging-login"] } });
  const TRUSTED_INPUT = {
    baseRef: "main", sameRepo: true, authorAssociation: "COLLABORATOR", authorIsBot: false, authorLogin: "a-human",
    defaultBranch: "main", trustOwnApp: false,
  };

  it("computes trusted: true for a same-repo collaborator PR on the default branch, and carries it to legRequest", () => {
    const ctx = legRequestContext(TRUSTED_INPUT, false, ALLOWLIST, { pr: "7" });
    expect(ctx.trusted).toBe(true);
    const body = legRequest("acme", "example", PLANNED, ctx);
    expect(body.secretNames).toEqual(["staging-login"]);
  });

  it("computes trusted: false for a fork PR, and that reaches legRequest's secretNames decision too", () => {
    const ctx = legRequestContext({ ...TRUSTED_INPUT, sameRepo: false }, false, ALLOWLIST, { pr: "7" });
    expect(ctx.trusted).toBe(false);
    const body = legRequest("acme", "example", PLANNED, ctx);
    expect(Object.hasOwn(body, "secretNames")).toBe(false);
  });

  it("computes trusted: false for a PR against a non-default base, even same-repo and a collaborator", () => {
    const ctx = legRequestContext({ ...TRUSTED_INPUT, baseRef: "feature-base", defaultBranch: "main" }, false, ALLOWLIST, { pr: "7" });
    expect(ctx.trusted).toBe(false);
  });

  it("carries private, bundleKey and mergeBase through untouched", () => {
    const ctx = legRequestContext(TRUSTED_INPUT, true, ALLOWLIST, { pr: "7", bundleKey: "k", mergeBase: "m" });
    expect(ctx).toMatchObject({ private: true, bundleKey: "k", mergeBase: "m", baseRef: "main", pr: "7" });
  });

  it("omits bundleKey/mergeBase from the context when the caller names none", () => {
    const ctx = legRequestContext(TRUSTED_INPUT, false, ALLOWLIST, { pr: "7" });
    expect(Object.hasOwn(ctx, "bundleKey")).toBe(false);
    expect(Object.hasOwn(ctx, "mergeBase")).toBe(false);
  });

  // #1380: a studio PR (opened by the fleet's own GitHub App) reaches the
  // same secretNames decision as a human collaborator's PR, once opted in.
  it("computes trusted: true for the fleet's own opted-in App, and carries it to legRequest's secretNames", () => {
    const ctx = legRequestContext(
      {
        baseRef: "main", sameRepo: true, authorAssociation: "NONE", authorIsBot: true, authorLogin: "fleetflare-bot[bot]",
        defaultBranch: "main", trustOwnApp: true, ownAppSlug: "fleetflare-bot",
      },
      false, ALLOWLIST, { pr: "7" },
    );
    expect(ctx.trusted).toBe(true);
    const body = legRequest("acme", "example", PLANNED, ctx);
    expect(body.secretNames).toEqual(["staging-login"]);
  });

  it("computes trusted: false for the SAME App login when trustOwnApp is off (default)", () => {
    const ctx = legRequestContext(
      {
        baseRef: "main", sameRepo: true, authorAssociation: "NONE", authorIsBot: true, authorLogin: "fleetflare-bot[bot]",
        defaultBranch: "main", trustOwnApp: false,
      },
      false, ALLOWLIST, { pr: "7" },
    );
    expect(ctx.trusted).toBe(false);
  });
});

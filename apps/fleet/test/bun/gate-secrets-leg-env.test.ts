// #1346: leg-env.ts's own slice of gate-scoped secrets -- the env var naming
// convention, and that both buildLegEnvVars and gateOutboundProps only ever
// see VALUES as a separate parameter, never read off the request body (the
// body only ever carries names, req.secretNames).
import { describe, it, expect } from "bun:test";
import {
  buildLegEnvVars, buildSecretEnvVars, evidenceKeyFor, gateOutboundProps, secretEnvVarName, type GateLegRequest,
} from "../../src/gate/leg-env";

const BASE: GateLegRequest = {
  owner: "acme", repo: "example", commit: "abc", leg: "browser-e2e",
  installCmd: "bun install", legCmd: "bun run e2e",
  resultKey: "gate/acme/example/runs/7/run-a/shard-browser-e2e.json", baselineKeys: [],
  baseRef: "main", pr: "7", secretNames: ["staging-login"],
};

describe("secretEnvVarName", () => {
  it("maps a hyphenated name to a GATE_SECRET_ prefixed, upper-snake var", () => {
    expect(secretEnvVarName("staging-login")).toBe("GATE_SECRET_STAGING_LOGIN");
    expect(secretEnvVarName("workers-ai")).toBe("GATE_SECRET_WORKERS_AI");
  });
});

describe("buildSecretEnvVars", () => {
  it("builds one env var per resolved value", () => {
    expect(buildSecretEnvVars({ "staging-login": "sup3r-s3cret" })).toEqual({
      GATE_SECRET_STAGING_LOGIN: "sup3r-s3cret",
    });
  });

  it("skips a name with an empty resolved value, never an empty-string env var", () => {
    expect(buildSecretEnvVars({ "staging-login": "" })).toEqual({});
  });

  it("undefined secretValues builds nothing", () => {
    expect(buildSecretEnvVars(undefined)).toEqual({});
  });
});

describe("buildLegEnvVars: secret values are a separate parameter, not read off req", () => {
  it("a req with secretNames but no secretValues param gets no secret env vars", () => {
    expect(buildLegEnvVars(BASE).GATE_SECRET_STAGING_LOGIN).toBeUndefined();
  });

  it("passing the resolved values in adds the container env var", () => {
    const env = buildLegEnvVars(BASE, { "staging-login": "sup3r-s3cret" });
    expect(env.GATE_SECRET_STAGING_LOGIN).toBe("sup3r-s3cret");
    expect(env.GATE_LEG).toBe("browser-e2e");
  });
});

describe("gateOutboundProps: secretValues carries VALUES only, never names", () => {
  it("a public leg with granted secrets gets secretValues in props, no gitToken", () => {
    const props = gateOutboundProps(BASE, undefined, { "staging-login": "sup3r-s3cret" });
    expect(props).toEqual({ resultKey: BASE.resultKey, secretValues: ["sup3r-s3cret"] });
  });

  it("a leg with no secretValues gets no secretValues key at all", () => {
    const props = gateOutboundProps(BASE, undefined, undefined);
    expect(Object.hasOwn(props, "secretValues")).toBe(false);
  });

  it("an empty-value entry is filtered out of props.secretValues", () => {
    const props = gateOutboundProps(BASE, undefined, { "staging-login": "" });
    expect(Object.hasOwn(props, "secretValues")).toBe(false);
  });

  it("a private leg's git token and its granted secrets both ride the same props", () => {
    const props = gateOutboundProps({ ...BASE, private: true }, "tok", { "staging-login": "sup3r-s3cret" });
    expect(props).toEqual({
      resultKey: BASE.resultKey, repo: "acme/example", gitToken: "tok", secretValues: ["sup3r-s3cret"],
    });
  });
});

describe("evidenceKeyFor: the retry step's own internal try key (#1398)", () => {
  it("resolves a retry step's own 2nd/3rd internal try", () => {
    expect(evidenceKeyFor("gate/acme/widgets/runs/3/run-id/shard-browser.retry-try2.json"))
      .toBe("gate/acme/widgets/runs/3/run-id/evidence/shard-browser.retry-try2/");
  });
});

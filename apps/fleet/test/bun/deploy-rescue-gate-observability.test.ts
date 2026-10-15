import { describe, expect } from "bun:test";
import { builtDigests, deploy, deployed, deployedImage, expectHard, setCreds, test, useDeployRescueHarness, withImage, writeConfig } from "./helpers/deploy-rescue-harness";

useDeployRescueHarness(() => {});

describe("deploy.sh: rescue-all failure only warns when no container changes (#40)", () => {
  // PR #60 review F1: wrangler 4.141 derives each container application's
  // logs setting from the Worker's TOP-LEVEL `observability`
  // (isRootObservabilityLogsEnabled) and, for an app still on the legacy
  // configuration.observability, writes it there -- inside `configuration`,
  // so the rollout diff sees it and containers are replaced.
  describe("top-level observability (F1)", () => {
    test("logs on in config and on the deployed app (legacy configuration.observability) -> unchanged, proceeds", () => {
      deployed({}, { observability: { logs: { enabled: true } } });
      builtDigests([deployedImage]);
      writeConfig({ ...withImage("fleet-test"), observability: { enabled: true } });
      const r = deploy([], 1);
      expect(r.code, r.err).toBe(0);
    });

    test("SAFETY: observability flipped off, same image, deployed legacy logs on -> refused", () => {
      deployed({}, { observability: { logs: { enabled: true } } });
      builtDigests([deployedImage]);
      writeConfig({ ...withImage("fleet-test"), observability: { enabled: false } });
      expectHard(deploy([], 1), "observability");
    });

    test("SAFETY: observability.logs.enabled false overrides enabled true (wrangler's rule) -> refused vs deployed logs on", () => {
      deployed({}, { observability: { logs: { enabled: true } } });
      builtDigests([deployedImage]);
      writeConfig({ ...withImage("fleet-test"), observability: { enabled: true, logs: { enabled: false } } });
      expectHard(deploy([], 1), "observability");
    });

    test("SAFETY: observability turned on, deployed app has none -> refused", () => {
      deployed();
      builtDigests([deployedImage]);
      writeConfig({ ...withImage("fleet-test"), observability: { enabled: true } });
      expectHard(deploy([], 1), "observability");
    });

    test("deployed app on top-level observability, logs on both sides -> unchanged, proceeds", () => {
      deployed({ observability: { logs: { enabled: true } } });
      builtDigests([deployedImage]);
      writeConfig({ ...withImage("fleet-test"), observability: { logs: { enabled: true } } });
      const r = deploy([], 1);
      expect(r.code, r.err).toBe(0);
    });

    test("deployed app with BOTH top-level and legacy logs on (wrangler migrates it) -> refused", () => {
      deployed({ observability: { logs: { enabled: true } } }, { observability: { logs: { enabled: true } } });
      builtDigests([deployedImage]);
      writeConfig({ ...withImage("fleet-test"), observability: { enabled: true } });
      expectHard(deploy([], 1), "observability");
    });

    test("top-level `unsafe` set -> cannot tell, refused", () => {
      deployed();
      builtDigests([deployedImage]);
      writeConfig({ ...withImage("fleet-test"), unsafe: { metadata: { x: 1 } } });
      expectHard(deploy([], 1), "unsafe");
    });
  });

  // PR #60 review F4: deploy.sh's own is_plain_deploy layer, independent of
  // the probe's argument check: a non-plain command never reaches the probe.
  describe("is_plain_deploy (F4)", () => {
    for (const args of [[], ["deploy"], ["deploy", "-e", "staging"], ["deploy", "--env=staging"], ["--profile", "ops", "deploy"]]) {
      test(`"${args.join(" ")}" is plain: the probe runs`, () => {
        const base = withImage("fleet-test");
        writeConfig({ ...base, env: { staging: { durable_objects: base.durable_objects, containers: base.containers } } });
        if (args.some((a) => a.includes("staging"))) setCreds("https://fleet-test-staging.example.workers.dev");
        const r = deploy(args, 1);
        expect(r.probe.some((l) => l.startsWith("probe containers list"))).toBe(true);
      });
    }
    for (const args of [
      ["versions", "deploy"], ["rollback"], ["delete", "fleet-test"],
      ["deploy", "--containers-rollout", "immediate"], ["deploy", "--name", "fleet-test"],
      ["deploy", "--var", "X:1"], ["deploy", "--minify"], ["deploy", "extra-word"],
    ]) {
      test(`"${args.join(" ")}" is NOT plain: refused, the probe never runs`, () => {
        deployed();
        builtDigests([deployedImage]);
        const r = deploy(args, 1);
        expect(r.code).toBe(1);
        expect(r.wrangler).toEqual([]);
        expect(r.docker).toEqual([]);
        expect(r.probe.filter((l) => l.includes("containers"))).toEqual([]);
        // deploy.sh itself never started the probe script.
        expect(r.err).not.toContain("deploy-containers:");
      });
    }
  });
});

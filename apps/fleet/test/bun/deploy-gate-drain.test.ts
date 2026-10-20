import { describe, expect } from "bun:test";
import { deploy, stub, test, useDeployRescueHarness, withImage, writeConfig } from "./helpers/deploy-rescue-harness";

useDeployRescueHarness(() => {});

/** A config that declares the gate Workflow, so deploy.sh's drain path runs.
 *  The plain withImage config has no GATE_WORKFLOW binding, so every existing
 *  deploy test stays on the no-drain path. */
function gateConfig() {
  return {
    ...withImage("fleet-test"),
    workflows: [{ name: "gate", binding: "GATE_WORKFLOW", class_name: "GateWorkflow" }],
  };
}

describe("deploy.sh: drain running gate runs before a Worker deploy (#1232)", () => {
  test("plain deploy with the gate workflow: set flag -> poll list -> deploy -> clear flag", () => {
    writeConfig(gateConfig());
    const r = deploy([], 0); // rescue exits 0; gate-instances.json absent -> [] (drained)
    expect(r.code, r.err).toBe(0);
    const setAt = r.wrangler.findIndex((l) => l.includes("'gate_drain','1'"));
    const clearAt = r.wrangler.findIndex((l) => l.includes("'gate_drain','0'"));
    const deployAt = r.wrangler.findIndex((l) => l === "wrangler deploy -c wrangler.local.jsonc");
    expect(setAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(deployAt).toBeGreaterThanOrEqual(0);
    // order: set flag -> poll -> deploy -> clear flag
    expect(setAt).toBeLessThan(deployAt);
    expect(deployAt).toBeLessThan(clearAt);
    // the drain wait polled the list before the deploy
    expect(r.wrangler.slice(setAt, deployAt).some((l) => l.startsWith("wrangler workflows instances list gate"))).toBe(true);
  });

  test("a running gate instance never drains: refuses after the cap, flag is CLEARED, no deploy", () => {
    writeConfig(gateConfig());
    stub("gate-instances.json", [{ id: "gate-x", status: "running" }]);
    const r = deploy([], 0, { GATE_DRAIN_CAP_MS: "150", GATE_DRAIN_POLL_MS: "10" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("gate runs still running after the drain cap");
    expect(r.wrangler.some((l) => l === "wrangler deploy -c wrangler.local.jsonc")).toBe(false);
    // the trap cleared the flag on the way out
    expect(r.wrangler.some((l) => l.includes("'gate_drain','0'"))).toBe(true);
    expect(r.wrangler.some((l) => l.includes("'gate_drain','1'"))).toBe(true);
  });

  test("a failed deploy clears the flag on the way out (every exit path clears)", () => {
    writeConfig(gateConfig());
    const r = deploy([], 0, { STUB_DEPLOY_EXIT: "1" });
    expect(r.code).toBe(1);
    // set, then deploy failed, then the EXIT trap cleared it
    expect(r.wrangler.some((l) => l.includes("'gate_drain','1'"))).toBe(true);
    expect(r.wrangler.some((l) => l.includes("'gate_drain','0'"))).toBe(true);
    // the clear lands AFTER the (failed) deploy
    const deployAt = r.wrangler.findIndex((l) => l === "wrangler deploy -c wrangler.local.jsonc");
    const clearAt = r.wrangler.findIndex((l) => l.includes("'gate_drain','0'"));
    expect(deployAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeGreaterThan(deployAt);
  });

  test("--skip-gate-drain: deploy proceeds with no d1 execute and no poll", () => {
    writeConfig(gateConfig());
    stub("gate-instances.json", [{ id: "gate-x", status: "running" }]);
    const r = deploy(["--skip-gate-drain"], 0);
    expect(r.code, r.err).toBe(0);
    expect(r.wrangler).toEqual(["wrangler deploy -c wrangler.local.jsonc"]);
  });

  test("d1 migrations never drain, even with the gate workflow in the config", () => {
    writeConfig(gateConfig());
    const r = deploy(["d1", "migrations", "apply", "fleet", "--remote"], 0);
    expect(r.code, r.err).toBe(0);
    expect(r.wrangler).toEqual(["wrangler d1 migrations apply fleet --remote -c wrangler.local.jsonc"]);
  });
});
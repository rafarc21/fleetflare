import { describe, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deploy, harnessState, stub, test, useDeployRescueHarness, withImage, writeConfig } from "./helpers/deploy-rescue-harness";

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

  test("re-stamps the drain flag before the deploy (fresh TTL covers the deploy)", () => {
    writeConfig(gateConfig());
    const r = deploy([], 0);
    expect(r.code, r.err).toBe(0);
    const sets = r.wrangler.map((l, i) => ({ l, i })).filter((x) => x.l.includes("'gate_drain','1'"));
    expect(sets.length).toBe(2); // initial set + re-stamp before deploy
    const deployAt = r.wrangler.findIndex((l) => l === "wrangler deploy -c wrangler.local.jsonc");
    expect(sets[1].i).toBeGreaterThan(sets[0].i);
    expect(sets[1].i).toBeLessThan(deployAt);
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

  test("the refusal names the run id still blocking the drain (#1275)", () => {
    writeConfig(gateConfig());
    stub("gate-instances.json", [{ id: "gate-x", status: "running" }]);
    const r = deploy([], 0, { GATE_DRAIN_CAP_MS: "150", GATE_DRAIN_POLL_MS: "10" });
    expect(r.code).toBe(1);
    // gate-drain-wait.ts's own refusal line names the blocking run, so the
    // operator sees WHAT blocks, not just "still running".
    expect(r.err).toContain("gate-drain-wait: gate instances still running after the drain cap: gate-x");
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

  test("a failing clear keeps the deploy's exit code (rc not masked by the trap)", () => {
    writeConfig(gateConfig());
    const r = deploy([], 0, { STUB_DEPLOY_EXIT: "3", STUB_CLEAR_FAIL: "1" });
    expect(r.code).toBe(3);
    expect(r.err).toContain("could not clear the gate drain flag");
  });

  test("a failed set-flag write still clears on the way out (#1241 d)", () => {
    writeConfig(gateConfig());
    const r = deploy([], 0, { STUB_SET_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("could not set the gate drain flag");
    expect(r.wrangler.some((l) => l.includes("'gate_drain','0'"))).toBe(true);
  });

  test("SIGINT during the drain clears the flag and exits 130", async () => {
    writeConfig(gateConfig());
    stub("gate-instances.json", [{ id: "gate-x", status: "running" }]);
    const proc = Bun.spawn({
      cmd: ["bash", join(harnessState.fleet, "scripts", "deploy.sh")],
      cwd: harnessState.fleet,
      env: {
        ...process.env, HOME: harnessState.home, FLEET_CONFIG: harnessState.config,
        STUB_RESCUE_EXIT: "0", CLOUDFLARE_API_BASE_URL: harnessState.apiBase,
        WRANGLER_DOCKER_BIN: join(harnessState.root, "docker"),
        GATE_DRAIN_CAP_MS: "60000", GATE_DRAIN_POLL_MS: "500",
      },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
      detached: true,
    });
    // Let it set the flag and start polling the (running) instance list: wait
    // until the drain wait has actually issued its first wrangler instance-list
    // (cold spawn + config checks cost ~3s), so the SIGINT lands while the
    // foreground child is still polling, not before the drain began.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (existsSync(harnessState.calls) && readFileSync(harnessState.calls, "utf8").includes("workflows instances list")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    process.kill(-proc.pid, "SIGINT");
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    expect(code).toBe(130);
    // The INT trap fires mid-drain (the wait is still polling when the signal
    // lands), so the refusal line never prints — the drain-wait polling line is
    // the proof the drain was in progress.
    expect(err).toContain("still running — waiting");
    // The INT trap cleared the flag on the way out.
    expect(readFileSync(harnessState.calls, "utf8")).toContain("'gate_drain','0'");
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
import { describe, expect } from "bun:test";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { builtDigests, deploy, deployed, deployedImage, DIGEST_B, expectHard, REPO, test, useDeployRescueHarness, withImage, writeConfig } from "./helpers/deploy-rescue-harness";

let fleet: string;
let stubs: string;
useDeployRescueHarness((s) => {
  fleet = s.fleet;
  stubs = s.stubs;
});

/**
 * Issue #40 item 1: a Worker-only deploy (same studio image, same container
 * settings) replaces no container, so a failing rescue-all must not block
 * it: rescue-all still runs, its failure is a WARNING, the deploy proceeds.
 * The signal is wrangler 4.141's own: it builds each Dockerfile image, and
 * when the built image's RepoDigests already hold the registry digest the
 * container application runs, it pushes nothing and its apply diff is empty
 * -- no rollout. Anything the probe cannot prove unchanged counts as
 * changed: the gate stays hard.
 */
describe("deploy.sh: rescue-all failure only warns when no container changes (#40)", () => {

  test("same image digest, same settings: rescue-all fails -> WARNING, Worker-only deploy proceeds", () => {
    deployed();
    builtDigests(["other.example/x@" + DIGEST_B, deployedImage]);
    const r = deploy([], 1);
    expect(r.code, r.err).toBe(0);
    expect(r.log).toEqual(["fleet rescue-all", "wrangler deploy -c wrangler.local.jsonc"]);
    expect(r.err).toContain("WARNING");
    expect(r.err).toContain("no container changes");
    expect(r.err).toContain("fleet-test-studiodo");
  });

  test("the probe builds exactly as wrangler does: linux/amd64, no provenance, Dockerfile on stdin, app-dir context", () => {
    deployed();
    builtDigests([deployedImage]);
    writeConfig(withImage("fleet-test", { image_vars: { NODE_V: "22" } }));
    const r = deploy(["deploy"], 1);
    expect(r.code, r.err).toBe(0);
    const build = r.docker.find((l) => l.startsWith("docker build "));
    expect(build).toBeDefined();
    expect(build).toContain("--load");
    expect(build).toContain("--platform linux/amd64 --provenance=false");
    expect(build).toContain("--build-arg NODE_V=22");
    expect(build).toContain(`-f - ${join(realpathSync(fleet), "container")}`);
    expect(r.docker.some((l) => l.startsWith("docker image rm "))).toBe(true);
  });

  test("rescue-all passes: the image probe never runs (no docker, no containers calls)", () => {
    deployed();
    builtDigests([deployedImage]);
    const r = deploy([], 0);
    expect(r.code, r.err).toBe(0);
    expect(r.docker).toEqual([]);
    expect(r.probe.filter((l) => l.includes("containers"))).toEqual([]);
  });

  test("SAFETY: image digest changed + rescue-all fails -> still refused", () => {
    deployed();
    builtDigests([`${REPO}@${DIGEST_B}`]);
    expectHard(deploy([], 1), "image changed");
  });

  test("built image never pushed from this machine (no RepoDigests) -> treated as changed, refused", () => {
    deployed();
    builtDigests([]);
    expectHard(deploy([], 1), "image changed");
  });

  test("no deployed container application (first deploy) -> refused", () => {
    builtDigests([deployedImage]);
    expectHard(deploy([], 1), "fleet-test-studiodo");
  });

  test("docker build fails -> undeterminable, refused", () => {
    deployed();
    builtDigests([deployedImage]);
    expectHard(deploy([], 1, { STUB_DOCKER_BUILD_EXIT: "1" }), "cannot tell");
  });

  test("containers list fails (no auth, offline) -> undeterminable, refused", () => {
    builtDigests([deployedImage]);
    rmSync(join(stubs, "containers-list.json"));
    expectHard(deploy([], 1), "cannot tell");
  });

  test("containers info fails -> undeterminable, refused", () => {
    deployed();
    rmSync(join(stubs, "info-app-1.json"));
    builtDigests([deployedImage]);
    expectHard(deploy([], 1), "cannot tell");
  });

  test("same image, max_instances changed -> a rollout, refused", () => {
    deployed({ max_instances: 5 });
    builtDigests([deployedImage]);
    expectHard(deploy([], 1), "max_instances");
  });

  test("same image, instance_type changed (config standard-4, deployed lite) -> refused", () => {
    deployed();
    builtDigests([deployedImage]);
    writeConfig(withImage("fleet-test", { instance_type: "standard-4" }));
    expectHard(deploy([], 1), "instance");
  });

  test("same image, instance_type standard-4 both sides -> Worker-only, proceeds", () => {
    deployed({}, { vcpu: 4, memory_mib: 12288, disk: { size_mb: 20000 } });
    builtDigests([deployedImage]);
    writeConfig(withImage("fleet-test", { instance_type: "standard-4" }));
    const r = deploy([], 1);
    expect(r.code, r.err).toBe(0);
  });

  test("custom instance_type object matching the deployed limits -> proceeds", () => {
    deployed({}, { vcpu: 4, memory_mib: 12288, disk: { size_mb: 20000 } });
    builtDigests([deployedImage]);
    writeConfig(withImage("fleet-test", { instance_type: { vcpu: 4, memory_mib: 12288, disk_mb: 20000 } }));
    const r = deploy([], 1);
    expect(r.code, r.err).toBe(0);
  });

  test("rollout_step_percentage (rollout pacing, not part of wrangler's application diff) -> still Worker-only, proceeds", () => {
    deployed();
    builtDigests([deployedImage]);
    writeConfig(withImage("fleet-test", { rollout_step_percentage: 100 }));
    const r = deploy([], 1);
    expect(r.code, r.err).toBe(0);
  });

  test("an unmodelled key on ANY container is refused BEFORE any image build", () => {
    deployed();
    builtDigests([deployedImage]);
    writeConfig({
      ...withImage("fleet-test"),
      durable_objects: { bindings: [{ name: "STUDIO", class_name: "StudioDO" }, { name: "AGENT", class_name: "AgentDO" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["StudioDO", "AgentDO"] }],
      containers: [
        { class_name: "StudioDO", image: "./container/Dockerfile", max_instances: 1 },
        { class_name: "AgentDO", image: "./container/Dockerfile", max_instances: 1, constraints: { tiers: [1, 2] } },
      ],
    });
    const r = deploy([], 1);
    expect(r.code).toBe(1);
    expect(r.docker).toEqual([]);
  });

  test("a container setting the probe does not model (constraints) -> undeterminable, refused", () => {
    deployed();
    builtDigests([deployedImage]);
    writeConfig(withImage("fleet-test", { constraints: { tiers: [1, 2] } }));
    expectHard(deploy([], 1), "constraints");
  });

});

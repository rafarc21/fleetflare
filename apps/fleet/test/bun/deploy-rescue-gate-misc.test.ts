import { describe, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { builtDigests, deploy, deployed, deployedImage, DIGEST_A, expectHard, REPO, setCreds, stub, test, useDeployRescueHarness, withImage, writeConfig } from "./helpers/deploy-rescue-harness";

let home: string;
let root: string;
useDeployRescueHarness((s) => {
  home = s.home;
  root = s.root;
});

describe("deploy.sh: rescue-all failure only warns when no container changes (#40)", () => {
  // PR #60 review F2: a DO migration deleting, renaming or transferring a
  // container's class changes the container application's Durable Object.
  describe("DO migrations naming a container class (F2)", () => {
    for (const m of [
      { tag: "v2", deleted_classes: ["StudioDO"] },
      { tag: "v2", renamed_classes: [{ from: "StudioDO", to: "StudioDO2" }] },
      { tag: "v2", transferred_classes: [{ from: "StudioDO", from_script: "other", to: "StudioDO" }] },
    ]) {
      test(`${Object.keys(m)[1]} names StudioDO -> cannot tell, refused`, () => {
        deployed();
        builtDigests([deployedImage]);
        const base = withImage("fleet-test");
        writeConfig({ ...base, migrations: [...base.migrations, m] });
        expectHard(deploy([], 1), "migration");
      });
    }

    test("new_sqlite_classes only (the real config's shape) -> not a reason to refuse", () => {
      deployed();
      builtDigests([deployedImage]);
      const r = deploy([], 1);
      expect(r.code, r.err).toBe(0);
    });
  });

  test("config with no containers at all -> undeterminable, refused", () => {
    writeConfig({ name: "fleet-test" });
    expectHard(deploy([], 1), "no containers");
  });

  test("two containers, one unchanged and one changed -> refused", () => {
    deployed();
    builtDigests([deployedImage]);
    writeConfig({
      ...withImage("fleet-test"),
      durable_objects: { bindings: [{ name: "STUDIO", class_name: "StudioDO" }, { name: "AGENT", class_name: "AgentDO" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["StudioDO", "AgentDO"] }],
      containers: [
        { class_name: "StudioDO", image: "./container/Dockerfile", max_instances: 1 },
        { class_name: "AgentDO", image: "./container/Dockerfile", max_instances: 1 },
      ],
    });
    expectHard(deploy([], 1), "fleet-test-agentdo");
  });

  for (const args of [["versions", "deploy"], ["rollback"], ["deploy", "--containers-rollout", "immediate"]]) {
    test(`"${args.join(" ")}" is not a plain deploy: same image, rescue fails -> refused`, () => {
      deployed();
      builtDigests([deployedImage]);
      const r = deploy(args, 1);
      expect(r.code).toBe(1);
      expect(r.wrangler).toEqual([]);
    });
  }

  test("--env selects the env container app, named by wrangler own reader (fleet-test-studiodo-staging)", () => {
    const base = withImage("fleet-test");
    // durable_objects and containers are not inherited by an env.
    writeConfig({ ...base, env: { staging: { durable_objects: base.durable_objects, containers: base.containers } } });
    setCreds("https://fleet-test-staging.example.workers.dev");
    const img = "registry.cloudflare.com/acct-a/fleet-test-studiodo-staging@" + DIGEST_A;
    stub("containers-list.json", [{ id: "app-2", name: "fleet-test-studiodo-staging", image: img }]);
    stub("info-app-2.json", {
      id: "app-2", name: "fleet-test-studiodo-staging", max_instances: 1, scheduling_policy: "default",
      configuration: { image: img, vcpu: 0.0625, memory_mib: 256, disk: { size_mb: 2000 } },
      constraints: { tiers: [1, 2] }, rollout_active_grace_period: 0,
    });
    builtDigests([img]);
    const r = deploy(["deploy", "-e", "staging"], 1);
    expect(r.code, r.err).toBe(0);
    expect(r.wrangler).toEqual(["wrangler deploy -e staging -c wrangler.local.jsonc"]);
  });
});

/**
 * Issue #40 item 2: --allow-unrescued (and the Worker-only soft pass) used
 * to leave only a stderr line. Each now appends one JSON line to
 * ~/.fleet/deploy-overrides.jsonl -- the same small local ~/.fleet/ record
 * convention as orca-workspaces.json and locks/. No email in it.
 */
describe("deploy.sh records every rescue-gate override durably (#40)", () => {
  const logPath = () => join(home, ".fleet", "deploy-overrides.jsonl");
  const records = () => readFileSync(logPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const gitUser = (name: string | null) => {
    const f = join(root, "gitconfig");
    writeFileSync(f, name === null ? "" : `[user]\n\tname = ${name}\n\temail = op@example.com\n`);
    return { GIT_CONFIG_GLOBAL: f, GIT_CONFIG_NOSYSTEM: "1", USER: "op-user" };
  };

  test("--allow-unrescued with rescue-all failing: one record with time, command, Worker, verdicts, operator", () => {
    const r = deploy(["deploy", "--allow-unrescued"], 1, gitUser("Op Tester"));
    expect(r.code, r.err).toBe(0);
    const [rec, ...rest] = records();
    expect(rest).toEqual([]);
    expect(Date.now() - Date.parse(rec.ts)).toBeLessThan(120_000);
    expect(rec.override).toBe("--allow-unrescued");
    expect(rec.command).toBe("deploy");
    expect(rec.target_worker).toBe("fleet-test");
    expect(rec.target_check).toBe("matched");
    expect(rec.rescue_all).toBe("exit 1");
    expect(rec.operator).toBe("Op Tester");
    expect(readFileSync(logPath(), "utf8")).not.toContain("@");
    expect(r.err).toContain(logPath());
  });

  test("no git user.name: operator falls back to $USER", () => {
    deploy(["--allow-unrescued"], 1, gitUser(null));
    expect(records()[0].operator).toBe("op-user");
  });

  test("target mismatch overridden: the record says so and names the target Worker", () => {
    setCreds("https://fleet-other.example.workers.dev");
    deploy(["--allow-unrescued"], 0, gitUser("Op Tester"));
    const rec = records()[0];
    expect(rec.target_check).toBe("mismatch (exit 1)");
    expect(rec.target_worker).toBe("fleet-test");
    expect(rec.rescue_all).toBe("passed");
  });

  test("records append: two overrides -> two lines", () => {
    deploy(["--allow-unrescued"], 1, gitUser("Op Tester"));
    deploy(["--allow-unrescued"], 1, gitUser("Op Tester"));
    expect(records()).toHaveLength(2);
  });

  test("Worker-only soft pass is recorded too", () => {
    stub("containers-list.json", [{ id: "app-1", name: "fleet-test-studiodo", image: `${REPO}@${DIGEST_A}` }]);
    stub("info-app-1.json", {
      id: "app-1", name: "fleet-test-studiodo", max_instances: 1, scheduling_policy: "default",
      configuration: { image: `${REPO}@${DIGEST_A}`, vcpu: 0.0625, memory_mib: 256, disk: { size_mb: 2000 } },
      constraints: { tiers: [1, 2] }, rollout_active_grace_period: 0,
    });
    stub("repo-digests.json", [`${REPO}@${DIGEST_A}`]);
    const r = deploy([], 1, gitUser("Op Tester"));
    expect(r.code, r.err).toBe(0);
    const rec = records()[0];
    expect(rec.override).toBe("worker-only");
    expect(rec.rescue_all).toBe("exit 1");
  });

  test("no override needed (rescue passes, target matches): nothing recorded", () => {
    expect(deploy([], 0).code).toBe(0);
    expect(existsSync(logPath())).toBe(false);
  });

  // PR #60 review F3: --var/--define values and a secrets file path may be
  // secrets. The record keeps flag names only.
  test("flag values never land in the record: --var, --var=, --define, --secrets-file", () => {
    const r = deploy(["deploy", "--var", "API_KEY:s3cr3t-one", "--var=K2:s3cr3t-two", "--define", "D:s3cr3t-three",
      "--secrets-file", "s3cr3t-four.json", "--allow-unrescued"], 1, gitUser("Op Tester"));
    expect(r.code, r.err).toBe(0);
    const raw = readFileSync(logPath(), "utf8");
    expect(raw).not.toContain("s3cr3t");
    expect(raw).not.toContain("API_KEY");
    expect(records()[0].command).toBe("deploy --var --var --define --secrets-file");
  });

  // Issue #69: wrangler's --var/--define take EVERY following word until the
  // next flag. Dropping only the first leaked the rest into the record.
  test("multi-value --var / --var= / --define: every value dropped, not only the first", () => {
    const r = deploy(["deploy", "--var", "A:s3cr3t-one", "B:s3cr3t-two", "--var=C:s3cr3t-three", "D:s3cr3t-four",
      "--define", "E:s3cr3t-five", "F:s3cr3t-six", "--allow-unrescued"], 1, gitUser("Op Tester"));
    expect(r.code, r.err).toBe(0);
    const raw = readFileSync(logPath(), "utf8");
    expect(raw).not.toContain("s3cr3t");
    expect(records()[0].command).toBe("deploy --var --var --define");
  });

  test("-e after a multi-value --var still keeps its env value", () => {
    const base = withImage("fleet-test");
    writeConfig({ ...base, env: { staging: { durable_objects: base.durable_objects, containers: base.containers } } });
    setCreds("https://fleet-test-staging.example.workers.dev");
    deploy(["deploy", "--var", "A:s3cr3t-one", "B:s3cr3t-two", "-e", "staging", "--allow-unrescued"], 1, gitUser("Op Tester"));
    expect(readFileSync(logPath(), "utf8")).not.toContain("s3cr3t");
    expect(records()[0].command).toBe("deploy --var -e staging");
  });

  test("-e keeps its env value (not secret, needed to know the target)", () => {
    const base = withImage("fleet-test");
    writeConfig({ ...base, env: { staging: { durable_objects: base.durable_objects, containers: base.containers } } });
    setCreds("https://fleet-test-staging.example.workers.dev");
    deploy(["deploy", "-e", "staging", "--allow-unrescued"], 1, gitUser("Op Tester"));
    expect(records()[0].command).toBe("deploy -e staging");
  });

  test("the record cannot be written -> refused (an override must leave a trace)", () => {
    mkdirSync(logPath(), { recursive: true });
    const r = deploy(["--allow-unrescued"], 1, gitUser("Op Tester"));
    expect(r.code).toBe(1);
    expect(r.wrangler).toEqual([]);
    expect(r.err).toContain("deploy-overrides.jsonl");
  });
});

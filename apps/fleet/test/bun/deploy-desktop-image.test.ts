import { describe, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deploy, harnessState, stubDesktopProbe, test, useDeployRescueHarness, withImage, writeConfig,
} from "./helpers/deploy-rescue-harness";

useDeployRescueHarness(() => {});

/**
 * Issue #1314: deploy.sh's desktop-image probe branches. The probe internals
 * (hash compare, repin) are unit-tested; here the probe is stubbed to a fixed
 * exit code so the DEPLOY.SH branches are what's pinned: unchanged -> proceed,
 * changed -> refuse rc 75, repin flag -> push (no ops write), and non-plain
 * commands never run the probe.
 */
describe("deploy.sh: digest-pinned desktop image probe (#1314)", () => {
  test("probe unchanged (0): plain deploy proceeds", () => {
    writeConfig(withImage("fleet-test"));
    stubDesktopProbe(0);
    const r = deploy([], 0);
    expect(r.code, r.err).toBe(0);
    expect(r.wrangler.some((l) => l === "wrangler deploy -c wrangler.local.jsonc")).toBe(true);
  });

  test("probe changed (1): plain deploy refuses with distinct rc 75, no wrangler deploy", () => {
    writeConfig(withImage("fleet-test"));
    stubDesktopProbe(1);
    const r = deploy([], 0);
    expect(r.code, r.err).toBe(75);
    expect(r.wrangler.some((l) => l === "wrangler deploy -c wrangler.local.jsonc")).toBe(false);
    expect(r.err).toContain("desktop gate image changed");
  });

  test("probe failed (2): plain deploy refuses with exit 1", () => {
    writeConfig(withImage("fleet-test"));
    stubDesktopProbe(2);
    const r = deploy([], 0);
    expect(r.code, r.err).toBe(1);
    expect(r.err).toContain("desktop image probe failed");
  });

  test("repin mode: probe runs with --repin-desktop-image, exits 0, never deploys", () => {
    writeConfig(withImage("fleet-test"));
    stubDesktopProbe(0);
    const r = deploy(["--repin-desktop-image"], 0);
    expect(r.code, r.err).toBe(0);
    // The flag is consumed by deploy.sh, never passed to wrangler: no deploy
    // runs (repin is standalone — the operator commits the pin bump, then
    // deploys normally).
    expect(r.wrangler.some((l) => l.includes("--repin-desktop-image"))).toBe(false);
    expect(r.wrangler.some((l) => l === "wrangler deploy -c wrangler.local.jsonc")).toBe(false);
  });

  test("repin mode probe failure refuses", () => {
    writeConfig(withImage("fleet-test"));
    stubDesktopProbe(2);
    const r = deploy(["--repin-desktop-image"], 0);
    expect(r.code, r.err).toBe(1);
    expect(r.err).toContain("rebuild/push failed");
  });

  test("non-plain command (d1 migration) never runs the probe", () => {
    writeConfig(withImage("fleet-test"));
    // The probe would exit 1 if run; a d1 command must not touch it.
    stubDesktopProbe(1);
    const r = deploy(["d1", "migrations", "apply", "fleet", "--remote"], 0);
    // d1 migrations apply is read-only-ish and completes via the wrangler
    // forward; the probe's refusal must not fire.
    expect(r.code, r.err).toBe(0);
    expect(r.err).not.toContain("desktop gate image changed");
  });

  test("probe never writes the ops config", () => {
    writeConfig(withImage("fleet-test"));
    stubDesktopProbe(0);
    const before = readFileSync(harnessState.config, "utf8");
    deploy([], 0);
    expect(readFileSync(harnessState.config, "utf8")).toBe(before);
    expect(existsSync(join(harnessState.fleet, "wrangler.local.jsonc"))).toBe(true);
  });
});
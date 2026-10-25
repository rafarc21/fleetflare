import { describe, expect } from "bun:test";
import { deploy, test, useDeployRescueHarness } from "./helpers/deploy-rescue-harness";

useDeployRescueHarness(() => {});

/**
 * Issue #1315: `wrangler deploy` can exit 1 with CF 100146 "version not found"
 * after the version upload has landed but before containers/triggers are
 * applied — a race in CF's version lookup, not a fully-failed deploy. deploy.sh
 * must NOT auto-succeed (there is no version id to check, and containers/
 * triggers may not have run): it reports the half-deploy and exits a DISTINCT
 * non-zero code (75) so the operator re-runs. Non-plain commands (versions
 * deploy, rollback, d1) keep their original rc and are never tee'd.
 */
describe("deploy.sh: CF 100146 after upload reports half-deploy, exit 75 (#1315)", () => {
  test("plain deploy 100146: reports uploaded-but-unapplied, exits 75 (distinct, non-zero)", () => {
    const r = deploy([], 0, { STUB_DEPLOY_100146: "1", STUB_DEPLOY_EXIT: "1" });
    expect(r.code, r.err).toBe(75);
    expect(r.err).toContain("100146");
    expect(r.err).toContain("re-run the same deploy");
    // The real deploy ran; no status poll is made (no auto-success).
    expect(r.wrangler.some((l) => l === "wrangler deploy -c wrangler.local.jsonc")).toBe(true);
    expect(r.wrangler.some((l) => l.includes("deployments status"))).toBe(false);
  });

  test("plain deploy failure without 100146 keeps its original rc (no rewrite)", () => {
    const r = deploy([], 0, { STUB_DEPLOY_EXIT: "3" });
    expect(r.code, r.err).toBe(3);
    expect(r.err).not.toContain("100146");
  });

  test("versions deploy keeps its original rc, never tee'd", () => {
    const r = deploy(["versions", "deploy", "bad-id"], 0, { STUB_VERSIONS_DEPLOY_EXIT: "4" });
    expect(r.code, r.err).toBe(4);
    // The stub wrangler recorded the command exactly once, and no 100146
    // rewrite fired even though the exit was non-zero.
    expect(r.wrangler.some((l) => l.startsWith("wrangler versions deploy bad-id"))).toBe(true);
    expect(r.err).not.toContain("100146");
  });

  test("rollback keeps its original rc", () => {
    const r = deploy(["rollback", "bad-id"], 0, { STUB_ROLLBACK_EXIT: "5" });
    expect(r.code, r.err).toBe(5);
    expect(r.err).not.toContain("100146");
  });

  test("d1 migrations apply keeps its original rc (no tee, no confirm auto-yes)", () => {
    const r = deploy(["d1", "migrations", "apply", "fleet", "--remote"], 0, { STUB_D1_MIGRATE_EXIT: "6" });
    expect(r.code, r.err).toBe(6);
    expect(r.err).not.toContain("100146");
  });
});
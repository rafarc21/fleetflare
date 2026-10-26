import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * #1342 image-COPY follow-up: the gate image ships container/gate/browser/
 * at /opt/fleet-gate/browser (env FLEET_GATE_BROWSER). Static half — a real
 * build needs a docker daemon, which the gate lacks. These tests pin the
 * source of truth the Dockerfile COPYs: the dir must exist and hold the stub
 * marker, and every file the guard (#1344) / AI harness (#1345) later add
 * under it rides the same glob. The Dockerfile COPY assertions live in
 * gate-dockerfile.test.ts.
 */
const CONTAINER = join(import.meta.dir, "..", "..", "container");
const BROWSER = join(CONTAINER, "gate", "browser");

describe("gate browser harness dir (#1342 image-COPY)", () => {
  test("the source dir exists and the stub README names guard + ai", () => {
    expect(existsSync(BROWSER)).toBe(true);
    const readme = readFileSync(join(BROWSER, "README.md"), "utf8");
    expect(readme).toContain("/opt/fleet-gate/browser");
    expect(readme).toContain("#1344");
    expect(readme).toContain("#1345");
  });
});
// Issue #1160 (option 2): a repo opts into studio tools by declaring
// `studio.tools` in its own fleet.json. parseStudioTools is the only place
// that reads the key; unknown names are rejected, absent means none.
import { describe, expect, test } from "vitest";
import { BlueprintError } from "../src/studio/blueprint";
import { provisionedCheckCmd, readinessWarningIn, resolveStudioTools } from "../src/studio/provision";
import { parseStudioTools, STUDIO_TOOL_ALLOWLIST } from "../src/studio/studio-tools";

function fleetJson(extra: Record<string, unknown>): string {
  return JSON.stringify({ blueprint: { repo: "acme/blueprint", ref: "main" }, roles: [], instance_type: "standard-2", ...extra });
}

describe("parseStudioTools", () => {
  test("the allow-list is exactly azure-cli for now", () => {
    expect([...STUDIO_TOOL_ALLOWLIST]).toEqual(["azure-cli"]);
  });

  test("a fleet.json with no studio block declares no tools", () => {
    expect(parseStudioTools(fleetJson({}))).toEqual([]);
  });

  test("a studio block without a tools key declares no tools", () => {
    expect(parseStudioTools(fleetJson({ studio: {} }))).toEqual([]);
  });

  test("an empty tools array declares no tools", () => {
    expect(parseStudioTools(fleetJson({ studio: { tools: [] } }))).toEqual([]);
  });

  test("a known tool passes through", () => {
    expect(parseStudioTools(fleetJson({ studio: { tools: ["azure-cli"] } }))).toEqual(["azure-cli"]);
  });

  test("an unknown tool name is rejected, naming the value", () => {
    const attempt = () => parseStudioTools(fleetJson({ studio: { tools: ["kubectl"] } }));
    expect(attempt).toThrow(BlueprintError);
    expect(attempt).toThrow(/kubectl/);
  });

  test("tools must be an array", () => {
    expect(() => parseStudioTools(fleetJson({ studio: { tools: "azure-cli" } }))).toThrow(BlueprintError);
  });

  test("tools entries must be strings", () => {
    expect(() => parseStudioTools(fleetJson({ studio: { tools: [42] } }))).toThrow(BlueprintError);
  });

  test("studio must be an object when present", () => {
    expect(() => parseStudioTools(fleetJson({ studio: ["azure-cli"] }))).toThrow(BlueprintError);
  });

  test("invalid JSON is rejected", () => {
    expect(() => parseStudioTools("{not json")).toThrow(BlueprintError);
  });
});

// Worker side (issue #1160): the work repo's own fleet.json decides which
// tools bring-up installs, and the READY check shows the marker bring-up
// leaves when an install fails.
describe("resolveStudioTools", () => {
  test("reads the work repo's own fleet.json at the default ref", async () => {
    const seen: string[] = [];
    const deps = {
      fetchBlueprintFile: async (repo: string, path: string, ref: string) => {
        seen.push(`${repo}:${path}@${ref}`);
        return fleetJson({ studio: { tools: ["azure-cli"] } });
      },
    };
    expect(await resolveStudioTools(deps, "acme/desktop")).toEqual(["azure-cli"]);
    expect(seen).toEqual(["acme/desktop:fleet.json@main"]);
  });

  test("a repo with no fleet.json at all declares no tools", async () => {
    const deps = {
      fetchBlueprintFile: async () => {
        throw new Error("fetch fleet.json@main failed (404): Not Found");
      },
    };
    expect(await resolveStudioTools(deps, "acme/desktop")).toEqual([]);
  });

  test("a non-404 fetch failure propagates, it is not silently dropped", async () => {
    const deps = {
      fetchBlueprintFile: async () => {
        throw new Error("fetch fleet.json@main failed (503): unavailable");
      },
    };
    await expect(resolveStudioTools(deps, "acme/desktop")).rejects.toThrow(/503/);
  });

  test("an unknown tool in the work repo's fleet.json fails the provision loudly", async () => {
    const deps = {
      fetchBlueprintFile: async () => fleetJson({ studio: { tools: ["kubectl"] } }),
    };
    await expect(resolveStudioTools(deps, "acme/desktop")).rejects.toThrow(BlueprintError);
  });
});

describe("READY surfacing of the tools marker", () => {
  test("the readiness check reads the tools marker alongside the tailnet one", () => {
    expect(provisionedCheckCmd("desktop")).toContain("/.fleet/tools-down");
  });

  test("a tools warning line is picked out", () => {
    expect(readinessWarningIn("provisioned\ntools: not installed\n")).toBe("tools: not installed");
  });

  test("tailnet and tools warnings both survive, joined", () => {
    expect(readinessWarningIn("tailnet: down\ntools: not installed\n")).toBe("tailnet: down; tools: not installed");
  });

  test("no warning line means no warning", () => {
    expect(readinessWarningIn("PROVISIONED_OK\n")).toBeNull();
  });
});

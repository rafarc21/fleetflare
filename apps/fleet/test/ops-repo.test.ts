import { describe, it, expect, vi } from "vitest";
import { resolveOpsRepo } from "../src/ops-repo";

// #341 + #330: ONE setting names the operator's private config repo
// (rafarc21/fleetflare-ops): harvested memory and the house-rules overlay both
// live there. Unset = those features off, the public default.
describe("resolveOpsRepo", () => {
  it("unset or blank: off", () => {
    expect(resolveOpsRepo({})).toBeNull();
    expect(resolveOpsRepo({ FLEET_OPS_REPO: "  " })).toBeNull();
  });
  it("owner/name: that repo, trimmed", () => {
    expect(resolveOpsRepo({ FLEET_OPS_REPO: " rafarc21/fleetflare-ops " })).toBe("rafarc21/fleetflare-ops");
  });
  it("anything else: off, logged once, naming the setting", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(resolveOpsRepo({ FLEET_OPS_REPO: "fleetflare-ops" })).toBeNull();
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0]!.join(" ")).toContain("FLEET_OPS_REPO");
    } finally {
      errors.mockRestore();
    }
  });
});

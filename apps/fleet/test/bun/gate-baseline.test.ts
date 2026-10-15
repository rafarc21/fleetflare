import { describe, it, expect } from "bun:test";
import { baselineId, baselineTarballKey, baselineSnapshotName } from "../../src/gate/baseline";

describe("baselineId", () => {
  it("joins sha and lockfile hash with a dash, no other lookup needed", () => {
    expect(baselineId("abc123", "def456")).toBe("abc123-def456");
  });
});

describe("baselineTarballKey", () => {
  it("builds the R2 fallback key under gate/<owner>/<repo>/baselines/", () => {
    expect(baselineTarballKey("rafarc21", "fleetflare", "abc123", "def456")).toBe(
      "gate/rafarc21/fleetflare/baselines/abc123-def456.tar",
    );
  });
});

describe("baselineSnapshotName", () => {
  it("builds a lower-kebab snapshot name, the primary mechanism", () => {
    expect(baselineSnapshotName("rafarc21", "fleetflare", "abc123", "def456")).toBe(
      "rafarc21-fleetflare-abc123-def456",
    );
  });
  it("same (owner, repo, sha, lockfileHash) always names the same snapshot — deterministic, not random", () => {
    const a = baselineSnapshotName("rafarc21", "fleetflare", "abc123", "def456");
    const b = baselineSnapshotName("rafarc21", "fleetflare", "abc123", "def456");
    expect(a).toBe(b);
  });
  it("sanitizes mixed-case owner/repo (dots, underscores) to ASCII lower-kebab, per the interface contract", () => {
    expect(baselineSnapshotName("Rafa.Rc21", "Fleet_Flare", "abc123", "def456")).toBe(
      "rafa-rc21-fleet-flare-abc123-def456",
    );
  });
});

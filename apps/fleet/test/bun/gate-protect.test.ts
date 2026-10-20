import { describe, it, expect, vi } from "bun:test";
import { runGateProtect, type ProtectPort } from "../../src/gate/protect";
import { GATE_STATUS_CONTEXT } from "../../src/gate/status-post";

function fakePort(opts: {
  branch?: string;
  before?: string[] | null;
}): ProtectPort & {
  getDefaultBranch: ReturnType<typeof vi.fn>;
  getProtection: ReturnType<typeof vi.fn>;
  setProtection: ReturnType<typeof vi.fn>;
} {
  const port = {
    getDefaultBranch: vi.fn(async () => opts.branch ?? "main"),
    getProtection: vi.fn(async () => opts.before === null ? null : { contexts: opts.before ?? [] }),
    setProtection: vi.fn(async () => {}),
  };
  return port;
}

describe("runGateProtect", () => {
  it("idempotent: an existing gate/verdict means after equals before (deduped) and changed: false", async () => {
    const port = fakePort({ before: ["lint", "gate/verdict"] });
    const result = await runGateProtect(port, "acme/websites");
    expect(result.branch).toBe("main");
    expect(result.before).toEqual(["lint", "gate/verdict"]);
    expect(result.after).toEqual(["lint", "gate/verdict"]);
    expect(result.changed).toBe(false);
    expect(port.setProtection).toHaveBeenCalledWith("acme/websites", "main", ["lint", "gate/verdict"]);
  });

  it("first protect: adds gate/verdict and reports changed", async () => {
    const port = fakePort({ before: ["lint"] });
    const result = await runGateProtect(port, "acme/websites");
    expect(result.before).toEqual(["lint"]);
    expect(result.after).toEqual(["lint", "gate/verdict"]);
    expect(result.changed).toBe(true);
  });

  it("no protection rule at all: before [], after [gate/verdict], changed", async () => {
    const port = fakePort({ before: null });
    const result = await runGateProtect(port, "acme/websites");
    expect(result.before).toEqual([]);
    expect(result.after).toEqual(["gate/verdict"]);
    expect(result.changed).toBe(true);
  });

  it("uses the default branch for both the read and the write", async () => {
    const port = fakePort({ branch: "trunk", before: ["lint"] });
    await runGateProtect(port, "acme/websites");
    expect(port.getProtection).toHaveBeenCalledWith("acme/websites", "trunk");
    expect(port.setProtection).toHaveBeenCalledWith("acme/websites", "trunk", ["lint", GATE_STATUS_CONTEXT]);
  });

  it("always PUTs, even when unchanged, so a flipped strict is re-pinned", async () => {
    const port = fakePort({ before: ["gate/verdict"] });
    const result = await runGateProtect(port, "acme/websites");
    expect(result.changed).toBe(false);
    expect(port.setProtection).toHaveBeenCalledTimes(1);
  });
});
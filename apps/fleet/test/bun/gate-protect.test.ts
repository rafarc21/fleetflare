import { describe, it, expect, vi } from "bun:test";
import { runGateProtect, type ProtectPort } from "../../src/gate/protect";
import { GATE_STATUS_CONTEXT } from "../../src/gate/status-post";

function fakePort(opts: {
  branch?: string;
  before?: string[] | null;
}): ProtectPort & {
  getDefaultBranch: ReturnType<typeof vi.fn>;
  getProtection: ReturnType<typeof vi.fn>;
  createProtection: ReturnType<typeof vi.fn>;
  addRequiredContexts: ReturnType<typeof vi.fn>;
  setStrict: ReturnType<typeof vi.fn>;
} {
  const port = {
    getDefaultBranch: vi.fn(async () => opts.branch ?? "main"),
    getProtection: vi.fn(async () => opts.before === null ? null : { contexts: opts.before ?? [] }),
    createProtection: vi.fn(async () => {}),
    addRequiredContexts: vi.fn(async () => {}),
    setStrict: vi.fn(async () => {}),
  };
  return port;
}

describe("runGateProtect", () => {
  it("no protection rule at all: full PUT creates it, nothing appended or re-pinned", async () => {
    const port = fakePort({ before: null });
    const result = await runGateProtect(port, "acme/websites");
    expect(result.branch).toBe("main");
    expect(result.before).toEqual([]);
    expect(result.after).toEqual(["gate/verdict"]);
    expect(result.changed).toBe(true);
    expect(port.createProtection).toHaveBeenCalledWith("acme/websites", "main", ["gate/verdict"]);
    expect(port.addRequiredContexts).not.toHaveBeenCalled();
    expect(port.setStrict).not.toHaveBeenCalled();
  });

  it("existing rule without gate/verdict: appends the context and re-pins strict, never a PUT", async () => {
    const port = fakePort({ before: ["lint"] });
    const result = await runGateProtect(port, "acme/websites");
    expect(result.before).toEqual(["lint"]);
    expect(result.after).toEqual(["lint", "gate/verdict"]);
    expect(result.changed).toBe(true);
    expect(port.addRequiredContexts).toHaveBeenCalledWith("acme/websites", "main", ["gate/verdict"]);
    expect(port.setStrict).toHaveBeenCalledWith("acme/websites", "main", false);
    expect(port.createProtection).not.toHaveBeenCalled();
  });

  it("existing rule already has gate/verdict: still appends + re-pins strict, after deduped, changed false", async () => {
    const port = fakePort({ before: ["lint", "gate/verdict"] });
    const result = await runGateProtect(port, "acme/websites");
    expect(result.before).toEqual(["lint", "gate/verdict"]);
    expect(result.after).toEqual(["lint", "gate/verdict"]);
    expect(result.changed).toBe(false);
    expect(port.addRequiredContexts).toHaveBeenCalledWith("acme/websites", "main", ["gate/verdict"]);
    expect(port.setStrict).toHaveBeenCalledWith("acme/websites", "main", false);
    expect(port.createProtection).not.toHaveBeenCalled();
  });

  it("uses the default branch for both the read and the write", async () => {
    const port = fakePort({ branch: "trunk", before: ["lint"] });
    await runGateProtect(port, "acme/websites");
    expect(port.getProtection).toHaveBeenCalledWith("acme/websites", "trunk");
    expect(port.addRequiredContexts).toHaveBeenCalledWith("acme/websites", "trunk", [GATE_STATUS_CONTEXT]);
  });

  it("idempotent second run: changed reflects only the delta", async () => {
    const first = fakePort({ before: ["lint"] });
    const firstResult = await runGateProtect(first, "acme/websites");
    expect(firstResult.changed).toBe(true);
    const second = fakePort({ before: ["lint", GATE_STATUS_CONTEXT] });
    const secondResult = await runGateProtect(second, "acme/websites");
    expect(secondResult.changed).toBe(false);
    expect(secondResult.after).toEqual(["lint", GATE_STATUS_CONTEXT]);
  });
});
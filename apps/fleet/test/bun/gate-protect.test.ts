import { describe, it, expect, vi } from "bun:test";
import { runGateProtect, type ProtectPort, type ProtectionState } from "../../src/gate/protect";
import { GATE_STATUS_CONTEXT } from "../../src/gate/status-post";

function state(o: Partial<ProtectionState> = {}): ProtectionState {
  return { contexts: [], hasRequiredStatusChecks: true, enforceAdmins: false, ...o };
}

function fakePort(opts: {
  branch?: string;
  before?: ProtectionState | null;
}): ProtectPort & {
  getDefaultBranch: ReturnType<typeof vi.fn>;
  getProtection: ReturnType<typeof vi.fn>;
  createProtection: ReturnType<typeof vi.fn>;
  addRequiredContexts: ReturnType<typeof vi.fn>;
  setStrict: ReturnType<typeof vi.fn>;
  setRequiredStatusChecks: ReturnType<typeof vi.fn>;
  disableEnforceAdmins: ReturnType<typeof vi.fn>;
} {
  const port = {
    getDefaultBranch: vi.fn(async () => opts.branch ?? "main"),
    getProtection: vi.fn(async () => (opts.before === null ? null : opts.before ?? state())),
    createProtection: vi.fn(async () => {}),
    addRequiredContexts: vi.fn(async () => {}),
    setStrict: vi.fn(async () => {}),
    setRequiredStatusChecks: vi.fn(async () => {}),
    disableEnforceAdmins: vi.fn(async () => {}),
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
    expect(port.setRequiredStatusChecks).not.toHaveBeenCalled();
    expect(port.disableEnforceAdmins).not.toHaveBeenCalled();
  });

  it("existing rule with required status checks: appends the context and re-pins strict, never a PUT", async () => {
    const port = fakePort({ before: state({ contexts: ["lint"] }) });
    const result = await runGateProtect(port, "acme/websites");
    expect(result.before).toEqual(["lint"]);
    expect(result.after).toEqual(["lint", "gate/verdict"]);
    expect(result.changed).toBe(true);
    expect(port.addRequiredContexts).toHaveBeenCalledWith("acme/websites", "main", ["gate/verdict"]);
    expect(port.setStrict).toHaveBeenCalledWith("acme/websites", "main", false);
    expect(port.createProtection).not.toHaveBeenCalled();
    expect(port.setRequiredStatusChecks).not.toHaveBeenCalled();
    expect(port.disableEnforceAdmins).not.toHaveBeenCalled();
  });

  it("existing rule already has gate/verdict: still appends + re-pins strict, after deduped, changed false", async () => {
    const port = fakePort({ before: state({ contexts: ["lint", "gate/verdict"] }) });
    const result = await runGateProtect(port, "acme/websites");
    expect(result.before).toEqual(["lint", "gate/verdict"]);
    expect(result.after).toEqual(["lint", "gate/verdict"]);
    expect(result.changed).toBe(false);
    expect(port.addRequiredContexts).toHaveBeenCalledWith("acme/websites", "main", ["gate/verdict"]);
    expect(port.setStrict).toHaveBeenCalledWith("acme/websites", "main", false);
    expect(port.createProtection).not.toHaveBeenCalled();
  });

  it("rule without required status checks: PATCHes required_status_checks instead of the contexts POST that would 404", async () => {
    const port = fakePort({ before: state({ contexts: [], hasRequiredStatusChecks: false }) });
    const result = await runGateProtect(port, "acme/websites");
    expect(result.before).toEqual([]);
    expect(result.after).toEqual(["gate/verdict"]);
    expect(result.changed).toBe(true);
    expect(port.setRequiredStatusChecks).toHaveBeenCalledWith("acme/websites", "main", false, ["gate/verdict"]);
    expect(port.addRequiredContexts).not.toHaveBeenCalled();
    expect(port.setStrict).not.toHaveBeenCalled();
    expect(port.createProtection).not.toHaveBeenCalled();
  });

  it("rule still enforcing admins: disables enforce_admins", async () => {
    const port = fakePort({ before: state({ contexts: ["lint"], enforceAdmins: true }) });
    await runGateProtect(port, "acme/websites");
    expect(port.disableEnforceAdmins).toHaveBeenCalledWith("acme/websites", "main");
    expect(port.addRequiredContexts).toHaveBeenCalledWith("acme/websites", "main", ["gate/verdict"]);
    expect(port.setStrict).toHaveBeenCalledWith("acme/websites", "main", false);
  });

  it("uses the default branch for both the read and the write", async () => {
    const port = fakePort({ branch: "trunk", before: state({ contexts: ["lint"] }) });
    await runGateProtect(port, "acme/websites");
    expect(port.getProtection).toHaveBeenCalledWith("acme/websites", "trunk");
    expect(port.addRequiredContexts).toHaveBeenCalledWith("acme/websites", "trunk", [GATE_STATUS_CONTEXT]);
  });

  it("idempotent second run: changed reflects only the delta", async () => {
    const first = fakePort({ before: state({ contexts: ["lint"] }) });
    const firstResult = await runGateProtect(first, "acme/websites");
    expect(firstResult.changed).toBe(true);
    const second = fakePort({ before: state({ contexts: ["lint", GATE_STATUS_CONTEXT] }) });
    const secondResult = await runGateProtect(second, "acme/websites");
    expect(secondResult.changed).toBe(false);
    expect(secondResult.after).toEqual(["lint", GATE_STATUS_CONTEXT]);
  });
});
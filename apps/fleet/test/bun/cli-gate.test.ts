import { describe, it, expect } from "bun:test";
import { gateWatchExitCode, parseStatusResponse, type GateStatusResponse } from "../../cli/gate";

describe("gateWatchExitCode", () => {
  it("success -> 0", () => {
    expect(gateWatchExitCode({ state: "success" })).toBe(0);
  });
  it("failure -> 1", () => {
    expect(gateWatchExitCode({ state: "failure", description: "x" })).toBe(1);
  });
  it("error -> 2", () => {
    expect(gateWatchExitCode({ state: "error", description: "x" })).toBe(2);
  });
  it("missing or unknown state -> 2, never a green exit", () => {
    expect(gateWatchExitCode({} as GateStatusResponse)).toBe(2);
    expect(gateWatchExitCode({ state: "bogus" } as unknown as GateStatusResponse)).toBe(2);
  });
  it("statusPostFailed overrides the state's own code -> 3", () => {
    const status: GateStatusResponse = { state: "success", statusPostFailed: true };
    expect(gateWatchExitCode(status)).toBe(3);
  });
});

describe("parseStatusResponse", () => {
  it("valid JSON status object parses", () => {
    const parsed = parseStatusResponse(JSON.stringify({ state: "success" }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.status.state).toBe("success");
  });
  it("non-JSON body (Cloudflare 500 HTML) is an error, never a green exit", () => {
    const parsed = parseStatusResponse("<html><body>500</body></html>");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.body.length).toBeLessThanOrEqual(200);
  });
  it("JSON that is not a status object (e.g. null) is an error too", () => {
    expect(parseStatusResponse("null").ok).toBe(false);
  });
});

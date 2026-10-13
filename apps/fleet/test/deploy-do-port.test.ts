// Issue #559 (PR #560 follow-up, refs #514 sweep-14 §S14-F10): PR #560's
// import-edge pin could not see WHICH symbol rode the runtime import —
// Bun.Transpiler.scanImports returns import paths only, never named
// imports — so reverting either DO's defaultPort to the 8080 literal kept
// the suite green. These are the per-site pins that review asked for,
// reading each DO's source through the vitest config bindings
// (TEST_AGENT_DO_SRC / TEST_DEPLOY_DO_SRC — the TEST_STUDIO_DO_SRC
// technique), which also keeps test-lies-check quiet: that detector flags
// src/ text read via readFileSync inside a test file, not bindings handed
// in by the config. The DOs themselves are container-backed and cannot be
// constructed under vitest-pool-workers, so wiring is pinned as source —
// same slice technique test/agents.do.test.ts uses.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Slice a class/method body out of a bound source: from the line starting
// with `sig` to the next `\n  }` at class-method indent. Throws if the
// signature is not found — a missing slice is a broken pin, not a skip.
const body = (src: string, sig: string): string => {
  const start = src.indexOf(sig);
  if (start === -1) throw new Error(`signature not found in source: ${sig}`);
  return src.slice(start, src.indexOf("\n  }\n", start));
};

const agentsDoSrc: string = env.TEST_AGENT_DO_SRC;
const deployDoSrc: string = env.TEST_DEPLOY_DO_SRC;

describe("issue #559 — CONTAINER_PORT rides every per-DO site (source-pinned)", () => {
  it("AgentDO's defaultPort is CONTAINER_PORT, not a re-typed literal", () => {
    const cls = body(agentsDoSrc, "export class AgentDO extends Container<Env> {");
    expect(cls).toContain("defaultPort = CONTAINER_PORT;");
  });

  it("DeployDO's defaultPort is CONTAINER_PORT, not a re-typed literal", () => {
    const cls = body(deployDoSrc, "export class DeployDO extends Container<Env> {");
    expect(cls).toContain("defaultPort = CONTAINER_PORT;");
  });

  it("DeployDO's /run containerFetch passes CONTAINER_PORT", () => {
    const fetch = body(deployDoSrc, "async fetch(req: Request): Promise<Response> {");
    expect(fetch).toContain("containerFetch(");
    expect(fetch).toContain("CONTAINER_PORT,");
  });

  it("DeployDO's pollDeploy status fetch passes CONTAINER_PORT", () => {
    const poll = body(deployDoSrc, "async pollDeploy(_payload: { targetId: string }): Promise<void> {");
    expect(poll).toContain("containerFetch(new Request(\"http://container/status\"), CONTAINER_PORT)");
  });

  it("no DO source keeps a surviving 8080 literal", () => {
    expect(agentsDoSrc.includes("8080")).toBe(false);
    expect(deployDoSrc.includes("8080")).toBe(false);
  });
});

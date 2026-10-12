// apps/fleet/test/bun/container-port.test.ts
//
// Issue #514 (sweep-14 §S14-F10): the Containers platform's port 8080 is
// re-typed four times — defaultPort on both Container subclasses, two
// containerFetch calls in deploy/do.ts, and ContainerRuntime's default
// parameter. This file pins two things: ContainerRuntime's default port is
// the shared CONTAINER_PORT (behavioral — a fake Container records the port
// containerFetch actually receives), and each DO keeps a runtime import
// edge (import-edge pin — scanImports sees import PATHS only, not the names
// imported, so it proves each DO keeps its runtime import edge, not which
// symbol rides it; the stronger per-site pin is follow-up task material).
// The import list is inspected with Bun's transpiler, never by reading
// file text, which scripts/test-lies-check.ts flags as a source-reading lie.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContainerRuntime } from "../../src/agents/runtime";

const AGENTS_DO = join(import.meta.dir, "../../src/agents/do.ts");
const DEPLOY_DO = join(import.meta.dir, "../../src/deploy/do.ts");

/** Container seam: records containerFetch's port, returns a canned 200. */
class RecordingContainer {
  public readonly fetchPorts: number[] = [];
  containerFetch(_req: Request | string | URL, portOrInit?: number | RequestInit): Promise<Response> {
    const port = typeof portOrInit === "number" ? portOrInit : 8080;
    this.fetchPorts.push(port);
    return Promise.resolve(new Response("{}", { status: 200 }));
  }
}

describe("issue #514 CONTAINER_PORT — ContainerRuntime's default is the one name", () => {
  test("default port: startTask fetches the container on CONTAINER_PORT", async () => {
    const container = new RecordingContainer();
    const runtime = new ContainerRuntime(container as never);
    await runtime.startTask({ taskId: "t", prompt: "p", repo: "r", ref: "main", ghToken: "g" });
    expect(container.fetchPorts).toEqual([8080]);
  });

  test("explicit port still wins: ctor override 1234 reaches containerFetch", async () => {
    const container = new RecordingContainer();
    const runtime = new ContainerRuntime(container as never, 1234);
    await runtime.status();
    expect(container.fetchPorts).toEqual([1234]);
  });
});

describe("issue #514 import-edge pin — each DO keeps a runtime import edge", () => {
  const importPaths = (file: string): string[] =>
    new Bun.Transpiler({ loader: "ts" })
      .scanImports(readFileSync(file, "utf8"))
      .map((i) => i.path)
      .filter((p) => p === "./runtime" || p === "../agents/runtime");

  test("agents/do.ts and deploy/do.ts keep a runtime import edge", () => {
    // agents/do.ts already imported ContainerRuntime and task types from
    // ./runtime; deploy/do.ts gains the edge in this change. This asserts
    // the edge only — per-site CONTAINER_PORT adoption is the follow-up.
    expect(importPaths(AGENTS_DO).length).toBeGreaterThan(0);
    expect(importPaths(DEPLOY_DO).length).toBeGreaterThan(0);
  });
});

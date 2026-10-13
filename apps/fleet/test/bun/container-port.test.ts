// apps/fleet/test/bun/container-port.test.ts
//
// Issue #514 (sweep-14 §S14-F10): the Containers platform's port 8080 has
// one shared name — CONTAINER_PORT in src/agents/runtime.ts — and this
// file pins its BEHAVIOR: ContainerRuntime's default port is that shared
// constant, proven with a fake Container recording the port containerFetch
// actually receives; an explicit ctor port still wins. The per-DO WIRING
// (each DO's defaultPort and containerFetch args ride the same constant,
// not a re-typed literal) is source-pinned by test/deploy-do-port.test.ts
// through the vitest config SRC bindings — a stronger pin than the
// scanImports import-edge test this file used to carry, retired in #559
// (scanImports sees import paths only, never named imports).
import { describe, expect, test } from "bun:test";
import { ContainerRuntime } from "../../src/agents/runtime";

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

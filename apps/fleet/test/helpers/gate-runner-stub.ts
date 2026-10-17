// #1203: test-only stand-in for GateRunnerDO, bound under the same
// GATE_RUNNER name by test/wrangler.test.jsonc so the success path of
// GateWorkflow.run() can reach a success verdict end to end. The real
// GateRunnerDO (src/gate/do.ts) runs one leg in a container via
// this.ctx.container, which vitest-pool-workers cannot spawn, and is therefore
// NOT bound in the test config — a plain DurableObject like this one boots
// fine. It answers /run-leg with a success LegResult for whatever leg it was
// asked, so the merge-tree leg the plan always includes goes green.
//
// Reachable from the worker entrypoint only through test/vitest-test-entry.ts
// (the test-only `main` of the vitest config), never through src/index.ts —
// nothing under src/ imports this file, and it never ships.
import { DurableObject } from "cloudflare:workers";

/** Every leg name the stub has been asked to run, in dispatch order. The test
 *  resets it in beforeEach and asserts the run dispatched exactly the
 *  merge-tree leg. Module-level because the runtime constructs each DO
 *  instance; the array is the only observation point back into the test. */
export const requestedLegs: string[] = [];

export class GateRunnerStub extends DurableObject {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/run-leg" && req.method === "POST") {
      const body = (await req.json()) as { leg?: string };
      requestedLegs.push(body.leg ?? "merge-tree");
      return Response.json({ leg: body.leg ?? "merge-tree", state: "success" });
    }
    return new Response("not found", { status: 404 });
  }
}

// #715 Phase 1: GateRunnerDO runs ONE leg or ONE shard per container
// instance, writes its JSON result to R2, exits. Not a studio: no Claude
// session, no claude binary, no write-proxy. Plain DurableObject base on the
// native ctx.container API (no @cloudflare/containers base class): the image
// is named explicitly at start, which the durable_object scheduling policy
// requires (see run-leg.ts for the start/poll/destroy flow).
// Created on the `durable_object` scheduling policy (wrangler.example.jsonc,
// Task 1) — fixed at class creation.
//
// Plain R2 keys, never a presigned URL: a presigned URL is itself a bearer
// credential, forgeable by the PR code it is meant to gate. The container's
// own plain fetches to R2 are authorized by the Worker-side outbound handler
// (outbound-entrypoint.ts, allow-list in outbound-handler.ts), registered
// with ctx.container.interceptAllOutboundHttp before each container start.
import { DurableObject, exports as workerExports } from "cloudflare:workers";
import type { Env } from "../env";
import type { GateLegRequest } from "./leg-env";
import { runLegInContainer } from "./run-leg";

export class GateRunnerDO extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/run-leg" && req.method === "POST") {
      const body = (await req.json()) as GateLegRequest;
      // Every plain outbound request from the leg container is served by
      // GateOutbound, the Worker-side entrypoint that holds the R2 binding.
      // Props carry this leg's own resultKey: the only key the container may PUT.
      const outbound = workerExports.GateOutbound({ props: { resultKey: body.resultKey } });
      const result = await runLegInContainer(body, { container: this.ctx.container, outbound });
      return Response.json(result);
    }
    return new Response("not found", { status: 404 });
  }
  // /run-leg is synchronous by design: the reply is the leg's LegResult.
}

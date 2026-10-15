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
//
// #715 private clones: a private leg mints ONE read-only App token here, at leg
// start, and passes it in the outbound props. The git proxy never mints.
import { DurableObject, exports as workerExports } from "cloudflare:workers";
import type { Env } from "../env";
import { mintPrivateCloneToken } from "../github/auth";
import { gateOutboundProps, legGitToken, type GateLegRequest } from "./leg-env";
import { runLegInContainer, type LegResult } from "./run-leg";

/** The one refusal a PAT-served private leg gets. Named so it reaches the leg. */
const PAT_ONLY_REFUSAL = "private clone needs the GitHub App on this owner";

export class GateRunnerDO extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/run-leg" && req.method === "POST") {
      const body = (await req.json()) as GateLegRequest;
      // One mint per leg, and only for a private leg. Failure ends the leg
      // before any container starts or any upstream call is made.
      let gitToken: string | undefined;
      try {
        gitToken = await legGitToken(body, (repo) => mintPrivateCloneToken(this.env, repo));
      } catch (err) {
        const message = err instanceof Error && err.message === PAT_ONLY_REFUSAL
          ? PAT_ONLY_REFUSAL
          : "private clone token unavailable";
        const failed: LegResult = { state: "error", description: message };
        return Response.json(failed);
      }
      // Every plain outbound request from the leg container is served by
      // GateOutbound, the Worker-side entrypoint that holds the R2 binding.
      // Props carry this leg's own resultKey (the only key the container may PUT)
      // and, for a private leg, its one repo and minted token.
      const outbound = workerExports.GateOutbound({ props: gateOutboundProps(body, gitToken) });
      const result = await runLegInContainer(body, { container: this.ctx.container, outbound });
      return Response.json(result);
    }
    return new Response("not found", { status: 404 });
  }
  // /run-leg is synchronous by design: the reply is the leg's LegResult.
}

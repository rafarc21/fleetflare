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
import { legResponse, runLegInContainer, type LegResult } from "./run-leg";
import { legResultReader } from "./leg-run";
import { legTimeoutMin } from "./config";
import { resolveGrantedSecrets } from "./secrets-registry";
import { mintRunToken } from "./secrets-ai-token";

/** The one refusal a PAT-served private leg gets. Named so it reaches the leg. */
const PAT_ONLY_REFUSAL = "private clone needs the GitHub App on this owner";

/** #1346: the container-start margin added on top of a leg's own hard
 *  timeout when sizing the Workers AI run token's TTL (waitUntilRunning's own
 *  180 s budget in run-leg.ts, plus a little headroom) -- "expires with run"
 *  means strictly outliving the leg it was minted for, never the reverse. */
const AI_TOKEN_START_MARGIN_MS = 3 * 60_000;

/** #1346: the one Env-touching, Date.now()-touching glue around
 *  resolveGrantedSecrets' pure loop (secrets-registry.ts) -- everything that
 *  decides WHICH names are resolvable (the registry) and HOW they combine
 *  (the loop itself) lives there and is bun-tested; this is just the real
 *  signing key and the real clock, injected. */
function mintAiToken(req: GateLegRequest, env: Env): (name: string) => Promise<string | undefined> {
  return async () => {
    const signingKey = env.GATE_SECRET_SIGNING_KEY;
    if (signingKey === undefined || signingKey === "") return undefined;
    const ttlMs = legTimeoutMin(req.timeoutMin) * 60_000 + AI_TOKEN_START_MARGIN_MS;
    return mintRunToken({ runId: req.resultKey, leg: req.leg, now: Date.now(), ttlMs }, signingKey);
  };
}

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
      // #1346: body.secretNames is already fully gated by workflow.ts
      // (grantedSecretNames) before this request ever reached the DO --
      // resolving each granted NAME to a real value happens here, once per
      // leg, exactly where the git token above is minted.
      const secretValues = await resolveGrantedSecrets(
        body.secretNames ?? [], this.env as unknown as Record<string, string | undefined>, mintAiToken(body, this.env),
      );
      // Every plain outbound request from the leg container is served by
      // GateOutbound, the Worker-side entrypoint that holds the R2 binding.
      // Props carry this leg's own resultKey (the only key the container may PUT),
      // for a private leg its one repo and minted token, and the plain VALUES
      // (never names) of its granted secrets, for result-body redaction.
      const outbound = workerExports.GateOutbound({ props: gateOutboundProps(body, gitToken, secretValues) });
      // The container's own R2 result, read on a transport loss (#1122).
      const result = await runLegInContainer(body, {
        container: this.ctx.container, outbound, readResult: legResultReader(this.env.STUDIO_ARCHIVE), secretValues,
      });
      return legResponse(result);
    }
    return new Response("not found", { status: 404 });
  }
  // /run-leg is synchronous by design: the reply is the leg's LegResult.
}

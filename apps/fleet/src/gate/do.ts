// #715 Phase 1: GateRunnerDO runs ONE leg or ONE shard per container
// instance, writes its JSON result to R2, exits. Not a studio: no Claude
// session, no claude binary, no write-proxy — same container-class pattern
// DeployDO uses (deploy/do.ts), via the plain Container<Env> base
// AgentDO/DeployDO already use — NOT the heavier Sandbox<Env> base StudioDO
// uses (no tmux/chromium/claude needed).
// Created on the `durable_object` scheduling policy (wrangler.example.jsonc,
// Task 1) — fixed at class creation; this class's code never checks it at
// runtime. Outbound-handler wiring (Task 16) is the part of that policy this
// file uses.
//
// Plain R2 keys, never a presigned URL: a presigned URL is itself a bearer
// credential, forgeable by the PR code it is meant to gate. The container's
// own plain fetches to R2 are authorized by the Worker-side outbound handler
// (outbound-entrypoint.ts, allow-list in outbound-handler.ts), registered
// with ctx.container.interceptAllOutboundHttp before each container start.
import { Container } from "@cloudflare/containers";
import { exports as workerExports } from "cloudflare:workers";
import type { Env } from "../env";
import { buildLegEnvVars, gateOutboundProps, type GateLegRequest } from "./leg-env";

const GATE_CONTAINER_PORT = 8080;

export class GateRunnerDO extends Container<Env> {
  defaultPort = GATE_CONTAINER_PORT;
  // Ephemeral by design (one leg, then exit) — short sleepAfter so a
  // crashed/stuck container doesn't idle-burn vCPU against the account's
  // 1,500-vCPU cap.
  sleepAfter = "2m";

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/run-leg" && req.method === "POST") {
      const body = (await req.json()) as GateLegRequest;
      // Task 16: every plain outbound request from the leg container is served
      // by GateOutbound, the Worker-side entrypoint that holds the R2 binding.
      // Registered before each cold start. Assumed, not yet verified live: that
      // interception does not survive a container stop, so it is re-applied.
      // Props carry this leg's own resultKey (the only key the container may PUT)
      // and its one repo (the only repo the git proxy will fetch, #715).
      if (!this.ctx.container?.running) {
        await this.ctx.container?.interceptAllOutboundHttp(
          workerExports.GateOutbound({ props: gateOutboundProps(body) }),
        );
      }
      await this.start({ envVars: buildLegEnvVars(body) });
      await this.startAndWaitForPorts(GATE_CONTAINER_PORT);
      const legRes = await this.containerFetch(new Request(`http://container/run`, { method: "POST" }));
      if (!legRes.ok) return new Response(await legRes.text(), { status: legRes.status });
      const legBody = await legRes.json() as { state: "success" | "failure" | "error"; description?: string };
      return Response.json(legBody);
    }
    return new Response("not found", { status: 404 });
  }
  // Still open from Task 16's plan text: `/run-leg` ACKs fast (202), keeps the
  // container running via `this.ctx.waitUntil`, and calls `sendEvent` on the
  // calling Workflow instance when done. That needs Task 14's GATE_WORKFLOW
  // binding and instance-id contract, neither on main yet, so this route is
  // still synchronous.
}

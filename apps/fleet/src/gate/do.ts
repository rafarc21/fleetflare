// #715 Phase 1: GateRunnerDO runs ONE leg or ONE shard per container
// instance, writes its JSON result to R2, exits. Not a studio: no Claude
// session, no claude binary, no write-proxy — same container-class pattern
// DeployDO uses (deploy/do.ts), via the plain Container<Env> base
// AgentDO/DeployDO already use — NOT the heavier Sandbox<Env> base StudioDO
// uses (no tmux/chromium/claude needed).
// Created on the `durable_object` scheduling policy (wrangler.example.jsonc,
// Task 1) — fixed at class creation; this class's code never checks it at
// runtime. Snapshot/outbound-handler behavior that policy enables is wired
// in by Task 16, later.
//
// Plain R2 keys, never a presigned URL: a presigned URL is itself a bearer
// credential, forgeable by the PR code it is meant to gate. The container's
// own plain fetches to R2 are authorized by Task 16's Worker-side outbound
// handler, added to this file in a later wave.
import { Container } from "@cloudflare/containers";
import type { Env } from "../env";
import { buildLegEnvVars, type GateLegRequest } from "./leg-env";

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
      await this.start({ envVars: buildLegEnvVars(body) });
      await this.startAndWaitForPorts(GATE_CONTAINER_PORT);
      const legRes = await this.containerFetch(new Request(`http://container/run`, { method: "POST" }));
      if (!legRes.ok) return new Response(await legRes.text(), { status: legRes.status });
      const legBody = await legRes.json() as { state: "success" | "failure" | "error"; description?: string };
      return Response.json(legBody);
    }
    return new Response("not found", { status: 404 });
  }
  // Task 16 (Wave 3, later, same file) adds the outbound-traffic-handler
  // wiring and changes `/run-leg` to ACK fast (202), keeping the container
  // running via `this.ctx.waitUntil` and calling `sendEvent` on the calling
  // Workflow instance when done. Task 14 only consumes that contract.
}

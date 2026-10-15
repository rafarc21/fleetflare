// #715 Phase 1 (Task 16): the Worker-side entrypoint the gate container's
// outbound HTTP is routed to. GateRunnerDO hands this binding to
// ctx.container.interceptAllOutboundHttp (do.ts), so every plain request the
// leg container makes is served here, inside the Worker, with the Worker's own
// STUDIO_ARCHIVE binding. The container holds no credential and no signed URL.
//
// The logic lives in outbound-handler.ts (pure, bun-testable). This file only
// binds it to the real R2 binding.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../env";
import { handleGateOutbound, type GateOutboundProps } from "./outbound-handler";

// Types `exports.GateOutbound` (cloudflare:workers) from the main module's own
// exports, so do.ts gets a typed loopback binding instead of a cast.
declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("../index");
    }
  }
}

export class GateOutbound extends WorkerEntrypoint<Env, GateOutboundProps> {
  override fetch(req: Request): Promise<Response> {
    return handleGateOutbound(req, this.env.STUDIO_ARCHIVE, this.ctx.props);
  }
}

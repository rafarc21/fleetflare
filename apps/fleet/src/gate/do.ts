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
import { GATE_CONTAINER_PORT, legResponse, runLegInContainer, runLegWithSecrets, startAsyncLeg, startLegContainer, type LegResult } from "./run-leg";
import { legResultReader, type ClaimableBucket } from "./leg-run";
import { abandonAttempt, alarmTick, observeOnce, type RunLegAlarmState } from "./run-leg-alarm";
import { legTimeoutMin } from "./config";
import { resolveGrantedSecrets } from "./secrets-registry";
import { mintRunToken } from "./secrets-ai-token";

/** #1398: the container's own inactivity timeout for the async path, in
 *  MINUTES, sized past the leg's own deadline (review r1 item 5) so the
 *  platform never stops an idle container mid-leg. The old 2*ALARM_TICK_MS
 *  (40 s) let ONE late alarm tick read as a false "exited mid-leg"; minutes
 *  (max 6h per https://developers.cloudflare.com/sandbox/concepts/lifetime/)
 *  are far past both the tick and the leg, never between them. */
const INACTIVITY_TIMEOUT_MIN = 60;

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
      // #1398: the async branch starts a container and returns 202 without
      // holding the request open; the leg result arrives in R2 and is found
      // by the Workflow's own poll loop (Task 7). Its check+start+persist runs
      // inside blockConcurrencyWhile so two overlapping /run-leg POSTs on this
      // instance cannot both observe "no alarmState" and start two containers
      // (review r1 item 3). The SYNC path is NOT wrapped: a sync leg holds
      // this DO for minutes (readiness wait + poll), far past
      // blockConcurrencyWhile's ~30 s ceiling, and wrapping it would reset
      // every sync leg mid-run (review r2 BLOCKER).
      if (body.mode === "async-poll") {
        return legResponse(await this.ctx.blockConcurrencyWhile(async () =>
          startAsyncLeg(body, secretValues, {
            getAlarmState: async () => this.ctx.storage.get("alarmState"),
            // r2 leftover (a): ONE atomic storage.put for both keys, never two.
            putAttempt: async (attempt) => { await this.ctx.storage.put({ alarmState: attempt.alarmState, secretValues: attempt.secretValues }); },
            setAlarm: async (at) => { await this.ctx.storage.setAlarm(at); },
          }, () =>
            startLegContainer(body, {
              container: this.ctx.container, outbound, secretValues,
              inactivityTimeoutMs: INACTIVITY_TIMEOUT_MIN * 60_000,
            }),
          async () => { await this.ctx.container?.destroy(); })));
      }
      // #1346 security review r2: both "an unresolved granted secret never
      // runs" and "redact the leg's own result before it leaves this DO"
      // live in run-leg.ts's runLegWithSecrets, not here -- this file
      // imports cloudflare:workers and can never be loaded under bun test,
      // so either guard living as plain code here could be silently
      // reverted without failing a single test. The container's own R2
      // result (read on a transport loss, #1122) is passed straight through.
      const outcome = await runLegWithSecrets(body.secretNames ?? [], secretValues, () =>
        runLegInContainer(body, {
          container: this.ctx.container, outbound, readResult: legResultReader(this.env.STUDIO_ARCHIVE), secretValues,
        }));
      return legResponse(outcome);
    }
    // #1428 item 1: the Workflow's own give-up (leg-run.ts's dispatchAndPollOnce
    // giveup step) calls this idempotent RPC once it concludes this DO may
    // have gone dormant -- cleans up promptly instead of leaving secretValues
    // to the far slower one-shot sweep backstop (run-leg-alarm.ts's
    // SECRET_SWEEP_MS). blockConcurrencyWhile for the same reason /run-leg's
    // own idempotency check above uses it: without it, an in-flight alarm()
    // tick and this request could both read "a state exists" and each act on
    // it, one destroying the container out from under the other's own
    // in-progress work.
    if (url.pathname === "/abandon" && req.method === "POST") {
      const { resultKey } = (await req.json()) as { resultKey: string };
      const result = await this.ctx.blockConcurrencyWhile(() => abandonAttempt({
        storage: {
          getState: () => this.ctx.storage.get<RunLegAlarmState>("alarmState").then((v) => v ?? undefined),
          deleteSecretValues: () => this.ctx.storage.delete("secretValues").then(() => undefined),
          deleteState: () => this.ctx.storage.delete("alarmState").then(() => undefined),
        },
        container: this.ctx.container,
      }, resultKey));
      return Response.json({ result });
    }
    return new Response("not found", { status: 404 });
  }

  /** #1398: the real tick loop, a thin wrapper around alarmTick
   *  (run-leg-alarm.ts) -- every piece of real I/O is built here and
   *  injected, so the orchestration itself is bun-tested and cannot be
   *  silently reverted in this cloudflare:workers-only file. */
  async alarm(): Promise<void> {
    await alarmTick({
      storage: {
        getState: () => this.ctx.storage.get<RunLegAlarmState>("alarmState").then((v) => v ?? undefined),
        getSecretValues: () => this.ctx.storage.get<Record<string, string>>("secretValues").then((v) => v ?? undefined),
        putState: (s) => this.ctx.storage.put("alarmState", s),
        deleteSecretValues: () => this.ctx.storage.delete("secretValues").then(() => undefined),
        deleteState: () => this.ctx.storage.delete("alarmState").then(() => undefined),
        scheduleAlarm: (at) => this.ctx.storage.setAlarm(at),
      },
      container: this.ctx.container,
      bucket: this.env.STUDIO_ARCHIVE as unknown as ClaimableBucket,
      instanceStatus: async (instanceId) => (await this.env.GATE_WORKFLOW.get(instanceId)).status().then((s) => s.status),
      // #1428 item 5: both running() and getPort() are LAZY callbacks, not
      // values resolved once up front -- observeOnce itself decides when to
      // call each (getPort only after confirming not-running, running()
      // again fresh in its own catch), so a container that changes state
      // mid-call is never judged by a stale snapshot taken before the fetch.
      observe: (state) => observeOnce({
        state,
        running: () => this.ctx.container?.running ?? false,
        getPort: () => this.ctx.container?.getTcpPort(GATE_CONTAINER_PORT),
      }),
      now: () => Date.now(),
      log: (message) => { console.error(message); },
    });
  }
}

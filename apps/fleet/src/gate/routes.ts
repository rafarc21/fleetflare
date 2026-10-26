// /studio/gate/start, /studio/gate/status (#715 Phase 1). Mounted inside
// src/studio/routes.ts's handleStudio, same Access-gated lane as
// /studio/models — this module carries no auth of its own, same posture
// handleModelsRoute's own header states. /start reads the PR's head sha (one
// token mint) and starts the run keyed by that sha (#1072): a manual run of a
// sha with a live run reattaches to it, and a finished one starts a fresh run
// (#1085). /status reads the Workflow
// binding's OWN native instance-status API, not a second GitHub read.
import type { Env } from "../env";
import { getPullRequest, getPullRequestHeadSha } from "../github/api";
import {
  getDefaultBranch, getBranchProtection, setBranchProtectionRule, addBranchProtectionContexts, setBranchProtectionStrict, setBranchProtectionRequiredStatusChecks, disableBranchProtectionEnforceAdmins,
} from "../github/api";
import { redactSecrets } from "../studio/redact";
import { runGateProtect, type ProtectPort } from "./protect";
import { repoTokenMinter } from "../github/auth";
import { startManualGateRun, type GateRunIndex, type GateRunParams } from "./auto-run";
import { d1RunIndex } from "./auto-run-env";
import { isGateRunnerRepo } from "./config";
import { gateDraining } from "./drain";
import { greenLegsOf, type CarryGreen, type OutcomeLeg } from "./fanout";
import { rerunInstanceId, statusFollowingRerun } from "./infra-rerun";
import { finalLegKey, failingLines, firstFailingTest, legAttemptKeys, type LegOutput } from "./log";
import { evidenceKeyFor } from "./leg-env";

// Narrow view of the GATE_WORKFLOW binding. Task 14 adds the real field to
// Env; until then this cast keeps this module typechecking. Drop it then.
type GateWorkflowBinding = {
  create(opts: { id?: string; params: GateRunParams }): Promise<{ id: string }>;
  get(id: string): Promise<{
    status(): Promise<{ status: string; output?: unknown }>;
    terminate(): Promise<void>;
  }>;
};

const workflow = (env: Env) => (env as unknown as { GATE_WORKFLOW: GateWorkflowBinding }).GATE_WORKFLOW;

const j = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** The PR's live head sha: the manual start keys its run on it (#1072). */
export const liveHeadSha = (env: Env) => async (repo: string, pr: number): Promise<string> =>
  getPullRequestHeadSha(await repoTokenMinter(env)(repo), repo, pr);

/** #1247: the real GitHub calls behind `gate protect`. One credential per repo
 *  owner, minted lazily, same as liveHeadSha. */
export function realProtectPort(env: Env): ProtectPort {
  const mint = repoTokenMinter(env);
  return {
    getDefaultBranch: async (repo) => getDefaultBranch(await mint(repo), repo),
    getProtection: async (repo, branch) => getBranchProtection(await mint(repo), repo, branch),
    createProtection: async (repo, branch, contexts) => setBranchProtectionRule(await mint(repo), repo, branch, contexts),
    addRequiredContexts: async (repo, branch, contexts) => addBranchProtectionContexts(await mint(repo), repo, branch, contexts),
    setStrict: async (repo, branch, strict) => setBranchProtectionStrict(await mint(repo), repo, branch, strict),
    setRequiredStatusChecks: async (repo, branch, strict, contexts) => setBranchProtectionRequiredStatusChecks(await mint(repo), repo, branch, strict, contexts),
    disableEnforceAdmins: async (repo, branch) => disableBranchProtectionEnforceAdmins(await mint(repo), repo, branch),
  };
}

/** The status one run id reports. A throw (an unknown id included) is the
 *  caller's to map to a JSON error. */
async function gateRunStatus(env: Env, runId: string): Promise<Response> {
  const instance = await workflow(env).get(runId); // Workflows get() is async
  let first = await instance.status();
  // The watchdog ends a first run once its rerun has taken over (#1148): the run then reports that rerun (#1150 review).
  if (first.status === "terminated") {
    const rerun = await workflow(env).get(rerunInstanceId(runId)).catch(() => undefined);
    if (rerun !== undefined) first = await rerun.status();
  }
  // A run that handed off to its infra rerun (#1119) reports the rerun's status.
  const status = await statusFollowingRerun(first, async (rerunId) =>
    (await workflow(env).get(rerunId)).status());
  // Task 14's verdict rides in the Workflow's own output once terminal;
  // anything not yet terminal maps to pending.
  const out = status.output as
    | {
        state?: string; description?: string; statusPostFailed?: boolean; skipped?: string; legs?: unknown[];
        baseSha?: string; planFingerprint?: string; headSha?: string;
      }
    | undefined;
  // "terminated" is terminal too: mapping it to pending would poll forever.
  if (status.status === "errored" || status.status === "terminated") {
    return j({ state: "error", description: "gate workflow instance ended without a verdict" });
  }
  if (status.status !== "complete") {
    return j({ state: "pending" });
  }
  if (out?.skipped !== undefined) {
    // The only skip that still carries `skipped` is the #1125 "head moved"
    // skip, which posted nothing to GitHub: error, never a false green. The
    // "no gated paths changed" skip returns its guarded state/description
    // directly (the `out.state` branch below) since #1214 round 2.
    return j({ state: "error", description: `skipped: ${out.skipped}`, statusPostFailed: out.statusPostFailed });
  }
  if (!out?.state) {
    return j({ state: "error", description: "gate workflow instance errored" });
  }
  // legs (#1049), baseSha, planFingerprint and headSha (#1230) are dropped
  // from the JSON when the run carries none (the early-return paths never
  // set them).
  return j({
    state: out.state, description: out.description, statusPostFailed: out.statusPostFailed, legs: out.legs,
    baseSha: out.baseSha, planFingerprint: out.planFingerprint, headSha: out.headSha,
  });
}

/** gateRunStatus, with an unknown/expired instance mapped to the same clean
 *  JSON error the GET /studio/gate/status handler returns (#1144) — a bare
 *  throw must never reach a caller, whichever route reads a run's status. */
async function gateRunStatusSafe(env: Env, runId: string): Promise<Response> {
  try {
    return await gateRunStatus(env, runId);
  } catch (err) {
    // An id the Workflow does not know is a JSON 404 (#1144). Any other throw
    // is a JSON 500: a bare throw reached Cloudflare's HTML error page.
    if (/not[ _.-]?found/i.test(err instanceof Error ? err.message : String(err))) {
      return j({ error: "no such gate run", runId }, 404);
    }
    console.error("gate status failed", err);
    return j({ error: "gate status unavailable" }, 500);
  }
}

/** #1277: read one leg's final R2 output for `fleet gate log`. The runId comes
 *  from `--run`, else the PR's latest run pointer in D1. The canonical repo
 *  name is resolved via GitHub (R2 keys are case-sensitive, #1119), the leg's
 *  final-try key is chosen, and the result is returned with its fail lines
 *  extracted. A bare throw must never reach the caller: it maps to JSON 404
 *  (no run / no leg) or 500, the same shape gateRunStatusSafe uses. */
async function gateLegLogSafe(
  env: Env, repo: string, pr: number, leg: string, runId?: string, all = false, evidence = false,
): Promise<Response> {
  try {
    const index = d1RunIndex(env.DB);
    const run = runId !== undefined ? { runId } : await index.latest(repo, pr);
    if (run === null || run.runId === undefined) return j({ error: "no gate run for this PR", pr }, 404);
    const token = await repoTokenMinter(env)(repo);
    const canonical = (await getPullRequest(token, repo, pr)).repoFullName;
    const prefix = `gate/${canonical}/runs/${pr}/${run.runId}/`;
    const listed = await env.STUDIO_ARCHIVE.list({ prefix });
    const keys = listed.objects.map((o) => o.key);
    if (evidence) {
      // #1343: the leg's evidence files, listed for `fleet gate log --evidence`.
      // The evidence dir is derived from the leg's FINAL result key, so the
      // try/retry variant does not change where evidence lives (evidence is
      // per-leg, keyed by run+leg). No result at all -> no evidence dir.
      const finalKey = finalLegKey(keys, leg);
      const evidenceKeys = finalKey === null ? [] : await listEvidenceKeys(env.STUDIO_ARCHIVE, evidenceKeyFor(finalKey));
      return j({ repo, pr, leg, runId: run.runId, evidence: evidenceKeys.map(evidenceLine) });
    }
    const key = finalLegKey(keys, leg);
    if (key === null) return j({ error: `no result for leg ${leg}`, runId: run.runId }, 404);
    if (all) {
      // #1318: every attempt of the leg, oldest first. The first-attempt shard
      // is always written by the container's putResult (runSteps returns on
      // every path, including a throw), so it exists for a red-first retry.
      const attemptKeys = legAttemptKeys(keys, leg);
      const attempts = await Promise.all(attemptKeys.map(async (k) => {
        const obj = await env.STUDIO_ARCHIVE.get(k);
        if (obj === null) return { key: k, state: "error", failingTest: null };
        // One malformed shard must not fail the whole listing (#1318 r1): that
        // attempt reports "error", the rest still list.
        let b: Partial<LegOutput> | null;
        try {
          b = (await obj.json()) as Partial<LegOutput> | null;
        } catch {
          b = null;
        }
        if (b === null || typeof b !== "object") return { key: k, state: "error", failingTest: null };
        return {
          key: k,
          state: b.state ?? "error",
          summary: b.summary,
          failingTest: firstFailingTest(b as LegOutput),
        };
      }));
      return j({ repo, pr, leg, runId: run.runId, attempts });
    }
    const obj = await env.STUDIO_ARCHIVE.get(key);
    if (obj === null) return j({ error: `no result for leg ${leg}`, runId: run.runId }, 404);
    const body = (await obj.json()) as Partial<LegOutput> | null;
    if (body === null || typeof body !== "object") return j({ error: `leg ${leg} result unreadable` }, 500);
    return j({
      repo, pr, leg, runId: run.runId, key,
      state: body.state, description: body.description, summary: body.summary, limits: body.limits,
      stdout: body.stdout ?? "", stderr: body.stderr ?? "",
      failing: failingLines(body as LegOutput),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`gate log failed for ${repo}#${pr} leg ${leg}`, err);
    if (/not[ _.-]?found/i.test(message)) return j({ error: `no such gate run or leg`, pr, leg }, 404);
    return j({ error: `gate log unavailable: ${redactSecrets(message)}` }, 500);
  }
}

/** The minimal R2 shape evidence listing needs. The real R2Bucket satisfies it. */
interface EvidenceBucket {
  list(opts: { prefix: string }): Promise<{ objects: { key: string }[] }>;
  get(key: string): Promise<{ body: ReadableStream | null; size: number } | null>;
}

/** #1343: every evidence key under a prefix, sorted for stable output. */
async function listEvidenceKeys(bucket: EvidenceBucket, prefix: string | null): Promise<string[]> {
  if (prefix === null) return [];
  const listed = await bucket.list({ prefix });
  return listed.objects.map((o) => o.key).sort();
}

/** One evidence file as `fleet gate log --evidence` prints it: its R2 key and
 *  the Worker's own serve URL (Access-gated, no credential). */
function evidenceLine(key: string): { key: string; url: string } {
  return { key, url: `/studio/gate/evidence/${key.split("/").map(encodeURIComponent).join("/")}` };
}

/** The evidence overview for a run: every evidence file under the run's
 *  evidence prefix, each with its serve URL. The verdict's target_url points
 *  here, so the operator opens one link and sees every leg's screens. */
async function evidenceLinesFor(bucket: EvidenceBucket, prefix: string): Promise<{ key: string; url: string }[]> {
  return (await listEvidenceKeys(bucket, prefix)).map(evidenceLine);
}

/** #1230: the carry for a `--failed-only` rerun, built from the PR's latest
 *  run — or the clean error Response to return in its place: 404 when there
 *  is no prior run (or its instance is gone behind a stale D1 pointer,
 *  reusing gateRunStatusSafe's own mapping), 409 when the prior run carries
 *  no leg results to carry from.
 *
 *  Maestro review (#1230): `latest.headSha` (from the D1 run index) is only
 *  the DISPATCH-TIME sha `recordRun` stored when the run was created — it is
 *  NOT necessarily what the run actually resolved and tested. A run that is
 *  slow to start can have its `resolve-pr` step do its live head read AFTER
 *  the PR moved again; if that later push dedupes back onto the same run id
 *  (gateRunId is deterministic on repo+sha), the run's own `headSha` in its
 *  output can differ from the index's stale label even though the index was
 *  never told the run tested something else. Trusting `latest.headSha` here
 *  would let legs that validated the WRONG commit ride forward as "green"
 *  for a later run of the right one. So the run's own `headSha` (from step 2
 *  below, `resolved.headSha` in workflow.ts) must agree with the index's
 *  before a carry is built at all; a mismatch is treated exactly like "no leg
 *  results to carry from", never a special case. */
async function carryGreenFromLatestRun(
  env: Env, repo: string, pr: number, index: GateRunIndex,
): Promise<CarryGreen | Response> {
  const latest = await index.latest(repo, pr);
  if (latest === null) return j({ error: "no prior gate run for this PR to rerun failed legs from" }, 404);
  const statusRes = await gateRunStatusSafe(env, latest.runId);
  if (statusRes.status !== 200) return statusRes;
  const statusBody = await statusRes.json() as {
    legs?: OutcomeLeg[]; baseSha?: string; planFingerprint?: string; headSha?: string;
  };
  if (
    statusBody.legs === undefined || statusBody.baseSha === undefined || statusBody.planFingerprint === undefined
    || statusBody.headSha === undefined || statusBody.headSha !== latest.headSha
  ) {
    return j({ error: "latest gate run has no leg results to carry" }, 409);
  }
  return {
    // The run's OWN resolved head sha is the ground truth; `latest.headSha`
    // above was only the check. They are confirmed equal at this point, but
    // the run's own value is the one that actually matches what its legs
    // tested.
    headSha: statusBody.headSha, baseSha: statusBody.baseSha, planFingerprint: statusBody.planFingerprint,
    // ms/summary ride along too (#1230 review): OutcomeLeg already carries
    // both, and the auto-infra-rerun carry (workflow.ts) passes full leg
    // results through, so this carry must not be the one path that drops them.
    legs: greenLegsOf(statusBody.legs).map((l) => (
      { leg: l.leg, state: "success" as const, description: l.description, ms: l.ms, summary: l.summary }
    )),
  };
}

/** The R2 key a /studio/gate/evidence file path names, or null when it is not
 *  an evidence key (the same shape outbound-handler.ts's EVIDENCE_RE pins for
 *  the container's writes — a serve path outside it is never read). */
const EVIDENCE_FILE_RE = /^gate\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/runs\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/evidence\/shard-[a-z0-9-]+(?:@head)?\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** Serve one evidence file, or list a run's evidence when no file is named.
 *  The run overview (the verdict target_url) lists every evidence file under
 *  the run's evidence prefix; the file path serves one blob. Both Access-gated
 *  like the rest of the gate route, so the operator's browser opens them. */
async function gateEvidenceSafe(env: Env, url: URL, file: string): Promise<Response> {
  try {
    // A path must be the exact evidence-file shape; anything else (traversal,
    // a result JSON, a baseline) is a 404, never a read.
    const key = file === "" ? "" : EVIDENCE_FILE_RE.test(file) ? file : "";
    if (file !== "" && key === "") return j({ error: "not found" }, 404);
    if (key !== "") {
      const obj = await env.STUDIO_ARCHIVE.get(key);
      if (obj === null) return j({ error: "not found" }, 404);
      const contentType = key.endsWith(".json") ? "application/json" : "application/octet-stream";
      return new Response(obj.body, { headers: { "content-length": String(obj.size), "content-type": contentType } });
    }
    const repo = url.searchParams.get("repo");
    const pr = Number(url.searchParams.get("pr"));
    const run = url.searchParams.get("run");
    if (!repo || !Number.isInteger(pr) || pr <= 0 || !run) {
      return j({ error: "repo, pr and run required" }, 400);
    }
    // Evidence overview: list under the run's evidence prefix, resolved
    // canonical-repo-first so keys match R2's case-sensitive store (#1119).
    const token = await repoTokenMinter(env)(repo);
    const canonical = (await getPullRequest(token, repo, pr)).repoFullName;
    const prefix = `gate/${canonical}/runs/${pr}/${run}/evidence/`;
    const lines = await evidenceLinesFor(env.STUDIO_ARCHIVE, prefix);
    return j({ repo, pr, run, evidence: lines });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not[ _.-]?found/i.test(message)) return j({ error: `no such gate run or evidence` }, 404);
    return j({ error: `gate evidence unavailable: ${redactSecrets(message)}` }, 500);
  }
}

export async function handleGateRoute(
  req: Request, env: Env, headShaOf: (repo: string, pr: number) => Promise<string> = liveHeadSha(env),
  protect: ProtectPort = realProtectPort(env),
): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/studio/gate/protect" && req.method === "POST") {
    const body = (await req.json()) as { repo?: unknown };
    if (typeof body.repo !== "string" || !body.repo.includes("/")) {
      return j({ error: "repo required as owner/name" }, 400);
    }
    try {
      const result = await runGateProtect(protect, body.repo);
      return j(result);
    } catch (err) {
      // A repo typo is a 404 the operator must see, not a generic 500 — same
      // 404->404 / else->502 split the board's upstreamFailure makes, with the
      // underlying message preserved either way (and redacted the same way,
      // defense-in-depth against a future error echoing a header).
      const message = err instanceof Error ? err.message : String(err);
      const status = /\((\d{3})\)/.exec(message)?.[1];
      const redacted = redactSecrets(message);
      if (status === "404") return j({ error: redacted }, 404);
      console.error("gate protect failed", err);
      return j({ error: `gate protect failed: ${redacted}` }, 502);
    }
  }

  if (url.pathname === "/studio/gate/start" && req.method === "POST") {
    const body = (await req.json()) as { repo: string; pr: number; failedOnly?: boolean };
    if (env.FLEET_GATE_RUNNER !== "on" || !isGateRunnerRepo(env.GATE_RUNNER_REPOS, body.repo)) {
      return j({ error: "gate runner not enabled for this repo" }, 404);
    }
    // #1232: a Worker deploy is draining — the manual start queues as pending
    // instead of creating a run the deploy would kill. The id-less manual form
    // carries no headSha to queue, so it is told to wait rather than queued.
    if (await gateDraining(env.DB)) {
      return j({ started: false, pending: true });
    }
    // #1276: the head-sha read is one GitHub GET that can hit the installation's
    // hourly REST quota. A throw here reached Cloudflare's HTML 500 page and the
    // CLI's `res.json()` crashed on "Failed to parse JSON". Guard it: JSON 503,
    // the same shape gateRunStatusSafe returns for its own throw, so the CLI sees
    // a parseable body and the real cause, never an HTML page.
    let headSha: string;
    try {
      headSha = await headShaOf(body.repo, body.pr);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`gate start: head sha read failed for ${body.repo}#${body.pr}`, err);
      return j({ error: `gate start unavailable: ${redactSecrets(message)}` }, 503);
    }
    const index = d1RunIndex(env.DB);
    // #1230: `fleet gate run --failed-only` reruns only the legs the PR's
    // latest run did not already go green on. The new run still targets the
    // LIVE head sha above; a head that moved since `latest` is caught by
    // carriedGreenByLeg's own headSha check (a full replan), never a special
    // case here.
    if (body.failedOnly === true) {
      const carryGreen = await carryGreenFromLatestRun(env, body.repo, body.pr, index);
      if (carryGreen instanceof Response) return carryGreen;
      const run = await startManualGateRun(workflow(env), { repo: body.repo, pr: body.pr, headSha, carryGreen }, index);
      return j({ started: true, runId: run.runId, reused: run.reused });
    }
    const run = await startManualGateRun(workflow(env), { repo: body.repo, pr: body.pr, headSha }, index);
    return j({ started: true, runId: run.runId, reused: run.reused });
  }

  if (url.pathname === "/studio/gate/status" && req.method === "GET") {
    const repo = url.searchParams.get("repo") ?? "";
    if (env.FLEET_GATE_RUNNER !== "on" || !isGateRunnerRepo(env.GATE_RUNNER_REPOS, repo)) {
      return j({ error: "gate runner not enabled for this repo" }, 404);
    }
    const runId = url.searchParams.get("runId");
    if (!runId) return j({ error: "runId required" }, 400);
    return await gateRunStatusSafe(env, runId);
  }

  // #1277: read one leg's final R2 output. Same Access-gated lane as /status;
  // the R2 read needs no Cloudflare cred in the CLI — the Worker does it here.
  if (url.pathname === "/studio/gate/log" && req.method === "GET") {
    const repo = url.searchParams.get("repo") ?? "";
    if (env.FLEET_GATE_RUNNER !== "on" || !isGateRunnerRepo(env.GATE_RUNNER_REPOS, repo)) {
      return j({ error: "gate runner not enabled for this repo" }, 404);
    }
    const pr = Number(url.searchParams.get("pr"));
    const leg = url.searchParams.get("leg") ?? "";
    if (!Number.isInteger(pr) || pr <= 0) return j({ error: "pr required as a positive integer" }, 400);
    if (!/^[a-z0-9][a-z0-9-]{0,39}(?:@head(?:-\d+)?)?$/.test(leg)) return j({ error: "leg required" }, 400);
    // Only all=1 / all=true means --all; any other value (or none) is the
    // single-key final-try read (#1318 r1). evidence=1 lists the leg's
    // evidence files instead (for `fleet gate log --evidence`, #1343).
    const allParam = url.searchParams.get("all");
    const all = allParam === "1" || allParam === "true";
    const evidenceParam = url.searchParams.get("evidence");
    const evidence = evidenceParam === "1" || evidenceParam === "true";
    return await gateLegLogSafe(env, repo, pr, leg, url.searchParams.get("run") ?? undefined, all, evidence);
  }

  // #1343: serve one evidence file (a screenshot, a console JSON), and list the
  // run's evidence when no file is named (the verdict target_url lands here).
  if (url.pathname.startsWith("/studio/gate/evidence") && req.method === "GET") {
    return await gateEvidenceSafe(env, url, url.pathname.slice("/studio/gate/evidence".length).replace(/^\/+/, ""));
  }

  return j({ error: "not found" }, 404);
}

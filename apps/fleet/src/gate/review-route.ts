// #1469: /studio/review/start + /studio/review/status — the cloud PR review
// route. Pure handlers over injected ports (head sha, compare, status post,
// board read, spawn, D1 index); the real wiring lives in studio/routes.ts,
// which mounts this on the same Access-gated lane as /studio/gate/*. No Env,
// no token, no fetch of self here.
import {
  decideReviewStart, postReviewStatus, reviewBlocking, reviewLeadType,
  reviewSkipDescription, reviewVerdict, REVIEW_PENDING_DESCRIPTION, REVIEWER_ROLE,
  type ReviewAxis, type ReviewState, type ReviewStatusPort,
} from "./review";
import type { ReviewConfig } from "./config";
import { repoIdSegment } from "../studio/repo";

/** The D1 pointer for one PR's review: the head sha and reviewer studio id. */
export interface ReviewRunRecord {
  headSha: string;
  studioId: string;
  task: number;
}

/** The D1 index: one row per (repo, pr), overwritten by each new head. */
export interface ReviewRunIndex {
  latest(repo: string, pr: number): Promise<ReviewRunRecord | null>;
  record(repo: string, pr: number, run: ReviewRunRecord): Promise<void>;
}

/** The board read this route needs: file the review task and read its latest
 *  result envelope status back. */
export interface ReviewBoard {
  createTask(repo: string, brief: { title: string; objective: string; outputFormat: string; boundaries: string; assignee: string; idempotencyKey: string }): Promise<number>;
  latestEnvelopeStatus(repo: string, task: number): Promise<string | undefined>;
}

/** The read-only reviewer spawn: one /studio/spawn-equivalent call. */
export type ReviewSpawn = (
  repo: string, role: string, leadType: "claude" | "glm", task: number,
) => Promise<string>;

/** The real GitHub reads the start route needs, split out for tests. */
export interface ReviewPort {
  /** The PR's head sha and base sha, in one read. */
  pr(repo: string, pr: number): Promise<{ headSha: string; baseSha: string }>;
  changedFiles(repo: string, baseSha: string, headSha: string): Promise<string[]>;
  /** The repo's review config at its default branch (never the PR head). */
  reviewConfig(repo: string): Promise<ReviewConfig | null>;
  status: ReviewStatusPort;
}

/** The repo's review run in flight, or the terminal verdict to hand back. */
export type ReviewStartResult =
  | { kind: "noop"; line: string }
  | { kind: "started"; studioId: string; task: number }
  | { kind: "already"; line: string };

/** Builds the review task brief a read-only reviewer boots with. The reviewer
 *  reads the diff and repo files, posts findings as one comment, and reports
 *  a status via its envelope. No secrets, no push, no merge, no test run. */
export function reviewBrief(repo: string, pr: number, axis: ReviewAxis | undefined, blocking: boolean): {
  title: string; objective: string; outputFormat: string; boundaries: string;
} {
  const axisLine = axis === undefined ? "all three axes (spec, standards, security)" : `the ${axis} axis only`;
  return {
    title: `review ${repo}#${pr} (${axis ?? "spec|standards|security"})`,
    objective: `Review the diff of PR #${pr} in ${repo} at its current head sha, for ${axisLine}. ` +
      `Read the diff and the repo files it touches, nothing else. ` +
      `Post your findings as one comment on this task, then report a result envelope: ` +
      `status "ok" when the diff passes, "blocked" when it has findings that must be fixed${blocking ? " (this repo blocks these paths)" : ""}.`,
    outputFormat: "One findings comment plus one result envelope (fleet task report). Findings cite file and line.",
    boundaries: "Read-only reviewer: no Edit, no Write, no push, no merge, no secrets, no test run. Read the diff and repo files only.",
  };
}

/** The start route: resolve the PR, decide (disabled / skip / already / run),
 *  spawn the reviewer + file its task, record the run, post a pending status. */
export async function runReviewStart(
  port: ReviewPort, board: ReviewBoard, spawn: ReviewSpawn, index: ReviewRunIndex,
  input: { repo: string; pr: number; axis?: ReviewAxis },
): Promise<ReviewStartResult> {
  const { headSha: head, baseSha } = await port.pr(input.repo, input.pr);
  const files = await port.changedFiles(input.repo, baseSha, head);
  const cfg = await port.reviewConfig(input.repo);

  const existing = await port.status.get(
    await port.status.mintToken(input.repo), input.repo, head,
  ).catch(() => undefined);
  const decision = decideReviewStart({ review: cfg, changedFiles: files, existingState: existing?.state });

  if (decision.action === "disabled") {
    return { kind: "noop", line: `review disabled for ${input.repo}` };
  }
  if (decision.action === "skip") {
    const description = reviewSkipDescription(decision.reason);
    await postReviewStatus(port.status, input.repo, head, { state: "neutral", description });
    return { kind: "noop", line: `review: neutral — ${description}` };
  }
  if (decision.action === "already-reviewed") {
    return { kind: "already", line: `review: head ${head.slice(0, 8)} already reviewed` };
  }

  // A live run of the same head already in the index is the same dedup, even
  // when its status post has not landed yet. One reviewer per head, never two.
  const live = await index.latest(input.repo, input.pr);
  if (live !== null && live.headSha === head) {
    return { kind: "already", line: `review: head ${head.slice(0, 8)} already reviewed` };
  }

  const config = decision.config;
  const blocking = reviewBlocking(files, config.blockingPaths);
  // The reviewer studio id's repo segment is the id-normalized short name
  // (dots/underscores fold to hyphens), the same rule runSpawn derives a child
  // id from. A repo whose short name cannot name a studio is refused before
  // any spawn or task write.
  const segment = repoIdSegment(input.repo.split("/")[1] ?? input.repo);
  if (segment === null) throw new Error(`review: repo ${input.repo} cannot name a reviewer studio`);
  const task = await board.createTask(input.repo, {
    ...reviewBrief(input.repo, input.pr, input.axis, blocking),
    assignee: `${segment}--${REVIEWER_ROLE}`,
    idempotencyKey: `review-${segment}-${input.pr}-${head.slice(0, 8)}`,
  });
  const studioId = await spawn(input.repo, REVIEWER_ROLE, reviewLeadType(config.lead), task);
  await index.record(input.repo, input.pr, { headSha: head, studioId, task });
  // Best-effort pending: the verdict post is the authoritative one. A failed
  // pending is logged, never a second reviewer (the index row already holds
  // the dedup for the head).
  await postReviewStatus(port.status, input.repo, head, { state: "pending", description: REVIEW_PENDING_DESCRIPTION }).catch((err) => {
    console.error(`review: pending status post failed for ${input.repo}#${input.pr}`, err);
  });
  return { kind: "started", studioId, task };
}

/** The status route: read the run, read the reviewer's latest result envelope
 *  status, map to a verdict, post it, return it. */
export async function runReviewStatus(
  port: ReviewPort, board: ReviewBoard, index: ReviewRunIndex,
  input: { repo: string; pr: number },
): Promise<{ state: ReviewState | "pending"; description?: string }> {
  const run = await index.latest(input.repo, input.pr);
  if (run === null) return { state: "pending" };
  const envelopeStatus = await board.latestEnvelopeStatus(input.repo, run.task);
  // No result envelope yet -> still pending.
  if (envelopeStatus === undefined) return { state: "pending" };

  const { baseSha } = await port.pr(input.repo, input.pr).catch(() => ({ baseSha: "" as string }));
  const files = baseSha === "" ? [] : await port.changedFiles(input.repo, baseSha, run.headSha).catch(() => []);
  const cfg = await port.reviewConfig(input.repo).catch(() => null);
  const blocking = reviewBlocking(files, cfg?.blockingPaths ?? []);

  const state = reviewVerdict({ blocking, envelopeStatus });
  const description = state === "success" ? "review passed" : state === "failure" ? "review found blocking issues" : "review advisory findings";
  await postReviewStatus(port.status, input.repo, run.headSha, { state, description }).catch((err) => {
    console.error(`review: verdict post failed for ${input.repo}#${input.pr}`, err);
  });
  return { state, description };
}

/** The route's dependencies, injected by the mount point. */
export interface ReviewRouteDeps {
  port: ReviewPort;
  board: ReviewBoard;
  spawn: ReviewSpawn;
  index: ReviewRunIndex;
}

/** Dispatches /studio/review/* to the start/status handlers. No auth here —
 *  the mount point (handleStudio) already ran verifyAccess. */
export async function handleReviewRoute(
  req: Request, deps: ReviewRouteDeps,
): Promise<Response> {
  const url = new URL(req.url);
  const j = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

  if (url.pathname === "/studio/review/start" && req.method === "POST") {
    const body = (await req.json()) as { repo?: unknown; pr?: unknown; axis?: unknown };
    if (typeof body.repo !== "string" || !body.repo.includes("/")) {
      return j({ error: "repo required as owner/name" }, 400);
    }
    const pr = Number(body.pr);
    if (!Number.isInteger(pr) || pr <= 0) return j({ error: "pr required as a positive integer" }, 400);
    if (body.axis !== undefined && body.axis !== "spec" && body.axis !== "standards" && body.axis !== "security") {
      return j({ error: 'axis must be spec, standards or security' }, 400);
    }
    try {
      const result = await runReviewStart(deps.port, deps.board, deps.spawn, deps.index, {
        repo: body.repo, pr, axis: body.axis as ReviewAxis | undefined,
      });
      if (result.kind === "started") return j({ started: true, studioId: result.studioId, task: result.task });
      if (result.kind === "already") return j({ started: false, line: result.line });
      return j({ noop: true, line: result.line });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`review start failed for ${body.repo}#${pr}`, err);
      return j({ error: `review start failed: ${message}` }, 502);
    }
  }

  if (url.pathname === "/studio/review/status" && req.method === "GET") {
    const repo = url.searchParams.get("repo") ?? "";
    const pr = Number(url.searchParams.get("pr"));
    if (!repo.includes("/")) return j({ error: "repo required as owner/name" }, 400);
    if (!Number.isInteger(pr) || pr <= 0) return j({ error: "pr required as a positive integer" }, 400);
    try {
      return j(await runReviewStatus(deps.port, deps.board, deps.index, { repo, pr }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`review status failed for ${repo}#${pr}`, err);
      return j({ error: `review status failed: ${message}` }, 502);
    }
  }

  return j({ error: "not found" }, 404);
}
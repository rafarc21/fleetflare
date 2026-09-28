// The memory surface. P5 §9's compaction pass, wired.
//
// Two paths, one handler, because a compaction has two callers with two
// different credentials and exactly one behaviour:
//
//   /studio/memory*   Cloudflare-Access authed — the Mac CLI (`fleet memory`)
//   /fleet/memory*    spawn-token authed — the Release Studio, at sprint close
//
// Same split, same reason, as src/board/routes.ts's handleBoard vs
// handleFleetBoard: a container holds a spawn token, never an Access service
// token, and the Access application is scoped to the `/studio` PATH. A studio
// id always contains `--` (src/studio/ids.ts), so the literal `memory` can
// never collide with one.
//
// WHEN this runs: sprint close. §9 — "Release Studio already harvests there;
// extend that pass rather than inventing a ritual." There is no cron and no
// schedule here on purpose; a compaction that fires on its own is a
// compaction nobody is reading the PR for.

import { resolveMemoryRepo } from "./store";
import type { Env } from "../env";
import { verifyAccess } from "../studio/auth";
import { repoTokenMinter } from "../github/auth";
import {
  fetchRepoFile, listRepoTree, commitFilesOnNewBranch, openPullRequest, getDefaultBranch,
} from "../github/api";
import { listIssueTexts, GitHubError } from "../board/api";
import { listStudios } from "../studio/registry";
import { isSpawnTokenShaped, resolveSpawnParent, SPAWN_TOKEN_HEADER } from "../studio/spawn";
import { redactSecrets } from "../studio/redact";
import type { StudioStatus } from "../studio/types";
import { MEMORY_DIR, MEMORY_INDEX_PATH } from "./index-file";
import {
  surveyMemory, planCompaction, type CompactionProposal, type MemorySource, type TaskCitation,
} from "./compact";

const MEMORY_ROUTE_RE = /^\/(?:studio|fleet)\/memory(?:\/(compact))?$/;

/**
 * How many memory files one pass will read. A survey costs one fetch per file
 * (the bytes are needed to bootstrap an index line and to move a file into
 * archive/), and a Worker has a finite subrequest budget. §9 sizes the index
 * at ~60 lines, so this is generous by more than double — the same "orders of
 * magnitude, not a tight fit" sizing github/api.ts's own caps use. Exceeding
 * it refuses loudly rather than silently surveying a subset, which would let
 * an unread file look uncited and get demoted.
 */
export const MEMORY_SURVEY_MAX_FILES = 150;

/**
 * Everything this route needs from the outside world, as one port. Tests hand
 * it a plain object; `githubMemoryDeps` below is the only wired
 * implementation. Same seam shape src/board/routes.ts's `api` parameter
 * already is, for the same reason: nothing here can run under the test pool
 * with a live GitHub call in it.
 */
export interface MemoryDeps {
  /** The blueprint repo — where fleet memory lives (§7). Resolved from
   *  fleet.json exactly as harvestLearnings resolves its write target, so the
   *  read side and the write side can never point at different repos. */
  /** Issue #341: the memory store (FLEET_OPS_REPO), or null when memory is off. */
  memoryRepo: () => Promise<string | null>;
  listTree: (repo: string, ref: string) => Promise<string[]>;
  fetchFile: (repo: string, path: string, ref: string) => Promise<string>;
  /** The citation corpus: every task's body plus its comments, plus whether
   *  board/api.ts's listIssueTexts hit its page bound before covering every
   *  issue (issue #187) — `handleMemory` surfaces that flag to the caller
   *  rather than reporting a partial survey as a complete one. */
  taskTexts: (repo: string) => Promise<{ citations: TaskCitation[]; truncated: boolean }>;
  defaultBranch: (repo: string) => Promise<string>;
  commit: (
    repo: string, base: string, branch: string, message: string,
    changes: { path: string; content: string | null }[],
  ) => Promise<string>;
  openPr: (repo: string, head: string, base: string, title: string, body: string) => Promise<{ number: number; url: string }>;
  /** Registry rows, for the spawn-token surface only. Injected for the same
   *  reason handleFleetBoard injects its own: a D1 read cannot run under the
   *  test pool without one. */
  studios: () => Promise<StudioStatus[]>;
  now: () => Date;
}

/** P6a: one credential per repo OWNER (src/github/auth.ts's repoTokenMinter),
 *  memoised across the several calls one compaction pass makes. A memory pass
 *  touches the fleet repo, the blueprint repo and the board repo, and under a
 *  mixed config those need not share an owner — so each call asks for the
 *  credential its own repo's owner uses, rather than one shared token. */
export function githubMemoryDeps(env: Env): MemoryDeps {
  const token = repoTokenMinter(env);
  return {
    memoryRepo: async () => resolveMemoryRepo(env),
    listTree: async (repo, ref) => listRepoTree(await token(repo), repo, ref),
    fetchFile: async (repo, path, ref) => fetchRepoFile(await token(repo), repo, path, ref),
    // Issue #167: batched over GraphQL (board/api.ts's listIssueTexts) rather
    // than a `listIssues` + per-issue `listComments` REST loop — see that
    // function's doc comment for the subrequest math. Same join order the old
    // loop produced: title, body, then comment bodies in GitHub's own order.
    taskTexts: async (repo) => {
      const t = await token(repo);
      const { issues, truncated } = await listIssueTexts(t, repo);
      return {
        citations: issues.map((i): TaskCitation => ({
          number: i.number,
          text: [i.title, i.body, ...i.comments].join("\n"),
        })),
        truncated,
      };
    },
    defaultBranch: async (repo) => getDefaultBranch(await token(repo), repo),
    commit: async (repo, base, branch, message, changes) =>
      commitFilesOnNewBranch(await token(repo), repo, base, branch, message, changes),
    openPr: async (repo, head, base, title, body) => openPullRequest(await token(repo), repo, head, base, title, body),
    studios: () => listStudios(env),
    now: () => new Date(),
  };
}

/**
 * Reads the whole memory tree at the blueprint repo's default branch — the
 * SAME branch harvestLearnings commits to (github/api.ts's createRepoFile
 * sends no `branch`, so GitHub writes to the default). Reading at a pinned
 * blueprint ref instead would let a compaction pass survey an older tree than
 * the one it is about to rewrite, and archive files that are not there.
 *
 * A missing INDEX.md is not a failure: it is the bootstrap case, and the pass
 * builds the first index from the files' own frontmatter.
 */
async function readMemory(
  deps: MemoryDeps, repo: string, ref: string,
): Promise<{ indexMd: string; sources: MemorySource[] } | { error: string }> {
  const paths = (await deps.listTree(repo, ref)).filter(
    (p) => p.startsWith(`${MEMORY_DIR}/`) && p.endsWith(".md") && p !== MEMORY_INDEX_PATH,
  );
  if (paths.length > MEMORY_SURVEY_MAX_FILES) {
    return { error: `${repo} holds ${paths.length} memory files, over the ${MEMORY_SURVEY_MAX_FILES} this pass reads in one go` };
  }
  let indexMd = "";
  try {
    indexMd = await deps.fetchFile(repo, MEMORY_INDEX_PATH, ref);
  } catch (err) {
    // A 404 is the bootstrap case. Anything else is a real failure and must
    // not read as "there is no index" — that would silently regenerate one
    // over a tree whose real index simply could not be fetched.
    if (!(err instanceof Error && err.message.includes("(404)"))) throw err;
  }
  const sources: MemorySource[] = [];
  for (const path of paths) sources.push({ path, content: await deps.fetchFile(repo, path, ref) });
  return { indexMd, sources };
}

function jsonBody(req: Request): Promise<Record<string, unknown>> {
  return req.json<Record<string, unknown>>().catch(() => ({}));
}

/**
 * `mode` is decided by the mount in src/index.ts, never by anything in the
 * request — the path prefix IS the credential boundary.
 */
export async function handleMemory(
  req: Request, env: Env, deps: MemoryDeps = githubMemoryDeps(env),
): Promise<Response> {
  const url = new URL(req.url);
  const m = MEMORY_ROUTE_RE.exec(url.pathname);
  if (!m) return new Response("not found", { status: 404 });
  const compacting = m[1] === "compact";

  const method = req.method;
  if (compacting ? method !== "POST" : method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }

  if (url.pathname.startsWith("/studio/")) {
    const failure = await verifyAccess(req, env);
    if (failure) return failure;
  } else {
    // Shape gate before any I/O, exactly as handleFleetBoard does it: this
    // surface is deliberately Access-less, so an unauthenticated flood must
    // cost one regex, not a D1 query each.
    const presented = req.headers.get(SPAWN_TOKEN_HEADER);
    if (!isSpawnTokenShaped(presented)) return new Response("unauthorized", { status: 401 });
    if (!(await resolveSpawnParent(await deps.studios(), presented))) {
      return new Response("unauthorized", { status: 401 });
    }
  }

  // The BOARD repo (where tasks are) is not necessarily the BLUEPRINT repo
  // (where memory is) — repo.ts's FLEET/BLUEPRINT/WORK split. Citations are
  // counted over the board; the tree is read from the blueprint.
  const boardRepo = (url.searchParams.get("repo") ?? env.AGENT_REPO).toLowerCase();

  try {
    const repo = await deps.memoryRepo();
    if (repo === null) {
      return new Response("memory store off: FLEET_OPS_REPO is not set on this Worker -- nothing to survey or compact", { status: 409 });
    }
    const ref = await deps.defaultBranch(repo);
    const read = await readMemory(deps, repo, ref);
    if ("error" in read) return new Response(read.error, { status: 409 });
    // `surveyMemory`'s own (pure, independently-tested) core takes a plain
    // TaskCitation[] and stays that way — the truncation flag is plumbing
    // this route layer carries, not something the compaction judgment itself
    // needs to know about.
    const { citations, truncated } = await deps.taskTexts(boardRepo);
    const survey = surveyMemory(read.indexMd, read.sources, citations, deps.now());

    if (!compacting) {
      return Response.json({
        repo, ref, boardRepo,
        index: survey.entries,
        files: survey.files,
        unindexed: survey.unindexed,
        candidates: survey.candidates,
        truncated,
      });
    }

    const body = await jsonBody(req);
    const proposal = (body.proposal ?? body) as CompactionProposal;
    const planned = planCompaction(survey, proposal, deps.now());
    if (!planned.ok) return new Response(planned.message, { status: planned.status });

    const { plan } = planned;
    const sha = await deps.commit(repo, ref, plan.branch, plan.title, plan.changes);
    const pr = await deps.openPr(repo, plan.branch, ref, plan.title, plan.body);
    return Response.json({
      repo, branch: plan.branch, commit: sha, pr: pr.number, url: pr.url, summary: plan.summary, truncated,
    });
  } catch (err) {
    const status = err instanceof GitHubError ? err.status : 502;
    return new Response(redactSecrets(err instanceof Error ? err.message : String(err)), {
      status: status >= 400 && status < 500 ? status : 502,
    });
  }
}

// GitHub's Issues API, as the board uses it. Same contract as
// src/github/api.ts and for the same reasons: the caller mints the
// short-lived installation token (src/github/app.ts), this module never mints
// its own, and any non-2xx throws GitHub's own words — it explains "Validation
// Failed", "Not Found" and a bad milestone better than we would. The token
// never appears in a thrown message.
//
// Separate file from src/github/api.ts, not more functions inside it: that one
// is the DEPLOY path's GitHub (merge a PR, read a blueprint file, list the
// installation's repos). This one is the BOARD's, and the board is the single
// writer of task state — keeping the two apart is what makes "who can write a
// label" answerable by reading one directory.
//
// No caching and no backoff, deliberately. An installation token is worth
// 5,000+ requests/hour and a sprint is 20-30 tasks; machinery for a rate limit
// this scale cannot reach would be machinery with no failing case to test.

import { taskAssignees, taskStates, type BoardTask } from "./types";

const GITHUB_API = "https://api.github.com";
// Issue #331: a neutral product name, not the App's own bot slug
// (the operator's own App slug) — GitHub asks the User-Agent identify the calling
// CLIENT, and an OSS adopter running their own App installation should not
// see the operator's name in their own outbound requests. Same value
// src/github/api.ts and src/github/app.ts send.
const USER_AGENT = "fleetflare";

/**
 * GitHub's own per-page maximum. `listComments` and `listMilestones` stay at
 * one page of this size each — a sprint is 20-30 tasks (§5), so a second page
 * is out of reach at their scale. `listIssues` uses this as its page size too,
 * but paginates past it (see `BOARD_MAX_PAGES`) once a repo's issue+PR history
 * outgrows one page.
 */
export const BOARD_PAGE_SIZE = 100;

/**
 * Hard ceiling on how many pages `listIssues` will follow. At `BOARD_PAGE_SIZE`
 * per page this covers up to 2,000 issues+PRs (state=all) in one call —
 * generous past anything a studio's history will produce (§5's busiest label
 * measured 2026-09-24: 28) — while still finite: an unbounded loop turns one
 * unexpectedly huge repo into a request storm this Worker would never notice
 * sending. A run that hits this bound reports a truncation rather than
 * silently dropping older issues; see `listIssues`.
 */
export const BOARD_MAX_PAGES = 20;

/**
 * A failed GitHub call, carrying the status alongside GitHub's own words.
 *
 * The status is on the error rather than parsed back out of the message
 * because the route layer has to tell two very different failures apart: a
 * task number that does not exist is the CALLER's 404, while a 500 or a
 * revoked token is OURS and must not be reported as the caller's mistake.
 * Sniffing "(404)" out of a message string would make that distinction depend
 * on the wording of a message meant for humans.
 */
export class GitHubError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

function authHeaders(token: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
  };
  if (hasBody) headers["content-type"] = "application/json";
  return headers;
}

async function ghJson<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: authHeaders(token, body !== undefined),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new GitHubError(res.status, `${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

/**
 * Like `ghJson`, but also hands back the raw `Response` — `listIssues` is the
 * only caller in this file that needs a response header (`Link`, for
 * pagination), so this stays a private twin rather than a flag threaded
 * through `ghJson` and every one of its other callers.
 */
async function ghJsonWithHeaders<T>(token: string, method: string, url: string): Promise<{ body: T; res: Response }> {
  const res = await fetch(url, { method, headers: authHeaders(token, false) });
  const text = await res.text();
  if (!res.ok) throw new GitHubError(res.status, `${method} ${url} failed (${res.status}): ${text.slice(0, 300)}`);
  return { body: (text === "" ? undefined : JSON.parse(text)) as T, res };
}

/** Pulls the `rel="next"` URL out of a GitHub `Link` response header
 *  (`<url>; rel="next", <url>; rel="last"`), or null on the last page. */
function nextPageUrl(linkHeader: string | null): string | null {
  if (linkHeader === null) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]*)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

/** GitHub's issue shape, only the fields the board reads. `pull_request` is
 *  present iff the "issue" is really a PR — the Issues API returns both. */
interface RawIssue {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  state: string;
  labels?: ({ name?: string } | string)[];
  milestone?: { title?: string } | null;
  updated_at?: string;
  state_reason?: string | null;
  pull_request?: unknown;
}

function labelNames(raw: RawIssue): string[] {
  // GitHub returns objects here, but the string form is still valid in its own
  // schema and costs one line to accept — a shape surprise must not turn a
  // whole listing into a task with no labels, which would read as drift.
  return (raw.labels ?? [])
    .map((l) => (typeof l === "string" ? l : l.name ?? ""))
    .filter((n) => n !== "");
}

export function toBoardTask(raw: RawIssue): BoardTask {
  const labels = labelNames(raw);
  const states = taskStates(labels);
  const assignees = taskAssignees(labels);
  return {
    number: raw.number,
    url: raw.html_url,
    title: raw.title,
    body: raw.body ?? "",
    // Exactly one state label is a healthy task. Zero or two mean a writer
    // other than this Worker touched the issue; null carries that to the
    // caller instead of picking one and papering over it.
    state: states.length === 1 ? states[0] : null,
    labels,
    // Same rule as `state` one line up, applied to the assignment label: one
    // is an answer, zero or two are drift the caller has to be able to see.
    assignee: assignees.length === 1 ? assignees[0] : null,
    milestone: raw.milestone?.title ?? null,
    open: raw.state === "open",
    reopened: raw.state_reason === "reopened",
    updatedAt: raw.updated_at ?? "",
  };
}

export interface IssueInput {
  title: string;
  body: string;
  labels: string[];
  /** GitHub takes the milestone NUMBER, never its title — the board resolves
   *  the sprint's title to this before calling (see board.ts). */
  milestone?: number;
}

export async function createIssue(token: string, repo: string, input: IssueInput): Promise<BoardTask> {
  const body: Record<string, unknown> = { title: input.title, body: input.body, labels: input.labels };
  // Omitted rather than sent as null: GitHub reads an explicit null as
  // "remove the milestone", which is a different request than "no opinion".
  if (input.milestone !== undefined) body.milestone = input.milestone;
  return toBoardTask(await ghJson<RawIssue>(token, "POST", `/repos/${repo}/issues`, body));
}

export async function getIssue(token: string, repo: string, number: number): Promise<BoardTask> {
  return toBoardTask(await ghJson<RawIssue>(token, "GET", `/repos/${repo}/issues/${number}`));
}

export interface ListIssuesQuery {
  milestone?: number;
  labels?: string[];
}

/**
 * Every issue in a repo (up to `BOARD_MAX_PAGES` pages), mapped and with pull
 * requests removed — the Issues API returns PRs as issues, and a PR is never
 * a task.
 *
 * Paginates past GitHub's `BOARD_PAGE_SIZE`-per-page maximum by following the
 * `Link` response header's `rel="next"` (issue #148: a single page silently
 * hid every issue older than the newest ~100 once a repo passed that count).
 * Pages are concatenated in the order GitHub sends them — page 1's items
 * first, newest first within each page — NEVER sorted or reversed: `findByKey`
 * in board.ts resolves a duplicate to the OLDEST match via `.at(-1)`, which is
 * only correct because that order survives pagination intact.
 *
 * If the bound is reached while GitHub still reports a next page, that is a
 * truncation, not an empty result: it is reported via `console.error` (same
 * fail-open posture as close-action.ts's board-state-drift log) and this
 * still returns everything fetched so far, rather than throwing over an edge
 * case with no real repo close to it yet.
 *
 * A `next` URL is only ever followed when its origin — scheme, host AND
 * port, via `new URL(next).origin` — is exactly GitHub's own API origin: the
 * bearer token was minted for `api.github.com` and must never be sent
 * anywhere else. A plain string-prefix check would wrongly pass look-alikes
 * like `https://api.github.com.evil.example` (a subdomain of `evil.example`)
 * or `https://api.github.com:8443` (a different port); an unparseable `next`
 * fails closed the same way. A `next` that fails this check stops the walk
 * right there (same fail-open-but-log posture as the truncation above)
 * instead of being followed — this should never happen from GitHub's real
 * Link header, so seeing it logged means something upstream of this function
 * is wrong.
 *
 * `state=all` always: GitHub's open/closed is not the board's state
 * vocabulary, so a task that reached `completed` still reports its board state
 * after sprint close closes the issue.
 */
export async function listIssues(token: string, repo: string, query: ListIssuesQuery): Promise<BoardTask[]> {
  const params = new URLSearchParams({ state: "all", per_page: String(BOARD_PAGE_SIZE) });
  if (query.milestone !== undefined) params.set("milestone", String(query.milestone));
  if (query.labels?.length) params.set("labels", query.labels.join(","));

  const raw: RawIssue[] = [];
  let next: string | null = `${GITHUB_API}/repos/${repo}/issues?${params.toString()}`;
  let pages = 0;
  while (next !== null && pages < BOARD_MAX_PAGES) {
    const { body, res } = await ghJsonWithHeaders<RawIssue[]>(token, "GET", next);
    raw.push(...body);
    pages++;
    next = nextPageUrl(res.headers.get("link"));
    // The bearer token must never leave the GitHub host it was minted for —
    // a `next` URL pointing anywhere else is treated as "no more pages"
    // (fail open, same posture as the truncation report below) rather than
    // followed, and the anomaly is logged since it should never happen from
    // GitHub's own Link header.
    //
    // This is a genuine origin comparison (`new URL(...).origin`), not a
    // string-prefix check: a prefix check lets `https://api.github.com.evil.
    // example` and `https://api.github.comevil.example` through (both start
    // with the right characters, neither IS the right host) and can't tell
    // `https://api.github.com:8443` apart from the real, default-port origin
    // either. An unparseable `next` fails closed the same way — off-host.
    if (next !== null) {
      let host = next;
      let sameOrigin: boolean;
      try {
        const url = new URL(next);
        host = url.host;
        sameOrigin = url.origin === GITHUB_API;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) {
        console.error(`listIssues: ${repo}'s next-page link pointed off-host (${host}) — pagination stopped, not followed`);
        next = null;
      }
    }
  }
  if (next !== null) {
    console.error(
      `listIssues: ${repo} has more issues than the ${BOARD_MAX_PAGES}-page bound covers ` +
      `(fetched ${pages} pages, ${raw.length} items) — result truncated`,
    );
  }
  return raw.filter((i) => i.pull_request === undefined).map(toBoardTask);
}

export async function addLabels(token: string, repo: string, number: number, labels: string[]): Promise<void> {
  await ghJson(token, "POST", `/repos/${repo}/issues/${number}/labels`, { labels });
}

export async function removeLabel(token: string, repo: string, number: number, label: string): Promise<void> {
  await ghJson(token, "DELETE", `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`);
}

export async function createComment(
  token: string, repo: string, number: number, body: string,
): Promise<{ id: number; url: string }> {
  const raw = await ghJson<{ id: number; html_url: string }>(
    token, "POST", `/repos/${repo}/issues/${number}/comments`, { body },
  );
  return { id: raw.id, url: raw.html_url };
}

export interface BoardComment {
  id: number;
  url: string;
  author: string;
  createdAt: string;
  body: string;
}

export async function listComments(token: string, repo: string, number: number): Promise<BoardComment[]> {
  const raw = await ghJson<{ id: number; html_url: string; body?: string; created_at?: string; user?: { login?: string } }[]>(
    token, "GET", `/repos/${repo}/issues/${number}/comments?per_page=${BOARD_PAGE_SIZE}`,
  );
  return raw.map((c) => ({
    id: c.id,
    url: c.html_url,
    author: c.user?.login ?? "",
    createdAt: c.created_at ?? "",
    body: c.body ?? "",
  }));
}

/** Sprints, as GitHub stores them. `state=all` because a sprint that has been
 *  closed is still the milestone its tasks point at. */
export async function listMilestones(token: string, repo: string): Promise<{ number: number; title: string }[]> {
  const raw = await ghJson<{ number: number; title: string }[]>(
    token, "GET", `/repos/${repo}/milestones?state=all&per_page=${BOARD_PAGE_SIZE}`,
  );
  return raw.map((m) => ({ number: m.number, title: m.title }));
}

// --- issue #167: citation-survey text, batched over GraphQL -----------------
//
// src/memory/routes.ts's taskTexts used to make one REST `listComments` call
// PER issue, over the repo's ENTIRE history (state=all — a citation can come
// from a years-old CLOSED task's comment, see src/memory/compact.ts's
// countCitations doc comment; filtering to "open only" would silently
// under-count and risk a wrongly-demoted file, which is the direction
// demotionVerdict names as dangerous). At ~80 issues that is already 80+
// subrequests for one read; at ~1000 issues it alone approaches Cloudflare's
// 1000-subrequest-per-invocation cap (paid plan), which would hard-fail the
// whole memory-compaction pass, not just this one call.
//
// GraphQL answers this in a handful of calls instead: `issues` (never
// `pullRequests`) already excludes PRs with no filtering needed, and each
// page carries up to BOARD_PAGE_SIZE issues with up to BOARD_PAGE_SIZE
// comments each — the same 100-comment cap `listComments` above already has
// (an issue past that count already silently caps under REST; this must not
// make that worse, and does not need to make it better).

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

/**
 * The board's own GraphQL POST — same shape src/github/api.ts's private
 * `ghGraphQL` uses (POST `{query, variables}`, `res.ok` for a transport
 * failure, then the GraphQL-level `errors[]` array checked explicitly, since
 * a 200 carrying `errors` is GraphQL's own failure signal, not `res.ok`'s).
 * Not imported from there: that module is deliberately the DEPLOY path's
 * GitHub client, kept separate from the board's (see this file's header) —
 * this is the board's own few-line equivalent, using the same `GitHubError`
 * every other function in this file throws.
 */
async function ghGraphQL<T>(
  token: string, query: string, variables: Record<string, unknown>, what: string,
): Promise<T> {
  const res = await fetch(GITHUB_GRAPHQL_URL, {
    method: "POST",
    headers: authHeaders(token, true),
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) throw new GitHubError(res.status, `${what} failed (${res.status}): ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { data?: T; errors?: { message: string }[] };
  if (body.errors && body.errors.length > 0) {
    // Not a real HTTP status — GraphQL reports this failure INSIDE a 200, so
    // there is no client-facing status code to carry; 502 reads as "upstream
    // (GitHub) failed", same as this file's other non-4xx failures.
    throw new GitHubError(502, `${what} failed: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (body.data === undefined) throw new GitHubError(502, `${what} failed: GraphQL returned no data`);
  return body.data;
}

/**
 * Hard ceiling on how many GraphQL pages `listIssueTexts` will follow. At
 * `BOARD_PAGE_SIZE` (100) issues per page this covers up to 2,000 issues in
 * 20 calls — 2% of Cloudflare's 1000-subrequest-per-invocation cap, leaving
 * essentially the whole budget for everything else one memory-compaction
 * pass does in the same Worker invocation (listIssues' own pagination, the
 * token mint, memory file fetches). Same "generous by orders of magnitude,
 * not a tight fit" sizing as BOARD_MAX_PAGES above.
 *
 * On hitting this bound with GitHub still reporting a next page, that is a
 * truncation, not an empty result: reported via `console.error` (same
 * fail-open posture as `listIssues`' own truncation report), returned to the
 * caller as `ListIssueTextsResult.truncated` (issue #187 — a bare array gave
 * the caller no way to tell "complete" from "truncated" apart), and this
 * still returns everything fetched so far, rather than throwing or looping
 * forever. Pages proceed newest-first (see `ISSUE_TEXTS_QUERY`'s `orderBy`
 * below), so a truncation drops the OLDEST issues, not the newest.
 */
export const TASK_TEXTS_MAX_PAGES = 20;

/** One issue's citation-survey text, as `listIssueTexts` assembles it. Kept
 *  as separate fields (not pre-joined) so the caller controls the join order
 *  — src/memory/routes.ts's taskTexts joins title, body, then comments, the
 *  exact order the REST loop it replaces produced. */
export interface IssueTexts {
  number: number;
  title: string;
  body: string;
  comments: string[];
}

interface GraphQLIssueNode {
  number: number;
  title?: string | null;
  body?: string | null;
  comments?: { totalCount?: number; nodes?: { body?: string | null }[] };
}

interface GraphQLIssuesConnection {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: GraphQLIssueNode[];
}

interface GraphQLIssuesPage {
  repository?: { issues?: GraphQLIssuesConnection };
}

// Issue #187: GraphQL's `issues` connection has no default order pinned here,
// which meant GitHub's own default — CREATED_AT ASC, oldest first — applied.
// Combined with `TASK_TEXTS_MAX_PAGES`'s bound, a repo that outgrows the
// bound got its NEWEST issues silently dropped forever: page 1 was always the
// same oldest issues, and the walk never reached anything newer. That is
// backwards for a citation survey — a brand-new issue's comments are exactly
// the ones most likely to cite a CURRENT memory file (see compact.ts's
// countCitations/demotionVerdict doc comments), so under-counting from a
// missing NEW issue risks wrongly demoting a still-cited file. `orderBy:
// CREATED_AT DESC` makes pagination proceed newest-first, so a truncation
// (when it happens) drops the OLDEST issues instead — the ones least likely
// to carry a live citation.
const ISSUE_TEXTS_QUERY = `
  query($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issues(first: ${BOARD_PAGE_SIZE}, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          body
          comments(last: ${BOARD_PAGE_SIZE}) { totalCount nodes { body } }
        }
      }
    }
  }
`;

/** `listIssueTexts`'s result: the texts it fetched, plus whether
 *  `TASK_TEXTS_MAX_PAGES` cut the walk short before GitHub ran out of pages.
 *  A bare array cannot carry that second fact, and a caller with no way to
 *  tell "complete" from "truncated" apart would report a partial citation
 *  survey as a whole one — see `handleMemory` in memory/routes.ts, the only
 *  caller that reads this flag today. */
export interface ListIssueTextsResult {
  issues: IssueTexts[];
  truncated: boolean;
}

/**
 * Every issue's title, body and comment bodies, over GraphQL — the batched
 * replacement for a `listIssues` + per-issue `listComments` loop (see the
 * section header above). `state=all`'s equivalent needs no flag here: the
 * `issues` connection has no open/closed filter applied, so both are
 * returned, matching the REST call it replaces.
 *
 * Bounded by `TASK_TEXTS_MAX_PAGES`; see its doc comment and `orderBy` above
 * for the truncation behaviour, which direction it drops issues from, and the
 * math behind the bound.
 */
export async function listIssueTexts(token: string, repo: string): Promise<ListIssueTextsResult> {
  const [owner, name] = repo.split("/");
  const result: IssueTexts[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  let pages = 0;

  while (hasNextPage && pages < TASK_TEXTS_MAX_PAGES) {
    const data: GraphQLIssuesPage = await ghGraphQL<GraphQLIssuesPage>(
      token, ISSUE_TEXTS_QUERY, { owner, repo: name, cursor }, `list issue texts for ${repo}`,
    );
    const conn: GraphQLIssuesConnection | undefined = data.repository?.issues;
    for (const n of conn?.nodes ?? []) {
      // Optional (issue #187): the 100-comment-per-issue cap below already
      // silently drops an issue's older comments past that count (same cap
      // `listComments` above has, with zero live impact measured 2026-09-24).
      // `totalCount` costs nothing extra to ask for on the same connection, so
      // logging when it exceeds what one page fetched at least makes that
      // existing gap visible instead of quietly under-counting the citation
      // corpus for a heavily-commented issue.
      const totalCount = n.comments?.totalCount;
      if (typeof totalCount === "number" && totalCount > BOARD_PAGE_SIZE) {
        console.error(
          `listIssueTexts: ${repo}#${n.number} has ${totalCount} comments, over the ` +
          `${BOARD_PAGE_SIZE} fetched in one page — its oldest comments were not read`,
        );
      }
      result.push({
        number: n.number,
        title: n.title ?? "",
        body: n.body ?? "",
        comments: (n.comments?.nodes ?? []).map((c: { body?: string | null }) => c.body ?? ""),
      });
    }
    pages++;
    hasNextPage = conn?.pageInfo?.hasNextPage === true;
    cursor = conn?.pageInfo?.endCursor ?? null;
  }

  const truncated = hasNextPage;
  if (truncated) {
    console.error(
      `listIssueTexts: ${repo} has more issues than the ${TASK_TEXTS_MAX_PAGES}-page bound covers ` +
      `(fetched ${pages} pages, ${result.length} issues) — result truncated (oldest-first, since pages ` +
      `proceed newest-first)`,
    );
  }
  return { issues: result, truncated };
}

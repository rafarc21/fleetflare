import { closesIssueByKeyword } from "./promote-close";

// Issue #331: a neutral product name, not the App's own bot slug
// (the operator's own App slug) — GitHub asks the User-Agent identify the calling
// CLIENT, and an OSS adopter running their own App installation should not
// see the operator's name in their own outbound requests. Same value
// src/github/app.ts and src/board/api.ts send.
const USER_AGENT = "fleetflare";

/**
 * Merges an already-approved pull request using a short-lived installation
 * token minted by the caller (src/github/app.ts — this module never mints
 * its own). `mergeMethod` is the caller's call, not this module's: squash is
 * right for a feature branch merging into an integration branch, but wrong
 * for promoting one long-lived branch into another (it would flatten shared
 * history, so every later promotion replays already-integrated commits as
 * conflicts) — see src/approvals/gates.ts's makeExecutor for which gate
 * uses which. Returns the merge commit's sha; throws GitHub's own message on
 * any non-2xx — "not mergeable", "review required", a base branch that
 * moved — since GitHub explains these better than we would.
 */
export async function mergePullRequest(
  token: string, repo: string, pr: string, commitTitle: string,
  mergeMethod: "merge" | "squash",
): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}/merge`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": USER_AGENT,
      "content-type": "application/json",
    },
    body: JSON.stringify({ commit_title: commitTitle, merge_method: mergeMethod }),
  });
  const text = await res.text();
  if (!res.ok) {
    // GitHub explains itself well here — "not mergeable", "review required",
    // "base was modified". Pass its words through rather than inventing ours.
    // The token itself never appears in this message.
    throw new Error(`merge failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (JSON.parse(text) as { sha: string }).sha;
}

/**
 * Review finding: the raw media type below trades GitHub's own ~1MB Contents
 * API envelope cap for whatever the raw endpoint itself allows (~100MB) —
 * and this function's result lands straight in an exec env var
 * (ROLE_PROMPT_B64/ROLE_ALLOWED_TOOLS, via src/studio/blueprint.ts's
 * roleBringupEnv), with no envelope-imposed ceiling protecting that path
 * any more. Same shape of guard this codebase already applies twice —
 * src/studio/paste.ts's PASTE_MAX_BYTES and sandbox-api.ts's sbWriteFile —
 * generous by orders of magnitude for an actual role/org/fleet file (a few
 * KB), not a tight fit.
 */
export const BLUEPRINT_FILE_MAX_BYTES = 262_144; // 256KB

/**
 * Fetches one file's raw text from a repo at a ref (branch, tag, or sha),
 * authenticated with a short-lived installation token the caller mints —
 * this module never mints its own, same convention mergePullRequest above
 * uses. Task 11's blueprint wiring (src/studio/provision.ts) is the first
 * caller: fleet.json from the target repo, then a role file + org.json from
 * the blueprint repo, all through this one function.
 *
 * Uses the Contents API's raw media type (`application/vnd.github.raw+json`)
 * rather than the default `application/vnd.github+json` envelope: the
 * default wraps a file's bytes in a JSON object with a base64 `content`
 * field (and refuses anything over 1MB outright), while the raw media type
 * makes the response body BE the file's bytes directly — no envelope, no
 * decode step, and it still goes through the same authenticated `api.
 * github.com` host every other call in this module uses (unlike
 * raw.githubusercontent.com, which is a separate, differently-authenticated
 * surface).
 *
 * Size is checked twice, same "declared claim vs. actual" split
 * routes.ts's paste handler already uses for an upload body: Content-Length,
 * when GitHub sends one, is checked FIRST so an honestly-oversized response
 * is rejected without ever buffering the body; the actual decoded byte
 * length is checked SECOND regardless, since a missing (or understated)
 * header must not be a way around the cap. Either failure throws a message
 * naming the file, ref, and the size involved — actionable once it lands in
 * a degraded StudioStatus.error (redactSecrets-scrubbed same as every other
 * error on that path, though nothing size-shaped is secret-shaped here).
 */
export async function fetchRepoFile(
  token: string, repo: string, path: string, ref: string,
): Promise<string> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github.raw+json",
        "user-agent": USER_AGENT,
      },
    },
  );
  if (!res.ok) {
    // Same "pass GitHub's own words through" rule as mergePullRequest —
    // "Not Found" (bad path/ref) and rate-limit messages are both already
    // clear. The token never appears in this message.
    throw new Error(`fetch ${path}@${ref} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  const declaredLength = res.headers.get("content-length");
  if (declaredLength !== null) {
    const declared = Number(declaredLength);
    if (Number.isFinite(declared) && declared > BLUEPRINT_FILE_MAX_BYTES) {
      throw new Error(
        `fetch ${path}@${ref} failed: declared size ${declared} bytes exceeds the ` +
        `${BLUEPRINT_FILE_MAX_BYTES}-byte blueprint file cap`,
      );
    }
  }

  const text = await res.text();
  const actualBytes = new TextEncoder().encode(text).length;
  if (actualBytes > BLUEPRINT_FILE_MAX_BYTES) {
    throw new Error(
      `fetch ${path}@${ref} failed: response is ${actualBytes} bytes, exceeds the ` +
      `${BLUEPRINT_FILE_MAX_BYTES}-byte blueprint file cap`,
    );
  }

  return text;
}

// Chunked (0x8000/chunk), TextEncoder first — same shape and same reason
// src/studio/blueprint.ts's base64EncodeUtf8 already documents (a bare
// btoa(content) throws outright on any character outside Latin1, and a
// single un-chunked spread call risks a call-stack blowup on a long
// learning). Duplicated locally rather than imported: this module stays a
// generic GitHub REST helper with no dependency on a studio-specific file,
// same as sandbox-api.ts's own bytesToBase64 duplicates it too.
const B64_CHUNK = 0x8000;

function base64EncodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(bin);
}

/**
 * Task 4 (P5a guardrails): creates ONE new file via the Contents API —
 * never updates. The teardown learning harvest (src/studio/do.ts) is the
 * only caller: one fact per file (spec section 9), always a fresh path
 * under fleet/memory/<studio>/, so this is always a CREATE.
 *
 * No `sha` is ever sent — the Contents API only demands one to overwrite an
 * EXISTING path, and omitting it turns an existing path into a 422 rather
 * than a silent overwrite, which is the right outcome here: this function
 * must never clobber an earlier harvested learning.
 *
 * No `branch` either: omitted, GitHub commits to the repo's own default
 * branch. Deliberate — fleet/memory is fleet-wide, ongoing state, never
 * pinned to whatever ref a studio's role happened to resolve against for
 * ITS OWN blueprint read (provision.ts's fleet.blueprint.ref).
 *
 * Same error-passthrough and token-never-leaks convention as every other
 * function in this module.
 */
export async function createRepoFile(
  token: string, repo: string, path: string, content: string, message: string,
  /** The existing file's blob sha, to replace it (#363). Absent = create. */
  sha?: string,
): Promise<{ path: string; sha: string }> {
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": USER_AGENT,
      "content-type": "application/json",
    },
    body: JSON.stringify({ message, content: base64EncodeUtf8(content), ...(sha === undefined ? {} : { sha }) }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`create ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const body = JSON.parse(text) as { content?: { sha?: string } };
  return { path, sha: body.content?.sha ?? "" };
}

/**
 * #363 review round 2: create OR replace one file. The Contents API refuses a
 * PUT over an existing file that carries no sha (422), so ask for the sha
 * first: 404 = new file, anything else not-ok throws -- never a blind PUT.
 */
export async function upsertRepoFile(
  token: string, repo: string, path: string, content: string, message: string,
): Promise<{ path: string; sha: string }> {
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": USER_AGENT },
  });
  let sha: string | undefined;
  if (res.ok) {
    sha = ((await res.json()) as { sha?: string }).sha;
  } else if (res.status !== 404) {
    throw new Error(`upsert ${path}: sha lookup failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return createRepoFile(token, repo, path, content, message, sha);
}

/**
 * Dynamic repo selection (P4a): how many repos one page of the installation
 * listing asks for, and how many pages are ever fetched. GitHub's own
 * maximum is 100 per page; the page cap is a termination guarantee, not a
 * capacity estimate — `total_count` is a number the server sends, and a
 * loop that trusts it without a floor of its own has no bound at all if it
 * ever lies. 10 pages = 1,000 repos, orders of magnitude above this fleet's
 * scale, the same "generous by orders of magnitude, not a tight fit" sizing
 * BLUEPRINT_FILE_MAX_BYTES above already uses.
 */
export const INSTALLATION_REPOS_PAGE_SIZE = 100;
export const INSTALLATION_REPOS_MAX_PAGES = 10;

/**
 * Every repo the GitHub App installation can reach, as `owner/name` full
 * names. This is the fleet's real repo boundary — the App token already
 * scopes what a studio's clone can authenticate against — so
 * src/studio/repo.ts's resolveWorkRepo checks a caller's requested repo
 * against THIS rather than against any list the Worker keeps of its own.
 * The two can never disagree: there is only one list.
 *
 * Paginated, terminating on the first short page (nothing more to read) or
 * once `total_count` is covered, and hard-capped either way — see
 * INSTALLATION_REPOS_MAX_PAGES. Throws GitHub's own message on any non-2xx,
 * same convention every other call in this module uses; the token never
 * appears in it.
 */
export async function listInstallationRepos(token: string): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= INSTALLATION_REPOS_MAX_PAGES; page++) {
    const res = await fetch(
      `https://api.github.com/installation/repositories?per_page=${INSTALLATION_REPOS_PAGE_SIZE}&page=${page}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": USER_AGENT,
        },
      },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`installation repositories failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const body = JSON.parse(text) as { total_count?: number; repositories?: { full_name?: string }[] };
    const batch = body.repositories ?? [];
    for (const r of batch) if (typeof r.full_name === "string") names.push(r.full_name);
    // A short page means there is nothing after it, whatever total_count
    // claims — this is the honest terminator; total_count is only the
    // early-exit for a full last page.
    if (batch.length < INSTALLATION_REPOS_PAGE_SIZE) break;
    if (typeof body.total_count === "number" && names.length >= body.total_count) break;
  }
  return names;
}

// --- P5d: one branch, one commit, one pull request --------------------------
//
// Spec §9 names three mitigations for the risk that an agent decides what to
// demote, and this section is the second of them: "compaction lands as a PR
// the operator can reject". Nothing else in the fleet opens a pull request — the board
// only ever merges one (mergePullRequest, top of this file).
//
// The Git Data API rather than the Contents API, deliberately. A compaction
// moves files: an archive copy created and the original removed. Through
// Contents that is two commits per file with a window in between where the
// fact exists twice or not at all. Through a single tree it is ONE commit that
// is either wholly there or wholly absent, which is the only shape that can
// honestly claim "nothing was deleted" — a reviewer sees the move as a move.

const GH_HEADERS = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "user-agent": USER_AGENT,
  "content-type": "application/json",
});

/** GitHub's own words on any non-2xx, same convention as every other function
 *  in this module; the token never appears in the message. */
async function ghJson<T>(url: string, init: RequestInit, what: string): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/**
 * The repo's default branch, asked rather than assumed. A compaction PR must
 * target the branch harvestLearnings' own commits land on (createRepoFile
 * above sends no `branch`, so GitHub puts them on the default), and hardcoding
 * "main" would silently open a PR against nothing on a repo that uses another
 * name.
 */
export async function getDefaultBranch(token: string, repo: string): Promise<string> {
  const body = await ghJson<{ default_branch?: string }>(
    `https://api.github.com/repos/${repo}`,
    { method: "GET", headers: GH_HEADERS(token) },
    `read ${repo}`,
  );
  if (typeof body.default_branch !== "string" || body.default_branch === "") {
    throw new Error(`read ${repo} failed: GitHub named no default branch`);
  }
  return body.default_branch;
}

/** Issue #1: GitHub's own `private` flag. Throws on non-2xx; the leak gate
 *  reads a throw as public, so only a confirmed private repo skips its scan. */
export async function repoIsPrivate(token: string, repo: string): Promise<boolean> {
  const body = await ghJson<{ private?: unknown }>(
    `https://api.github.com/repos/${repo}`,
    { method: "GET", headers: GH_HEADERS(token) },
    `read ${repo}`,
  );
  return body.private === true;
}

/** One file write, or — `content: null` — the removal of that path. Mirrors
 *  src/memory/compact.ts's FileChange exactly; a compaction plan's changes are
 *  handed here unmodified. */
export interface RepoFileChange {
  path: string;
  content: string | null;
}

/**
 * Commits every change as ONE commit on a NEW branch, and returns its sha.
 *
 * Five calls, whatever the change count: resolve the base branch's commit,
 * read its tree, post a new tree over it, post the commit, create the ref. The
 * branch must not already exist — GitHub answers 422 "Reference already
 * exists" and that surfaces as-is, which is correct: a compaction branch is
 * named with a timestamp, so a collision means two passes are racing and the
 * second must not quietly write into the first one's branch.
 *
 * A `null` content becomes a tree entry with `sha: null`, which is the Git
 * Data API's own spelling of "this path is not in the new tree". JSON.stringify
 * preserves an explicit null (it drops `undefined`), so the deletion actually
 * reaches GitHub — the one detail this whole mechanism depends on.
 *
 * An empty change list throws instead of pushing an empty commit: a branch and
 * a PR with no diff is noise in a review queue that exists to be trusted.
 */
export async function commitFilesOnNewBranch(
  token: string, repo: string, base: string, branch: string, message: string,
  changes: RepoFileChange[],
): Promise<string> {
  if (changes.length === 0) throw new Error("commit refused: no changes");
  const headers = GH_HEADERS(token);

  const ref = await ghJson<{ object: { sha: string } }>(
    `https://api.github.com/repos/${repo}/git/ref/heads/${base}`,
    { method: "GET", headers },
    `read ${base}`,
  );
  const baseCommit = ref.object.sha;

  const commit = await ghJson<{ tree: { sha: string } }>(
    `https://api.github.com/repos/${repo}/git/commits/${baseCommit}`,
    { method: "GET", headers },
    `read commit ${baseCommit}`,
  );

  const tree = await ghJson<{ sha: string }>(
    `https://api.github.com/repos/${repo}/git/trees`,
    {
      method: "POST", headers,
      body: JSON.stringify({
        base_tree: commit.tree.sha,
        tree: changes.map((c) =>
          c.content === null
            ? { path: c.path, mode: "100644", type: "blob", sha: null }
            : { path: c.path, mode: "100644", type: "blob", content: c.content }),
      }),
    },
    "create tree",
  );

  const newCommit = await ghJson<{ sha: string }>(
    `https://api.github.com/repos/${repo}/git/commits`,
    { method: "POST", headers, body: JSON.stringify({ message, tree: tree.sha, parents: [baseCommit] }) },
    "create commit",
  );

  await ghJson<unknown>(
    `https://api.github.com/repos/${repo}/git/refs`,
    { method: "POST", headers, body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: newCommit.sha }) },
    `create branch ${branch}`,
  );

  return newCommit.sha;
}

/**
 * Every blob path in a repo at a ref, one call. Recursive, because fleet
 * memory is two levels deep (`fleet/memory/<studio>/<file>.md`) and walking it
 * through the Contents API would cost one listing per studio directory.
 *
 * `truncated` is GitHub's own signal that the tree was too large to return
 * whole; it throws rather than returning a subset, for the same reason
 * src/memory/routes.ts caps the file count — a memory file missing from the
 * survey looks uncited, and an uncited file is a demotion candidate.
 */
export async function listRepoTree(token: string, repo: string, ref: string): Promise<string[]> {
  const body = await ghJson<{ tree?: { path: string; type: string }[]; truncated?: boolean }>(
    `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    { method: "GET", headers: GH_HEADERS(token) },
    `read tree ${ref}`,
  );
  if (body.truncated === true) {
    throw new Error(`read tree ${ref} failed: GitHub truncated the listing for ${repo}`);
  }
  return (body.tree ?? []).filter((e) => e.type === "blob").map((e) => e.path);
}

/**
 * Opens the pull request. Returns the number and the html_url, because the
 * URL is what actually reaches a human — a compaction the operator cannot
 * click is a compaction nobody reviews.
 *
 * A 403 "Resource not accessible by integration" here means the GitHub App
 * installation has no `pull_requests: write` permission. That surfaces as a
 * thrown error on purpose: silently downgrading to a direct commit would
 * defeat the entire mitigation this function exists for.
 */
export async function openPullRequest(
  token: string, repo: string, head: string, base: string, title: string, body: string,
): Promise<{ number: number; url: string }> {
  const pr = await ghJson<{ number: number; html_url: string }>(
    `https://api.github.com/repos/${repo}/pulls`,
    { method: "POST", headers: GH_HEADERS(token), body: JSON.stringify({ title, body, head, base }) },
    "open pull request",
  );
  return { number: pr.number, url: pr.html_url };
}

/**
 * P6a: can this credential WRITE to this repo — the token provider's answer to
 * the reachability question `listInstallationRepos` answers for the App
 * (src/github/auth.ts's reachRepo picks between them, per repo owner).
 *
 * It works for ANY owner, which is the whole point: a GitHub App installs per
 * ACCOUNT, so an org installation can never list `rafarc21/sample` however
 * many times the App is installed; asking one credential about one repo has no
 * such structural blind spot.
 *
 * WRITE, not merely readable, and that is a security requirement rather than a
 * nicety. Measured against a real fine-grained PAT, 2026-08-30:
 *
 *   GET /repos/rafarc21/sample   -> 200  permissions {admin:T, push:T,  pull:T}
 *   GET /repos/torvalds/linux       -> 200  permissions {admin:F, push:F,  pull:T}
 *   GET /repos/acme-org/websites -> 404  (private, never granted)
 *
 * A fine-grained PAT answers 200 for EVERY public repo on GitHub, granted or
 * not. So "can it GET this" would let any caller point a studio at any public
 * repo in the world — and that studio's container holds the fleet's own
 * credential, so an attacker-chosen checkout becomes a foothold next to it.
 * `permissions.push` is the honest boundary instead: a studio clones AND
 * pushes (task branches, rescue pushes, PRs), so read-only access is not
 * "reachable" for this fleet's purposes, and requiring write shrinks the
 * accepted set from "every public repo" to "repos this token was actually
 * granted".
 *
 * Fails CLOSED on a response carrying no `permissions` object at all: absent
 * is not `true`.
 *
 * `false` means the credential may not write it. `throw` means the question
 * could not be answered — and the two are deliberately different outcomes all
 * the way up: reachRepo's callers turn a false into 403 ("no") and a throw
 * into 503 ("ask again"), so a GitHub outage never reads to an operator as a
 * permission problem they would then go and "fix".
 *
 * Only 403 and 404 are `false` on the status line. Note 404 is AMBIGUOUS under
 * a PAT — a private repo outside the grant answers exactly as a repo that does
 * not exist does, GitHub declining to confirm existence to a credential with
 * no access. That is why the refusal message (auth.ts's TOKEN_REMEDY) names
 * both readings rather than asserting either. Everything else — 401 on a
 * revoked token, 5xx, a rate limit — throws, since none of them are an answer.
 */
export async function repoIsWritable(token: string, repo: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${repo}`, {
    method: "GET", headers: GH_HEADERS(token),
  });
  const text = await res.text();
  if (res.status === 403 || res.status === 404) return false;
  if (!res.ok) {
    // GitHub's own words, same convention as every other function in this
    // module; the token never appears in the message.
    throw new Error(`read ${repo} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const body = JSON.parse(text) as { permissions?: { push?: boolean } };
  return body.permissions?.push === true;
}

/**
 * Does this PR exist? 404 is `false`; 2xx is `true`; everything else THROWS.
 *
 * Same convention as repoIsWritable above, and the same 404 ambiguity applies
 * — under a PAT a private repo outside the grant answers exactly as a missing
 * one does. That ambiguity is acceptable HERE in a way it is not for auth: the
 * caller (board.ts's commentEnvelope) treats a throw as inconclusive and
 * proceeds, so the only outcome a false 404 produces is a refused claim on a
 * repo the fleet cannot see anyway.
 */
export async function pullRequestExists(token: string, repo: string, number: number): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, {
    method: "GET", headers: GH_HEADERS(token),
  });
  const text = await res.text();
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`read ${repo}#${number} failed (${res.status}): ${text.slice(0, 300)}`);
  return true;
}

/**
 * Every open PR on a repo, by number.
 *
 * One page (GitHub's own maximum, 100). A fleet whose open-PR list is longer
 * than that is not quiescent by any reading, so paging would only make a
 * "definitely busy" answer more precise.
 *
 * THROWS on any non-2xx, deliberately: its only caller is the quiescence
 * check, which is fail-CLOSED. An error swallowed into `[]` here would read
 * as "no open PRs" and could stop supervision of a fleet mid-flight.
 */
export async function listOpenPullNumbers(token: string, repo: string): Promise<number[]> {
  const params = new URLSearchParams({ state: "open", per_page: "100" });
  const raw = await ghJson<{ number: number }[]>(
    `https://api.github.com/repos/${repo}/pulls?${params.toString()}`,
    { method: "GET", headers: GH_HEADERS(token) },
    `list open pulls for ${repo}`,
  );
  return raw.map((p) => p.number);
}

/**
 * Does this branch exist? Same convention as pullRequestExists above: 404 is
 * `false`, 2xx is `true`, everything else throws with GitHub's own words (the
 * token never appears in them).
 *
 * Task #119's whole reason for being: a §6 verification step naming a branch
 * is a CLAIM ("against branch ci/fleet-check-workflow"), and this is the one
 * mechanical check that tells a human whether the claim is even followable —
 * see src/board/verify.ts's attemptVerification, the only caller.
 */
export async function branchExists(token: string, repo: string, branch: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${repo}/branches/${encodeURIComponent(branch)}`, {
    method: "GET", headers: GH_HEADERS(token),
  });
  const text = await res.text();
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`read ${repo}@${branch} failed (${res.status}): ${text.slice(0, 300)}`);
  return true;
}

/**
 * Does this commit exist? Same convention again — 404 is `false`, 2xx is
 * `true`, everything else throws. `sha` may be any ref the Commits API
 * resolves (a full or abbreviated sha, in practice — src/board/verify.ts's
 * extractRefCandidates only ever extracts something sha-shaped for this
 * check), same as branchExists above is only ever called with something
 * branch-shaped.
 */
export async function commitExists(token: string, repo: string, sha: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(sha)}`, {
    method: "GET", headers: GH_HEADERS(token),
  });
  const text = await res.text();
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`read ${repo}@${sha} failed (${res.status}): ${text.slice(0, 300)}`);
  return true;
}

/**
 * Does this issue exist? Same convention as pullRequestExists above — 404 is
 * `false`, 2xx is `true`, everything else throws with GitHub's own words.
 * GitHub's Issues endpoint answers for a plain issue AND for a pull request
 * opened against this repo (a PR is an issue with a `pull_request` field
 * attached), so this reads correctly for either.
 *
 * Task #126: one of the shapes src/board/verify.ts's parseGithubUrl
 * recognizes (`/<owner>/<repo>/issues/<n>`), used by
 * src/board/routes.ts's realVerifyFetch so an issue url in a §6
 * verification block is answered by the fleet's own credential instead of
 * an anonymous fetch that 404s on every private repo.
 */
export async function issueExists(token: string, repo: string, number: number): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}`, {
    method: "GET", headers: GH_HEADERS(token),
  });
  const text = await res.text();
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`read ${repo}#${number} failed (${res.status}): ${text.slice(0, 300)}`);
  return true;
}

/**
 * Does this path exist at this ref? One Contents API call answers BOTH a
 * `/blob/<ref>/<path>` (file) and a `/tree/<ref>/<path>` (directory) url —
 * GitHub's own Contents API responds identically to either shape (a single
 * object for a file, an array for a directory; 404 either way if nothing is
 * there at that ref), so parseGithubUrl maps both to this one check. Same
 * 404/2xx/throw convention as commitExists above.
 */
export async function pathExists(token: string, repo: string, path: string, ref: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
    method: "GET", headers: GH_HEADERS(token),
  });
  const text = await res.text();
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`read ${repo}:${path}@${ref} failed (${res.status}): ${text.slice(0, 300)}`);
  return true;
}

/**
 * Does this compare resolve? `base` and `head` are whatever
 * `/<owner>/<repo>/compare/<base>...<head>` named — each may itself be a
 * branch, tag, or sha, same "any ref the API resolves" latitude commitExists
 * above documents for `sha`. Same 404/2xx/throw convention throughout this
 * module; the token never appears in a thrown message.
 */
export async function compareExists(token: string, repo: string, base: string, head: string): Promise<boolean> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    { method: "GET", headers: GH_HEADERS(token) },
  );
  const text = await res.text();
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`read ${repo} compare ${base}...${head} failed (${res.status}): ${text.slice(0, 300)}`);
  return true;
}

// --- board issue #8: auto-close on promote -----------------------------
//
// GitHub only auto-closes an issue via a "Fixes #N" keyword when the PR's
// commits land on the repo's DEFAULT branch. Every PR in this fleet merges
// into `staging` first — the keyword never fires there, and promoting
// staging -> main later (almost always a squash, one NEW commit) never
// re-processes the original small PR's own keyword. The primitives below are
// what src/github/promote-close.ts (the commit -> PR -> issue resolver) and
// src/studio/task-reap.ts (the poll-based backfill) need from real GitHub;
// everything else in those two modules is pure and DI'd over fakes of these.

/** One PR a commit belongs to — `GET .../commits/{sha}/pulls`. Only the
 *  fields promote-close.ts actually reads: `number` to chase
 *  closingIssuesForPull/listPullCommits with, `base`/`head` for a caller
 *  that wants to reason about which branch a PR targets (this module makes
 *  no judgement call itself — see promote-close.ts's own squash-fallback
 *  rule for why "closingIssuesReferences came back empty" is used instead of
 *  a base/head heuristic). */
export interface CommitPull {
  number: number;
  base: string;
  head: string;
}

export async function listPullsForCommit(token: string, repo: string, sha: string): Promise<CommitPull[]> {
  const raw = await ghJson<{ number: number; base: { ref: string }; head: { ref: string } }[]>(
    `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(sha)}/pulls`,
    { method: "GET", headers: GH_HEADERS(token) },
    `list pulls for commit ${sha}`,
  );
  return raw.map((p) => ({ number: p.number, base: p.base.ref, head: p.head.ref }));
}

/**
 * A PR's own ORIGINAL commit shas, regardless of how it was merged.
 * Squash-merging changes what lands on the base branch (one new commit,
 * new sha) but never what this endpoint reports — which is exactly why
 * promote-close.ts's squash fallback calls this to recover the pre-squash
 * commits a promotion PR's own `closingIssuesReferences` had nothing to say
 * about.
 */
export async function listPullCommits(token: string, repo: string, pullNumber: number): Promise<string[]> {
  const raw = await ghJson<{ sha: string }[]>(
    `https://api.github.com/repos/${repo}/pulls/${pullNumber}/commits?per_page=100`,
    { method: "GET", headers: GH_HEADERS(token) },
    `list commits for pull ${repo}#${pullNumber}`,
  );
  return raw.map((c) => c.sha);
}

/**
 * `PATCH .../issues/{n} {state:"closed", state_reason:"completed"}`. The one
 * write this fleet had no primitive for before this task — every prior issue
 * helper (this file and board/api.ts) was read/label/comment only. Idempotent
 * on GitHub's own side (closing an already-closed issue is a harmless 200),
 * which is what lets board/close-action.ts call it unconditionally once its
 * own dedup guard has let a call through. `state_reason: "completed"` on
 * purpose (board issue #157) — every caller here (the webhook auto-close,
 * reap's backfill) is closing a task the board itself already tracked as
 * genuinely done, never "not planned" or "duplicate".
 */
export async function closeIssue(
  token: string, repo: string, number: number, reason: "completed" | "not_planned" = "completed",
): Promise<void> {
  await ghJson<unknown>(
    `https://api.github.com/repos/${repo}/issues/${number}`,
    { method: "PATCH", headers: GH_HEADERS(token), body: JSON.stringify({ state: "closed", state_reason: reason }) },
    `close issue ${repo}#${number}`,
  );
}

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

/**
 * The one GraphQL client in this codebase (closingIssuesForPull and
 * getIssueCloser use it) — everything else here is REST. Same auth header shape
 * (`GH_HEADERS`, bearer token) as every REST call in this module, just a
 * different endpoint and a POST body shaped `{query, variables}` instead of
 * a path. A 200 transport response carrying a top-level `errors[]` array is
 * GraphQL's OWN way of reporting a failure (a bad PR number, a scope this
 * token lacks) — checked and thrown on explicitly, since `res.ok` alone
 * would read that as success.
 */
async function ghGraphQL<T>(
  token: string, query: string, variables: Record<string, unknown>, what: string,
): Promise<T> {
  const res = await fetch(GITHUB_GRAPHQL_URL, {
    method: "POST",
    headers: GH_HEADERS(token),
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} failed (${res.status}): ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { data?: T; errors?: { message: string }[] };
  if (body.errors && body.errors.length > 0) {
    throw new Error(`${what} failed: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (body.data === undefined) throw new Error(`${what} failed: GraphQL returned no data`);
  return body.data;
}

/**
 * Issue #268/#284 round 2: GitHub's canonical `owner/name` for `repo`,
 * resolved live so a stale (renamed/transferred) slug still answers
 * correctly — the SAME `repository(owner:$owner,name:$repo){nameWithOwner}`
 * query `getIssueCloser`/`closingIssuesForPull` below already make to learn
 * this as a side effect of a different question. This asks it standalone,
 * for `board/assign-wake.ts` and `board/comment-wake.ts`'s own studio-repo
 * checks (`github/wake-events.ts`'s `sameRepoSlug`), which have no other
 * GitHub call of their own to piggyback it on.
 */
export async function resolveCanonicalRepoName(token: string, repo: string): Promise<string> {
  const [owner, name] = repo.split("/");
  const query = `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){nameWithOwner}}`;
  const data = await ghGraphQL<{ repository?: { nameWithOwner?: string } }>(
    token, query, { owner, repo: name }, `canonical name for ${repo}`,
  );
  return data.repository?.nameWithOwner ?? repo;
}

type ClosingIssueNode = { number: number; repository: { nameWithOwner: string } };

/** Issue #252: GitHub resolves "Fixes other/repo#12" into
 *  closingIssuesReferences too. Only this repo's issues are ours to close.
 *  #265: "this repo" is the caller's slug OR GitHub's canonical name for it —
 *  after a rename/transfer the slug is stale and GitHub names the issue by
 *  its new home (the getIssueCloser pattern, #149). Any case. */
function sameRepoIssues(nodes: ClosingIssueNode[], names: readonly string[]): number[] {
  const known = names.map((r) => r.toLowerCase());
  return nodes.filter((n) => known.includes(n.repository.nameWithOwner.toLowerCase())).map((n) => n.number);
}

/**
 * Board issue #8's step 2: the issue(s) a PR's own `Fixes #N`-style closing
 * keyword names, straight from GitHub's own parse of it — never re-derived
 * from the PR body text here. Query kept deliberately minimal (just
 * `nodes { number repository { nameWithOwner } }`, the repo to drop other
 * repos' issues, #252).
 */
export async function closingIssuesForPull(token: string, repo: string, pullNumber: number): Promise<number[]> {
  const [owner, name] = repo.split("/");
  const query = `query($owner:String!,$repo:String!,$number:Int!){` +
    `repository(owner:$owner,name:$repo){nameWithOwner ` +
    `pullRequest(number:$number){closingIssuesReferences(first:20){nodes{number repository{nameWithOwner}}}}}}`;
  const data = await ghGraphQL<{
    repository?: { nameWithOwner?: string; pullRequest?: { closingIssuesReferences?: { nodes?: ClosingIssueNode[] } } };
  }>(token, query, { owner, repo: name, number: pullNumber }, `closing issues for ${repo}#${pullNumber}`);
  const names = [repo, data.repository?.nameWithOwner ?? repo];
  return sameRepoIssues(data.repository?.pullRequest?.closingIssuesReferences?.nodes ?? [], names);
}

/** Who closed an issue, from the newest ClosedEvent on its timeline.
 *  `stateReason` is GitHub's own (`COMPLETED`, `NOT_PLANNED`, `DUPLICATE`),
 *  `null` when GitHub reports none. `closer` is `null` when it was closed
 *  by hand, or there is no ClosedEvent at all. A PR closer carries its
 *  `repo`: the caller's own slug when it is this repo (any case, or the name
 *  before a rename), else the other repo's owner/name — a PR elsewhere can
 *  close this issue too. A
 *  commit closer with a merged PR in THIS repo reads as that PR (a squash
 *  merge closes the issue from the commit, not the PR). */
export interface IssueCloser {
  stateReason: string | null;
  closer: { kind: "pr"; number: number; merged: boolean; repo: string } | { kind: "commit"; sha: string } | null;
}

/**
 * Board issue #138: a token-auth repo gets no webhooks, and a PR that closed
 * a task with `Closes #N` often never lands a result envelope. task-reap.ts
 * asks this for a CLOSED task with no envelope PR — the same closing
 * reference webhook.ts's path 1 follows, read back from the issue side.
 */
export async function getIssueCloser(token: string, repo: string, number: number): Promise<IssueCloser> {
  const [owner, name] = repo.split("/");
  const query = `query($owner:String!,$repo:String!,$number:Int!){` +
    `repository(owner:$owner,name:$repo){nameWithOwner issue(number:$number){stateReason ` +
    `timelineItems(itemTypes:[CLOSED_EVENT],last:1){nodes{... on ClosedEvent{closer{__typename ` +
    `... on PullRequest{number merged repository{nameWithOwner}} ` +
    `... on Commit{oid associatedPullRequests(first:5){nodes{number merged repository{nameWithOwner}}}}}}}}}}}`;
  type Pr = { number: number; merged?: boolean; repository?: { nameWithOwner?: string } };
  type Closer = (Partial<Pr> & {
    __typename: string; oid?: string; associatedPullRequests?: { nodes?: Pr[] };
  }) | null;
  const data = await ghGraphQL<{
    repository?: {
      nameWithOwner?: string;
      issue?: { stateReason?: string | null; timelineItems?: { nodes?: { closer?: Closer }[] } };
    };
  }>(token, query, { owner, repo: name, number }, `closer of ${repo}#${number}`);
  const issue = data.repository?.issue;
  // `repo` is the board's lowercased slug; GitHub answers canonical case, and
  // after a rename/transfer the new name. Same repo = either, ignoring case.
  const known = [repo, data.repository?.nameWithOwner ?? repo].map((r) => r.toLowerCase());
  const sameRepo = (r: string | undefined) => r !== undefined && known.includes(r.toLowerCase());
  const raw = issue?.timelineItems?.nodes?.at(-1)?.closer ?? null;
  let closer: IssueCloser["closer"] = null;
  if (raw?.__typename === "PullRequest" && typeof raw.number === "number") {
    const prRepo = raw.repository?.nameWithOwner;
    closer = { kind: "pr", number: raw.number, merged: raw.merged === true, repo: sameRepo(prRepo) ? repo : prRepo ?? "" };
  } else if (raw?.__typename === "Commit" && typeof raw.oid === "string") {
    const pr = raw.associatedPullRequests?.nodes?.find((n) => n.merged === true && sameRepo(n.repository?.nameWithOwner));
    closer = pr ? { kind: "pr", number: pr.number, merged: true, repo } : { kind: "commit", sha: raw.oid };
  }
  return { stateReason: issue?.stateReason ?? null, closer };
}

/** A PR's merge state, as task-reap.ts's landed-check needs it: whether it
 *  merged at all, the sha that landed (null until it does), and which
 *  branch it targeted — `staging` in the common case, occasionally the
 *  default branch directly. */
export interface PullRequestInfo {
  number: number;
  merged: boolean;
  mergeCommitSha: string | null;
  baseRef: string;
  headRef: string;
  /** Issue #248: where a closing keyword lives when closingIssuesReferences
   *  is empty (any PR into staging). `body` is "" when GitHub sends null. */
  title: string;
  body: string;
  /** Issue #265: GitHub's canonical owner/name for the PR's repo — differs
   *  from the caller's slug after a rename/transfer. */
  repoFullName: string;
}

export async function getPullRequest(token: string, repo: string, number: number): Promise<PullRequestInfo> {
  const raw = await ghJson<{
    number: number; merged?: boolean; merge_commit_sha?: string | null;
    base: { ref: string; repo?: { full_name?: string } }; head: { ref: string }; title?: string; body?: string | null;
  }>(
    `https://api.github.com/repos/${repo}/pulls/${number}`,
    { method: "GET", headers: GH_HEADERS(token) },
    `read pull ${repo}#${number}`,
  );
  return {
    number: raw.number,
    merged: raw.merged === true,
    mergeCommitSha: raw.merge_commit_sha ?? null,
    baseRef: raw.base.ref,
    headRef: raw.head.ref,
    title: raw.title ?? "",
    body: raw.body ?? "",
    repoFullName: raw.base.repo?.full_name ?? repo,
  };
}

/**
 * Issue #248/#265: does this PR claim to close `issue` — a same-repo
 * closing reference, else a closing keyword in its title/body? Same repo is
 * the caller's slug or GitHub's canonical name, so a stale (renamed or
 * transferred) board slug still claims. task-reap's `prClaims`.
 */
export async function pullClaimsIssue(token: string, repo: string, pullNumber: number, issue: number): Promise<boolean> {
  if ((await closingIssuesForPull(token, repo, pullNumber)).includes(issue)) return true;
  const pr = await getPullRequest(token, repo, pullNumber);
  return closesIssueByKeyword(`${pr.title}\n${pr.body}`, issue, [repo, pr.repoFullName]);
}

/**
 * Is `sha` already reachable from `branch`'s tip — squash-strategy-agnostic,
 * unlike asking "is this exact sha an ancestor" by walking git history
 * directly (which a squash promotion would answer "no" to even once the
 * work IS on the branch, since squashing produces a brand new sha with no
 * parent link to the original commits at all). Wraps the same compare
 * endpoint `compareExists` above already uses, but reads the body instead of
 * discarding it: `ahead_by === 0` means `sha` contributes nothing beyond
 * what `branch` already has — every commit reachable from it is ALREADY
 * reachable from `branch`, which is exactly "landed" regardless of whether
 * that happened via a direct merge, a regular merge commit, or a squash
 * somewhere upstream of `branch`'s current tip.
 *
 * A 404 (a bad or unresolvable ref) reads as `false`, same convention as
 * `compareExists`'s own 404 handling — not yet resolvable is not yet landed,
 * not a hard failure. Everything else throws GitHub's own words.
 */
export async function commitReachableFromBranch(
  token: string, repo: string, branch: string, sha: string,
): Promise<boolean> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/compare/${encodeURIComponent(branch)}...${encodeURIComponent(sha)}`,
    { method: "GET", headers: GH_HEADERS(token) },
  );
  const text = await res.text();
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new Error(`compare ${repo} ${branch}...${sha} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const body = JSON.parse(text) as { ahead_by?: number };
  return body.ahead_by === 0;
}

// --- issue #217: rescue-branch GC -----------------------------------------

/** Every branch under `refs/heads/<prefix>` with its tip sha. */
export async function listMatchingBranches(token: string, repo: string, prefix: string): Promise<{ name: string; sha: string }[]> {
  const refs = await ghJson<{ ref: string; object: { sha: string } }[]>(
    `https://api.github.com/repos/${repo}/git/matching-refs/heads/${prefix}`,
    { method: "GET", headers: GH_HEADERS(token) },
    `list ${repo} refs/heads/${prefix}*`,
  );
  return refs.map((r) => ({ name: r.ref.replace(/^refs\/heads\//, ""), sha: r.object.sha }));
}

/** A commit's committer date (ISO). */
export async function commitDate(token: string, repo: string, sha: string): Promise<string> {
  const c = await ghJson<{ commit: { committer: { date: string } } }>(
    `https://api.github.com/repos/${repo}/commits/${sha}`,
    { method: "GET", headers: GH_HEADERS(token) },
    `read ${repo} commit ${sha}`,
  );
  return c.commit.committer.date;
}

/** `head` against `base`: commits ahead, and every file the diff touches. */
export async function compareFiles(
  token: string, repo: string, base: string, head: string,
): Promise<{ aheadBy: number; files: string[] }> {
  const c = await ghJson<{ ahead_by: number; files?: { filename: string }[] }>(
    `https://api.github.com/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    { method: "GET", headers: GH_HEADERS(token) },
    `read ${repo} compare ${base}...${head}`,
  );
  return { aheadBy: c.ahead_by, files: (c.files ?? []).map((f) => f.filename) };
}

/**
 * Issue #249 (PR4b, #107's delivery): how far `head` is ahead of `base`, and
 * when its newest commit landed — the two facts a survival re-brief's task
 * line needs (`SurvivalTaskBranch.commitsAheadOfMain` /
 * `.lastCommitAt`, src/studio/survival-brief.ts), from ONE compare call.
 *
 * Separate from `compareFiles` above rather than a flag on it: that one also
 * maps the whole `files` array, which a re-brief never reads, and neither one
 * can give the other what it needs (`compareFiles` has no commit date;
 * `commitReachableFromBranch` returns a bare boolean). This reads `ahead_by`
 * and the LAST element of `commits` — GitHub returns that array oldest-first,
 * so the last entry is the head's own tip commit.
 *
 * `ahead_by: 0` is a genuinely CHECKED zero and is returned as `0`, never
 * softened to null: the composer renders it as "EMPTY, 0 commits ahead of
 * main, nothing survived", and dropping it is the exact silent-drop #107
 * exists to fix.
 *
 * A 404 returns `null` — "GitHub cannot resolve this ref", same convention
 * `commitReachableFromBranch` and `compareExists` above already use for a 404
 * on this endpoint. The caller reads that as "no branch on origin", which is
 * a different statement from "we could not check": every OTHER non-2xx
 * THROWS with GitHub's own words, and the caller turns that into `null`
 * commits-ahead ("commits ahead unknown"), never a fabricated 0.
 *
 * `commits` can be absent or empty on a compare with nothing to show, and a
 * page cut at GitHub's own 250-commit compare limit still carries the tip, so
 * a missing date reads `null` ("last unknown") rather than throwing.
 */
export async function compareAhead(
  token: string, repo: string, base: string, head: string,
): Promise<{ aheadBy: number; lastCommitAt: string | null } | null> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    { method: "GET", headers: GH_HEADERS(token) },
  );
  const text = await res.text();
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`compare ${repo} ${base}...${head} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const body = JSON.parse(text) as {
    ahead_by?: number;
    commits?: { commit?: { committer?: { date?: string } } }[];
  };
  if (typeof body.ahead_by !== "number" || !Number.isFinite(body.ahead_by)) {
    throw new Error(`compare ${repo} ${base}...${head} failed: GitHub named no ahead_by`);
  }
  const commits = body.commits ?? [];
  const tip = commits.length === 0 ? undefined : commits[commits.length - 1];
  const date = tip?.commit?.committer?.date;
  return { aheadBy: body.ahead_by, lastCommitAt: typeof date === "string" && date !== "" ? date : null };
}

/** Deletes `refs/heads/<branch>`. */
export async function deleteBranch(token: string, repo: string, branch: string): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
    { method: "DELETE", headers: GH_HEADERS(token) },
  );
  if (!res.ok) throw new Error(`delete ${repo} branch ${branch} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
}

/** One commit's batched answer: its PRs (first page) and how many exist. */
export type BatchedCommitAnswer = {
  prsTotal: number;
  prs: { number: number; closingIssues: number[]; closingIssuesTotal?: number; commits?: string[]; commitsTotal?: number }[];
};

/** One PR's closing issues, this repo's only, and their total. Other repos'
 *  references on this page are not cut, only dropped. No totalCount (#265)
 *  reads as unknown, never NaN. */
function closingPage(
  conn: { totalCount?: number; nodes: ClosingIssueNode[] }, names: readonly string[],
): { closingIssues: number[]; closingIssuesTotal?: number } {
  const closingIssues = sameRepoIssues(conn.nodes, names);
  if (conn.totalCount === undefined) return { closingIssues };
  return { closingIssues, closingIssuesTotal: conn.totalCount - (conn.nodes.length - closingIssues.length) };
}

/**
 * Issue #208: Path 1's commit -> PR -> closing issues for many commits in ONE
 * GraphQL call — one aliased `object(oid:)` selection per commit, the same
 * batching src/board/api.ts's listIssueTexts established (#167/#179). The
 * caller (promote-close.ts) chunks to PATH1_BATCH_MAX. Every 40-hex sha is a
 * key of the answer (no PRs when GitHub knows none for it); a sha that is not 40
 * hex is LEFT OUT (shas are inlined into the query text, so nothing else may
 * reach it) and the caller walks it over REST as before. `first:30` matches
 * the REST `commits/{sha}/pulls` default page;
 * `first:20` matches closingIssuesForPull, `commits(first:100)` the one page
 * listPullCommits reads (both oldest first). Every connection carries its
 * totalCount, so the caller can say when a page cut it. Throws on any GraphQL
 * error, like every helper here.
 */
export async function pullsWithClosingIssuesForCommits(
  token: string, repo: string, shas: string[], opts: { commits: boolean } = { commits: true },
): Promise<Map<string, BatchedCommitAnswer>> {
  const out = new Map<string, BatchedCommitAnswer>();
  const valid = [...new Set(shas.filter((s) => /^[0-9a-f]{40}$/.test(s)))];
  if (valid.length === 0) return out;
  const [owner, name] = repo.split("/");
  const fields = valid
    .map((sha, i) =>
      `c${i}:object(oid:"${sha}"){...on Commit{associatedPullRequests(first:30){totalCount nodes{number ` +
      `closingIssuesReferences(first:20){totalCount nodes{number repository{nameWithOwner}}}` +
      `${opts.commits ? " commits(first:100){totalCount nodes{commit{oid}}}" : ""}}}}}`)
    .join(" ");
  const query = `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){nameWithOwner ${fields}}}`;
  type Node = { associatedPullRequests?: { totalCount: number; nodes: {
    number: number;
    closingIssuesReferences: { totalCount?: number; nodes: ClosingIssueNode[] };
    commits?: { totalCount: number; nodes: { commit: { oid: string } }[] };
  }[] } } | null;
  const data = await ghGraphQL<{ repository: ({ nameWithOwner?: string } & Record<string, unknown>) | null }>(
    token, query, { owner, repo: name }, `batched closing issues for ${valid.length} commits in ${repo}`,
  );
  const names = [repo, data.repository?.nameWithOwner ?? repo];
  valid.forEach((sha, i) => {
    const conn = (data.repository?.[`c${i}`] as Node | undefined)?.associatedPullRequests;
    out.set(sha, {
      prsTotal: conn?.totalCount ?? 0,
      prs: (conn?.nodes ?? []).map((p) => ({
        number: p.number,
        ...closingPage(p.closingIssuesReferences, names),
        ...(opts.commits && p.commits
          ? { commits: p.commits.nodes.map((n) => n.commit.oid), commitsTotal: p.commits.totalCount }
          : {}),
      })),
    });
  });
  return out;
}

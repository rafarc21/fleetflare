// I/O shell for #717's model pool quality pass (spec 2026-10-13-model-pool-
// design, Quality / Task 6) — collectOutcomes (GitHub + the model store) and
// the daily cron glue, around the pure modelStats/shouldDemote/statsTable in
// ./model-quality.
//
// Split out of model-quality.ts on purpose: this file references D1Database
// and Env (through repoTokenMinter, getAssignedModel, setModelState,
// getFlag/setFlag), which only resolve under @cloudflare/workers-types.
// test/bun/llm-model-quality.test.ts exercises the pure functions under
// bun:test (test/tsconfig.json's "types": ["bun"] override, no Workers
// types at all) — keeping this Worker-only code in model-quality.ts would
// pull the whole Worker type graph into that bun-only compilation and break
// the repo-wide typecheck. This file is only ever imported from src/index.ts
// (the real cron) and test/llm.model-quality-cron.test.ts (vitest's
// cloudflare:test pool, which has the real Workers types) — see that test's
// own header for why collectOutcomes itself is never unit-tested directly.
import { ghJson, listPullCommits } from "../github/api";
import { repoTokenMinter } from "../github/auth";
import { getFlag, setFlag } from "../state";
import { getAssignedModel, setModelState } from "./model-store";
import { modelStats, shouldDemote, statsTable, type PrOutcome } from "./model-quality";
import { taskAssignees } from "../board/types";
import type { Env } from "../env";

const QUALITY_WINDOW_DAYS = 14;
const GITHUB_API = "https://api.github.com";

/** GET + JSON.parse, GitHub-API shaped — thin wrapper over the shared
 *  ghJson (github/api.ts), which this file has no other caller for. */
async function ghGet<T>(token: string, url: string, what: string): Promise<T> {
  return ghJson<T>(token, url, { method: "GET" }, what);
}

/** The `refs #N` every board PR body carries (never a closing keyword — see
 *  this plan's Global Constraints). `null` when the body names none. */
function refsIssue(body: string): number | null {
  const m = body.match(/\brefs #(\d+)\b/i);
  return m ? Number(m[1]) : null;
}

interface RawPull {
  number: number;
  title: string;
  body: string | null;
  closed_at: string | null;
  merged_at: string | null;
}

interface CheckSuite {
  status: string;
  conclusion: string | null;
}

async function checkSuitesFor(token: string, repo: string, sha: string): Promise<CheckSuite[]> {
  const body = await ghGet<{ check_suites?: CheckSuite[] }>(
    token, `${GITHUB_API}/repos/${repo}/commits/${sha}/check-suites`, `check suites ${repo}@${sha}`,
  );
  return body.check_suites ?? [];
}

/** The conclusion of the FIRST completed check suite on this commit, or
 *  `null` when none has completed. */
async function firstCompletedConclusion(token: string, repo: string, sha: string): Promise<string | null> {
  const completed = (await checkSuitesFor(token, repo, sha)).filter((c) => c.status === "completed");
  return completed.length > 0 ? completed[0].conclusion : null;
}

async function hadFailedCheck(token: string, repo: string, sha: string): Promise<boolean> {
  return (await checkSuitesFor(token, repo, sha)).some((c) => c.conclusion === "failure");
}

/** Does a later, merged PR revert this one — title `Revert "..."` and a
 *  reference (title or body) to this PR's own number. */
function wasReverted(prNumber: number, candidates: RawPull[]): boolean {
  return candidates.some((c) =>
    c.number > prNumber &&
    c.merged_at !== null &&
    c.title.startsWith('Revert "') &&
    (c.title.includes(`#${prNumber}`) || (c.body ?? "").includes(`#${prNumber}`)));
}

/**
 * The last QUALITY_WINDOW_DAYS of closed PRs in the fleet's own repo,
 * turned into per-PR outcomes: which model's studio it belonged to, whether
 * its first completed check suite passed, whether it bounced (more than one
 * head sha carried a failed check — a fix-and-repush after a CI failure),
 * and whether a later merged PR reverted it.
 *
 * A PR with no `refs #N` in its body, an issue whose `studio:` labels don't
 * resolve to EXACTLY ONE studio (zero or two — see board/types.ts's
 * taskAssignees doc comment for why both are real signals rather than
 * something to guess past), or a studio with no assigned pool model is
 * skipped outright — Claude-led, unassigned, and ambiguously-labelled
 * studios have no model to score.
 */
export async function collectOutcomes(env: Env): Promise<PrOutcome[]> {
  const repo = env.AGENT_REPO;
  const token = await repoTokenMinter(env)(repo);
  const cutoff = Date.now() - QUALITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const params = new URLSearchParams({ state: "closed", sort: "updated", direction: "desc", per_page: "100" });
  const raw = await ghGet<RawPull[]>(token, `${GITHUB_API}/repos/${repo}/pulls?${params.toString()}`, `list closed pulls for ${repo}`);
  const recent = raw.filter((p) => p.closed_at !== null && Date.parse(p.closed_at) >= cutoff);

  const outcomes: PrOutcome[] = [];
  for (const pr of recent) {
    const issueNumber = refsIssue(pr.body ?? "");
    if (issueNumber === null) continue;

    const issue = await ghGet<{ labels: { name: string }[] }>(
      token, `${GITHUB_API}/repos/${repo}/issues/${issueNumber}`, `read issue ${repo}#${issueNumber}`,
    );
    const assignees = taskAssignees(issue.labels.map((l) => l.name));
    if (assignees.length !== 1) continue;
    const studio = assignees[0];

    const model = await getAssignedModel(env.DB, studio);
    if (model === null) continue;

    const shas = await listPullCommits(token, repo, pr.number);
    const firstSha = shas[0];
    const firstCiPassed = firstSha !== undefined && (await firstCompletedConclusion(token, repo, firstSha)) === "success";

    const failingShas = await Promise.all(shas.map(async (sha) => ((await hadFailedCheck(token, repo, sha)) ? sha : null)));
    const bounced = new Set(failingShas.filter((s): s is string => s !== null)).size > 1;

    outcomes.push({
      model,
      closedAt: Date.parse(pr.closed_at as string),
      firstCiPassed,
      bounced,
      reverted: wasReverted(pr.number, raw),
    });
  }
  return outcomes;
}

const LAST_DAY_FLAG = "model-quality:last-day";

function utcDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The daily quality pass: once per UTC day (guarded by the `model-quality:
 * last-day` flag, keyed off `deps.now` rather than `Date.now()` so a test
 * can drive two "days" without a real clock), only when `LEAD_MODEL_POOL`
 * is `"on"`. Demotes every model `shouldDemote` names, then — only if
 * `MODEL_QUALITY_ISSUE` is set — posts the stats table via `deps.post`.
 * Demotion always runs when the pool is on and it is a new day; posting is
 * the one piece that is skipped when the board issue is not configured.
 *
 * The day-flag is written ONLY after `deps.collect()` and the demote/post
 * work it feeds have all succeeded (#717 review, Finding 3) — `collect()`
 * is several sequential GitHub API calls over a network, and a transient
 * failure there must be retryable on the NEXT minute's invocation, not
 * silently disable demotion monitoring for the rest of the day. Marking the
 * day done BEFORE that work runs would do exactly that.
 */
export async function runDailyModelQuality(
  env: Env,
  deps: { collect: () => Promise<PrOutcome[]>; post: (text: string) => Promise<void>; now: number },
): Promise<void> {
  if (env.LEAD_MODEL_POOL !== "on") return;

  const today = utcDateString(deps.now);
  const last = await getFlag(env.DB, LAST_DAY_FLAG);
  if (last === today) return;

  const stats = modelStats(await deps.collect());
  const demoted = shouldDemote(stats);
  for (const id of demoted) await setModelState(env.DB, id, "demoted");

  if (env.MODEL_QUALITY_ISSUE) {
    const demotedLine = demoted.length > 0 ? `\n\nDemoted: ${demoted.join(", ")}` : "\n\nDemoted: none";
    await deps.post(statsTable(stats) + demotedLine);
  }

  await setFlag(env.DB, LAST_DAY_FLAG, today, deps.now);
}

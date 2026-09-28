// Board task #125: `fleet onboard` — a pure, read-only preflight for a repo
// that has never talked to this fleet before (possibly not even THIS repo —
// e.g. a the operator personal repo, run from inside it). Four checks, printed in a
// fixed order, then a paste-ready brief for that repo's CTO agent.
//
// PURE ORCHESTRATION, no I/O of its own — every side effect is injected
// (this codebase's established DI convention for exactly this class of
// untestable-outside-a-real-network problem; see src/studio/destroy.ts and
// src/board/board.ts's own doc comments for the same posture). No
// `vi.mock()` anywhere in apps/fleet/test, confirmed by grep, so this file
// does not introduce the first one.
//
// Deliberately depends on NO type from cli/fleet.ts (not even `Credentials`
// or `DetectedRepo`): that file carries genuine Bun-only globals
// (Bun.file, inside loadCredentials) that only type-check under
// cli/tsconfig.json's own "bun" types, not this file's root tsconfig
// (workers-types) — cli-args.ts's own header comment records the identical
// boundary. `OnboardDeps` is generic over the credentials shape (`C`) for
// exactly that reason: this module never needs to know what a Credentials
// object looks like, only that the same opaque value flows from
// `loadCredentials` into `checkReach`/`listStudios`. Structural typing means
// cli/fleet.ts's real `Credentials` and `DetectedRepo` satisfy this file's
// shapes with no import at all.
import type { RepoReach } from "../github/reach";
import type { StudioStatus } from "./types";
import { parseStudioId } from "./ids";
import { repoIdSegment } from "./repo";

export interface OnboardCheck {
  label: string;
  pass: boolean;
  detail: string;
}

export interface OnboardResult {
  checks: OnboardCheck[];
  /** Only checks 1-3 (repo detected, reach, credentials+worker) are hard
   *  failures — check 4 (studio already exists) is informational per the
   *  task spec and never affects this. */
  allPass: boolean;
  /** Null whenever `allPass` is false: a brief for a repo the fleet cannot
   *  yet reach is not useful, and printing one would read as a green light
   *  it did not earn. */
  brief: string | null;
}

export interface OnboardDeps<C = unknown> {
  detectRepo: () => Promise<{ slug: string | null; reason: string | null }>;
  /** The SOFT credentials load — never exits, never throws; a missing or
   *  malformed `~/.fleet/credentials` is check #3's own pass/fail, not a
   *  crash before the first check even prints. */
  loadCredentials: () => Promise<C | { error: string }>;
  checkReach: (creds: C, repo: string) => Promise<RepoReach>;
  listStudios: (creds: C) => Promise<StudioStatus[]>;
}

function isCredError<C>(v: C | { error: string }): v is { error: string } {
  return typeof v === "object" && v !== null && "error" in v;
}

/** The repo's studio-id segment out of an `owner/repo` slug, or null when
 *  the name can be no segment at all — the same comparison `formatTable`
 *  (cli/fleet.ts) already does via `parseStudioId(s.id)?.repo`.
 *
 *  Board #21: this goes through repo.ts's repoIdSegment rather than
 *  lowercasing the short name here, because a dotted repo's studio id
 *  carries the FOLDED segment (`exampleorg.com` -> studio
 *  `exampleorg-com--maestro`). Comparing the raw name would report "no
 *  existing studio for this repo yet" while one is running — a preflight
 *  that lies in exactly the direction that makes an operator spawn a second
 *  studio. Null never matches any id, which is the honest answer for a name
 *  no fold can rescue. */
function shortName(slug: string): string | null {
  return repoIdSegment(slug.split("/")[1] ?? "");
}

const CREDENTIALS_LABEL = "credentials (~/.fleet/credentials present, Worker answers)";

/**
 * The four checks, in the task's own stated order — 1 repo, 2 reach, 3
 * credentials+worker, 4 studio-exists — regardless of the actual compute
 * order underneath (see this file's own header and the design's "ordering
 * nuance": credentials are loaded once, silently, before anything else,
 * because checks 2 and 3 both need them to attempt a network call at all).
 */
export async function runOnboardPreflight<C>(deps: OnboardDeps<C>): Promise<OnboardResult> {
  const detected = await deps.detectRepo();
  const repoCheck: OnboardCheck = detected.slug
    ? { label: "repo detected", pass: true, detail: `${detected.slug} (from git remote origin)` }
    : { label: "repo detected", pass: false, detail: `${detected.reason} — run this from inside a repo with a github.com origin remote` };

  const creds = await deps.loadCredentials();
  const credsFailed = isCredError(creds);

  let reachCheck: OnboardCheck;
  let credCheck: OnboardCheck;
  let existsCheck: OnboardCheck;

  if (detected.slug === null) {
    // No repo name, nothing to check reachability or existing-studio status
    // against — the whole preflight short-circuits sensibly rather than
    // asking the Worker a question that names no repo.
    reachCheck = { label: "reachable & writable", pass: false, detail: "skipped — no repo detected" };
    credCheck = credsFailed
      ? { label: CREDENTIALS_LABEL, pass: false, detail: creds.error }
      : { label: CREDENTIALS_LABEL, pass: true, detail: "credentials file present (not exercised — no repo to ask about)" };
    existsCheck = { label: "existing studio", pass: true, detail: "skipped — no repo detected" };
  } else if (credsFailed) {
    // Credentials failed to load: checks 2 and 3 both need them to attempt a
    // network call, so both report blocked/failed rather than being skipped
    // silently — check #3's own failure IS the credentials failure.
    reachCheck = { label: "reachable & writable", pass: false, detail: "blocked — cannot reach the Worker without valid credentials (see the credentials check below)" };
    credCheck = { label: CREDENTIALS_LABEL, pass: false, detail: creds.error };
    existsCheck = { label: "existing studio", pass: true, detail: "blocked — cannot check without valid credentials" };
  } else {
    // Both structured as "compute fully inside the try, or fully inside the
    // catch" (rather than a nullable local checked afterwards) so every path
    // assigns reachCheck/credCheck/existsCheck exactly once, which is also
    // what keeps tsc's definite-assignment analysis happy across the two
    // independent network calls below.
    try {
      const reach: RepoReach = await deps.checkReach(creds, detected.slug);
      reachCheck = reach.reachable
        ? { label: "reachable & writable", pass: true, detail: `repo "${detected.slug}" is reachable and writable by the fleet's GitHub credential` }
        : { label: "reachable & writable", pass: false, detail: `repo "${detected.slug}" ${reach.remedy}` };
    } catch (err) {
      reachCheck = {
        label: "reachable & writable", pass: false,
        detail: `reach check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    try {
      const studios: StudioStatus[] = await deps.listStudios(creds);
      credCheck = { label: CREDENTIALS_LABEL, pass: true, detail: `credentials valid, Worker answered (${studios.length} studio(s) fleet-wide)` };
      const segment = shortName(detected.slug);
      const existing = segment === null
        ? undefined
        : studios.find((s) => parseStudioId(s.id)?.repo === segment);
      existsCheck = existing
        ? { label: "existing studio", pass: true, detail: `${existing.id} already exists (state: ${existing.state}) — informational, not a failure` }
        : { label: "existing studio", pass: true, detail: "no existing studio for this repo yet" };
    } catch (err) {
      credCheck = {
        label: CREDENTIALS_LABEL, pass: false,
        detail: `Worker did not answer: ${err instanceof Error ? err.message : String(err)}`,
      };
      existsCheck = { label: "existing studio", pass: true, detail: "skipped — the Worker did not answer" };
    }
  }

  const checks = [repoCheck, reachCheck, credCheck, existsCheck];
  const allPass = repoCheck.pass && reachCheck.pass && credCheck.pass;
  const brief = allPass ? buildOnboardBrief(detected.slug as string) : null;
  return { checks, allPass, brief };
}

/**
 * The paste-ready block for a repo's CTO agent, once checks 1-3 pass.
 *
 * The traps section is quoted VERBATIM from skills/fleet-cockpit/SKILL.md
 * ("Traps that make a healthy fleet look broken") — paraphrasing it wrong
 * would be worse than not including it at all, since these are the exact
 * failure modes an operator has already been burned by.
 *
 * Roles are listed as static text, not read live from a route: enumerating
 * them dynamically would need a new authenticated Worker route just for
 * this brief, which is scope this task's own boundaries explicitly rule out
 * (four checks plus a brief, no new server surface beyond the one GET this
 * feature already adds).
 */
export function buildOnboardBrief(repoSlug: string): string {
  return [
    `--- fleet brief for ${repoSlug} ---`,
    "",
    "This repo is reachable by the fleet. From inside a checkout of it:",
    "",
    '  ff <role> "<task>"   files a task (a GitHub issue) AND spawns a studio FOR it',
    "  ff <role> <n>        adopts an EXISTING issue <n>, spawns a studio on it",
    "  ff <role>            attach that role's studio, spawning it first if absent",
    "",
    "Roles: maestro, web-studio, release-studio, pilot, scratch. maestro is the",
    "interface — ideas go to it in prose; it classifies, writes task specs, spawns",
    "studios, reports status. Other studios report to the board, never to maestro.",
    "Role definitions (prompt, allowed tools, org-chart edges) live in the",
    "blueprint repo's roles/ + org.json — see skills/fleet-cockpit/SKILL.md.",
    "",
    "Leads never implement: a PreToolUse hook refuses their Edit/Write and their",
    "file-writing Bash forms, so implementation is always dispatched to members.",
    "",
    "The board (GitHub Issues) is the single source of truth for task state.",
    "Never open, close or relabel a task by hand with `gh` — the Worker is the",
    "only writer of task state; a hand-set label creates drift a merged PR can",
    "never repair. Comment freely — that is how a studio reports.",
    "",
    "Traps that make a healthy fleet look broken (skills/fleet-cockpit/SKILL.md):",
    "",
    "  Merged is not served. The fleet reads its org chart, roles and skills",
    "  from `main` of the blueprint repo. A PR merged to `staging` changes",
    "  nothing until it is promoted. Read the branch and the deployed state,",
    "  never the issue.",
    "",
    "  Deploy is not rollout. `wrangler deploy` diffs the image DIGEST. Output",
    "  saying `no changes <worker-name>-studiodo` means the image did not rebuild",
    "  and your container change is not live. And even after a real push, the",
    "  first recycle often lands on the old image — poll on script CONTENT",
    "  inside the container, never on a route's verdict.",
    "",
    "  A studio can look alive and be bare. Container running, claude gone,",
    "  harness missing. `fleet ls`'s READY column and",
    "  `GET /studio/:id/provisioned` tell the truth; the STATE column does not.",
    "",
    "  `fleet` inside a container is a different CLI. In-container it is",
    "  `studio-fleet`, a much smaller surface. `fleet attach` there does",
    "  nothing.",
    "",
    "--- end brief ---",
  ].join("\n");
}

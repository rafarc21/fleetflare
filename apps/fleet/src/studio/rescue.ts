// Rescue-push: the one command that saves a studio's uncommitted work before
// teardown. Pure (no Worker bindings), so test/bun/rescue-push.test.ts runs it
// against real git; do.ts re-exports it for its callers.
import { RESCUE_MARKER_PATHSPECS } from "./rescue-gc";
import { KILL_GRACE_SECONDS } from "./exec-deadline";
import { STUDIO_REAL_GIT_PATH } from "./credentials";

/**
 * Issue #1 piece 5: origin can be PUBLIC, so rescued work goes to a PRIVATE
 * repo when the Worker setting `FLEET_RESCUE_REMOTE` (`owner/name`) names one.
 * Its token reaches the container only as exec env under this NAME; a
 * credential helper expands it at auth time, so argv never carries it
 * (same shape as memory/store.ts's memoryCloneCmd).
 */
export const RESCUE_TOKEN_ENV = "FLEET_RESCUE_TOKEN";

/** Where rescue pushes go, and how. remoteUrl absent = origin via plain
 *  `git` on PATH, i.e. the leak-gate wrapper (origin may be public). */
export interface RescuePushOptions {
  /** Push URL replacing `origin` for every rescue push. */
  remoteUrl?: string;
  /** Git binary for PRIVATE-remote pushes only (remoteUrl set) -- the REAL
   *  one, past the leak-gate wrapper: a private rescue must never lose data
   *  to a refused push. Ignored for origin: that push stays leak-gated. */
  realGit?: string;
}

/** Exec-side half of RescuePushOptions: what do.ts resolves per rescue. */
export interface RescueTarget {
  remoteUrl?: string;
  env?: Record<string, string>;
}

const RESCUE_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Same contract as ops-repo.ts's resolveOpsRepo: blank = null, malformed =
 *  null + logged, never guessed at. */
export function resolveRescueRemote(env: { FLEET_RESCUE_REMOTE?: string }): string | null {
  const raw = (env.FLEET_RESCUE_REMOTE ?? "").trim();
  if (raw === "") return null;
  if (!RESCUE_REPO_RE.test(raw)) {
    console.error(`rescue: FLEET_RESCUE_REMOTE ${JSON.stringify(raw)} is not owner/name -- ignored`);
    return null;
  }
  return raw;
}

/**
 * One call per rescue. Unset/malformed or a failed mint → `{}` (origin), each
 * loudly. Origin rescue runs through the leak-gate wrapper, so a denylist hit
 * refuses it (RESCUE_FAILED) rather than publish private text.
 * `mint` is do.ts's mintRepoToken, scoped contents:write to that repo.
 *
 * Issue #24: the archive is for PUBLIC work repos only. `workRepoIsPrivate`
 * true → origin: a private repo's rescue stays in its own repo, never the
 * fleet's archive. A throw → origin too, leak-gated, since visibility is
 * unknown and origin is where that studio's work already lives.
 */
export async function resolveRescueTarget(
  env: { FLEET_RESCUE_REMOTE?: string }, mint: (repo: string) => Promise<string | null>,
  workRepoIsPrivate: () => Promise<boolean>,
  // PR #42 review: provision's discovery (issue #30) asks every provision.
  // There the expected cases (unset, private repo) are silent, and real
  // failures are worded for discovery, not as a rescue push.
  purpose: "push" | "discovery" = "push",
  // Issue #7: the rescue token WRITES and rides into the container, past
  // every scan -- only for a rescue repo confirmed private. Absent = no check.
  rescueRepoIsPrivate?: (repo: string) => Promise<boolean>,
): Promise<RescueTarget> {
  const discovery = purpose === "discovery";
  const discoveryFailed = (what: string, err: unknown) => console.error(
    `rescue discovery: ${what} failed (${err instanceof Error ? err.message : String(err)}) -- ` +
    "listing origin only; rescued work on the private rescue remote is NOT fetched",
  );
  const slug = resolveRescueRemote(env);
  if (slug === null) {
    if (discovery) return {};
    console.error(
      "rescue: FLEET_RESCUE_REMOTE is unset -- rescue pushes go to origin and are leak-gated; " +
      "a denylist hit or missing denylist refuses them; set FLEET_RESCUE_REMOTE",
    );
    return {};
  }
  try {
    if (await workRepoIsPrivate()) {
      if (discovery) return {};
      console.error(`rescue: work repo is private -- rescue pushes go to its own origin, not ${slug}`);
      return {};
    }
  } catch (err) {
    if (discovery) {
      discoveryFailed("work repo visibility check", err);
      return {};
    }
    console.error(
      `rescue: work repo visibility check failed (${err instanceof Error ? err.message : String(err)}) -- ` +
      `rescue pushes go to origin, not ${slug}, and are leak-gated`,
    );
    return {};
  }
  const toOrigin = (why: string): RescueTarget => {
    console.error(`rescue${discovery ? " discovery" : ""}: ${why} -- ${discovery ? "listing origin only" : "rescue pushes go to origin and are leak-gated"}`);
    return {};
  };
  if (rescueRepoIsPrivate) {
    let priv = false;
    try {
      priv = (await rescueRepoIsPrivate(slug)) === true;
    } catch { /* unknown = not private */ }
    if (!priv) return toOrigin(`${slug} is not confirmed private`);
  }
  try {
    const token = await mint(slug);
    if (token === null) return toOrigin(`no write token for ${slug} (PAT fleet: set FLEET_RESCUE_GITHUB_TOKEN)`);
    return { remoteUrl: `https://github.com/${slug}.git`, env: { [RESCUE_TOKEN_ENV]: token } };
  } catch (err) {
    if (discovery) {
      discoveryFailed(`token mint for ${slug}`, err);
      return {};
    }
    console.error(
      `rescue: token mint for ${slug} failed (${err instanceof Error ? err.message : String(err)}) -- ` +
      "falling back to origin; rescue to origin is leak-gated; a denylist hit or missing denylist " +
      "refuses it; set FLEET_RESCUE_REMOTE",
    );
    return {};
  }
}

/**
 * Issue #45: the rescue-remote token's GitHub App permissions, by purpose.
 * Rescue pushes (write). Provision's rescue-branch discovery only lists and
 * fetches, so it gets read: a token leaked from a provision exec cannot
 * write the archive.
 */
export function rescueMintPermissions(purpose: "push" | "discovery"): { contents: "read" | "write" } {
  return { contents: purpose === "discovery" ? "read" : "write" };
}

/** Single-quotes `s` for bash. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Prelude both builders emit: `__rgit` (argv prefix for every push) and
 * `__rdest` (push destination). The helper is added only for a remoteUrl, and
 * only when the token env is present at run time; otherwise the container's
 * own git auth applies, as for origin.
 * Issue #30: provision.ts's discoverRescueRefsCmd reuses it to list + fetch
 * from the same remote with the same auth; `__rgit` and `__rdest` work for
 * `ls-remote`/`fetch` as for `push`.
 */
export function rescuePushPrelude(opts: RescuePushOptions): string {
  // Origin may be public: plain `git` on PATH = the leak-gate wrapper.
  if (opts.remoteUrl === undefined) return `__rgit=(git); __rdest=origin\n`;
  const git = shq(opts.realGit ?? STUDIO_REAL_GIT_PATH);
  const helper = `!f() { echo username=x-access-token; echo "password=\${${RESCUE_TOKEN_ENV}}"; }; f`;
  // Issue #7: proxy mode's global pushInsteadOf sends every github.com push
  // to the Worker, which would refuse this one (not the work repo). A
  // self-mapping entry for the exact URL is the longest match, so it wins.
  const pin = shq(`url.${opts.remoteUrl}.pushInsteadOf=${opts.remoteUrl}`);
  return (
    `__rgit=(${git} -c ${pin}); __rdest=${shq(opts.remoteUrl)}\n` +
    `if [ -n "\${${RESCUE_TOKEN_ENV}:-}" ]; then __rgit+=(-c credential.helper= -c ${shq(`credential.helper=${helper}`)}); fi\n`
  );
}

/**
 * Issue #16: `rescue_try_push <w> <nv> <src> <ref>` — one bounded push of
 * `<src>` to `refs/heads/<ref>`, leaving git's stderr in the CALLER's `perr`.
 * Provision clones `--depth 1`; a remote without the history behind that
 * shallow boundary (an empty private rescue remote) rejects the push with
 * "shallow update not allowed". Then this pushes a PARENTLESS snapshot of
 * `<src>`'s tree to the same ref instead: the content survives, only the
 * history cut is lost. Never `+`/`--force`.
 *
 * Issue #140, observed 2026-09-30: "shallow update not allowed" is the
 * PRE-transfer rejection vanilla local git's own `receive-pack` gives before
 * it even tries to unpack. Against a REAL, disjoint-history private rescue
 * remote, the actual failure never got that far -- "did not receive
 * expected object <sha>" plus a generic "[remote rejected] ... (failed)"
 * summary instead -- so this fallback never fired (old grep, no match) and
 * the push just failed, losing the work; only a manual seed of the rescue
 * remote unblocked it. Verified live against git's own source (git/git,
 * builtin/index-pack.c:265): that exact text is `check_object()`'s own
 * `die()` message, fired by a STRICT/fsck connectivity check
 * (`receive.fsckObjects`) when a shallow boundary commit's own
 * still-present-in-the-raw-bytes parent pointer is neither in the incoming
 * pack nor already on the receiver -- the SAME "this remote has never seen
 * the history behind this shallow boundary" fact "shallow update not
 * allowed" already catches, just surfaced by a receive path that doesn't
 * carry vanilla git's own `receive-pack.c` grace window for it (confirmed
 * live: every empty/non-empty/ahead-by-N/merge-boundary/deepened-shallow
 * disjoint remote this repo's own real `git push` could reach against real
 * local git either hit the original message or fully succeeded, never this
 * one -- a live hosted backend's receive path evidently doesn't always
 * carry that grace window; see test/bun/rescue-push.test.ts's own issue
 * #140 test and this fix's plan doc for the full live investigation). The
 * grep below now matches both; the recovery is identical either way -- a
 * parentless snapshot has no parent pointer for ANY connectivity check to
 * trip on. Deliberately NOT broadened to a generic "(failed)"/"rejected":
 * that would fire the snapshot retry on a genuine, unrelated rejection
 * (permission denied, branch protection, a repo's own pre-receive hook)
 * too, masking the real error with a second, equally-doomed push.
 */
/**
 * Issue #49: `rescue_on_origin <w> <sha>` — true when `<sha>` is already a
 * branch tip on origin. Provision clones `--depth 1` (implies
 * `--single-branch`), so a branch the lead pushed itself has no
 * `refs/remotes/origin/<branch>` here and `rev-list --not --remotes` counts
 * its already-pushed commits as ahead: rescue then pushed a clean,
 * already-saved HEAD to that real branch, where the repo's own pre-push hook
 * runs (#359) — and a hook resolving `@{u}` on an upstream-less branch
 * failed the rescue, refusing destroy. One bounded `ls-remote` per run,
 * cached; a failed listing reads as "not on origin", so the push still runs
 * (the saving direction). Exact tip match only: an ancestor of a tip is not
 * provable without fetching.
 *
 * Fix round (#208 PR #215 review item 1): BLOCKER — a wip-sync tip
 * (`fleet/rescue/<studio>/wip/<bootStamp>`, rescue.ts's `wipSyncCmd`) must
 * NEVER count as "already safely rescued" here, even though it genuinely is
 * a real tip on origin with the exact same sha teardown rescue is about to
 * push. If it did, a studio whose dirty tree was wip-synced moments before
 * teardown would see `rescue_on_origin` return true for that sha and skip
 * the REAL rescue push entirely — leaving the work reachable ONLY from the
 * wip ref, which the very NEXT container's own first wip-sync tick would
 * then force-push over (see `wipSyncRef`'s own doc comment for that half of
 * this same fix), losing it for good with no rescue log entry anywhere
 * naming a loss. The listing below now excludes every ref matching
 * `fleet/rescue/<studio>/wip` (optionally followed by more path) — the grep
 * covers both the new per-boot-stamped shape and the OLD flat
 * `fleet/rescue/<studio>/wip` shape, belt and braces against a stale ref
 * some prior deploy may have left on origin) BEFORE the sha-match checks run
 * — a wip tip is simply never in `$__rheads` to match against, so this
 * function can only ever answer "on origin" from a REAL rescue ref or a
 * genuine lead-pushed branch, exactly as issue #49 intended.
 */
function rescueOnOriginFn(pushTimeoutSeconds: number): string {
  return (
    `rescue_on_origin() {\n` +
    `  if [ -z "\${__rheads_done:-}" ]; then __rheads_done=1; __rheads=""\n` +
    // Issue #58: a push URL other than the fetch URL means the listing below
    // (fetch URL) cannot vouch for where a push would land: never "saved".
    // #7's write proxy uses a global pushInsteadOf that forwards to the SAME
    // GitHub repo, so it leaves this check (and the listing) valid.
    // PR #65 review: fetch-side insteadOf can point the listing at a decoy
    // while pushInsteadOf keeps pushes on the real origin (#344's shape).
    // `ls-remote --get-url` applies insteadOf, ignores pushInsteadOf: it must
    // name remote.origin.url itself, same guard as credentials.ts's wrapper.
    `    __rurl="$(git -C "$1" config --get remote.origin.url 2>/dev/null)"\n` +
    `    __rpu="$(git -C "$1" config --get remote.origin.pushurl 2>/dev/null)"\n` +
    `    if [ -n "$__rurl" ] && { [ -z "$__rpu" ] || [ "$__rpu" = "$__rurl" ]; } && ` +
    `[ "$(git -C "$1" ls-remote --get-url origin 2>/dev/null)" = "$__rurl" ]; then\n` +
    // Issue #58: budgeted like every push. Out of budget = no listing =
    // "not on origin", so the push path (and its own budget refusal) runs.
    // Fix round item 1: `grep -Ev` strips every `fleet/rescue/*/wip*` tip
    // BEFORE it ever reaches `__rheads` — see this function's own doc
    // comment above. A listing with nothing LEFT after the filter makes
    // grep itself exit non-zero; that is never checked here (the assignment
    // runs unconditionally inside this `if`), so `__rheads` simply ends up
    // empty, same as "nothing on origin at all".
    `      if rescue_budget_ok on-origin >/dev/null; then ` +
    `__rheads="$(timeout -k ${KILL_GRACE_SECONDS} ${pushTimeoutSeconds} git -C "$1" ls-remote --heads origin </dev/null 2>/dev/null | grep -Ev 'refs/heads/fleet/rescue/[^/[:space:]]+/wip(/|$)')"; fi\n` +
    `    fi\n` +
    `  fi\n` +
    `  [ -n "$2" ] || return 1\n` +
    `  printf '%s\\n' "$__rheads" | cut -f1 | grep -qx -e "$2" && return 0\n` +
    // Issue #80: origin's same-named branch moved PAST this sha (another push
    // to the PR branch). Exact tips miss it; fetch that one tip into a scratch
    // ref (budgeted, bounded, never the real branch) and ask ancestry. Any
    // failure = not on origin, so the push still runs. `grep -F`: a branch
    // name is not a regex. `--refmap=`: a configured wide fetch refspec must
    // not move refs/remotes/origin/<branch> behind the lead's back.
    `  [ -n "\${3:-}" ] || return 1\n` +
    `  printf '%s\\n' "$__rheads" | cut -f2 | grep -Fqx -e "refs/heads/$3" || return 1\n` +
    `  rescue_budget_ok on-origin >/dev/null || return 1\n` +
    `  timeout -k ${KILL_GRACE_SECONDS} ${pushTimeoutSeconds} git -C "$1" fetch -q --no-tags --refmap= origin "+refs/heads/$3:refs/fleet-rescue-check/tip" </dev/null >/dev/null 2>&1 || return 1\n` +
    `  git -C "$1" merge-base --is-ancestor "$2" refs/fleet-rescue-check/tip 2>/dev/null; __ranc=$?\n` +
    `  git -C "$1" update-ref -d refs/fleet-rescue-check/tip 2>/dev/null\n` +
    `  [ "$__ranc" = 0 ]\n` +
    `}\n`
  );
}

function rescueTryPushFn(identity: string, pushTimeoutSeconds: number): string {
  const push = (src: string) =>
    `timeout -k ${KILL_GRACE_SECONDS} ${pushTimeoutSeconds} "\${__rgit[@]}" -C "$w" push $nv "$__rdest" "${src}:refs/heads/$ref" 2>&1 1>/dev/null`;
  return (
    `rescue_try_push() {\n` +
    // Issue #216 fix 4: `rbranch`, 5th and optional, is the real identifier
    // (branch/stash name) this push is rescuing -- used only as the fallback
    // snapshot's `Rescued-From:` trailer below. The `${5:-$4}` default exists
    // purely so an UNANTICIPATED future call site that omits it entirely
    // falls back to *something* readable rather than an empty trailer --
    // every call site this file actually ships (rescue_push()'s own two, plus
    // the branch walk's and stash walk's four direct calls below) passes its
    // own real identifier explicitly; none relies on this default.
    `  local w="$1" nv="$2" src="$3" ref="$4" rbranch="\${5:-$4}" snap prc\n` +
    // PR #65 review: an early budget return must not leave the PREVIOUS
    // push's stderr in perr for the caller to report as this one's.
    `  perr=""\n` +
    // PR #31 review: the snapshot push (and the -nff retry calling this) run
    // past the pushes the caller's rescue_budget_ok reserved. Checked before
    // EVERY push, silently (a budget line here would land in rescue_push's
    // captured stdout): out of budget = a confirmed push failure, never an
    // exec killed by the server deadline mid-push.
    // Issue #80: every failed return leaves a reason in perr — a push killed
    // by its timeout prints nothing, and the 409 carried no reason at all.
    `  rescue_budget_ok "$ref" >/dev/null || { perr="push to $ref not attempted: rescue budget exhausted"; return 1; }\n` +
    `  perr="$(${push("$src")})"; prc=$?\n` +
    `  [ "$prc" = 0 ] && return 0\n` +
    `  if [ -z "$perr" ]; then perr="push to $ref failed (code $prc) with no output"; ` +
    `if [ "$prc" = 124 ] || [ "$prc" = 137 ]; then perr="push to $ref killed after ${pushTimeoutSeconds}s (timeout)"; fi; fi\n` +
    // Issue #140: broadened past git's own pre-transfer "shallow update not
    // allowed" to also catch a STRICT/fsck-enabled remote's later-stage
    // "did not receive expected object" -- same underlying gap, different
    // wording (see this function's own doc comment above). -E, not two
    // greps: one pipeline, one exit code, same short-circuit shape as before.
    `  printf '%s' "$perr" | grep -qiE 'shallow update not allowed|did not receive expected object' || return 1\n` +
    // Issue #216 fix 4: same `Rescued-From: <branch>` trailer (second `-m`,
    // its own paragraph) every other rescue commit in this file already
    // carries — this parentless snapshot was the one exception.
    `  snap=$(git -C "$w" ${identity} commit-tree "$src^{tree}" -m "fleet rescue snapshot of $(git -C "$w" rev-parse "$src") (shallow clone)" -m "Rescued-From: $rbranch" 2>/dev/null) || return 1\n` +
    `  rescue_budget_ok "$ref" >/dev/null || { perr="snapshot push to $ref not attempted: rescue budget exhausted"; return 1; }\n` +
    `  perr="$(${push("$snap")})"; prc=$?\n` +
    `  [ "$prc" = 0 ] && return 0\n` +
    `  if [ -z "$perr" ]; then perr="snapshot push to $ref failed (code $prc) with no output"; ` +
    `if [ "$prc" = 124 ] || [ "$prc" = 137 ]; then perr="snapshot push to $ref killed after ${pushTimeoutSeconds}s (timeout)"; fi; fi\n` +
    `  return 1\n` +
    `}\n`
  );
}

/**
 * Issue #39: the operator's per-worktree report. After each worktree,
 * `rescue_wt` prints ONE `RESCUE_WT <id> pushed <ref> | nothing | failed
 * <step...>` line, derived from what `rescue_one` itself printed (captured
 * through a temp file, so rescue_one still runs in THIS shell and its
 * fail/any/markers globals survive). Additive: every existing line is echoed
 * through unchanged, and do.ts strips these before its own verdict parse.
 * No temp file (mktemp failed) = rescue_one runs bare and the line says
 * `unknown`, never a guessed outcome.
 */
export const RESCUE_WT_PREFIX = "RESCUE_WT";

export interface RescueWorktree {
  worktree: string;
  outcome: "pushed" | "nothing" | "failed" | "unknown";
  /** pushed: the ref; failed: the step (and any detail after it). */
  detail?: string;
}

/** Issue #39: one human line per worktree, for recycle's row and rescue-all. */
export function formatRescueReport(worktrees: RescueWorktree[]): string[] {
  return worktrees.map((w) => {
    if (w.outcome === "pushed") return `${w.worktree}: pushed ${w.detail}`;
    if (w.outcome === "nothing") return `${w.worktree}: nothing to push`;
    if (w.outcome === "failed") return `${w.worktree}: FAILED (${w.detail})`;
    return `${w.worktree}: outcome unknown (see rescue lines)`;
  });
}

function rescueWtFn(): string {
  return (
    `rescue_wt() {\n` +
    `  local id="$2" f l\n` +
    `  if ! f="$(mktemp)"; then rescue_one "$@"; echo "${RESCUE_WT_PREFIX} $id unknown"; return; fi\n` +
    `  rescue_one "$@" >"$f"\n` +
    `  cat "$f"\n` +
    `  if l="$(grep -m1 "^${RESCUE_FAILED_PREFIX} $id " "$f")"; then echo "${RESCUE_WT_PREFIX} $id failed \${l#* * }"\n` +
    `  elif l="$(grep -m1 "^${RESCUE_PUSHED_PREFIX} " "$f")"; then l="\${l#* }"; echo "${RESCUE_WT_PREFIX} $id pushed \${l%% *}"\n` +
    `  else echo "${RESCUE_WT_PREFIX} $id nothing"; fi\n` +
    `  rm -- "$f" 2>/dev/null || true\n` +
    `}\n`
  );
}

/**
 * Board issue #359, fresh review round 3: the ORIGINAL fix for "rescue-all
 * times out on a busy studio" only added a client-side budget for the WHOLE
 * multi-push walk (cli/fleet.ts's RESCUE_ALL_STUDIO_TIMEOUT_MS) — a single
 * stalled `git push` (a slow or hanging pre-push hook in the TARGET repo,
 * this codebase has no control over its config — the measured incident's own
 * "finalize-902 (push)" shape) still hangs the ENTIRE exec until the SERVER's
 * own EXEC_CLASSES.rescue deadline (300s) eventually kills it, at which point
 * `isDeadlineExit` (do.ts's parseRescueExecResult) discards every line this
 * script already printed — "output cannot be trusted" — including which
 * target's push was in flight, the exact information an operator needs most.
 *
 * Fixed at the source: every `git push` in this file now runs under coreutils
 * `timeout`, the same `-k <grace> <seconds>` shape sandbox-api.ts's own
 * withKillDeadline already uses for the OUTER exec (KILL_GRACE_SECONDS
 * imported from exec-deadline.ts, not re-declared, so the two stay in sync).
 * A push that blows ITS OWN budget now fails FAST, inside the script, and is
 * reported through the exact same `RESCUE_FAILED <id> push` line a rejected
 * push already produces — no new step-name plumbing needed, since a killed
 * push's exit code is simply non-zero, exactly like a rejected one, and every
 * caller (rescue_push()'s own `prc`/`if ! git ... push` checks) already
 * treats "non-zero" as "failed", regardless of WHY. One stalled push can no
 * longer consume the entire 300s exec budget and hide behind an opaque
 * whole-operation timeout; it fails on its own, named, within seconds, and
 * the walk moves on to the NEXT worktree/branch/stash exactly as C1 (below)
 * already guarantees for a genuine rejection.
 *
 * 45s (`RESCUE_PUSH_TIMEOUT_SECONDS`, `+ KILL_GRACE_SECONDS` worst case = 50s)
 * per push, verified live against a real git repo with a real, slow (but
 * eventually-successful) pre-push hook (`sleep 3; exit 0`) under a 1s test
 * budget: `timeout -k 1 1 git push ...` returned exit 124 in ~1000ms, never
 * hanging the parent script for the hook's own full 3s. `pushTimeoutSeconds`
 * (both command builders' own new, optional last parameter — same test-seam
 * convention as `root`) lets test/bun/rescue-push.test.ts exercise this with
 * a tiny budget instead of waiting out 45 real seconds per test.
 */
export const RESCUE_PUSH_TIMEOUT_SECONDS = 45;

/**
 * Board issue #371 (#362 follow-up review): #359's own per-push `timeout`
 * fix (above) bounds each STALLED push to its own small budget, but nothing
 * stopped rescue.ts from STARTING a new push once too little of the
 * SERVER'S own exec deadline remained — sandbox-api.ts's `EXEC_CLASSES.rescue`
 * wraps the WHOLE generated script in a 300s (this constant) outer
 * `timeout`. Six or more genuinely stalled pushes (6 * 50s worst case = 300s)
 * can still exhaust that outer deadline; once it fires, do.ts's own
 * `isDeadlineExit` discards EVERY line this script already printed —
 * including already-successful `RESCUE_PUSHED` lines from earlier
 * worktrees/branches/stashes in the SAME run — as untrustworthy, with no
 * indication of which target was even in flight.
 *
 * `rescue_budget_ok` (below, generated into both `rescuePushCmd` and
 * `rescueSnapshotCmd`'s own scripts) tracks real elapsed wall-clock time via
 * a literal `date +%s`, captured once at the very top of the generated
 * script (`__rescue_start`) — not strictly necessary since every exec is a
 * fresh `bash -c` per `withKillDeadline` (sandbox-api.ts's `sbExec` wraps
 * EVERY command that way, regardless of `sessionId` — verified by reading
 * both; a "session" only carries cwd/env across separate `sbExec` calls, it
 * does not change how any ONE command's own `bash -c` subprocess starts, so
 * a fresh `$SECONDS` would have worked here too), but `date +%s` is used for
 * clarity/robustness independent of that detail: it is the simplest,
 * most obviously-correct way to measure real elapsed wall-clock time without
 * depending on a bash-version-specific or context-dependent builtin, and it
 * costs one cheap `date` subprocess at script start plus one more per budget
 * check — negligible next to a 45s+ push timeout. Before every LOGICAL push
 * attempt, `rescue_budget_ok "$id" [mult]` compares what remains of
 * `serverDeadlineSeconds` against the worst case of `mult` more pushes
 * (`mult * (pushTimeoutSeconds + KILL_GRACE_SECONDS)`, `mult` defaulting to
 * 1): `mult=1` for a call site whose push can only ever run ONCE (the
 * branch-walk and stash-walk below always push to a freshly generated ref,
 * which can never be rejected non-fast-forward, so there is never a retry);
 * `mult=2` at `rescue_one`'s own dirty-tree and clean-but-ahead call sites (in
 * BOTH command builders — 4 checkpoints total), where `rescue_push()` can run
 * a first attempt AND its own immediate non-fast-forward retry back-to-back,
 * each an INDEPENDENTLY `timeout`-bounded push — so the worst case there is
 * genuinely two pushes' worth, not one (#371 review Finding 1: the original
 * single-push threshold at these 4 sites undercounted this real worst case).
 * On insufficient remaining budget it prints `RESCUE_FAILED <id> budget <n>
 * not attempted` — the exact line do.ts's own `parseRescueExecResult` now
 * parses a `detail` field out of — and returns non-zero, so the caller can
 * `return`/`continue` without ever starting a push that cannot possibly
 * finish inside what's left of the server's own deadline.
 * `serverDeadlineSeconds` (both command builders' own new, optional 5th
 * parameter) is a THIRD test seam, same convention as
 * `root`/`pushTimeoutSeconds` — production always uses this default (300,
 * matching `EXEC_CLASSES.rescue`'s own `timeoutMs`).
 */
export const RESCUE_SERVER_DEADLINE_SECONDS = 300;

/**
 * PR #376 review (maestro, suggested — cheap and closes a real gap):
 * `rescue_budget_ok`'s own `remaining` is computed from two `date +%s`
 * samples, which TRUNCATE their sub-second fraction rather than round it —
 * real elapsed wall-clock time can be up to just-under-1s MORE than the
 * integer difference suggests. That is a small, real gap between the
 * calculated and the actual remaining budget, on top of (not a replacement
 * for) the ~3s of test-timing slack test/bun/rescue-push.test.ts's own
 * boundary tests now use (a test-fixture concern; this is the production
 * comparison itself). `budgetMarginSeconds` (both command builders' own new,
 * optional 6th parameter) is a FOURTH test seam, same convention as
 * `root`/`pushTimeoutSeconds`/`serverDeadlineSeconds`: production always uses
 * this default. A small hardcoded production constant, not scaled by `mult`
 * — it covers ONE pair of truncated samples per check, regardless of how many
 * pushes' worth of budget the check is protecting.
 */
export const RESCUE_BUDGET_MARGIN_SECONDS = 5;

/**
 * Task 3 (P5a guardrails): rescue-push. P4 §2.14
 * (fleet-atomic-teams-p4-design.md) designed this and it was never built;
 * P5's own failure list (fleet-guardrails-p5-design.md, failure 3) names the
 * cost — "work lost on teardown", a container that died holding uncommitted
 * work, watched live. A Stop hook cannot catch this: teardown is not a
 * "stop", so the fix has to live Worker-side, in the kill path itself,
 * before whatever is about to destroy the container runs.
 *
 * One exec, same if/else-chain shape as provision.ts's own
 * provisionedCheckCmd (no `exit` anywhere — same HARD RULE, same reason:
 * this runs inside the shared, long-lived "sandbox-default" session, and
 * `exit` there kills the session shell instead of the command). Three
 * outcomes, all announced on stdout, never an exit code, for that same
 * reason:
 *   - no checkout at /workspace/<repo> yet -> RESCUE_NO_CHECKOUT
 *   - `git status --porcelain` empty -> RESCUE_CLEAN — the common case, per
 *     the brief this closes ("most studios die clean")
 *   - only tool markers dirty (issue #217, RESCUE_MARKER_PATHS in
 *     rescue-gc.ts) -> RESCUE_MARKERS_ONLY: nothing to rescue, no branch
 *   - a dirty tree -> staged, committed under a fixed fleet identity (never
 *     relies on Dockerfile.studio configuring git user.name/user.email —
 *     it doesn't; container/Dockerfile does, for the OTHER container this
 *     feature does not touch), and pushed to a TARGET resolved below ->
 *     `RESCUE_PUSHED <target> <fileCount>`
 *
 * Fix round 2 (2026-08-27, T5 live-verification Finding 1, HIGH — see
 * task-5-report.md and this fix's own rescue-ref-fix-report.md): the
 * ORIGINAL target here was unconditionally `git rev-parse --abbrev-ref
 * HEAD` — "whatever branch is currently checked out" — a documented
 * tradeoff made because guardedCloneCmd (above) clones the default branch
 * only and creates no task branch to push to instead. T5 measured the cost
 * LIVE, on two real studios, both still sitting on `main`: a studio that
 * never ran its own `git checkout -b` pushes its ENTIRE dirty tree to
 * `main`, unreviewed (`main` is unprotected on this repo) — or, once `main`
 * has moved past the studio's shallow (`--depth 1`) clone, the push is
 * rejected non-fast-forward and rescue-push silently saves NOTHING (caught,
 * logged, kill proceeds regardless — a "successful" teardown with no
 * evidence anything went wrong). Two failure modes, opposite, both bad.
 *
 * Fixed by resolving the repo's default branch — `git symbolic-ref
 * --quiet refs/remotes/origin/HEAD`, set by `git clone` itself and
 * confirmed (live, against a real `--depth 1` clone) to survive shallow —
 * and comparing it against the checked-out branch, rather than trusting
 * that branch unconditionally. NOT hardcoded to `"main"`: a repo whose
 * default branch has any other name is handled identically. Two outcomes
 * (as originally shipped — issue #207 below superseded the first of them,
 * see that note):
 *   - checked-out branch != resolved default (the ordinary case once a
 *     studio's own agent branches) -> push there, unchanged from before
 *   - checked-out branch == resolved default, OR the default could not be
 *     resolved at all (fail SAFE, not fail open: "cannot prove this push
 *     is safe" gets the SAME verdict as "confirmed unsafe") -> push to a
 *     freshly generated `fleet/rescue/<studio>-<UTC timestamp>` ref
 *     instead, never `main`
 *
 * A generated ref is what actually closes the shallow-clone non-fast-
 * forward failure too, not only the unreviewed-write one — worth saying
 * plainly: a brand-new ref has no existing tip on origin to be non-fast-
 * forward AGAINST, so a shallow clone's truncated history pushes onto it
 * clean, as a new branch, with no rejection possible. Verified live against
 * a local origin (bare repo, `main` advanced past a `--depth 1` clone
 * exactly like guardedCloneCmd's own): the identical rescue commit pushed
 * straight to `main` came back `[rejected] ... (fetch first)`; pushed to a
 * generated `fleet/rescue/...` ref instead, it landed `[new branch]`, exit
 * 0. Full transcript in this fix's own report.
 *
 * Issue #207 (2026-10-03): superseded — the first outcome above ("checked-out
 * branch != resolved default -> push there") is no longer what
 * `rescue_target()` does. Measured live: a studio's checked-out branch was
 * the head of an already-gated, already-reviewed PR, and rescue committed an
 * uncommitted dev-only edit straight onto it as a bot commit, pushed to that
 * branch. The round-2 design above assumed a studio's own non-default branch
 * was always safe to write to directly; it is not, whenever that branch is
 * also someone else's reviewed PR head. `rescue_target()` now ALWAYS
 * generates a fresh `fleet/rescue/<studio>-<ts>` ref in checkout mode,
 * exactly like `rescueSnapshotCmd`'s own `snapshot_target()` already does for
 * the identical reason (#312, below) — see `rescue_target()`'s own doc
 * comment for the current behavior.
 *
 * `RescueResult.branch` (below) reports whichever of the two the push
 * ACTUALLY landed on, never the one that was merely checked out — an
 * operator reading it after the fact can always find the work.
 *
 * Every git subcommand below is `git -C <dir>`, never a bare `cd` — this
 * exec shares the SAME persistent "sandbox-default" shell every other
 * sbExec call in this feature runs in (syncSession's tar, the credential
 * write, the next provisioned check), so a `cd` here would leak its cwd into
 * every one of them. No command in this file does that; this one doesn't
 * start.
 */
export const RESCUE_NO_CHECKOUT = "RESCUE_NO_CHECKOUT";
export const RESCUE_CLEAN = "RESCUE_CLEAN";
/** Issue #217: the tree's only changes are tool markers — nothing to rescue. */
export const RESCUE_MARKERS_ONLY = "RESCUE_MARKERS_ONLY";
/**
 * Issue #266 (follow-up on #251/#263): a RESCUE_PUSHED line's count field
 * used to be a bare number, and every consumer (do.ts's `pushLine` regex and
 * every downstream renderer) unconditionally labeled it "file(s)" — correct
 * for the dirty-tree case (`wn`, a `git status --porcelain` line count) and
 * the N2 stash case (`sfiles`, a `git diff --name-only` line count, despite
 * that variable's own name it genuinely IS a file count — verified by
 * reading its own assignment below, not assumed), but WRONG for the
 * "clean, but has unpushed commits" case (`wahead`/`bahead`, both a `git
 * rev-list --count` — a COMMIT count, not a file count): a studio with 3
 * already-committed-but-never-pushed commits and zero dirty files logged
 * "rescue-push saved 3 file(s)", actively misleading. A third field now
 * says which: `RESCUE_PUSHED <target> <count> <files|commits>`.
 */
export const RESCUE_PUSHED_KIND_FILES = "files";
export const RESCUE_PUSHED_KIND_COMMITS = "commits";
export const RESCUE_PUSHED_PREFIX = "RESCUE_PUSHED";
/**
 * PR #263 round 2 (#251 review), C1: one worktree's own status/add/commit/
 * push step failed — `<wt> <step>`, `wt` the same identifier RESCUE_PUSHED
 * uses for that worktree ("checkout" for the main checkout, the worktree's
 * own unique admin name otherwise — see C4 below), `step` one of status/add/
 * commit/push. Never silently swallowed into RESCUE_CLEAN/RESCUE_MARKERS_ONLY
 * (do.ts's rescuePush throws on any line with this prefix).
 */
export const RESCUE_FAILED_PREFIX = "RESCUE_FAILED";

/**
 * Issue #251: the fix above (RESCUE_MARKER_PATHSPECS) closed one hole and
 * opened another, measured live the same day — `.claude/worktrees` is
 * excluded from the MAIN checkout's own `status`/`add` scope so its gitlink
 * never enters a rescue commit, but that same exclusion made the marker
 * logic treat the worktree DIRECTORY itself as nothing to look at, when it
 * is in fact a real nested git worktree (`git worktree add`, not a plain
 * directory) that can hold real, uncommitted, un-pushed work of its own — a
 * member subagent's ~183k-token feature was lost exactly this way on
 * `fleet destroy`, because rescue never walked in. `git worktree list
 * --porcelain` (run from the main checkout, which always knows about every
 * worktree registered against the same `.git`) enumerates every one of
 * them — the main checkout plus every `.claude/worktrees/<name>` member —
 * and each is now inspected and rescued independently:
 *   - dirty (beyond markers) -> committed under the same fixed fleet
 *     identity as the main checkout, pushed to its OWN generated
 *     `fleet/rescue/<studio>/wt/<worktree-name>-<timestamp>` ref (the
 *     worktree's `basename`, so two member worktrees' rescues never
 *     collide) — never the worktree's own current branch, never main.
 *   - clean, but holds commits no remote-tracking ref already has (an
 *     upstream-less branch, or a real branch ahead of its `@{u}`) — the
 *     "committed but unpushed" loss measured separately (~24 minutes lost
 *     on a container exit, nothing had ever pushed those commits) — its
 *     current HEAD is pushed to that same ref scheme, no commit needed.
 *     `git rev-list --count HEAD --not --remotes` answers both shapes at
 *     once: it is the count of commits reachable from HEAD that NO
 *     remote-tracking ref already contains, upstream configured or not.
 *   - markers-only, or already fully covered by some remote-tracking ref:
 *     nothing to do — a worktree freshly `git worktree add -b`'d off an
 *     already-pushed tip (this file's own test fixture) must still count
 *     as clean, exactly like the main checkout's existing markers-only case
 *     always has.
 * The main checkout keeps its own pre-existing behaviour unchanged (dirty ->
 * commit + target resolution; see the file-level history above — issue #207
 * later changed WHAT that resolution produces, never whether it runs) and
 * additionally gets the same "clean but unpushed" check the
 * worktree loop uses, closing the same loss for it too. `any`/`markers`
 * track whether anything was pushed and whether markers-only was ever the
 * reason nothing was, across EVERY worktree — so a clean main checkout
 * beside a dirty member worktree still reports the push (never a bare
 * RESCUE_CLEAN just because the main checkout alone looked clean), and
 * "markers-only everywhere" still reports RESCUE_MARKERS_ONLY, not
 * RESCUE_CLEAN, matching the main-checkout-only behaviour this replaces.
 *
 * #251 review finding (sourced from a separate review on #259): the main
 * checkout's own branch-vs-default resolution above trusted `git rev-parse
 * --abbrev-ref HEAD` to always return a real branch name. In DETACHED HEAD
 * (a checkout mid-`git checkout <sha>`, or mid-rebase — real states a
 * teardown can catch a studio in) it instead returns the literal string
 * "HEAD", which is never equal to the resolved default branch, so the
 * comparison fell through to the branch-push path and used that literal
 * string as the push target — landing a real ref at `refs/heads/HEAD` on
 * origin, colliding with git's own special symbolic meaning for that name.
 * Both main-checkout branches below now treat `branch = "HEAD"` exactly
 * like "checked out branch is the default": always the generated
 * `fleet/rescue/...` ref, never a branch literally named HEAD. The
 * worktree loop further down never had this hole — it always pushes to a
 * generated `fleet/rescue/<studio>-<worktree>-<timestamp>` ref regardless
 * of what's checked out, so it needs no equivalent check.
 *
 * Issue #207 (2026-10-03): superseded — `rescue_target()` no longer inspects
 * `HEAD`/the checked-out branch at all in checkout mode (see its own doc
 * comment), so there is no branch-vs-default comparison left for a literal
 * "HEAD" string to fall through. The "ref literally named HEAD" collision
 * this paragraph fixed is still impossible today, just for a simpler
 * reason: every checkout-mode target is now unconditionally generated.
 *
 * PR #263 round 2 (board issue #251, HOLD review): six more holes measured
 * against real git, closed together because they all live in this same
 * shell script:
 *
 *   C1. A rejected push, an `index.lock`, a failing pre-commit hook, or a
 *       ref collision was never distinguished from "nothing to do" — the
 *       tail only ever printed RESCUE_CLEAN/RESCUE_MARKERS_ONLY when NO
 *       push happened, never when one FAILED to happen. Every git step
 *       (status/add/commit/push) is now checked; any failure prints
 *       `RESCUE_FAILED <wt> <step>` immediately and moves on to the next
 *       worktree — one failure never blocks another worktree's rescue, and
 *       the tail's CLEAN/MARKERS_ONLY fallback only fires when `fail`
 *       (below) is still 0. Commits use `--no-verify` (a rescue commit is
 *       not a normal commit a human is reviewing, and a broken pre-commit
 *       hook must never be the reason work is lost); at the time this was
 *       written, pushes deliberately did NOT also skip hooks — issue #259's
 *       own push guard had to see them, because rescue_target() could still
 *       return a real, checked-out branch's own name back then. Issue #207
 *       (2026-10-03) superseded that: rescue_target() in checkout mode now
 *       always generates a fresh ref, never a real branch name, so every
 *       push below (like every push rescueSnapshotCmd's own rescue_push()
 *       already made) now uses `--no-verify` unconditionally too — see
 *       rescue_push()'s own doc comment for why that's safe today.
 *   C2. The markers-only arm and the "clean but has unpushed commits" arm
 *       used to be mutually exclusive branches of one if/elif/else, so a
 *       worktree whose ONLY untracked change was a marker (`.claude/
 *       worktrees/...`, always true of the main checkout once it holds any
 *       member) short-circuited before the unpushed-commits check ever ran
 *       — a lead's own already-committed-but-never-pushed work went
 *       unreported as RESCUE_MARKERS_ONLY. The unpushed check now always
 *       runs when the scoped status is empty, regardless of whether the
 *       marker was present; `markers=1` is set only when THAT worktree
 *       pushed nothing at all.
 *   C3. `guardedCloneCmd`'s `--depth 1` clone never gets a local
 *       `refs/remotes/origin/<target>` for a freshly generated rescue ref
 *       (only the configured single-branch fetch refspec does), so
 *       `rev-list --not --remotes` re-counts the SAME already-pushed
 *       commit as "ahead" on every subsequent run — re-pushing forever.
 *       Every successful push now runs `git update-ref refs/remotes/
 *       origin/<target> HEAD` immediately after, so the next run sees the
 *       work as already saved.
 *   C4. Two worktrees whose DIRECTORY names happen to share a basename
 *       (nested vs. not, created in the same session) used to generate the
 *       identical ref in the identical second, and the second push lost —
 *       rejected non-fast-forward. Git itself already disambiguates two
 *       worktrees' own administrative directories (`.git/worktrees/<name>`,
 *       `<name>1`, ...); the ref-naming scheme now reads THAT name (`basename
 *       "$(git -C "$w" rev-parse --git-dir)"`), which is unique by
 *       construction. Never a `+`/`--force` push anywhere in this file.
 *
 *       Issue #266 (follow-up on #251/#263): this unique `$id` originally sat
 *       directly between two dashes in a FLAT ref — `fleet/rescue/<studio>-
 *       $id-<timestamp>` — the exact same flat tree the main checkout's own
 *       fallback ref lives under (`fleet/rescue/<studio>-<timestamp>`, no
 *       `$id` at all). provision.ts's discoverRescueRefsCmd anchors its flat
 *       pattern to `<studio>-` followed by EXACTLY 14 digits and end-of-
 *       string (see that anchor's own comment on the `websites--maestro`/
 *       `websites--maestro-2` collision it guards against) — a member
 *       worktree's ref has extra characters (`$id-`) between the dash and
 *       the digit run, so it never matched that anchor and sat on origin
 *       forever, invisible to the very auto-fetch this whole feature exists
 *       to provide: the identical class of silent loss round 4's Finding 2
 *       (above) closed for the N1/N2 nested shape, just for this flat member-
 *       worktree shape instead. Worse, `$id` is git's own admin-directory
 *       name (`agent-a1b2`, or a bare incrementing `agent-dup1` for a
 *       duplicate basename — see this test file's own C4 fixture) and is not
 *       CONTRACTUALLY guaranteed dash/digit-free, so no regex anchored only
 *       from the flat side could split `$id` from the trailing timestamp
 *       reliably. Fixed by giving `$id` its OWN path segment, `wt/`, the same
 *       way the N1/N2 nested shape already disambiguates its own `checkout/`
 *       segment from the flat tree below it — `fleet/rescue/<studio>/wt/
 *       $id-<timestamp>`. This still satisfies every existing guarantee:
 *       `$id` is still embedded and still unique (this comment's own
 *       collision-avoidance point above is unchanged), and it lives under
 *       the SAME `fleet/rescue/<studio>/` nested tree the N1/N2 shape already
 *       proved collision-safe against a hyphen-extended studio-id prefix (a
 *       studio id can never itself be a literal prefix of a DIFFERENT
 *       studio's id immediately followed by `/` — studio ids don't contain
 *       `/`). discoverRescueRefsCmd gets a third pattern alternative,
 *       `<nestedPrefix>wt/[^[:space:]]+-[0-9]{14}$`, matching this shape
 *       exactly like the other two.
 *   C5. `for w in $(git worktree list --porcelain | awk ...)` word-splits
 *       on whitespace — a worktree at a path containing a space was
 *       silently skipped, never even looked at. Paths are read one per
 *       line instead (`sed -n 's/^worktree //p'` piped into a
 *       `while IFS= read -r w; do ... done <<< "$list"` fed by a
 *       here-string, not a pipe, so `any`/`markers`/`fail` set inside the
 *       loop are still visible after it — a `| while` would run the loop in
 *       a subshell and lose them).
 *   A "prunable" worktree (registered, but its directory is gone — `git
 *   worktree list --porcelain` still reports it) is skipped with a plain
 *   `[ -d "$w" ]` check, quietly, never as a failure: there is nothing
 *   there to inspect, let alone rescue.
 */

/** `root` is a test seam (test/bun/rescue-push.test.ts); production is
 *  /workspace. `pushTimeoutSeconds` is a second test seam (issue #359 round
 *  3) — production always uses the default (RESCUE_PUSH_TIMEOUT_SECONDS).
 *  `serverDeadlineSeconds` is a third test seam (issue #371) — production
 *  always uses the default (RESCUE_SERVER_DEADLINE_SECONDS); see that
 *  constant's own doc comment above for why. `budgetMarginSeconds` is a
 *  fourth test seam (PR #376 review) — production always uses the default
 *  (RESCUE_BUDGET_MARGIN_SECONDS); see that constant's own doc comment. */
export function rescuePushCmd(
  repo: string, studio: string, root = "/workspace", pushTimeoutSeconds = RESCUE_PUSH_TIMEOUT_SECONDS,
  serverDeadlineSeconds = RESCUE_SERVER_DEADLINE_SECONDS, budgetMarginSeconds = RESCUE_BUDGET_MARGIN_SECONDS,
  // Issue #335 (public-release scrub): the real operator's bot identity used
  // to be a bare literal here — trailing optional params, neutral default,
  // same "absence = today's behavior" shape this file's own callers already
  // use elsewhere (do.ts's syncDeps() passes the real, env-configured value
  // through; every other/test caller gets this neutral default unchanged).
  botName = "fleetflare[bot]", botEmail = "fleetflare[bot]@users.noreply.github.com",
  // Issue #1 piece 5: private rescue remote + real git (RescuePushOptions).
  opts: RescuePushOptions = {},
): string {
  const dir = `${root}/${repo}`;
  // Issue #217: tool markers (RESCUE_MARKER_PATHS) never count as work and
  // never enter a rescue commit — measured 2026-09-24, a rescue branch whose
  // whole diff was Claude Code's `.claude/worktrees/agent-…` gitlink.
  const scope = `-- . ${RESCUE_MARKER_PATHSPECS}`;
  const identity = `-c user.name="${botName}" -c user.email="${botEmail}"`;
  return (
    // Issue #371: captured before anything else runs, via a literal `date
    // +%s` — not strictly necessary since every exec is a fresh `bash -c`
    // per `withKillDeadline` regardless of session, but used for clarity/
    // robustness independent of that detail (see
    // RESCUE_SERVER_DEADLINE_SECONDS's own doc comment above for the full
    // reasoning, including the #371-review correction of this file's
    // earlier, factually wrong "reused session" justification).
    `__rescue_start=$(date +%s)\n` +
    rescuePushPrelude(opts) +
    // Issue #371: checked once before every logical push attempt (a first
    // try plus its own immediate non-fast-forward retry counts as one — see
    // this file's own RESCUE_SERVER_DEADLINE_SECONDS doc comment). Prints
    // the exact `RESCUE_FAILED <id> budget <n> not attempted` line do.ts's
    // own parseRescueExecResult now parses a `detail` field out of, and
    // returns non-zero so its caller can `return`/`continue` without
    // starting a push that cannot finish before the server's own outer
    // exec deadline.
    // #371 review Finding 1: `mult` (2nd, optional arg, default 1) scales the
    // threshold to the worst case of the CALLER's own push shape — 1 for a
    // loop body whose target is always a freshly generated ref (branch-walk/
    // stash-walk below: structurally never rejected non-fast-forward, so
    // never retried, exactly one `timeout`-bounded push), 2 for a call site
    // that can run rescue_push()'s own first-attempt-plus-immediate-retry
    // pair (the dirty-tree and clean-but-ahead branches of rescue_one, in
    // BOTH command builders): a real, non-generated push target (the checked-
    // out branch's own name) CAN be rejected non-fast-forward, and the retry
    // that follows is its OWN independently timeout-bounded push, back-to-
    // back with no new loop iteration between them — so the worst case there
    // is genuinely TWO pushes' worth of `pushTimeoutSeconds + KILL_GRACE_SECONDS`,
    // not one. A single `mult`-parameterized helper, not a second copy of the
    // whole body: the only thing that differs between the two call shapes is
    // this one multiplier.
    `rescue_budget_ok() {\n` +
    `  local id="$1" mult="\${2:-1}" now remaining\n` +
    `  now=$(date +%s)\n` +
    `  remaining=$(( ${serverDeadlineSeconds} - (now - __rescue_start) ))\n` +
    `  if [ "$remaining" -lt $(( mult * (${pushTimeoutSeconds} + ${KILL_GRACE_SECONDS}) + ${budgetMarginSeconds} )) ]; then\n` +
    `    echo "${RESCUE_FAILED_PREFIX} $id budget $remaining not attempted"\n` +
    `    return 1\n` +
    `  fi\n` +
    `}\n` +
    `if [ ! -d ${dir}/.git ]; then echo "${RESCUE_NO_CHECKOUT}"; else\n` +
    `any=0; markers=0; fail=0\n` +
    // C4: the target ref for a worktree is named from git's OWN unique
    // admin directory name (never the worktree's directory basename, which
    // two independently-created worktrees can share) for a member, or an
    // unconditionally generated ref for the main checkout.
    //
    // Issue #207 (2026-10-03): superseded the branch-vs-default split this
    // function used to apply in checkout mode (see the "Fix round 2" comment
    // above rescuePushCmd for its own full history) — that split pushed to
    // the checked-out branch's OWN name whenever that branch wasn't the
    // repo's resolved default, on the theory that a studio's own task branch
    // is always safe to write to directly. A real incident proved that
    // theory wrong: a checked-out branch can be the head of an already-gated,
    // already-reviewed PR, and rescue must never write to it, ever. Now
    // ALWAYS generates in checkout mode, exactly like rescueSnapshotCmd's own
    // snapshot_target() already does for the identical reason (#312, see the
    // HOLD-round block below) — this function and that one are now the same
    // shape in checkout mode, modulo the calling convention (this one sets
    // `target` as a side effect via plain-statement-call; that one
    // `printf`s it for a `$(...)` capture).
    //
    // Fresh review of PR #359 round 1, Finding 1 (now moot, kept for
    // history): this used to need `target_generated` (1 = generated, 0 = the
    // checked-out branch's own real name) threaded out as a side effect, so
    // `rescue_push()` could decide `--no-verify` safety from provenance
    // rather than by pattern-matching the resulting string. Since this
    // function can no longer produce a real branch name, `target_generated`
    // would always be 1 — removed, along with `rescue_push()`'s own
    // conditional on it; see that function's own comment below.
    `rescue_target() {\n` +
    `  local mode="$1" id="$2"\n` +
    `  if [ "$mode" = "checkout" ]; then\n` +
    `    target="fleet/rescue/${studio}-$(date -u +%Y%m%d%H%M%S)"\n` +
    `  else\n` +
    // Issue #266: `$id` gets its own path segment (`wt/`) rather than sitting
    // flat between two dashes — see this function's own C4 comment above for
    // why the old flat shape was ambiguous to discoverRescueRefsCmd's regex.
    `    target="fleet/rescue/${studio}/wt/$id-$(date -u +%Y%m%d%H%M%S)"\n` +
    `  fi\n` +
    `}\n` +
    // PR #263 round 3 (#251 review), N3: a push rejected non-fast-forward —
    // the shallow-clone "(fetch first)" rejection this file's own header
    // already documents — used to fall straight into RESCUE_FAILED, and the
    // caller (do.ts's rescuePush) throws on that, which does NOT stop the
    // kill that follows (rescuePush's own doc comment: a failed rescue must
    // never block teardown) — so the work was gone. The SAME content is
    // retried, once, to a freshly generated `fleet/rescue/...` ref that has
    // no existing tip on origin to reject AGAINST. Prints whichever ref the
    // push ACTUALLY landed on (stdout) so the caller's `update-ref`/
    // RESCUE_PUSHED always name the right one; returns non-zero only when
    // BOTH attempts failed — that, and only that, is a genuine RESCUE_FAILED.
    // Never a `+`/`--force` retry: the fallback ref is BRAND NEW, so a plain
    // push is never rejected on it for the same reason.
    //
    // Issue #207 (2026-10-03): this comment used to open with "the
    // checked-out branch moved on origin since this worktree last knew about
    // it (a lead's own PR branch, pushed to from somewhere else while this
    // container was still up)" as the first-push-rejected scenario, with a
    // live-verified test fixture reproducing it (a second clone pushing
    // ahead of the checked-out branch). That scenario required the FIRST
    // push attempt to target a real, checked-out branch — the exact
    // behavior this issue's fix removed. `rescue_target()` in checkout mode
    // now always generates a fresh ref as the first attempt, which nothing
    // on origin can ever collide with, so that fixture's precondition can no
    // longer occur; the test was deleted. Only the shallow-clone "(fetch
    // first)" rejection (this file's own header comment) can still reach
    // this retry today — the same already-accepted gap
    // rescueSnapshotCmd's own HOLD-round comment already documents for its
    // own NFF-retry call site ("there is no real-branch-collision fixture
    // that reaches rescueSnapshotCmd's own retry call site at all").
    rescueTryPushFn(identity, pushTimeoutSeconds) + rescueWtFn() + rescueOnOriginFn(pushTimeoutSeconds) +
    `rescue_push() {\n` +
    // Issue #216 fix 4: `rbranch`, 5th and optional, defaults to `$ref` when
    // the caller omits it — forwarded to rescue_try_push's own new 5th
    // param on both call sites below, for its parentless shallow-clone
    // fallback snapshot's `Rescued-From:` trailer.
    `  local w="$1" id="$2" target="$3" ref="\${4:-HEAD}" rbranch="\${5:-\${4:-HEAD}}" perr prc ftarget\n` +
    // Issue #359, measured live 2026-09-26: a slow or hanging pre-push hook
    // in the TARGET repo (lefthook, this codebase has no control over its
    // config) stalled rescue-all's push step on 4/5 busy studios — exactly
    // "finalize-902 (push)"-shaped failures. `--no-verify` unconditionally
    // here, same as rescueSnapshotCmd's own `rescue_push()`.
    //
    // Issue #207 (2026-10-03): superseded a `$generated`-conditional
    // `--no-verify` that used to live here — rescue_target() could still
    // return a real, checked-out branch's own name in that older design, and
    // a real branch push had to keep going through a repo's own pre-push
    // hook (the C1 comment's own "pushes deliberately do NOT [skip hooks]"
    // point, written for that now-removed case). Since rescue_target() can
    // no longer produce a real branch name, this function's only possible
    // target is always a freshly generated, throwaway ref, so `--no-verify`
    // applies unconditionally — no provenance flag needed. Never
    // `+`/`--force` regardless.
    // Issue #359 round 3: `timeout -k <grace> <secs>` bounds a single push
    // that stalls (a slow/hanging pre-push hook) to its OWN small budget —
    // see this file's own header comment above for why. A killed push's exit
    // code is simply non-zero, so `prc` below already treats it exactly like
    // a rejected one; no other line here needs to change.
    // Issue #16: rescue_try_push (rescueTryPushFn) adds the shallow-clone
    // snapshot fallback to both this attempt and the nff retry below.
    //
    // BLOCKER fix (2026-10-03, fresh-context review on #207): `ref` is a NEW
    // 4th, optional parameter (default `HEAD`, same `${4:-HEAD}` shape
    // rescueSnapshotCmd's own copy already uses) — the dirty-tree branch of
    // rescue_one() below now passes a synthetic snapshot sha here instead of
    // ever advancing the real `HEAD`; the clean-but-ahead branch still omits
    // it and gets `HEAD` unchanged, since those commits are the studio's own
    // real ones and pushing `HEAD` there was already correct.
    `  rescue_try_push "$w" --no-verify "$ref" "$target" "$rbranch"; prc=$?\n` +
    `  if [ "$prc" = "0" ]; then printf '%s' "$target"; return 0; fi\n` +
    `  if printf '%s' "$perr" | grep -qiE 'non-fast-forward|fetch first'; then\n` +
    // HOLD-round fix: this used to sit flat between two dashes
    // (`fleet/rescue/<studio>-<id>-<ts>-nff`) — the exact same shape the
    // member-worktree ref's own #266 fix (above) already moved OFF of, for
    // the identical reason: discoverRescueRefsCmd's flat pattern anchors to
    // EXACTLY 14 digits right after `<studio>-`; the extra `<id>-...-nff`
    // characters never matched it, so an nff-retried rescue sat on origin
    // invisible to the very auto-fetch this whole feature exists to provide.
    // Nested under the same `wt/` segment, with `-nff` sitting BEFORE the
    // real timestamp rather than after it, so this shape matches
    // discoverRescueRefsCmd's existing `wt/` pattern alternative unchanged —
    // no new pattern needed.
    `    ftarget="fleet/rescue/${studio}/wt/$id-nff-$(date -u +%Y%m%d%H%M%S)"\n` +
    // Issue #359: `$ftarget` is ALWAYS a freshly generated fleet/rescue/ ref
    // (constructed one line above, never a real branch name), so this retry
    // always qualifies for --no-verify unconditionally — no case check
    // needed here the way the first attempt above needs one.
    // Issue #359 round 3: same per-push timeout bound as the first attempt.
    `    if rescue_try_push "$w" --no-verify "$ref" "$ftarget" "$rbranch"; then printf '%s' "$ftarget"; return 0; fi\n` +
    `  fi\n` +
    // Issue #49: the reason reaches the caller (and the destroy/recycle
    // 409) instead of dying in this function's own \`perr\`.
    `  printf '%s\\n' "$perr" | tail -n 5 >&2\n` +
    `  return 1\n` +
    `}\n` +
    // Issue #216 fix 3 (PR #212's own round-2 review): shared by rescue_one's
    // two "nothing new to commit, is HEAD itself ahead of origin?" call
    // sites below -- the genuinely-clean-tree branch, and (new) the
    // dirty-tree branch's own tree-identity shortcut, once its `add -A`
    // happens to reproduce HEAD's own tree byte-for-byte. Extracted so both
    // never drift into two copies of the same ahead-of-origin/markers
    // bookkeeping. `wall`, 4th and optional, defaults to empty: the
    // tree-identity shortcut omits it deliberately (see its own call site's
    // comment below) since a dirty-but-tree-equal file is not evidence of a
    // genuine tool-marker-only state.
    `rescue_check_ahead() {\n` +
    `  local w="$1" id="$2" mode="$3" wall="\${4:-}" whead wahead target rbranch rc\n` +
    // Issue #313 (PR #263 round 5 review, Finding 3): same ambiguous-bare-
    // HEAD guard as this file's own rescue_one dirty-tree branch -- resolve
    // to a SHA first, never pass a bare `HEAD` straight to `rev-list`.
    `  whead=$(git -C "$w" rev-parse HEAD 2>/dev/null); rc=$?\n` +
    `  if [ "$rc" != "0" ] || [ -z "$whead" ]; then echo "${RESCUE_FAILED_PREFIX} $id rev-parse"; fail=$((fail+1)); return; fi\n` +
    `  wahead=$(git -C "$w" rev-list --count "$whead" --not --remotes 2>/dev/null); rc=$?\n` +
    `  if [ "$rc" != "0" ]; then echo "${RESCUE_FAILED_PREFIX} $id rev-list"; fail=$((fail+1)); return; fi\n` +
    // Issue #49: already an origin tip = already saved, nothing to push.
    `  if [ -n "$wahead" ] && [ "$wahead" != "0" ] && ! rescue_on_origin "$w" "$whead" "$(git -C "$w" symbolic-ref -q --short HEAD 2>/dev/null)"; then\n` +
    `    rescue_target "$mode" "$id"\n` +
    // Issue #371 review Finding 1: `mult=2`, same retry-pair worst case as
    // every other rescue_push() call site in this file.
    `    if ! rescue_budget_ok "$id" 2; then fail=$((fail+1)); return; fi\n` +
    // Issue #216 fix 4: same `Rescued-From: <branch>` capture as rescue_one's
    // own dirty-tree branch, threaded through as rescue_push's 5th arg.
    `    rbranch=$(git -C "$w" rev-parse --abbrev-ref HEAD 2>/dev/null); rbranch="\${rbranch:-HEAD}"\n` +
    `    if ! target=$(rescue_push "$w" "$id" "$target" HEAD "$rbranch"); then echo "${RESCUE_FAILED_PREFIX} $id push"; fail=$((fail+1)); return; fi\n` +
    `    git -C "$w" update-ref "refs/remotes/origin/$target" HEAD 2>/dev/null || true\n` +
    // Issue #266: $wahead is a COMMIT count (rev-list --count, above) --
    // never "file(s)".
    `    echo "${RESCUE_PUSHED_PREFIX} $target $wahead ${RESCUE_PUSHED_KIND_COMMITS}"; any=1\n` +
    `  elif [ -n "$wall" ]; then\n` +
    `    markers=1\n` +
    `  fi\n` +
    `}\n` +
    // C1: every step is checked; the first that fails prints
    // RESCUE_FAILED and returns (a function `return`, never a top-level
    // `exit` — the HARD RULE this whole file already follows) so ONE
    // worktree's failure never blocks another's. Commits use --no-verify
    // (#259's own push guard still sees the push, unmodified); pushes never
    // do, and never `+`/`--force`.
    `rescue_one() {\n` +
    `  local w="$1" id="$2" mode="$3" wall wstatus wn wahead whead target rc idxfile realidx tree sha rbranch\n` +
    `  wall="$(git -C "$w" status --porcelain 2>&1)"; rc=$?\n` +
    `  if [ "$rc" != "0" ]; then echo "${RESCUE_FAILED_PREFIX} $id status"; fail=$((fail+1)); return; fi\n` +
    `  wstatus="$(git -C "$w" status --porcelain --untracked-files=all ${scope} 2>&1)"; rc=$?\n` +
    `  if [ "$rc" != "0" ]; then echo "${RESCUE_FAILED_PREFIX} $id status"; fail=$((fail+1)); return; fi\n` +
    `  if [ -n "$wstatus" ]; then\n` +
    `    wn=$(printf '%s\\n' "$wstatus" | wc -l | tr -d ' ')\n` +
    `    rescue_target "$mode" "$id"\n` +
    // BLOCKER fix (2026-10-03, fresh-context review on #207): this used to
    // `git add -A` + `git commit` against the REAL index/HEAD of whatever is
    // checked out, before the push below was even attempted — if the push
    // then failed for ANY reason (budget, network, shallow-clone fallback
    // also failing) the caller's RESCUE_FAILED leaves the kill refused (see
    // do.ts's rescuePush/destroy/recycle), but the bot commit stayed sitting
    // on the real branch's real local HEAD, tree now clean — the lead's own
    // next ordinary `git push` on that branch would ship it straight onto
    // the real branch. Since rescue_target() (above) already always
    // generates a fresh throwaway ref in every mode, there is no remaining
    // reason for this step to touch the real checkout at all. Builds the
    // snapshot the exact same non-mutating way rescueSnapshotCmd's own
    // rescue_one() already does for its own dirty-tree branch: a detached,
    // out-of-band `GIT_INDEX_FILE` (seeded from a READ of the real index,
    // never a write to it — see that function's own doc comment for why the
    // seed step matters) feeds `write-tree` + `commit-tree -p HEAD`, so the
    // real `.git/index` and `HEAD` are never touched, in or out of this
    // function's own failure paths below.
    `    idxfile=$(mktemp 2>/dev/null) || { echo "${RESCUE_FAILED_PREFIX} $id add"; fail=$((fail+1)); return; }\n` +
    `    realidx=$(git -C "$w" rev-parse --absolute-git-dir 2>/dev/null)/index\n` +
    // Issue #216 fix 5 (NIT): `mktemp` above already created `$idxfile` as a
    // real, empty (0-byte) file. When `$realidx` does not exist (no real
    // index to seed from), that 0-byte file must NOT be handed to
    // `GIT_INDEX_FILE` below -- it is not a valid empty-index format, and
    // `add -A` fails outright. `rm -f` it instead: pointing `GIT_INDEX_FILE`
    // at a non-existent path makes git create a fresh, valid, empty index on
    // its own.
    `    if [ -f "$realidx" ]; then cp "$realidx" "$idxfile" 2>/dev/null || true; else rm -f "$idxfile"; fi\n` +
    `    if ! GIT_INDEX_FILE="$idxfile" git -C "$w" add -A ${scope}; then rm -f "$idxfile"; echo "${RESCUE_FAILED_PREFIX} $id add"; fail=$((fail+1)); return; fi\n` +
    `    tree=$(GIT_INDEX_FILE="$idxfile" git -C "$w" write-tree 2>/dev/null); rc=$?\n` +
    `    rm -f "$idxfile"\n` +
    `    if [ "$rc" != "0" ] || [ -z "$tree" ]; then echo "${RESCUE_FAILED_PREFIX} $id add"; fail=$((fail+1)); return; fi\n` +
    // Issue #216 fix 3 (PR #212's own round-2 review): a dirty tree whose
    // final content is byte-identical to HEAD's own tree is not a real
    // change -- stage something, then revert the working tree's own bytes
    // back to HEAD's (without re-staging), and `status --porcelain` stays
    // dirty (the INDEX still differs from HEAD) even though `add -A` above
    // -- which captures the CURRENT working tree, not the stale index --
    // just handed back HEAD's own tree right back. Committing and pushing
    // that would be a hollow "rescue" reporting success for a push with
    // nothing new in it. Falls through to the exact same ahead-of-origin/
    // markers bookkeeping the clean-tree branch below already does, via the
    // shared rescue_check_ahead() above -- `wall` deliberately omitted (see
    // that function's own doc comment): this file was real, not a tool
    // marker, so it must never be read as "markers-only" on its own.
    //
    // Board issue #216 review (minor, accepted tradeoff): `wall` was captured
    // ONCE, at this function's own top, before this branch knew the dirty
    // tree would turn out to revert to HEAD -- it can ALSO hold an unrelated,
    // genuinely marker-only file dirty in the SAME worktree at the same time.
    // Omitting it wholesale (rather than passing it through) loses that
    // signal too: such a worktree now reports RESCUE_CLEAN here instead of
    // RESCUE_MARKERS_ONLY. No work is lost either way (nothing is pushed in
    // either outcome) -- only the reported status is less precise than
    // before this fix existed. Filtering `wall` down to exclude just the
    // reverted path(s) instead of dropping it wholesale was considered and
    // rejected: `wall` (unscoped `status --porcelain`, captured before
    // `${scope}` was known) and `wstatus`/`$tree` (both scoped, captured
    // after) do not share a format simple enough to diff line-for-line
    // without risking reintroducing the exact bug this fix closed. Do not
    // "fix" this back to passing `wall` through unfiltered.
    `    if [ "$tree" = "$(git -C "$w" rev-parse "HEAD^{tree}" 2>/dev/null)" ]; then rescue_check_ahead "$w" "$id" "$mode"; return; fi\n` +
    // MAJOR fix (survival brief review): every rescue commit this file
    // produces now names the real branch it came from, as a git trailer
    // (blank line + `Rescued-From: <value>`, via a second `-m` — both
    // `git commit` and `git commit-tree` treat multiple `-m` flags as
    // separate paragraphs, which IS the trailer convention, with no literal
    // newline to quote through the shell). `rev-parse --abbrev-ref HEAD`
    // already returns the literal string `HEAD` in detached HEAD — the same
    // fallback this file's own history (see the Fix-round-2/#251-review
    // comments above) already established as the sane literal for that
    // case — so the `:-HEAD` only covers the (believed-impossible) case
    // where the command itself produced no output at all.
    `    rbranch=$(git -C "$w" rev-parse --abbrev-ref HEAD 2>/dev/null); rbranch="\${rbranch:-HEAD}"\n` +
    `    sha=$(git -C "$w" ${identity} commit-tree "$tree" -p HEAD -m "fleet: rescue-push before teardown" -m "Rescued-From: $rbranch" 2>/dev/null); rc=$?\n` +
    `    if [ "$rc" != "0" ] || [ -z "$sha" ]; then echo "${RESCUE_FAILED_PREFIX} $id commit"; fail=$((fail+1)); return; fi\n` +
    // Issue #371: checked once, before this logical push attempt (rescue_push's
    // own first try + its immediate nff retry) — never inside rescue_push()
    // itself, whose entire stdout is captured by this call's own `$(...)`
    // substitution and would otherwise never reach the script's real stdout.
    // #371 review Finding 1: `mult=2` — rescue_push() below can still run its
    // own first-attempt-plus-retry pair (the shallow-clone "(fetch first)"
    // rejection this file's own header documents can hit even a freshly
    // generated target), each an independently `timeout`-bounded push.
    // Budgeted for that worst case, not a single push's. (Issue #207: this
    // used to also cover a REAL, non-generated branch name being rejected
    // non-fast-forward by a concurrent push — rescue_target() can no longer
    // produce one, but the retry mechanism itself, and this budget, still
    // exist for the shallow-clone case.)
    `    if ! rescue_budget_ok "$id" 2; then fail=$((fail+1)); return; fi\n` +
    // BLOCKER fix: push the synthetic snapshot `$sha` (never `HEAD`, which
    // the real checkout's own HEAD still is, untouched) — same convention
    // rescueSnapshotCmd's own identical call site already uses.
    // Issue #216 fix 4: `$rbranch`, already captured above for this commit's
    // own trailer, threaded through as rescue_push's 5th arg too.
    `    if ! target=$(rescue_push "$w" "$id" "$target" "$sha" "$rbranch"); then echo "${RESCUE_FAILED_PREFIX} $id push"; fail=$((fail+1)); return; fi\n` +
    // C3: a --depth 1 clone gets no local remote-tracking ref for a
    // freshly generated target on its own — without this, the NEXT run
    // re-counts this exact commit as unpushed forever.
    // BLOCKER fix: tracks `$sha`, not `HEAD` — `HEAD` was never advanced.
    `    git -C "$w" update-ref "refs/remotes/origin/$target" "$sha" 2>/dev/null || true\n` +
    // Issue #266: $wn is a FILE count (status --porcelain line count, above).
    `    echo "${RESCUE_PUSHED_PREFIX} $target $wn ${RESCUE_PUSHED_KIND_FILES}"; any=1\n` +
    `  else\n` +
    // C2: this branch now ALWAYS runs when the scoped status is empty,
    // regardless of whether $wall was non-empty (a marker-only tree) —
    // never gated behind an if/elif that would skip it. `markers=1` is set
    // only in the one case where nothing else happened either.
    // Issue #216 fix 3: delegates to rescue_check_ahead() (above), shared
    // with the dirty-tree branch's own now-equivalent-to-clean shortcut —
    // see that function's own doc comment for the full reasoning (#313
    // Finding 3's ambiguous-bare-HEAD guard included, unchanged).
    `    rescue_check_ahead "$w" "$id" "$mode" "$wall"\n` +
    `  fi\n` +
    `}\n` +
    // PR #263 round 3, N4: `rescue_one` runs inside the `while ... <<<
    // "$wtlist"` here-string loop below — any command inside it that reads
    // its OWN stdin without a redirect would otherwise inherit that SAME
    // here-string, silently consuming a line meant for the outer loop's own
    // `read -r w` and truncating the worktree list (verified live in plain
    // bash: a child process's bare `read` drains the next line). Real git's
    // own hooks turned out already immune (pre-commit/post-commit/pre-push
    // all get their stdin redirected or piped by git itself, verified live
    // against this exact git version) — but nothing here should depend on
    // that happening to be true forever. `</dev/null` on both calls means
    // every command `rescue_one` runs — this one and any future one — gets a
    // stdin that reads EOF immediately, never the outer here-string.
    `rescue_wt "${dir}" "checkout" "checkout" </dev/null\n` +
    // C5: worktree paths are read one per line from a here-string, never
    // word-split from a bare `$(...)` — a path containing a space survives.
    // A "prunable" worktree (registered, directory gone) is skipped
    // quietly by the plain `[ -d "$w" ]` check, never as a failure.
    `wtporcelain="$(git -C ${dir} worktree list --porcelain)"\n` +
    `wtlist="$(printf '%s\\n' "$wtporcelain" | sed -n 's/^worktree //p')"\n` +
    // N1/N2 below need to know which branches are ALREADY spoken for by a
    // worktree's own checkout (`porcelain`'s own `branch refs/heads/<name>`
    // line per entry) — captured once, from the SAME listing, rather than a
    // second `git worktree list` call. PR #263 round 4 (#251 review, Finding
    // 1, HIGH): a "prunable" worktree (registered, directory gone — e.g.
    // `rm -rf`'d instead of `git worktree remove`) still emits its own
    // `branch refs/heads/<name>` porcelain line, but the per-worktree loop
    // below skips it (`[ -d "$w" ] || continue` — nothing to walk into,
    // `rescue_one` never runs for it). Building `checked_out` from EVERY
    // branch line, live or prunable, wrongly told this walk "already
    // covered" for a branch nothing had actually rescued — reproducing the
    // exact "worktree gone, work lost" failure #251 exists to fix, immune to
    // this file's own worktree-loop fix for it. `checked_out` now only
    // suppresses a branch whose worktree DIRECTORY still exists (`[ -d
    // "$cur" ]`, tracked as each porcelain entry's `worktree <path>` line is
    // read, one entry ahead of its own `branch` line) — a prunable entry's
    // branch is deliberately left OUT, so the walk below treats it like any
    // other not-currently-live local branch: pushed if it holds unpushed
    // commits, exactly the coverage a live worktree's own `rescue_one` would
    // otherwise have provided.
    //
    // PR #263 round 5 (#251 review, LOW): this used to be a `case "$pline"
    // in ... esac` statement NESTED inside this `$(...)` command
    // substitution. Bash 3.2 (macOS's own shipped `/bin/bash` — never
    // upgraded, for licensing reasons — the interpreter every Mac-run test
    // pass uses) cannot reliably parse a `case` pattern's own `)` terminators
    // while it is still scanning for the matching `)` that closes a `$(...)`
    // substitution, and silently parses this whole block as producing
    // nothing rather than raising a syntax error — `checked_out` came back
    // empty on a Mac, and every test exercising this code path passed for
    // the wrong reason (an empty skip-list happens to look harmless against
    // this suite's own small fixtures). Production runs bash 5.1 in the
    // container and was never affected. Rewritten with plain `if`/`[ ]`
    // prefix checks (`${pline#prefix}` compared against the unstripped
    // string) instead of `case` — no construct here that bash 3.2's
    // command-substitution scanner can misparse, so a Mac-run test now
    // genuinely exercises this logic instead of silently no-op'ing.
    `checked_out="$(\n` +
    `  cur=""\n` +
    `  while IFS= read -r pline; do\n` +
    `    if [ "\${pline#worktree }" != "$pline" ]; then\n` +
    `      cur="\${pline#worktree }"\n` +
    `    elif [ "\${pline#branch refs/heads/}" != "$pline" ]; then\n` +
    `      if [ -d "$cur" ]; then printf '%s\\n' "\${pline#branch refs/heads/}"; fi\n` +
    `    fi\n` +
    `  done <<< "$wtporcelain"\n` +
    `)"\n` +
    `if [ -n "$wtlist" ]; then\n` +
    `  while IFS= read -r w; do\n` +
    `    [ "$w" = "${dir}" ] && continue\n` +
    `    [ -d "$w" ] || continue\n` +
    `    wid=$(basename "$(git -C "$w" rev-parse --git-dir)")\n` +
    `    rescue_wt "$w" "$wid" "member" </dev/null\n` +
    `  done <<< "$wtlist"\n` +
    `fi\n` +
    // PR #263 round 3, N1: a local branch holding commits with no
    // remote-tracking ref that already has them is invisible to every check
    // above when it is NOT the branch currently checked out anywhere — the
    // per-worktree "clean but ahead" check above only ever looks at THAT
    // worktree's own HEAD. Measured live: `git checkout -b feat && git
    // commit ... && git checkout main` leaves `feat` holding a real commit,
    // `main` checked out and clean, and the old rescue-push reported a bare
    // RESCUE_CLEAN — `feat`'s commit was gone the moment the container died.
    // `refs/heads` is shared repo-wide (every worktree of one repo sees the
    // identical set), so this walks it ONCE, from the main checkout, rather
    // than redundantly re-finding the same branches from every worktree.
    // Every branch already checked out somewhere (`$checked_out`, above) is
    // skipped — it is already covered by `rescue_one`'s own per-worktree
    // check, and pushing it again here would just be the same commits landing
    // on a SECOND, redundant ref. The ref shape is deliberately NESTED
    // (`fleet/rescue/<studio>/<ts>/checkout/<branch>`), not the flat
    // `<studio>-<id>-<ts>` scheme above — `<branch>` is already unique per
    // repo (git enforces that), so this is collision-safe by construction,
    // and `<ts>` is captured ONCE for this whole walk, not re-generated per
    // branch, exactly as intended for "one rescue run". PR #263 round 4
    // (#251 review, Finding 2): this nested shape is auto-discovered on the
    // next provision too — provision.ts's discoverRescueRefsCmd matches and
    // fetches it (a second pattern, alongside the flat one), so a rescued
    // branch here needs no manual `git fetch` any more than the flat scheme
    // does.
    //
    // PR #263 round 4 (#251 review, Finding 3, LOW): this is the same
    // here-string-fed `while read` shape N4 (above) already hardened
    // `rescue_one` against — every git invocation below (not only the
    // `push`, which already had it) now redirects stdin from `/dev/null`,
    // matching that same posture instead of relying on today's `for-each-
    // ref`/`rev-list`/`update-ref` happening not to read stdin.
    //
    // PR #263 round 5 (#251 review, HIGH): a branch literally named after a
    // top-level repo path — `docs`, `src`, `test`, `apps` (this very repo
    // has `apps/`) — made the `rev-list --count "$b" --not --remotes` call
    // below AMBIGUOUS the moment a top-level directory/file of that same
    // name also exists in the working tree: git cannot tell whether a bare
    // `docs` means the revision `docs` or the pathspec `docs`, and refuses
    // to guess (`fatal: ambiguous argument 'docs': both revision and
    // filename`). The old `|| echo 0` fallback could not distinguish that
    // failure from "branch genuinely has zero commits ahead" (a real, common
    // case on this same line) and silently treated the branch as fully
    // covered — no push, no RESCUE_FAILED, nothing; the branch's real
    // unpushed commit was simply never checked. `refs/heads/$b` (never a
    // bare `$b`) disambiguates every git invocation below that takes a
    // branch name: a ref path is never also a valid pathspec, so git never
    // has to guess. `|| echo 0` is gone; any git failure here (ambiguous
    // argument or otherwise) now prints its own `RESCUE_FAILED checkout:$b
    // rev-list` line and moves on to the next branch, matching this file's
    // own C1 failure-reporting convention rather than silently reading as
    // "nothing to do".
    //
    // PR #263 round 6 (#251 review, MEDIUM): `refs/heads/$b` (no trailing
    // `--`) is intentional, not an oversight — adding `--` here would ALSO
    // disambiguate a bare `$b`, which would silently defeat the round 5
    // reversion-mutant test (a future revert of `refs/heads/$b` back to a
    // bare `$b` must still be caught by a failing test). The stderr on this
    // `rev-list` is discarded (`2>/dev/null`, not `2>&1`): the `RESCUE_FAILED`
    // line below is a static string that never reads it, and merging it into
    // `$bahead` would corrupt the success path instead — `$bahead` is echoed
    // verbatim as `RESCUE_PUSHED`'s count field, which `do.ts` parses with a
    // strict single-line `^RESCUE_PUSHED (\S+) (\d+)$` regex; a real, benign
    // git warning on stderr (e.g. a dangling `origin/HEAD` symref, which can
    // follow a shallow/single-branch clone drifting) while the command still
    // exits 0 would otherwise make that line multi-line and fail the regex,
    // even though the push genuinely succeeded.
    `runts=$(date -u +%Y%m%d%H%M%S)\n` +
    // Issue #313 (PR #263 round 5 review, Finding 2): `:short` only strips
    // the leading `refs/heads/` when the RESULT is unambiguous across every
    // ref namespace -- a tag sharing a branch's exact name (`refs/tags/docs`
    // alongside `refs/heads/docs`) forces it to leave `heads/docs` in place,
    // which then fails every `refs/heads/$b` lookup below (no such ref) with
    // a spurious RESCUE_FAILED. `:lstrip=2` strips exactly two path
    // components unconditionally -- safe here since this query is already
    // scoped to `refs/heads` alone, nothing to disambiguate against within
    // it. Verified live: `:short` prints `heads/docs` once a tag `docs`
    // exists; `:lstrip=2` prints `docs` regardless.
    `allbranches="$(git -C ${dir} for-each-ref --format='%(refname:lstrip=2)' refs/heads </dev/null)"\n` +
    `if [ -n "$allbranches" ]; then\n` +
    `  while IFS= read -r b; do\n` +
    `    [ -z "$b" ] && continue\n` +
    // Issue #313 (PR #263 round 5 review, Finding 1): `-e` forces the next
    // argument to be treated as a PATTERN, never an option -- without it, a
    // branch literally named `-x` (not createable via `git branch`/`checkout
    // -b`, which both refuse it, but real on-disk once written via the raw
    // ref plumbing) makes `grep -qxF "-x"` exit 2 with its own usage error
    // instead of performing the literal match, silently defeating this skip
    // for that one input. Verified live against real GNU grep.
    `    printf '%s\\n' "$checked_out" | grep -qxF -e "$b" && continue\n` +
    `    bahead=$(git -C ${dir} rev-list --count "refs/heads/$b" --not --remotes </dev/null 2>/dev/null); brc=$?\n` +
    `    if [ "$brc" != "0" ]; then echo "${RESCUE_FAILED_PREFIX} checkout:$b rev-list"; fail=$((fail+1)); continue; fi\n` +
    // Issue #49: same already-on-origin check as rescue_one's.
    `    if [ -n "$bahead" ] && [ "$bahead" != "0" ] && ! rescue_on_origin ${dir} "$(git -C ${dir} rev-parse -q --verify "refs/heads/$b" </dev/null 2>/dev/null)" "$b"; then\n` +
    `      btarget="fleet/rescue/${studio}/$runts/checkout/$b"\n` +
    // Issue #371: checked once before this loop-body's own single push
    // attempt (this branch never retries — its target is already a freshly
    // generated ref, never subject to a non-fast-forward rejection). A loop
    // body, so `continue` (never `return`) is the right control flow here.
    `      if ! rescue_budget_ok "checkout:$b"; then fail=$((fail+1)); continue; fi\n` +
    // Issue #359: `$btarget` is ALWAYS a generated fleet/rescue/ ref (built
    // one line above; a local branch's own name never enters it), so this
    // push always qualifies for --no-verify unconditionally — never a real
    // branch push, unlike rescue_push()'s own conditional check above.
    // Issue #359 round 3: same per-push timeout bound as rescue_push()'s own
    // pushes above — see this file's own header comment.
    // Issue #216 fix 1: 5th arg `"$b"` is the real branch name, for the
    // shallow-clone fallback's `Rescued-From:` trailer should it fire here --
    // without it the trailer would default to `$btarget`, the generated
    // throwaway ref itself, naming nothing useful.
    `      if ! rescue_try_push ${dir} --no-verify "refs/heads/$b" "$btarget" "$b" </dev/null; then\n` +
    `        echo "${RESCUE_FAILED_PREFIX} checkout:$b push"; fail=$((fail+1))\n` +
    // Issue #58: the reason reaches the 409, same as rescue_push's.
    `        printf '%s\\n' "$perr" | tail -n 5 >&2\n` +
    `      else\n` +
    `        git -C ${dir} update-ref "refs/remotes/origin/$btarget" "refs/heads/$b" </dev/null 2>/dev/null || true\n` +
    // Issue #266: $bahead is a COMMIT count (rev-list --count, above) —
    // never "file(s)".
    `        echo "${RESCUE_PUSHED_PREFIX} $btarget $bahead ${RESCUE_PUSHED_KIND_COMMITS}"; any=1\n` +
    `      fi\n` +
    `    fi\n` +
    `  done <<< "$allbranches"\n` +
    `fi\n` +
    // PR #263 round 3, N2: `git stash` is invisible to every check above —
    // never a branch, never a worktree's own HEAD. `refs/stash` is
    // repository-wide, shared by every worktree (verified live: a stash made
    // INSIDE a member worktree shows up in `git stash list` run from the
    // main checkout), so — like the branch walk above — one scan from the
    // main checkout sees every entry from every worktree exactly once. Each
    // entry is a real commit (`git rev-parse stash@{N}`); pushed straight to
    // `fleet/rescue/<studio>/<ts>/checkout/stash-<N>` WITHOUT touching the
    // stash itself (never a `stash pop`/`drop` — the container's own stash
    // list is left exactly as it was), and counted in the summary exactly
    // like any other RESCUE_PUSHED line. `--not --remotes` first, same as
    // the branch walk, makes re-running this idempotent instead of
    // re-pushing the same stash forever. PR #263 round 4 (#251 review,
    // Finding 3): same `/dev/null` stdin hardening as the branch walk above,
    // on every git invocation in this loop, not only its `push`. Finding 2:
    // this ref shape is auto-discovered on the next provision too — see the
    // N1 comment above and provision.ts's discoverRescueRefsCmd.
    `stashlist="$(git -C ${dir} stash list --format='%gd' </dev/null 2>/dev/null)"\n` +
    `if [ -n "$stashlist" ]; then\n` +
    `  while IFS= read -r sref; do\n` +
    `    [ -z "$sref" ] && continue\n` +
    `    ssha=$(git -C ${dir} rev-parse "$sref" </dev/null 2>/dev/null) || continue\n` +
    `    sn=$(printf '%s' "$sref" | sed -n 's/^stash@{\\([0-9]*\\)}$/\\1/p')\n` +
    // Issue #313 (PR #263 round 5 review, Finding 3): same discipline as the
    // branch walk's own `brc` check above -- `$ssha` is already a resolved
    // SHA (never a bare `HEAD`), so this call is not exposed to the same
    // ambiguous-argument failure mode, but a genuine git failure here must
    // still never be misread as "nothing to push" the way `|| echo 0` did.
    `    sahead=$(git -C ${dir} rev-list --count "$ssha" --not --remotes </dev/null 2>/dev/null); src=$?\n` +
    `    if [ "$src" != "0" ]; then echo "${RESCUE_FAILED_PREFIX} checkout:stash-$sn rev-list"; fail=$((fail+1)); continue; fi\n` +
    `    if [ -n "$sahead" ] && [ "$sahead" != "0" ]; then\n` +
    `      sfiles=$(git -C ${dir} diff --name-only "$sref^1" "$sref" </dev/null 2>/dev/null | wc -l | tr -d ' ')\n` +
    `      if [ -z "$sfiles" ] || [ "$sfiles" = "0" ]; then sfiles=1; fi\n` +
    `      starget="fleet/rescue/${studio}/$runts/checkout/stash-$sn"\n` +
    // Issue #371: same single check ahead of this loop body's own single
    // push attempt as the branch-walk above — `continue`, matching this
    // loop body's own control flow (never `return`).
    `      if ! rescue_budget_ok "checkout:stash-$sn"; then fail=$((fail+1)); continue; fi\n` +
    // Issue #359: `$starget` is ALWAYS a generated fleet/rescue/ ref (built
    // one line above), so this push always qualifies for --no-verify
    // unconditionally — never a real branch push.
    // Issue #359 round 3: same per-push timeout bound as every other push in
    // this file — see this file's own header comment.
    // Issue #216 fix 1: 5th arg `"stash-$sn"` is the real stash identifier
    // (same spelling as `$starget`'s own suffix and the RESCUE_FAILED line
    // above), for the shallow-clone fallback's `Rescued-From:` trailer should
    // it fire here -- without it the trailer would default to `$starget`,
    // the generated throwaway ref itself, naming nothing useful.
    `      if ! rescue_try_push ${dir} --no-verify "$ssha" "$starget" "stash-$sn" </dev/null; then\n` +
    `        echo "${RESCUE_FAILED_PREFIX} checkout:stash-$sn push"; fail=$((fail+1))\n` +
    // Issue #58: the reason reaches the 409, same as rescue_push's.
    `        printf '%s\\n' "$perr" | tail -n 5 >&2\n` +
    `      else\n` +
    `        git -C ${dir} update-ref "refs/remotes/origin/$starget" "$ssha" </dev/null 2>/dev/null || true\n` +
    // Issue #266: $sfiles, despite `sahead` (the rev-list gate above) being a
    // commit count, IS genuinely a FILE count — `git diff --name-only`
    // between the stash and its own first parent, floored at 1 (verified by
    // reading its own assignment above, not assumed from the variable name).
    `        echo "${RESCUE_PUSHED_PREFIX} $starget $sfiles ${RESCUE_PUSHED_KIND_FILES}"; any=1\n` +
    `      fi\n` +
    `    fi\n` +
    `  done <<< "$stashlist"\n` +
    `fi\n` +
    `if [ "$any" = "0" ] && [ "$fail" = "0" ]; then\n` +
    `  if [ "$markers" = "1" ]; then echo "${RESCUE_MARKERS_ONLY}"; else echo "${RESCUE_CLEAN}"; fi\n` +
    `fi\n` +
    `fi`
  );
}

/**
 * Issue #266 (follow-up on #251/#263): `fleet rescue-all` (do.ts's
 * `rescueNow`) runs against studios that are still ALIVE and actively worked
 * on — the whole point of the command, a pre-image-deploy safety net — not
 * only against a container that is about to die anyway. The paragraph that
 * used to open this comment argued `rescuePushCmd` above was fine mutating
 * the real index/HEAD at teardown ("the container is doomed regardless") in
 * a way that would NOT have been fine here, against a live studio — that
 * argument is superseded below; read on.
 *
 * BLOCKER fix (fresh-context review on #207, 2026-10-03): that argument for
 * `rescuePushCmd` turned out to be wrong even at teardown. `rescue_target()`
 * (above) now always generates a fresh, throwaway ref — never the real
 * checked-out branch — so a successful push was never the risk; an UNSUCCESSFUL
 * one was. If the push failed for any reason (budget exhausted, network, the
 * shallow-clone fallback also failing) AFTER the real index/HEAD had already
 * been mutated, the caller (`do.ts`'s `rescuePush`) throws on the resulting
 * `RESCUE_FAILED`, and `destroy`/`recycle` refuse the kill on that throw
 * (unless `--discard-unsynced`) — so the container, and the bot commit now
 * sitting on the real branch's real local HEAD with a clean tree, both
 * survived. The lead's own next ordinary `git push` on that branch would
 * ship that commit straight onto the real branch. "The container is doomed
 * regardless" was never actually guaranteed the moment a failed rescue could
 * block its own teardown. `rescuePushCmd`'s own dirty-tree branch now uses
 * the exact same non-mutating technique described below that
 * `rescueSnapshotCmd` always has — there is no longer any call site in this
 * file, in either command, that mutates the real checkout's index or HEAD.
 *
 * This command produces the identical `RESCUE_NO_CHECKOUT`/`RESCUE_CLEAN`/
 * `RESCUE_MARKERS_ONLY`/`RESCUE_PUSHED`/`RESCUE_FAILED` output shape as
 * `rescuePushCmd` (do.ts's `rescuePush` parser is reused unchanged), and now
 * shares every part of the walk, including the dirty-tree branch (see the
 * BLOCKER fix note above): `rescue_target`/`snapshot_target` (identical
 * shape, including the #266 `wt/` fix above, modulo the calling convention —
 * `rescue_target` sets `target` as a side effect via plain-statement-call;
 * `snapshot_target` `printf`s it for a `$(...)` capture), the "clean, but has
 * unpushed commits" branch (N1/N2/the per-worktree ahead-check all just push
 * an EXISTING commit by ref — no local state to protect there in the first
 * place), the worktree walk, the branch walk, the stash walk. How a DIRTY
 * tree gets turned into something pushable, in BOTH commands now:
 *
 *   `GIT_INDEX_FILE=<tmp>` scopes `git add -A` to a throwaway index file,
 *     NEVER the real `.git/index` (or, for a member worktree, its own
 *     per-worktree index under `.git/worktrees/<id>/index` — `git rev-parse
 *     --absolute-git-dir` (an ABSOLUTE path, correctly per-worktree;
 *     `--git-path` was tried first and rejected — it returns a path relative
 *     to `$w`, not to this script's OWN cwd, and silently resolved against
 *     the wrong directory the moment anything other than `$w` itself happened
 *     to be the shell's cwd) resolves whichever is correct) -> the throwaway
 *     index is first SEEDED with a byte-for-byte copy of the real one (`cp`,
 *     a read of the real file, never a write to it) so `add -A`'s own "also
 *     stage removals already in the index" behaviour sees the SAME starting
 *     point the real index would have given it — skipping the seed would
 *     silently drop any deleted-file staging from the snapshot, a correctness
 *     gap the issue's own outline didn't call out but real `git add -A`
 *     semantics require closing. `git write-tree` against that scoped index
 *     produces a tree object; `git commit-tree <tree> -p HEAD -m ...`
 *     produces a commit object whose parent is the CURRENT real HEAD, but
 *     which no ref anywhere points at — HEAD/the checked-out branch never
 *     move. That floating commit's SHA is pushed directly (`git push origin
 *     <sha>:refs/heads/<target>`, never `HEAD:...`). The temp index file is
 *     removed immediately after (success or failure) on every path — nothing
 *     is left behind across repeated runs against a studio that stays up for
 *     a long time (`rescue-all`'s own repeated live case this issue exists
 *     for, and an ordinary teardown retried after a transient failure,
 *     exactly the BLOCKER fix's own scenario above).
 *
 * The one remaining, deliberate difference between the two commands is the
 * commit message's own subject line (`"fleet: rescue-push before teardown"`
 * vs. `"fleet: rescue snapshot (live, real HEAD/index untouched)"` — each
 * names its own real calling context) — both now also carry an identical
 * `Rescued-From: <branch>` trailer (see the dirty-tree branch's own comment
 * below) naming the real branch the snapshot came from.
 *
 * Net effect, proved by test/bun/rescue-push.test.ts's own real-git
 * "snapshot never mutates live state" suite (and, after the BLOCKER fix
 * above, `rescuePushCmd`'s own equivalent coverage too): `git status
 * --porcelain` and `git rev-parse HEAD`, read from the real working
 * tree/index/HEAD, are byte-identical before and after either command runs
 * against a genuinely dirty tree. Re-running either command against an
 * UNCHANGED dirty tree therefore always finds the SAME dirty diff again
 * (nothing local ever advances to make it look "already saved") and pushes a
 * FRESH snapshot ref each time — a deliberate tradeoff: some duplicate
 * snapshot/rescue refs on origin across repeated runs against a studio (or a
 * teardown retried after a transient push failure) that stays dirty, in
 * exchange for the real guarantee this design exists for (the live checkout's
 * own state is never touched, regardless of whether the push that follows
 * succeeds). The "clean, but has unpushed commits" branch keeps its own
 * `update-ref refs/remotes/origin/<target> HEAD` exactly as before — those
 * commits are real, persistent, local state that legitimately shouldn't be
 * re-pushed every run.
 *
 * `root`/`pushTimeoutSeconds`/`serverDeadlineSeconds`/`budgetMarginSeconds`
 * are test seams, same convention as `rescuePushCmd`'s own — see
 * RESCUE_SERVER_DEADLINE_SECONDS's and RESCUE_BUDGET_MARGIN_SECONDS's own
 * doc comments for why the budget guard below exists (issue #371).
 */
export function rescueSnapshotCmd(
  repo: string, studio: string, root = "/workspace", pushTimeoutSeconds = RESCUE_PUSH_TIMEOUT_SECONDS,
  serverDeadlineSeconds = RESCUE_SERVER_DEADLINE_SECONDS, budgetMarginSeconds = RESCUE_BUDGET_MARGIN_SECONDS,
  // Issue #335: see rescuePushCmd's own identical trailing params above.
  botName = "fleetflare[bot]", botEmail = "fleetflare[bot]@users.noreply.github.com",
  // Issue #1 piece 5: private rescue remote + real git (RescuePushOptions).
  opts: RescuePushOptions = {},
): string {
  const dir = `${root}/${repo}`;
  const scope = `-- . ${RESCUE_MARKER_PATHSPECS}`;
  const identity = `-c user.name="${botName}" -c user.email="${botEmail}"`;
  return (
    // Issue #371: identical to rescuePushCmd's own copy above — see that
    // function's own comments (and RESCUE_SERVER_DEADLINE_SECONDS's doc
    // comment) for the full reasoning. #371 review Finding 1: the `mult`
    // parameter (default 1) is identical to rescuePushCmd's own copy too —
    // see that copy's own doc comment for why the dirty-tree/clean-but-ahead
    // call sites below pass `2`.
    `__rescue_start=$(date +%s)\n` +
    rescuePushPrelude(opts) +
    `rescue_budget_ok() {\n` +
    `  local id="$1" mult="\${2:-1}" now remaining\n` +
    `  now=$(date +%s)\n` +
    `  remaining=$(( ${serverDeadlineSeconds} - (now - __rescue_start) ))\n` +
    `  if [ "$remaining" -lt $(( mult * (${pushTimeoutSeconds} + ${KILL_GRACE_SECONDS}) + ${budgetMarginSeconds} )) ]; then\n` +
    `    echo "${RESCUE_FAILED_PREFIX} $id budget $remaining not attempted"\n` +
    `    return 1\n` +
    `  fi\n` +
    `}\n` +
    `if [ ! -d ${dir}/.git ]; then echo "${RESCUE_NO_CHECKOUT}"; else\n` +
    `any=0; markers=0; fail=0\n` +
    // HOLD-round fix (real-git review on PR #312, HIGH): rescuePushCmd's
    // rescue_target() returns the checked-out branch's OWN name the moment
    // that branch is not the repo's resolved default (the ordinary case once
    // a studio's own agent branches) -- correct for rescuePushCmd, which runs
    // when the studio is going away, but WRONG for this LIVE snapshot: the
    // studio still owns that branch. Round 2 measured it for the DIRTY-tree
    // branch below (a synthetic snapshot commit the studio never made);
    // round 3 for the clean-but-ahead branch (the studio's own unpushed
    // commits, pushed onto origin/<branch> and the local tracking ref moved
    // with them). Both branches now use snapshot_target(); this function has
    // no rescue_target() of its own. Measured live: a studio on `task/feature` (not
    // the default branch) ran a snapshot rescue against a dirty tree; the old
    // shared rescue_target() call printed `RESCUE_PUSHED task/feature ...`,
    // and origin/task/feature moved from the studio's own tip to the
    // synthetic snapshot SHA -- the studio's own NEXT real push from that
    // branch was then rejected non-fast-forward, because the remote moved
    // out from under it as a side effect of a rescue that was supposed to be
    // non-mutating. snapshot_target() shares rescuePushCmd's rescue_target()
    // member-worktree shape (never ambiguous, no live branch involved there either
    // way) but, in checkout mode, ALWAYS returns a freshly generated
    // `fleet/rescue/...` ref -- unconditionally -- so nothing a live
    // snapshot pushes can ever land on a ref the studio still owns.
    `snapshot_target() {\n` +
    `  local mode="$1" id="$2"\n` +
    `  if [ "$mode" = "checkout" ]; then\n` +
    `    printf '%s' "fleet/rescue/${studio}-$(date -u +%Y%m%d%H%M%S)"\n` +
    `  else\n` +
    `    printf '%s' "fleet/rescue/${studio}/wt/$id-$(date -u +%Y%m%d%H%M%S)"\n` +
    `  fi\n` +
    `}\n` +
    // Same non-fast-forward retry-to-a-fresh-ref shape as rescuePushCmd's own
    // rescue_push (N3), generalized to push an explicit `ref` (a plain
    // `HEAD` for the non-mutating branches below, or a bare commit SHA for
    // the snapshot branch) instead of always `HEAD` — never a `+`/`--force`
    // retry, same reasoning as rescuePushCmd's own N3 comment.
    rescueTryPushFn(identity, pushTimeoutSeconds) + rescueWtFn() + rescueOnOriginFn(pushTimeoutSeconds) +
    `rescue_push() {\n` +
    // Issue #216 fix 4: `rbranch`, 5th and optional, defaults to `$ref` when
    // the caller omits it — forwarded to rescue_try_push's own new 5th
    // param on both call sites below, same as rescuePushCmd's own copy.
    `  local w="$1" id="$2" target="$3" ref="$4" rbranch="\${5:-$4}" perr prc ftarget\n` +
    // Issue #359: unlike rescuePushCmd's own rescue_push (above), `$target`
    // here is ALWAYS built by snapshot_target() — a freshly generated
    // fleet/rescue/... ref in EVERY mode, never the checked-out branch's own
    // name (see snapshot_target()'s own HOLD-round doc comment: a live
    // studio's real branch must never be a push target for a synthetic
    // snapshot commit) — so both pushes below always qualify for
    // --no-verify unconditionally, no case check needed the way rescuePushCmd's
    // copy needs one.
    // Issue #359 round 3: `timeout -k <grace> <secs>` bounds a single push
    // that stalls to its own small budget — see this file's own header
    // comment above.
    // Issue #16: same shallow-clone snapshot fallback as rescuePushCmd's copy.
    `  rescue_try_push "$w" --no-verify "$ref" "$target" "$rbranch"; prc=$?\n` +
    `  if [ "$prc" = "0" ]; then printf '%s' "$target"; return 0; fi\n` +
    `  if printf '%s' "$perr" | grep -qiE 'non-fast-forward|fetch first'; then\n` +
    // HOLD-round fix: same wt/-nested, discoverable shape as rescuePushCmd's
    // own rescue_push (N3) above — see that copy's own comment.
    `    ftarget="fleet/rescue/${studio}/wt/$id-nff-$(date -u +%Y%m%d%H%M%S)"\n` +
    // Issue #359 round 3: same per-push timeout bound as the first attempt.
    `    if rescue_try_push "$w" --no-verify "$ref" "$ftarget" "$rbranch"; then printf '%s' "$ftarget"; return 0; fi\n` +
    `  fi\n` +
    // Issue #49: the reason reaches the caller (and the destroy/recycle
    // 409) instead of dying in this function's own \`perr\`.
    `  printf '%s\\n' "$perr" | tail -n 5 >&2\n` +
    `  return 1\n` +
    `}\n` +
    // Issue #216 fix 3 (PR #212's own round-2 review): shared by rescue_one's
    // two "nothing new to commit, is HEAD itself ahead of origin?" call
    // sites below -- the genuinely-clean-tree branch, and (new) the
    // dirty-tree branch's own tree-identity shortcut, once its `add -A`
    // happens to reproduce HEAD's own tree byte-for-byte. Extracted so both
    // never drift into two copies of the same ahead-of-origin/markers
    // bookkeeping. `wall`, 4th and optional, defaults to empty: the
    // tree-identity shortcut omits it deliberately (see its own call site's
    // comment below) since a dirty-but-tree-equal file is not evidence of a
    // genuine tool-marker-only state.
    `rescue_check_ahead() {\n` +
    `  local w="$1" id="$2" mode="$3" wall="\${4:-}" whead wahead target rbranch rc\n` +
    // Issue #313 (PR #263 round 5 review, Finding 3): same ambiguous-bare-
    // HEAD guard as this file's own rescue_one dirty-tree branch -- resolve
    // to a SHA first, never pass a bare `HEAD` straight to `rev-list`.
    `  whead=$(git -C "$w" rev-parse HEAD 2>/dev/null); rc=$?\n` +
    `  if [ "$rc" != "0" ] || [ -z "$whead" ]; then echo "${RESCUE_FAILED_PREFIX} $id rev-parse"; fail=$((fail+1)); return; fi\n` +
    `  wahead=$(git -C "$w" rev-list --count "$whead" --not --remotes 2>/dev/null); rc=$?\n` +
    `  if [ "$rc" != "0" ]; then echo "${RESCUE_FAILED_PREFIX} $id rev-list"; fail=$((fail+1)); return; fi\n` +
    // Issue #49: already an origin tip = already saved, nothing to push.
    `  if [ -n "$wahead" ] && [ "$wahead" != "0" ] && ! rescue_on_origin "$w" "$whead" "$(git -C "$w" symbolic-ref -q --short HEAD 2>/dev/null)"; then\n` +
    // PR #312 round 3 (MED): snapshot_target() here too, never the
    // checked-out branch's own name.
    `    target=$(snapshot_target "$mode" "$id")\n` +
    // Issue #371 review Finding 1: `mult=2`, same retry-pair worst case as
    // every other rescue_push() call site in this file.
    `    if ! rescue_budget_ok "$id" 2; then fail=$((fail+1)); return; fi\n` +
    // Issue #216 fix 4: same `Rescued-From: <branch>` capture as rescue_one's
    // own dirty-tree branch, threaded through as rescue_push's 5th arg.
    `    rbranch=$(git -C "$w" rev-parse --abbrev-ref HEAD 2>/dev/null); rbranch="\${rbranch:-HEAD}"\n` +
    `    if ! target=$(rescue_push "$w" "$id" "$target" "HEAD" "$rbranch"); then echo "${RESCUE_FAILED_PREFIX} $id push"; fail=$((fail+1)); return; fi\n` +
    `    git -C "$w" update-ref "refs/remotes/origin/$target" HEAD 2>/dev/null || true\n` +
    `    echo "${RESCUE_PUSHED_PREFIX} $target $wahead ${RESCUE_PUSHED_KIND_COMMITS}"; any=1\n` +
    `  elif [ -n "$wall" ]; then\n` +
    `    markers=1\n` +
    `  fi\n` +
    `}\n` +
    // The one part that differs from rescuePushCmd's own rescue_one: a dirty
    // tree is snapshotted via a detached, out-of-band index instead of
    // `add -A` + `commit` against the real one — see this function's own
    // doc comment above for the full reasoning.
    `rescue_one() {\n` +
    `  local w="$1" id="$2" mode="$3" wall wstatus wn wahead whead target rc idxfile realidx tree sha rbranch\n` +
    `  wall="$(git -C "$w" status --porcelain 2>&1)"; rc=$?\n` +
    `  if [ "$rc" != "0" ]; then echo "${RESCUE_FAILED_PREFIX} $id status"; fail=$((fail+1)); return; fi\n` +
    `  wstatus="$(git -C "$w" status --porcelain --untracked-files=all ${scope} 2>&1)"; rc=$?\n` +
    `  if [ "$rc" != "0" ]; then echo "${RESCUE_FAILED_PREFIX} $id status"; fail=$((fail+1)); return; fi\n` +
    `  if [ -n "$wstatus" ]; then\n` +
    `    wn=$(printf '%s\\n' "$wstatus" | wc -l | tr -d ' ')\n` +
    // HOLD-round fix: snapshot_target(), never rescue_target() -- this
    // branch's commit is a synthetic snapshot the studio never made, and must
    // never be able to land on the checked-out branch's own ref. See
    // snapshot_target()'s own doc comment above.
    `    target=$(snapshot_target "$mode" "$id")\n` +
    `    idxfile=$(mktemp 2>/dev/null) || { echo "${RESCUE_FAILED_PREFIX} $id add"; fail=$((fail+1)); return; }\n` +
    // Seed the throwaway index from the REAL one (a read of the real file,
    // never a write to it) so `add -A` sees the same starting point the real
    // index would have given it -- without this, `add -A` against a blank
    // starting index can never see a file that's tracked in HEAD but deleted
    // in the working tree, and silently drops that deletion from the
    // snapshot.
    // `--git-path` (not used here) returns a path relative to `$w`, not to
    // this script's own cwd -- verified live: `git -C "$w" rev-parse
    // --git-path index`, run from any cwd other than `$w` itself, produces a
    // bare `.git/index` that resolves against the WRONG directory the moment
    // `cp` (below) reads it, and the copy silently no-ops (fails, `|| true`
    // swallows it), leaving the throwaway index BLANK -- reproducing the
    // exact "deletions silently dropped" gap this whole seed step exists to
    // close, plus (for a member worktree specifically) copying nothing at
    // all since it never even resolves to that worktree's own per-worktree
    // index under `.git/worktrees/<id>/index`. `--absolute-git-dir` returns
    // an ABSOLUTE path -- and, for a member worktree, correctly resolves to
    // ITS OWN admin dir, not the main checkout's -- so `/index` appended to
    // it is always the right file regardless of this script's own cwd.
    `    realidx=$(git -C "$w" rev-parse --absolute-git-dir 2>/dev/null)/index\n` +
    // Issue #216 fix 5 (NIT): same `rm -f` as rescuePushCmd's own identical
    // seed step above -- `mktemp`'s 0-byte file is not a valid empty-index
    // format, and must not reach `GIT_INDEX_FILE` below when there is no
    // real index to seed from.
    `    if [ -f "$realidx" ]; then cp "$realidx" "$idxfile" 2>/dev/null || true; else rm -f "$idxfile"; fi\n` +
    `    if ! GIT_INDEX_FILE="$idxfile" git -C "$w" add -A ${scope}; then rm -f "$idxfile"; echo "${RESCUE_FAILED_PREFIX} $id add"; fail=$((fail+1)); return; fi\n` +
    `    tree=$(GIT_INDEX_FILE="$idxfile" git -C "$w" write-tree 2>/dev/null); rc=$?\n` +
    `    rm -f "$idxfile"\n` +
    `    if [ "$rc" != "0" ] || [ -z "$tree" ]; then echo "${RESCUE_FAILED_PREFIX} $id add"; fail=$((fail+1)); return; fi\n` +
    // Issue #216 fix 3 (PR #212's own round-2 review): a dirty tree whose
    // final content is byte-identical to HEAD's own tree is not a real
    // change -- stage something, then revert the working tree's own bytes
    // back to HEAD's (without re-staging), and `status --porcelain` stays
    // dirty (the INDEX still differs from HEAD) even though `add -A` above
    // -- which captures the CURRENT working tree, not the stale index --
    // just handed back HEAD's own tree right back. Committing and pushing
    // that would be a hollow "rescue" reporting success for a push with
    // nothing new in it. Falls through to the exact same ahead-of-origin/
    // markers bookkeeping the clean-tree branch below already does, via the
    // shared rescue_check_ahead() above -- `wall` deliberately omitted (see
    // that function's own doc comment): this file was real, not a tool
    // marker, so it must never be read as "markers-only" on its own.
    //
    // Board issue #216 review (minor, accepted tradeoff): `wall` was captured
    // ONCE, at this function's own top, before this branch knew the dirty
    // tree would turn out to revert to HEAD -- it can ALSO hold an unrelated,
    // genuinely marker-only file dirty in the SAME worktree at the same time.
    // Omitting it wholesale (rather than passing it through) loses that
    // signal too: such a worktree now reports RESCUE_CLEAN here instead of
    // RESCUE_MARKERS_ONLY. No work is lost either way (nothing is pushed in
    // either outcome) -- only the reported status is less precise than
    // before this fix existed. Filtering `wall` down to exclude just the
    // reverted path(s) instead of dropping it wholesale was considered and
    // rejected: `wall` (unscoped `status --porcelain`, captured before
    // `${scope}` was known) and `wstatus`/`$tree` (both scoped, captured
    // after) do not share a format simple enough to diff line-for-line
    // without risking reintroducing the exact bug this fix closed. Do not
    // "fix" this back to passing `wall` through unfiltered.
    `    if [ "$tree" = "$(git -C "$w" rev-parse "HEAD^{tree}" 2>/dev/null)" ]; then rescue_check_ahead "$w" "$id" "$mode"; return; fi\n` +
    // MAJOR fix (survival brief review): same `Rescued-From: <branch>`
    // trailer rescuePushCmd's own rescue_one() now adds to its real commit —
    // see that function's own comment for why `rev-parse --abbrev-ref HEAD`
    // is the right capture (and already returns the literal `HEAD` when
    // detached, matching this file's own established fallback precedent).
    `    rbranch=$(git -C "$w" rev-parse --abbrev-ref HEAD 2>/dev/null); rbranch="\${rbranch:-HEAD}"\n` +
    `    sha=$(git -C "$w" ${identity} commit-tree "$tree" -p HEAD -m "fleet: rescue snapshot (live, real HEAD/index untouched)" -m "Rescued-From: $rbranch" 2>/dev/null); rc=$?\n` +
    `    if [ "$rc" != "0" ] || [ -z "$sha" ]; then echo "${RESCUE_FAILED_PREFIX} $id commit"; fail=$((fail+1)); return; fi\n` +
    // Issue #371: same single check ahead of the attempt+nff-retry pair as
    // rescuePushCmd's own identical guard — never inside rescue_push() itself
    // (its stdout is captured by this call's own `$(...)`).
    // #371 review Finding 1: `mult=2` — rescue_push() below (this function's
    // own copy) can still run its own first-attempt-plus-retry pair on a
    // collision (snapshot_target()'s generated ref is astronomically unlikely
    // to collide, but the retry code path genuinely exists here too), so this
    // is budgeted defensively for the same worst case as rescuePushCmd's own
    // identical call site, not the single-push figure.
    `    if ! rescue_budget_ok "$id" 2; then fail=$((fail+1)); return; fi\n` +
    // Issue #216 fix 4: `$rbranch`, already captured above for this commit's
    // own trailer, threaded through as rescue_push's 5th arg too.
    `    if ! target=$(rescue_push "$w" "$id" "$target" "$sha" "$rbranch"); then echo "${RESCUE_FAILED_PREFIX} $id push"; fail=$((fail+1)); return; fi\n` +
    `    git -C "$w" update-ref "refs/remotes/origin/$target" "$sha" 2>/dev/null || true\n` +
    `    echo "${RESCUE_PUSHED_PREFIX} $target $wn ${RESCUE_PUSHED_KIND_FILES}"; any=1\n` +
    `  else\n` +
    // Unchanged from rescuePushCmd: pushing an EXISTING commit by ref
    // (`HEAD`) never touches local state, so there is nothing to protect
    // here beyond what rescuePushCmd already does.
    // Issue #216 fix 3: delegates to rescue_check_ahead() (above), shared
    // with the dirty-tree branch's own now-equivalent-to-clean shortcut —
    // see that function's own doc comment for the full reasoning (#313
    // Finding 3's ambiguous-bare-HEAD guard included, unchanged).
    `    rescue_check_ahead "$w" "$id" "$mode" "$wall"\n` +
    `  fi\n` +
    `}\n` +
    // N4 stdin-isolation posture, unchanged from rescuePushCmd.
    `rescue_wt "${dir}" "checkout" "checkout" </dev/null\n` +
    `wtporcelain="$(git -C ${dir} worktree list --porcelain)"\n` +
    `wtlist="$(printf '%s\\n' "$wtporcelain" | sed -n 's/^worktree //p')"\n` +
    // checked_out builder, unchanged from rescuePushCmd (round 4 Finding 1 +
    // round 5's bash-3.2-safe rewrite both apply here identically).
    `checked_out="$(\n` +
    `  cur=""\n` +
    `  while IFS= read -r pline; do\n` +
    `    if [ "\${pline#worktree }" != "$pline" ]; then\n` +
    `      cur="\${pline#worktree }"\n` +
    `    elif [ "\${pline#branch refs/heads/}" != "$pline" ]; then\n` +
    `      if [ -d "$cur" ]; then printf '%s\\n' "\${pline#branch refs/heads/}"; fi\n` +
    `    fi\n` +
    `  done <<< "$wtporcelain"\n` +
    `)"\n` +
    `if [ -n "$wtlist" ]; then\n` +
    `  while IFS= read -r w; do\n` +
    `    [ "$w" = "${dir}" ] && continue\n` +
    `    [ -d "$w" ] || continue\n` +
    `    wid=$(basename "$(git -C "$w" rev-parse --git-dir)")\n` +
    `    rescue_wt "$w" "$wid" "member" </dev/null\n` +
    `  done <<< "$wtlist"\n` +
    `fi\n` +
    // N1 branch walk: unchanged from rescuePushCmd -- pushes an EXISTING
    // commit by ref, never mutates local state.
    `runts=$(date -u +%Y%m%d%H%M%S)\n` +
    // Issue #313 (PR #263 round 5 review, Finding 2): `:short` only strips
    // the leading `refs/heads/` when the RESULT is unambiguous across every
    // ref namespace -- a tag sharing a branch's exact name (`refs/tags/docs`
    // alongside `refs/heads/docs`) forces it to leave `heads/docs` in place,
    // which then fails every `refs/heads/$b` lookup below (no such ref) with
    // a spurious RESCUE_FAILED. `:lstrip=2` strips exactly two path
    // components unconditionally -- safe here since this query is already
    // scoped to `refs/heads` alone, nothing to disambiguate against within
    // it. Verified live: `:short` prints `heads/docs` once a tag `docs`
    // exists; `:lstrip=2` prints `docs` regardless.
    `allbranches="$(git -C ${dir} for-each-ref --format='%(refname:lstrip=2)' refs/heads </dev/null)"\n` +
    `if [ -n "$allbranches" ]; then\n` +
    `  while IFS= read -r b; do\n` +
    `    [ -z "$b" ] && continue\n` +
    // Issue #313 (PR #263 round 5 review, Finding 1): `-e` forces the next
    // argument to be treated as a PATTERN, never an option -- without it, a
    // branch literally named `-x` (not createable via `git branch`/`checkout
    // -b`, which both refuse it, but real on-disk once written via the raw
    // ref plumbing) makes `grep -qxF "-x"` exit 2 with its own usage error
    // instead of performing the literal match, silently defeating this skip
    // for that one input. Verified live against real GNU grep.
    `    printf '%s\\n' "$checked_out" | grep -qxF -e "$b" && continue\n` +
    `    bahead=$(git -C ${dir} rev-list --count "refs/heads/$b" --not --remotes </dev/null 2>/dev/null); brc=$?\n` +
    `    if [ "$brc" != "0" ]; then echo "${RESCUE_FAILED_PREFIX} checkout:$b rev-list"; fail=$((fail+1)); continue; fi\n` +
    // Issue #49: same already-on-origin check as rescue_one's.
    `    if [ -n "$bahead" ] && [ "$bahead" != "0" ] && ! rescue_on_origin ${dir} "$(git -C ${dir} rev-parse -q --verify "refs/heads/$b" </dev/null 2>/dev/null)" "$b"; then\n` +
    `      btarget="fleet/rescue/${studio}/$runts/checkout/$b"\n` +
    // Issue #371: same single check ahead of this loop body's own single push
    // attempt as rescuePushCmd's own identical branch-walk guard above.
    `      if ! rescue_budget_ok "checkout:$b"; then fail=$((fail+1)); continue; fi\n` +
    // Issue #359: `$btarget` is ALWAYS a generated fleet/rescue/ ref (built
    // one line above; a local branch's own name never enters it), so this
    // push always qualifies for --no-verify unconditionally — never a real
    // branch push, unlike rescue_push()'s own conditional check above.
    // Issue #359 round 3: same per-push timeout bound as rescue_push()'s own
    // pushes above — see this file's own header comment.
    // Issue #216 fix 1: 5th arg `"$b"` is the real branch name, for the
    // shallow-clone fallback's `Rescued-From:` trailer should it fire here --
    // without it the trailer would default to `$btarget`, the generated
    // throwaway ref itself, naming nothing useful.
    `      if ! rescue_try_push ${dir} --no-verify "refs/heads/$b" "$btarget" "$b" </dev/null; then\n` +
    `        echo "${RESCUE_FAILED_PREFIX} checkout:$b push"; fail=$((fail+1))\n` +
    // Issue #58: the reason reaches the 409, same as rescue_push's.
    `        printf '%s\\n' "$perr" | tail -n 5 >&2\n` +
    `      else\n` +
    `        git -C ${dir} update-ref "refs/remotes/origin/$btarget" "refs/heads/$b" </dev/null 2>/dev/null || true\n` +
    `        echo "${RESCUE_PUSHED_PREFIX} $btarget $bahead ${RESCUE_PUSHED_KIND_COMMITS}"; any=1\n` +
    `      fi\n` +
    `    fi\n` +
    `  done <<< "$allbranches"\n` +
    `fi\n` +
    // N2 stash walk: unchanged from rescuePushCmd -- pushes an EXISTING
    // stash commit by SHA, never touches the stash itself, never mutates
    // local state.
    `stashlist="$(git -C ${dir} stash list --format='%gd' </dev/null 2>/dev/null)"\n` +
    `if [ -n "$stashlist" ]; then\n` +
    `  while IFS= read -r sref; do\n` +
    `    [ -z "$sref" ] && continue\n` +
    `    ssha=$(git -C ${dir} rev-parse "$sref" </dev/null 2>/dev/null) || continue\n` +
    `    sn=$(printf '%s' "$sref" | sed -n 's/^stash@{\\([0-9]*\\)}$/\\1/p')\n` +
    // Issue #313 (PR #263 round 5 review, Finding 3): same discipline as the
    // branch walk's own `brc` check above -- `$ssha` is already a resolved
    // SHA (never a bare `HEAD`), so this call is not exposed to the same
    // ambiguous-argument failure mode, but a genuine git failure here must
    // still never be misread as "nothing to push" the way `|| echo 0` did.
    `    sahead=$(git -C ${dir} rev-list --count "$ssha" --not --remotes </dev/null 2>/dev/null); src=$?\n` +
    `    if [ "$src" != "0" ]; then echo "${RESCUE_FAILED_PREFIX} checkout:stash-$sn rev-list"; fail=$((fail+1)); continue; fi\n` +
    `    if [ -n "$sahead" ] && [ "$sahead" != "0" ]; then\n` +
    `      sfiles=$(git -C ${dir} diff --name-only "$sref^1" "$sref" </dev/null 2>/dev/null | wc -l | tr -d ' ')\n` +
    `      if [ -z "$sfiles" ] || [ "$sfiles" = "0" ]; then sfiles=1; fi\n` +
    `      starget="fleet/rescue/${studio}/$runts/checkout/stash-$sn"\n` +
    // Issue #371: same single check ahead of this loop body's own single push
    // attempt as rescuePushCmd's own identical stash-walk guard.
    `      if ! rescue_budget_ok "checkout:stash-$sn"; then fail=$((fail+1)); continue; fi\n` +
    // Issue #359: `$starget` is ALWAYS a generated fleet/rescue/ ref (built
    // one line above), so this push always qualifies for --no-verify
    // unconditionally — never a real branch push.
    // Issue #359 round 3: same per-push timeout bound as every other push in
    // this file — see this file's own header comment.
    // Issue #216 fix 1: 5th arg `"stash-$sn"` is the real stash identifier
    // (same spelling as `$starget`'s own suffix and the RESCUE_FAILED line
    // above), for the shallow-clone fallback's `Rescued-From:` trailer should
    // it fire here -- without it the trailer would default to `$starget`,
    // the generated throwaway ref itself, naming nothing useful.
    `      if ! rescue_try_push ${dir} --no-verify "$ssha" "$starget" "stash-$sn" </dev/null; then\n` +
    `        echo "${RESCUE_FAILED_PREFIX} checkout:stash-$sn push"; fail=$((fail+1))\n` +
    // Issue #58: the reason reaches the 409, same as rescue_push's.
    `        printf '%s\\n' "$perr" | tail -n 5 >&2\n` +
    `      else\n` +
    `        git -C ${dir} update-ref "refs/remotes/origin/$starget" "$ssha" </dev/null 2>/dev/null || true\n` +
    `        echo "${RESCUE_PUSHED_PREFIX} $starget $sfiles ${RESCUE_PUSHED_KIND_FILES}"; any=1\n` +
    `      fi\n` +
    `    fi\n` +
    `  done <<< "$stashlist"\n` +
    `fi\n` +
    `if [ "$any" = "0" ] && [ "$fail" = "0" ]; then\n` +
    `  if [ "$markers" = "1" ]; then echo "${RESCUE_MARKERS_ONLY}"; else echo "${RESCUE_CLEAN}"; fi\n` +
    `fi\n` +
    `fi`
  );
}

/**
 * Fix round (#208 PR #215 review item 2): wip-sync's own push timeout —
 * deliberately its OWN constant, not a reuse of `RESCUE_PUSH_TIMEOUT_SECONDS`
 * (45s, tuned for the teardown-time multi-push worktree/branch/stash walk,
 * whose own `rescue_budget_ok` ledger already accounts for a first attempt
 * plus one non-fast-forward retry at up to 2x that). `wip_sync_push`'s own
 * fallback (below) can also run twice back-to-back on the shallow/parentless
 * rejection path, so the worst case here is `2 * (WIP_SYNC_PUSH_TIMEOUT_SECONDS
 * + KILL_GRACE_SECONDS)` — kept deliberately small (25s, not 45s) so that
 * worst case (60s) sits comfortably inside `EXEC_CLASSES.wipSync`'s own short
 * budget (sandbox-api.ts) with room to spare for the status/add/write-tree/
 * commit-tree steps around it, rather than needing a budget anywhere close to
 * `EXEC_CLASSES.sync`'s 120s.
 */
export const WIP_SYNC_PUSH_TIMEOUT_SECONDS = 25;

/**
 * Fix round (#208 PR #215 review item 6): the sentinel `wipSyncProbeCmd`
 * (below) prints when — and ONLY when — there is genuinely something to
 * sync (a dirty scoped status, or a clean tree with commits no
 * remote-tracking ref already has). do.ts's `wipSync` checks for this exact
 * string BEFORE calling `resolveRescueTarget` (which can mint a GitHub token
 * and make a real API call) or running `wipSyncCmd`'s own full push script —
 * a clean, nothing-to-sync tick (the common case, same "most studios die
 * clean" expectation `rescuePushCmd`'s own header names) now costs one cheap
 * local `git status`/`rev-list` probe and nothing else: no token mint, no
 * API call, no `FLEET_RESCUE_REMOTE is unset` log line firing every single
 * tick for a studio that never configured one.
 */
export const WIP_SYNC_NEEDED = "WIP_SYNC_NEEDED";

/**
 * Fix round (#208 PR #215 review item 6): the cheap, read-only probe half of
 * wip-sync, split out of `wipSyncCmd` (below) so do.ts's `wipSync` can run it
 * FIRST, alone, before deciding whether the expensive half (resolving a
 * rescue target, which can mint a token and call GitHub's API, then the
 * actual push) is worth running at all. Answers with exactly one of:
 * `RESCUE_NO_CHECKOUT` / `RESCUE_CLEAN` / `RESCUE_MARKERS_ONLY` (nothing to
 * do — identical meaning to `wipSyncCmd`'s own same-named outcomes) or
 * `WIP_SYNC_NEEDED` (something is dirty or unpushed — the caller should go on
 * to resolve a target and run `wipSyncCmd` for real) or a
 * `RESCUE_FAILED_PREFIX`-led line (the probe's own `git` calls failed — the
 * caller treats this as "unrecognised output", same fail-closed posture
 * `parseRescueExecResult` already has for everything else it cannot read).
 *
 * No `exit` anywhere, same HARD RULE every other command builder in this
 * file follows (this runs inside its own short-lived exec class's session,
 * but never relies on that — see `rescuePushCmd`'s own doc comment for why):
 * an if/else chain throughout, never an early `exit`. Reuses the EXACT same
 * detection logic `wip_sync_one` (inside `wipSyncCmd`) uses for its own
 * dirty/ahead split — kept as a second, small, read-only copy rather than a
 * shared helper threaded through both command strings, since the two now
 * diverge immediately after detection (the probe only ever echoes a
 * sentinel; `wipSyncCmd` goes on to snapshot, commit, and push) and a shared
 * fragment would have to be assembled identically into two independently
 * exported top-level shell scripts regardless.
 *
 * `studio`/`bootStamp` are deliberately NOT parameters here: the probe never
 * names a push target, so it needs neither.
 */
export function wipSyncProbeCmd(repo: string, root = "/workspace"): string {
  const dir = `${root}/${repo}`;
  const scope = `-- . ${RESCUE_MARKER_PATHSPECS}`;
  return (
    `if [ ! -d ${dir}/.git ]; then echo "${RESCUE_NO_CHECKOUT}"; else\n` +
    // Fix round item 7: see wipSyncCmd's own identical comment on
    // GIT_OPTIONAL_LOCKS=0 for `git status` — the same live-studio race
    // applies here, since this probe runs on the same live checkout.
    `  wall="$(GIT_OPTIONAL_LOCKS=0 git -C ${dir} status --porcelain 2>&1)"; rc=$?\n` +
    `  if [ "$rc" != "0" ]; then echo "${RESCUE_FAILED_PREFIX} wip-sync-probe status"; else\n` +
    `    wstatus="$(GIT_OPTIONAL_LOCKS=0 git -C ${dir} status --porcelain --untracked-files=all ${scope} 2>&1)"; rc=$?\n` +
    `    if [ "$rc" != "0" ]; then echo "${RESCUE_FAILED_PREFIX} wip-sync-probe status"\n` +
    `    elif [ -n "$wstatus" ]; then echo "${WIP_SYNC_NEEDED}"\n` +
    `    else\n` +
    `      whead=$(git -C ${dir} rev-parse HEAD 2>/dev/null); rc=$?\n` +
    `      if [ "$rc" != "0" ] || [ -z "$whead" ]; then echo "${RESCUE_FAILED_PREFIX} wip-sync-probe rev-parse"\n` +
    `      else\n` +
    `        wahead=$(git -C ${dir} rev-list --count "$whead" --not --remotes 2>/dev/null); rc=$?\n` +
    `        if [ "$rc" != "0" ]; then echo "${RESCUE_FAILED_PREFIX} wip-sync-probe rev-list"\n` +
    `        elif [ -n "$wahead" ] && [ "$wahead" != "0" ]; then echo "${WIP_SYNC_NEEDED}"\n` +
    `        elif [ -n "$wall" ]; then echo "${RESCUE_MARKERS_ONLY}"\n` +
    `        else echo "${RESCUE_CLEAN}"\n` +
    `        fi\n` +
    `      fi\n` +
    `    fi\n` +
    `  fi\n` +
    `fi`
  );
}

/**
 * Fix round (#208 PR #215 full review, item 1 — maestro DESIGN decision,
 * 2026-10-04): BLOCKER found in review — the ORIGINAL ref here was FIXED per
 * STUDIO ONLY (`fleet/rescue/<studio>/wip`, no boot stamp), shared by every
 * container that studio ever runs. That made it invisible to the one check
 * that most needed to see it: `rescue_on_origin` (`rescueOnOriginFn`, above)
 * lists every tip on origin and treats an exact-sha match as "already safely
 * rescued" — a wip
 * tip from container A reads as "saved" to container A's OWN teardown
 * rescue, which is correct, but the SAME shared ref then got force-pushed
 * OVER by container B's very first wip-sync tick, the instant B booted,
 * before B's own teardown rescue (or A's, if A's teardown raced B's bring-up)
 * ever got a chance to look at it. The work that was only ever on the wip
 * ref — never a real commit, never a real branch — was gone, on no branch
 * anywhere, with no rescue log entry describing a loss at all, since from
 * the writer's own point of view every individual push had "succeeded".
 *
 * Fixed by scoping the ref per CONTAINER BOOT, not just per studio:
 * `fleet/rescue/<studio>/wip/<bootStamp>`, `bootStamp` a 14-digit UTC
 * timestamp — the SAME fixed-width convention every other rescue ref in this
 * file already uses (`RESCUE_STAMP_DIGITS`, survival-delivery.ts) — captured
 * ONCE per container boot (provision.ts's `recordBringupObservation`, right
 * alongside the `incarnation` token it already captures at the identical
 * moment; stored as `Observed.wipBootStamp`) and threaded in here by the
 * CALLER (do.ts's `wipSync`) on every tick of that one container's life.
 * This function never generates `bootStamp` itself, so every tick within ONE
 * container's lifetime still force-pushes the SAME ref — the rolling-
 * snapshot property this function's own doc comment below still describes,
 * unchanged — while a DIFFERENT container (a fresh boot, a fresh
 * `bootStamp`) always gets its OWN, never-before-seen ref and can never
 * touch a prior container's own wip ref, overwrite it, or race its teardown
 * rescue for it. `isRescueBranchFor` (survival-delivery.ts) and
 * `discoverRescueRefsCmd` (provision.ts) both gained a matching 4th shape so
 * a wip ref is now discoverable/fetchable exactly like every other rescue
 * shape — unlike the old flat ref, which `isRescueBranchFor` deliberately
 * excluded (see that function's own history) precisely because it could
 * never be safely attributed as "this studio's rescued work" while it was
 * still being silently clobbered across container boots. `rescue_on_origin`
 * (below) separately EXCLUDES every wip ref from its own "already on origin"
 * listing regardless of this discoverability change —
 * two different, deliberately independent fixes for two different
 * questions: "can a lead find this work" (yes, now) vs. "does a wip tip ever
 * count as proof a teardown rescue can skip" (no, never). Exported so a
 * caller (do.ts, tests) names it without re-deriving the string.
 */
export function wipSyncRef(studio: string, bootStamp: string): string {
  return `fleet/rescue/${studio}/wip/${bootStamp}`;
}

/**
 * Board issue #208: a PERIODIC safety net for a studio whose container is
 * replaced by the PLATFORM itself (Cloudflare-side host move/eviction/
 * restart) rather than by any fleet operation. `rescuePushCmd`/
 * `rescueSnapshotCmd` above only ever run at teardown (destroy/park/
 * recycle, or this file's own pre-restart/pre-recycle sync) — the platform
 * gives no pre-replacement hook, so neither gets a chance to run before a
 * replacement lands, and whatever was dirty or committed-but-unpushed at
 * that moment is simply gone. `wipSyncCmd` is wired into the EXISTING
 * SYNC_SESSION_SECONDS (300s) tick (do.ts's `syncSessionCycle`) instead of a
 * new schedule, so it runs every few minutes for the lifetime of the studio
 * and bounds the loss window to roughly one tick interval, rather than
 * closing it to zero (only a real teardown rescue can do that).
 *
 * NON-MUTATING, same technique `rescueSnapshotCmd` already proved live (see
 * that function's own doc comment for the full "why a separate command"
 * reasoning): a dirty tree is snapshotted via a THROWAWAY `GIT_INDEX_FILE`
 * (seeded from a byte copy of the real index, so a deleted-but-uncommitted
 * file is captured too) and `commit-tree`, never `git add -A`/`git commit`
 * against the real index/HEAD. This studio is ALIVE and may be mid-edit the
 * moment this runs — unlike `rescuePushCmd`, which only ever runs when the
 * container is already doomed, so mutating its real index/HEAD one last time
 * is harmless.
 *
 * TARGET IS FIXED PER CONTAINER BOOT, NOT PER CALL: `wipSyncRef(studio,
 * bootStamp)` — see that function's own doc comment (and its fix-round
 * history, #208 PR #215 review item 1) for the full reasoning. Every OTHER
 * push target in this file (`rescue_target`/`snapshot_target`) always
 * generates a fresh, timestamped, never-before-seen ref per CALL,
 * specifically so a plain (non-force) push can never be rejected
 * non-fast-forward against it. This function instead reuses the SAME ref
 * every call WITHIN ONE CONTAINER'S LIFETIME (`bootStamp` fixed for that
 * whole lifetime), on purpose — a periodic tick that generated a fresh ref
 * every 5 minutes for a studio's entire multi-day lifetime would leave
 * thousands of stale refs on origin. One rolling snapshot per CONTAINER BOOT
 * is the whole point; a NEW boot gets a NEW ref, never overwriting the prior
 * boot's own.
 *
 * FORCE-PUSH, AND ONLY HERE — THE ONE DELIBERATE EXCEPTION IN THIS FILE.
 * Read literally: this file's own comments repeat "Never a `+`/`--force`
 * push anywhere in this file" more than once, for good reason — every other
 * push target here is either a REAL branch (a studio's own checked-out
 * branch, or a local branch/stash the walk discovers: force-pushing one of
 * those could silently discard a commit someone else pushed in the
 * meantime) or a FRESHLY GENERATED, never-before-seen ref (force is simply
 * pointless there — a brand-new ref has no existing tip to be rejected
 * against, so a plain push always lands clean). `wipSyncCmd`'s own target
 * (`wipSyncRef`) is neither of those: it is this ONE function's own
 * exclusive, dedicated scratch ref. Nothing else in this codebase ever
 * writes to it, reads it as a real branch, or treats it as anything other
 * than "the last periodic WIP snapshot" — so overwriting it every tick can
 * never discard anyone else's work, only this same function's own PRIOR
 * snapshot, which is exactly the point (a rolling safety net, not a growing
 * archive). That is what makes force safe HERE SPECIFICALLY, and nowhere
 * else in this file.
 *
 * `rescueTryPushFn`/`rescueOnOriginFn` (both used by `rescuePushCmd`/
 * `rescueSnapshotCmd` above) are deliberately NOT reused here: both are
 * built around the generate-and-maybe-retry shape (a push rejected
 * non-fast-forward retries ONCE, to a FRESH ref) and both explicitly forbid
 * `--force`/`+`. There is nothing to retry against here — force already
 * wins, unconditionally — so this function writes its own small, dedicated
 * push step (`wip_sync_push` below) instead of bending either of those to a
 * shape they were not built for.
 *
 * NO BUDGET LEDGER (`rescue_budget_ok`, the elaborate multi-push worst-case
 * tracking both command builders above carry): that machinery exists
 * because THOSE functions can run a first push attempt plus an independent
 * non-fast-forward retry, several times over, across a whole worktree/
 * branch/stash walk. This function runs exactly ONE push, to ONE target —
 * fix round (#208 PR #215 review item 2) added ONE bounded fallback retry on
 * top of that (see `wip_sync_push`'s own comment below), never a whole
 * worktree/branch/stash walk, and the worst case (two `pushTimeoutSeconds`-
 * bounded pushes back to back) comfortably fits this function's own short
 * exec-class budget (`EXEC_CLASSES.wipSync`, sandbox-api.ts) with no
 * cross-push accounting needed — there is still no multi-target walk for a
 * ledger to protect against.
 *
 * Fix round (#208 PR #215 review item 2): PUBLIC WORK REPO + PRIVATE RESCUE
 * REMOTE was a BLOCKER — `wip_sync_push` used to be a bare, un-retried `git
 * push --force`, with none of `rescue_try_push`'s own #16/#140 shallow/
 * parentless-snapshot fallback (see that function's own extensive doc
 * comment above for the full history). Force does not exempt a push from
 * that failure class: "shallow update not allowed" (and its #140 sibling,
 * "did not receive expected object") are PRE-TRANSFER rejections about
 * whether the REMOTE has ever seen the history behind a shallow clone's own
 * boundary commit — a question force vs. non-force never touches, since
 * force only changes how a NON-FAST-FORWARD TIP comparison is handled, and a
 * brand-new per-boot ref never had an existing tip to compare against in the
 * first place. A fresh `fleet/rescue/<studio>/wip/<bootStamp>` ref pushed
 * from this file's own `guardedCloneCmd`-shallow checkout against a private
 * rescue remote with no shared history hit this exact rejection, every
 * single tick, forever (`RESCUE_FAILED wip-sync push` on repeat) — the work
 * was never saved anywhere. `wip_sync_push` (below) now carries the
 * identical fallback `rescue_try_push` does: on that specific rejection
 * class, and ONLY that class, it builds a PARENTLESS snapshot of the exact
 * same tree (`commit-tree "$src^{tree}"`, no `-p`) and retries the SAME
 * force-push with that snapshot instead — content survives, only the
 * (already-shallow, already-truncated) history cut is lost, exactly like
 * `rescue_try_push`'s own documented contract.
 *
 * SCOPE: THE MAIN CHECKOUT ONLY, never a member subagent's own worktree. A
 * deliberate v1 limitation (see this feature's own plan doc,
 * docs/plans/2026-10-03-feat-208-wip-sync.md), not an oversight: this runs
 * on a 5-minute cadence as a bounding safety net, not a one-shot teardown
 * rescue, and the board issue's own Ask talks about "a running studio's
 * container" and "worktree dirty" in the singular.
 *
 * Covers the same two shapes `rescue_one`/`snapshot_target` above already
 * distinguish, reusing the identical detection: a dirty tree (scoped status
 * non-empty — snapshotted and pushed by its synthetic SHA) and a clean tree
 * that still holds commits no remote-tracking ref already has (`git
 * rev-list --count HEAD --not --remotes` — pushed by `HEAD` itself, an
 * EXISTING commit, no snapshot needed). Nothing to sync at all (clean AND
 * zero ahead) emits `RESCUE_CLEAN`; a tree whose only change is a tool
 * marker (#217) emits `RESCUE_MARKERS_ONLY` — neither attempts a push. Same
 * exported constants (`RESCUE_CLEAN`/`RESCUE_MARKERS_ONLY`/
 * `RESCUE_NO_CHECKOUT`/`RESCUE_PUSHED_PREFIX`/`RESCUE_FAILED_PREFIX`), same
 * `RESCUE_PUSHED <target> <count> <files|commits>` line shape
 * (`parseRescueExecResult`, do.ts, parses this generically already — no new
 * parser needed), so every downstream consumer composes unchanged.
 *
 * `root`/`pushTimeoutSeconds` are the same test seams `rescuePushCmd`'s own
 * doc comment explains (production always uses `WIP_SYNC_PUSH_TIMEOUT_SECONDS`
 * below, deliberately shorter than `RESCUE_PUSH_TIMEOUT_SECONDS` — see that
 * constant's own doc comment for why); `botName`/`botEmail`/`opts` are the
 * same trailing shape too (issue #335, issue #1 piece 5) — this composes with
 * `RescuePushOptions`/`rescuePushPrelude` exactly like the other two command
 * builders. `bootStamp` (new, #208 fix round item 1) has NO default — unlike
 * `root`, a missing boot stamp has no safe neutral value to fall back to
 * (silently reusing a fixed/guessed value here is the exact per-container
 * collision this fix round exists to close), so a caller must always resolve
 * one first; do.ts's `wipSync` skips the whole sync for a tick rather than
 * call this with one invented.
 */
export function wipSyncCmd(
  repo: string, studio: string, bootStamp: string, root = "/workspace",
  pushTimeoutSeconds = WIP_SYNC_PUSH_TIMEOUT_SECONDS,
  botName = "fleetflare[bot]", botEmail = "fleetflare[bot]@users.noreply.github.com",
  opts: RescuePushOptions = {},
): string {
  const dir = `${root}/${repo}`;
  const scope = `-- . ${RESCUE_MARKER_PATHSPECS}`;
  const identity = `-c user.name="${botName}" -c user.email="${botEmail}"`;
  const target = wipSyncRef(studio, bootStamp);
  return (
    rescuePushPrelude(opts) +
    // `$1`: the thing to push (a bare `HEAD`, or a synthetic snapshot SHA) —
    // `--force --no-verify`, unconditionally: see this function's own doc
    // comment above for why force is safe HERE, and nowhere else in this
    // file. `--no-verify` for the same reason every OTHER generated-ref push
    // in this file skips hooks: `$target` is never a real branch a repo's own
    // pre-push hook needs to see.
    //
    // Fix round (#208 PR #215 review item 2): a #16/#140 shallow/parentless
    // fallback, reusing `rescue_try_push`'s own recovery (see this function's
    // doc comment above) — composed with FORCE rather than `rescue_try_push`'s
    // own non-force shape, since force is this function's one deliberate
    // exception. On the SAME rejection text that function's own grep already
    // recognises, and ONLY that text, a second attempt force-pushes a
    // PARENTLESS snapshot of the same tree instead. Prints its own error text
    // on stdout (never `>&2`) so the caller's `$(wip_sync_push ...)` captures
    // it exactly like the single-command version this replaces did.
    `wip_sync_push() {\n` +
    `  local src="$1" snap perr prc\n` +
    `  perr="$(timeout -k ${KILL_GRACE_SECONDS} ${pushTimeoutSeconds} "\${__rgit[@]}" -C ${dir} push --force --no-verify "$__rdest" "$src:refs/heads/${target}" 2>&1 1>/dev/null)"; prc=$?\n` +
    `  [ "$prc" = 0 ] && return 0\n` +
    `  if [ -z "$perr" ]; then perr="push to ${target} failed (code $prc) with no output"; ` +
    `if [ "$prc" = 124 ] || [ "$prc" = 137 ]; then perr="push to ${target} killed after ${pushTimeoutSeconds}s (timeout)"; fi; fi\n` +
    `  printf '%s' "$perr" | grep -qiE 'shallow update not allowed|did not receive expected object' || { printf '%s' "$perr"; return 1; }\n` +
    `  snap=$(git -C ${dir} ${identity} commit-tree "$src^{tree}" -m "fleet: periodic WIP sync snapshot (shallow clone fallback)" 2>/dev/null) || { printf '%s' "$perr"; return 1; }\n` +
    `  perr="$(timeout -k ${KILL_GRACE_SECONDS} ${pushTimeoutSeconds} "\${__rgit[@]}" -C ${dir} push --force --no-verify "$__rdest" "$snap:refs/heads/${target}" 2>&1 1>/dev/null)"; prc=$?\n` +
    `  [ "$prc" = 0 ] && return 0\n` +
    `  if [ -z "$perr" ]; then perr="snapshot push to ${target} failed (code $prc) with no output"; ` +
    `if [ "$prc" = 124 ] || [ "$prc" = 137 ]; then perr="snapshot push to ${target} killed after ${pushTimeoutSeconds}s (timeout)"; fi; fi\n` +
    `  printf '%s' "$perr"; return 1\n` +
    `}\n` +
    `wip_sync_one() {\n` +
    `  local wall wstatus wn wahead whead idxfile realidx tree sha perr prc rc\n` +
    // Fix round item 7: GIT_OPTIONAL_LOCKS=0 on every read-only `git status`
    // here — this studio is LIVE and may have its own lead committing at the
    // same moment this tick runs, unlike every teardown-time command above
    // (the studio is already doomed by the time those run). A plain `git
    // status` can create/refresh `.git/index.lock` as a side effect of its
    // own untracked-cache maintenance, racing a concurrent `git commit` for
    // the SAME lock file; GIT_OPTIONAL_LOCKS=0 makes git skip every
    // lock-taking maintenance step it would otherwise attempt, which a
    // purely informational `status --porcelain` call never needed anyway.
    `  wall="$(GIT_OPTIONAL_LOCKS=0 git -C ${dir} status --porcelain 2>&1)"; rc=$?\n` +
    `  if [ "$rc" != "0" ]; then echo "${RESCUE_FAILED_PREFIX} wip-sync status"; return; fi\n` +
    `  wstatus="$(GIT_OPTIONAL_LOCKS=0 git -C ${dir} status --porcelain --untracked-files=all ${scope} 2>&1)"; rc=$?\n` +
    `  if [ "$rc" != "0" ]; then echo "${RESCUE_FAILED_PREFIX} wip-sync status"; return; fi\n` +
    `  if [ -n "$wstatus" ]; then\n` +
    `    wn=$(printf '%s\\n' "$wstatus" | wc -l | tr -d ' ')\n` +
    // Same throwaway-index technique as rescueSnapshotCmd's own rescue_one
    // (see that function's doc comment for why the real index is seeded
    // in, never written to) — never the real `.git/index`.
    `    idxfile=$(mktemp 2>/dev/null) || { echo "${RESCUE_FAILED_PREFIX} wip-sync add"; return; }\n` +
    `    realidx=$(git -C ${dir} rev-parse --absolute-git-dir 2>/dev/null)/index\n` +
    `    if [ -f "$realidx" ]; then cp "$realidx" "$idxfile" 2>/dev/null || true; fi\n` +
    `    if ! GIT_INDEX_FILE="$idxfile" git -C ${dir} add -A ${scope}; then rm -f "$idxfile"; echo "${RESCUE_FAILED_PREFIX} wip-sync add"; return; fi\n` +
    `    tree=$(GIT_INDEX_FILE="$idxfile" git -C ${dir} write-tree 2>/dev/null); rc=$?\n` +
    `    rm -f "$idxfile"\n` +
    `    if [ "$rc" != "0" ] || [ -z "$tree" ]; then echo "${RESCUE_FAILED_PREFIX} wip-sync add"; return; fi\n` +
    `    sha=$(git -C ${dir} ${identity} commit-tree "$tree" -p HEAD -m "fleet: periodic WIP sync (live, real HEAD/index untouched)" 2>/dev/null); rc=$?\n` +
    `    if [ "$rc" != "0" ] || [ -z "$sha" ]; then echo "${RESCUE_FAILED_PREFIX} wip-sync commit"; return; fi\n` +
    `    perr="$(wip_sync_push "$sha")"; prc=$?\n` +
    `    if [ "$prc" != "0" ]; then echo "${RESCUE_FAILED_PREFIX} wip-sync push"; printf '%s\\n' "$perr" | tail -n 5 >&2; return; fi\n` +
    `    echo "${RESCUE_PUSHED_PREFIX} ${target} $wn ${RESCUE_PUSHED_KIND_FILES}"\n` +
    `  else\n` +
    // Issue #313-style ambiguity guard, same as rescue_one's own copy above:
    // `HEAD` resolved to its own SHA first, never passed bare.
    `    whead=$(git -C ${dir} rev-parse HEAD 2>/dev/null); rc=$?\n` +
    `    if [ "$rc" != "0" ] || [ -z "$whead" ]; then echo "${RESCUE_FAILED_PREFIX} wip-sync rev-parse"; return; fi\n` +
    `    wahead=$(git -C ${dir} rev-list --count "$whead" --not --remotes 2>/dev/null); rc=$?\n` +
    `    if [ "$rc" != "0" ]; then echo "${RESCUE_FAILED_PREFIX} wip-sync rev-list"; return; fi\n` +
    `    if [ -n "$wahead" ] && [ "$wahead" != "0" ]; then\n` +
    `      perr="$(wip_sync_push HEAD)"; prc=$?\n` +
    `      if [ "$prc" != "0" ]; then echo "${RESCUE_FAILED_PREFIX} wip-sync push"; printf '%s\\n' "$perr" | tail -n 5 >&2; return; fi\n` +
    `      echo "${RESCUE_PUSHED_PREFIX} ${target} $wahead ${RESCUE_PUSHED_KIND_COMMITS}"\n` +
    `    elif [ -n "$wall" ]; then\n` +
    `      echo "${RESCUE_MARKERS_ONLY}"\n` +
    `    else\n` +
    `      echo "${RESCUE_CLEAN}"\n` +
    `    fi\n` +
    `  fi\n` +
    `}\n` +
    `if [ ! -d ${dir}/.git ]; then echo "${RESCUE_NO_CHECKOUT}"; else wip_sync_one; fi`
  );
}

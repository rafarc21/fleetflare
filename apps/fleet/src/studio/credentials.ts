/**
 * The two git-credential command builders the container is driven with.
 *
 * They live here, not in do.ts, for the same reason provision.ts and
 * terminal.ts do: do.ts imports `@cloudflare/sandbox`, so anything inside it
 * can only be imported by a test running under workerd — where there is no
 * child_process and therefore no way to ASK GIT which credential it picks.
 * Asking git is the whole point (board task #149: two fixes were written
 * against reasoned-about git behaviour and both were wrong), so these strings
 * have to be reachable from the bun:test lane. do.ts re-exports both, so every
 * existing importer is unchanged.
 */
// blueprint.ts's own UTF-8-safe base64 (chunked TextEncoder + btoa), reused
// rather than re-derived: issue #253's git wrapper carries an em dash in its
// refusal message, and a bare btoa() throws outright on any non-Latin1 byte.
// blueprint.ts imports nothing itself, so this stays loadable from the
// bun:test lane exactly as this file already was.
import { base64EncodeUtf8 } from "./blueprint";

/** #110 review: the env var every token-carrying fleet command reads its
 *  secret from. sbExec hands it over in the exec's env option, so the token
 *  is never in a command string, an argv, or a `Killed <command>` line. */
export const FLEET_TOKEN_ENV = "FLEET_TOKEN";

export function tokenEnv(token: string): Record<string, string> {
  return { [FLEET_TOKEN_ENV]: token };
}

/**
 * Builds the one shell command that (re)writes the container's git
 * credential: `/workspace/.git-credentials` is OVERWRITTEN (not appended —
 * a stale prior token must not linger in the file past a refresh) with the
 * single `https://x-access-token:<token>@github.com` line, then
 * `credential.helper` is (re-)configured globally — safe to repeat every
 * call, which is why the brief calls it idempotent. Chained into one
 * sbExec call, the same shape as provision.ts's guardedCloneCmd.
 *
 * Review round 1, C1: the helper is registered as `store --file=<path>`,
 * NOT bare `store`. `git config --global` always writes to
 * `$HOME/.gitconfig`, and bare `store`'s OWN default (with no `--file`) is
 * to read/write `$HOME/.git-credentials` — a different path from the one
 * this command just wrote to. The container's Dockerfile sets `WORKDIR
 * /workspace` (cwd) but never `ENV HOME`, and runs as root by default (no
 * `USER` directive), so `$HOME` is `/root`: without `--file`, git would
 * look for credentials at `/root/.git-credentials`, find nothing, and the
 * clone/fetch below would fail exactly as if this file had never been
 * written. `--file=` pins the helper to the exact path this command itself
 * writes, independent of whatever `$HOME` happens to resolve to. (This also
 * overwrites the container image's own baked-in
 * `credential.helper '!gh auth git-credential'`, from Dockerfile — correct
 * for a long-lived studio, which cannot rely on a `gh`-managed auth state
 * or an env var set only at container spawn, per the task's own "studios
 * differ: long-lived, need re-injection via exec" framing.)
 *
 * Review round 3, Important 3: the same command also authenticates `gh`.
 * The pilot's allowedTools grants `Bash(gh *)`, but nothing ever logged the
 * studio in — this Worker wrote only the git credential, studio-bringup.sh
 * deliberately exports no GH_TOKEN, and the image's baked
 * `credential.helper '!gh auth git-credential'` is overwritten two lines up.
 * Every `gh pr`/`gh api` inside the studio was therefore unauthenticated.
 * Done HERE, in the one shared mint+write command, so both call sites
 * (provision and the 50-minute refresh) inherit it and gh's token never
 * outlives the git one.
 *
 * Why the config files and not `gh auth login --with-token` (measured with
 * gh 2.95, the version container/Dockerfile.studio installs, against a
 * throwaway GH_CONFIG_DIR):
 *   - `gh auth login --with-token` VALIDATES over the network before storing
 *     ("error validating token: HTTP 401 ... (https://api.github.com/)",
 *     exit 1, nothing written). That turns an offline, local file write into
 *     a GitHub round trip on every refresh, and its validation resolves a
 *     USER for the token — which a GitHub App installation token
 *     (`ghs_...`, what the App provider returns) is not. Its success on
 *     an installation token cannot be confirmed from here, and a mechanism
 *     that might fail every 50 minutes on the real deploy is not one to ship
 *     unverified.
 *   - Writing `hosts.yml` alone is NOT enough and fails loudly: gh runs a
 *     "multi account" config migration whenever config.yml carries no
 *     `version`, and that migration itself resolves a username over the
 *     network — measured, it aborts EVERY gh command with "failed to migrate
 *     config: cowardly refusing to continue". Pinning `version: "1"` in
 *     config.yml is what skips it.
 *   - With both files written, `gh auth token` returns the token, exit 0, no
 *     network, no migration, and `gh auth status` reports the account as
 *     active — measured.
 * The account name is `x-access-token`, the same username the git credential
 * line above uses for the identical token, so the two views of the studio's
 * GitHub identity cannot drift.
 *
 * `$HOME` rather than a literal `/root`: gh resolves its config dir from
 * `$HOME/.config/gh` and the container process env is what both this exec and
 * every tmux pane inherit, so expanding it is strictly more honest than
 * hard-coding the value `$HOME` happens to have today (contrast the git half
 * above, where `--file=` pins an absolute path precisely BECAUSE git would
 * otherwise resolve a different one).
 *
 * #110 review: the command carries NO token. It reads `$FLEET_TOKEN`, which
 * the caller hands over in the exec's env (`tokenEnv`), and expands it only
 * in `printf` — a bash builtin, so the value never becomes any process's argv.
 * Embedded in the command text it sat in `bash -c`'s argv for the whole run
 * (`ps -eo args` showed it) and came back as `Killed <command>` on a kill.
 *
 * P6a: `token` is now whichever credential that studio's WORK repo owner uses
 * — an App installation token (`ghs_...`) or a fine-grained PAT
 * (`github_pat_...`), resolved by src/github/auth.ts. This function is
 * unchanged and deliberately so: BOTH are bearer credentials GitHub accepts as
 * the Basic-auth PASSWORD over HTTPS, and GitHub ignores the username half for
 * token auth, which is why `x-access-token` works for either (the same
 * username actions/checkout writes for GITHUB_TOKEN and for a user-supplied
 * PAT alike). Nothing about the container's side of this changes with the
 * provider, and nothing new reaches the container: still a credential helper
 * file, never a raw token in the process environment.
 */
export function credentialWriteCmd(): string {
  const hostsYml =
    `github.com:\\n` +
    `    users:\\n` +
    `        x-access-token:\\n` +
    `            oauth_token: %s\\n` +
    `    git_protocol: https\\n` +
    `    user: x-access-token\\n` +
    `    oauth_token: %s\\n`;
  return (
    `printf '%s\\n' "https://x-access-token:$${FLEET_TOKEN_ENV}@github.com" > /workspace/.git-credentials && ` +
    `git config --global credential.helper 'store --file=/workspace/.git-credentials' && ` +
    `mkdir -p "$HOME/.config/gh" && ` +
    `printf 'version: "1"\\n' > "$HOME/.config/gh/config.yml" && ` +
    `printf '${hostsYml}' "$${FLEET_TOKEN_ENV}" "$${FLEET_TOKEN_ENV}" > "$HOME/.config/gh/hosts.yml" && ` +
    `chmod 600 "$HOME/.config/gh/hosts.yml"`
  );
}

/**
 * Board task #149 — the blueprint clone's OWN credential
 * (container/studio-bringup.sh, `git clone
 * "https://github.com/${BLUEPRINT_REPO}.git" /opt/blueprint`). Everything
 * above (`credentialWriteCmd`/`RefreshDeps`/`refreshDeps()`/every
 * `refreshWithStorage` call site) is untouched by this function — a pure
 * addition, not a change to the mechanism that already writes the studio's
 * WORK-repo credential. That existing credential is registered as a bare,
 * unscoped `credential.helper` naming only the work repo's owner
 * (`mintRepoToken(env, workRepoSlug)`); for a `websites--*` studio the
 * blueprint repo happens to share that owner, which is the only reason that
 * one studio's blueprint clone has ever worked. Every other studio's work
 * repo has a different owner, so that same credential is wrong for the
 * blueprint clone, which then fails silently (studio-bringup.sh's own
 * `|| echo ... >&2`) and every declared skill resolves to nothing.
 *
 * A SECOND file, not a second line appended to `/workspace/.git-credentials`:
 * git-credential-store(1) documents no precedence among multiple stored
 * lines that both match a request URL, so which credential git would
 * actually pick is unspecified, not merely untested. A second file sidesteps
 * that question entirely — nothing is ever appended to the work-repo file.
 *
 * TWO things make the URL-scoped helper actually win, and the first shipped
 * attempt at this function had NEITHER. Both were measured inside a live
 * `sample--web-studio` container with `GIT_TRACE=1`, which names the
 * helper git really ran; neither is inferable from reading git's docs, and
 * reasoning about them instead of asking git is what made two earlier fixes
 * no-ops:
 *
 *   1. The key carries the `.git` SUFFIX. git builds its match URL from the
 *      request's protocol, host AND path and only drops the path afterwards
 *      (`credential_apply_config` clears `c->path` for `!use_http_path`
 *      AFTER the config pass), so the context for bring-up's clone is
 *      `https://github.com/<owner>/<repo>.git` — which a
 *      `credential.https://github.com/<owner>/<repo>.helper` key does not
 *      match. Measured: with the suffixless key, git ran
 *      `credential-store --file=/workspace/.git-credentials` — the work-repo
 *      helper — and the clone died on `remote: Write access to repository
 *      not granted` / HTTP 403.
 *
 *   2. The list is RESET before the helper is added. git does not prefer the
 *      more specific `credential.<url>.*` section over the bare
 *      `credential.*` one; it CONCATENATES the matching sections' helpers in
 *      config order and asks each in turn until one returns a complete
 *      credential. The bare helper `credentialWriteCmd` registers matches
 *      every github.com URL and always answers first, so a merely-appended
 *      blueprint helper is never consulted at all. Measured: with the
 *      correct `.git` key and no reset, GIT_TRACE still showed only
 *      `--file=/workspace/.git-credentials`. An empty helper value is git's
 *      documented way to clear the list (gitcredentials(7), "set
 *      credential.helper to an empty string to clear the list, then add your
 *      helper"), so the key is written as exactly two values: `''`, then the
 *      blueprint store. With both changes the same clone fetched
 *      acme-org/websites and `skills/` landed in the checkout.
 *
 * `--unset-all` before the two `--add`s keeps this repeat-safe the way the
 * work-repo half already is: provision runs it on every call, and without
 * the unset each run would append another `''`/store pair to the same key.
 * The suffixless key the first attempt wrote is unset too — left behind it
 * is inert, but it looks exactly like a fix that is working, which is the
 * artifact that cost this task two debugging rounds.
 *
 * Not `useHttpPath`: that is a per-helper setting which would have to be
 * turned on globally to matter here, silently widening path matching for
 * every OTHER github.com URL this container touches — including its own work
 * repo, which runs `git push`/`gh pr create` all session and must keep
 * matching exactly as it does today.
 *
 * No token ever appears in a clone URL — same discipline
 * `credentialWriteCmd` already follows for the work repo.
 */
export function blueprintCredentialWriteCmd(blueprintRepo: string): string {
  const base = `credential.https://github.com/${blueprintRepo}`;
  // The key must match the URL studio-bringup.sh clones, `.git` and all.
  const key = `${base}.git.helper`;
  // The suffixless key the first attempt at this fix wrote — inert, removed
  // so it cannot be mistaken for a live one.
  const stale = `${base}.helper`;
  const drop = (k: string) => `{ git config --global --unset-all '${k}' 2>/dev/null || true; }`;
  return (
    `printf '%s\\n' "https://x-access-token:$${FLEET_TOKEN_ENV}@github.com" > /workspace/.git-credentials-blueprint && ` +
    `${drop(stale)} && ${drop(key)} && ` +
    `git config --global --add '${key}' '' && ` +
    `git config --global --add '${key}' 'store --file=/workspace/.git-credentials-blueprint'`
  );
}

/**
 * Issue #253 — 2026-09-25 06:02Z: a `fleetflare--web-studio` member
 * committed straight onto a local `main` in a worktree whose branch carried
 * `origin/main` as its upstream (`branch.autoSetupMerge`, git's own default,
 * sets that up silently for any branch cut off a remote-tracking ref), so a
 * bare `git push` had a real, name-matching upstream to push INTO. 6 commits
 * landed on main with zero PR, zero review, zero CI. Reportedly hit by
 * "multiple other dispatches today", previously dodged only by luck and
 * explicit refspecs.
 *
 * NOT `push.default`: measured in review (Linux, git 2.43), the
 * `push.default=simple` git already defaults to REFUSES a bare push whose
 * upstream branch is named differently from the local one, exit 128. It was
 * the same-named local `main` tracking `origin/main` that made this push
 * legal, and nothing about push.default's own resolution stops that. Only a
 * guard that inspects the push's actual TARGET does.
 *
 * No branch-protection API is available (free private repo: the
 * protection/rulesets endpoints 403 here), and the studio's own
 * GITHUB_TOKEN genuinely can push main — so this has to be closed from
 * inside the studio.
 *
 * WHY A PATH WRAPPER AND NOT A HOOK (maestro review of PR #259, measured on
 * Linux docker, git 2.43, lefthook 2.1.10). The first cut of this fix
 * installed a global pre-push hook via `core.hooksPath`. Three findings
 * retired that design outright:
 *
 *   1. A global `core.hooksPath` DISABLES every repo's own `.git/hooks`.
 *      One client repo (demosite.life) has a lefthook `pre-push` that is its
 *      only CI; the fix would have turned that off fleet-wide.
 *   2. `lefthook install --force`, which that repo's own prepare step runs,
 *      writes ITS pre-push into whatever `core.hooksPath` points at and
 *      renames what was there to `pre-push.old`. The guard stopped running,
 *      and `HEAD:main` was allowed container-wide until the next restart
 *      reinstalled it — which then turned the client's CI gate off again.
 *   3. `--no-verify`, `-c core.hooksPath=...` and a repo-LOCAL
 *      `core.hooksPath` (husky, a checked-in `.githooks`) each bypass any
 *      hook, by design.
 *
 * A wrapper at `/usr/local/bin/git` has none of those failure modes: it is
 * not a hook, so `--no-verify` and every `core.hooksPath` override are
 * irrelevant to it and no hook manager can overwrite it; and because it
 * hands the real push to the real git untouched, the repo's own hooks run
 * exactly as they would with no wrapper at all.
 */
export const STUDIO_GIT_WRAPPER_PATH = "/usr/local/bin/git";

/**
 * The real git the wrapper delegates to, by ABSOLUTE path. Never a PATH
 * lookup: PATH resolution would find the wrapper itself and recurse until
 * the process table gives out. Standard Unix PATH ordering puts
 * `/usr/local/bin` ahead of `/usr/bin`, which is what makes a plain `git`
 * reach the wrapper first (confirmed read-only on the studio image's own
 * PATH; the install command below re-confirms it at provision time rather
 * than assuming it).
 */
export const STUDIO_REAL_GIT_PATH = "/usr/bin/git";

/** Where the wrapper is staged before it goes live — the SAME directory as
 *  its destination, so the `mv -f` that publishes it is same-filesystem and
 *  therefore atomic. A `git` that is half-written is a studio that cannot
 *  run git at all, so this must never be written in place. */
export const STUDIO_GIT_WRAPPER_TMP_PATH = `${STUDIO_GIT_WRAPPER_PATH}.fleet-install`;

/** The refusal message piece 2 of #253 specifies verbatim, printed to
 *  stderr by the wrapper and asserted on by both the pure-generator test
 *  (this string appears in the generated text) and the real-git functional
 *  test (this string appears in the refused push's stderr). Exported as one
 *  constant so neither test can drift from the other, or from the wrapper. */
export const STUDIO_PUSH_REFUSAL = "fleet: studios never push the default branch — open a PR";

/** What the wrapper prints when the remote's default branch cannot be
 *  resolved at all. It then exits 1: an unresolvable default branch must
 *  never be read as "nothing to protect" (#253's own explicit fail-closed
 *  requirement). */
export const STUDIO_PUSH_UNRESOLVED_DEFAULT =
  "fleet: cannot resolve the remote's default branch -- refusing this push (fail closed)";

/** What the wrapper prints when its own dry-run PROBE exits non-zero. The
 *  probe is the only thing that knows what a push would move, so a probe that
 *  failed leaves the guard blind — and a blind guard must refuse, never hand
 *  over (maestro round-2 review of #259: a failing probe was being treated as
 *  "nothing to push", and eight real pushes reached the default branch that
 *  way). Printed AFTER the probe's own output, so the operator sees git's real
 *  error and then one fleet line explaining the refusal. */
export const STUDIO_PUSH_PROBE_FAILED =
  "fleet: could not check what this push would move -- refusing it (fail closed)";

/** What the wrapper prints for EVERY `!` shell alias, unconditionally. Such an
 *  alias runs an arbitrary shell command, and git prepends its own exec-path
 *  (`/usr/lib/git-core`, which holds a SECOND real git binary) onto that
 *  command's PATH — so a `git` word inside it reaches the real git directly
 *  and never this wrapper (measured, studio image: different inode from
 *  /usr/bin/git). Text-matching the alias for `push` or `git` (rounds 2 and 3
 *  of #259) was an arms race against arbitrary shell obfuscation and lost it
 *  (issue #310, measured: a shell GLOB hid the word `git` and an octal
 *  `printf` escape inside a command substitution hid the word `push`, and the
 *  combination pushed the default branch for real). Refusing every `!` alias
 *  outright is the only answer that does not depend on guessing the next
 *  obfuscation; replacing /usr/lib/git-core/git is not an option either
 *  (measured: it breaks dashed git subcommands and `git clone file://`). */
export const STUDIO_PUSH_SHELL_ALIAS_REFUSAL =
  "fleet: a '!' shell alias that runs git cannot be guarded -- run the git command directly";

/** What the wrapper prints for `git send-pack` and `git http-push`: the two
 *  PLUMBING commands that push without going through the `push` porcelain the
 *  probe understands. Refused outright rather than guarded. `send-pack` offers
 *  `--dry-run` but no `--porcelain` (measured, git 2.34.1), so guarding it would
 *  mean this wrapper growing a refspec parser of its own — exactly what the
 *  porcelain probe exists to avoid — and no studio has a legitimate reason to
 *  reach past `git push` for the plumbing (maestro round-3 review of #259, item
 *  2, which named refusing it outright as the acceptable answer). */
export const STUDIO_PUSH_PLUMBING_REFUSAL =
  "fleet: git send-pack and git http-push push without a check fleet can run -- use git push";

/** What the wrapper prints when an alias chain is deeper than the resolver's
 *  cap. The cap stops a self-referential alias from spinning forever; round 2
 *  spent it on `exec "$real" "$@"`, which handed an UNRESOLVED argv to the real
 *  git — measured, git 2.34.1: a ten-link chain ending in `push origin
 *  HEAD:trunk` resolved fine for git and moved the default branch. A resolver
 *  that gave up knows nothing about the push, so it refuses. */
export const STUDIO_PUSH_ALIAS_DEPTH_REFUSAL =
  "fleet: this alias chain is too deep to resolve -- refusing it (fail closed)";

/**
 * Subcommands that are git BUILTINS. Git ignores any alias that shadows a
 * builtin ("aliases that hide existing Git commands are ignored",
 * git-config(1)), so recognizing one here is final: no alias read is needed,
 * and none can hide behind a name on this list. That is the whole reason the
 * list exists — `git status`, run hundreds of times a session, must cost
 * ZERO extra processes.
 *
 * Deliberately the hot set rather than every builtin git ships: a
 * subcommand missing from here costs exactly one `git config --get
 * alias.<sub>` read before it is handed over anyway, so the list being short
 * is a performance detail, never a correctness one. `push` is absent on
 * purpose.
 */
const STUDIO_GIT_BUILTINS = [
  "add", "am", "annotate", "apply", "archive", "bisect", "blame", "branch", "bundle",
  "cat-file", "check-attr", "check-ignore", "checkout", "cherry", "cherry-pick", "clean",
  "clone", "commit", "config", "describe", "diff", "difftool", "fetch", "for-each-ref",
  "format-patch", "fsck", "gc", "grep", "help", "init", "log", "ls-files", "ls-remote",
  "ls-tree", "maintenance", "merge", "merge-base", "mergetool", "mv", "notes", "pull",
  "range-diff", "rebase", "reflog", "remote", "repack", "replace", "reset", "restore",
  "rev-list", "rev-parse", "revert", "rm", "shortlog", "show", "show-ref",
  "sparse-checkout", "stash", "status", "stripspace", "submodule", "switch",
  "symbolic-ref", "tag", "update-index", "update-ref", "var", "version", "whatchanged",
  "worktree",
];

/**
 * The `/usr/local/bin/git` wrapper's own shell text — a PURE function,
 * deliberately separated from `studioGitSafetyCmd` below (which installs
 * it), so the generated shell can be asserted on directly the same way
 * `blueprintCredentialWriteCmd`'s command string already is: a Worker-safe,
 * no-real-git test on the STRING this returns. The functional proof that
 * this shell, actually run, refuses/allows the right pushes lives in
 * test/bun/git-wrapper.test.ts instead (real git — see that file's own
 * header for why it must never run inside a studio).
 *
 * WHAT IT DOES, in the order it does it:
 *
 *   - Anything that is not a push: `exec /usr/bin/git "$@"` and nothing
 *     else. No subprocess, no config read, no measurable cost.
 *   - Finding the subcommand means skipping git's own global options first.
 *     `-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--config-env`
 *     and `--attr-source` take a SEPARATE value, so they skip two tokens;
 *     the `--opt=value` spellings carry their value inline and skip one.
 *     Whatever globals were consumed are passed to every delegated read
 *     below, so `git -C other/repo push` is judged against `other/repo`.
 *   - `send-pack` and `http-push`, the two plumbing commands that push
 *     WITHOUT going through the push porcelain, are REFUSED outright.
 *     Measured, git 2.34.1: `git send-pack <url> HEAD:refs/heads/<default>`
 *     moved the remote ref with nothing looking at it. `send-pack` has
 *     `--dry-run` but no `--porcelain`, so guarding it would need a refspec
 *     parser of this wrapper's own; refusing the plumbing costs a studio
 *     nothing, since `git push` does the same job and IS guarded.
 *   - A subcommand that is neither `push` nor a known builtin may be an
 *     ALIAS. `alias.<sub>` is read once; if it expands to something whose
 *     own subcommand is `push`, the expansion is spliced in and rescanned,
 *     so `git yolo` with `alias.yolo = push origin HEAD:main` is treated as
 *     exactly the push it is. Resolving gives up after 8 links and REFUSES
 *     there — a resolver that stopped reading knows nothing about the push,
 *     and the real git resolves chains of any length itself (measured: a
 *     ten-link chain ending in a push moved the default branch when this cap
 *     handed over instead of refusing).
 *   - A `!`-prefixed alias runs an arbitrary SHELL command, which cannot be
 *     judged from its argv — and cannot be trusted to come back through this
 *     wrapper either (see RESIDUAL GAP below). EVERY `!` alias is refused
 *     OUTRIGHT now, unconditionally, with no text inspection at all (issue
 *     #310): an earlier design normalized its text and arguments (quote and
 *     expansion characters stripped) and refused on a `push` mention or a
 *     `git` word, but a shell GLOB (`g?t`) and an octal `printf` escape
 *     inside a command substitution hid both words from that scan at once and
 *     pushed the default branch for real (measured, git 2.34.1) — arbitrary
 *     shell obfuscation cannot be closed by any text scan, however many
 *     triggers it has.
 *   - The default branch is resolved DYNAMICALLY, and from the REMOTE the
 *     push is actually TARGETING — parsed out of the push subcommand's own
 *     argv per git-push(1) (`[<repository> [<refspec>...]]`), never a
 *     hardcoded "origin" (issue #310): `git remote rename origin up && git
 *     remote add origin <decoy>` leaves the real repo reachable only as
 *     "up", and a hardcoded lookup never asks it. `git ls-remote --symref
 *     <target> HEAD` goes first, because the local
 *     `refs/remotes/<target>/HEAD` symref is REWRITABLE from the studio's own
 *     shell (`git remote set-head <target> <other>` — measured: one command
 *     and the guard was watching the wrong branch). That local symref is
 *     still read, and `git remote show <target>`'s "HEAD branch:" line is
 *     still the last resort, but every source that resolves ADDS a protected
 *     name rather than replacing one, so poisoning the local read can only
 *     ever protect one MORE branch, never one fewer. Never a hardcoded
 *     "main". If NONE resolves (or the remote reports `(unknown)`), the push
 *     is REFUSED, fail closed.
 *   - The push's actual targets come from git itself, via a PROBE:
 *     `push <caller's args> --dry-run --porcelain --no-verify --no-quiet`.
 *     `--dry-run` touches nothing; `--porcelain` prints one
 *     `<flag>\t<src>:<dst>\t<summary>` line per ref with `<dst>` already
 *     resolved to its full `refs/...` form (measured, git 2.34:
 *     `HEAD:trunk` comes back as `HEAD:refs/heads/trunk`), which is why this
 *     needs no refspec parser of its own and why every exotic spelling —
 *     `+HEAD:main`, `--force`, `--all`, `--mirror`, `--delete`, `:main`,
 *     `remote.origin.push`, a bare URL instead of `origin` — is covered by
 *     the same three lines. `--no-verify` keeps the repo's own pre-push hook
 *     from firing on this probe; it still fires for real on the exec at the
 *     end.
 *   - PROBE AUTHORITY: those four flags go LAST, after everything the caller
 *     wrote. Git's option parse is last-wins, so a hostile spelling earlier
 *     in the argv cannot override them — measured on 2.34.1 and 2.43, with
 *     the flags FIRST a caller's `--no-dry-run` made the probe itself perform
 *     the real push, and `--no-porcelain`, `--quie` (an abbreviation git
 *     still resolves), `-qf` (a bundled short form) and `--verify` each
 *     disarmed it. A bare `--` ends git's option parsing, so anything from
 *     the caller's own `--` onward is re-appended AFTER the flags: past a
 *     `--` they would be read as refspecs rather than flags.
 *   - A FIFTH, SACRIFICIAL `--no-verify` leads those four. Going last puts
 *     them directly behind the caller's last token, and a DANGLING option
 *     there — one expecting a separate value the caller never supplied —
 *     makes git eat the next token as its value. Measured, git 2.34.1: a
 *     trailing `--repo`, `--rep` or `-o`/`--push-option` (against a remote
 *     advertising push options) swallowed `--dry-run`, so the probe WAS the
 *     real push, with the probe's own `--no-verify` skipping the repo's hooks
 *     on it, and the refusal printed after the default branch had moved. The
 *     dangling option eats the sacrificial flag instead. A pure flag whose
 *     real copy follows it is the only safe thing to sacrifice.
 *   - Any probe line whose `<dst>` is `refs/heads/<default>` (any resolved
 *     default name) and whose flag is not `=` refuses the whole push. `=` is
 *     git's "up to date" flag: nothing would move, so it is not a push.
 *   - FAIL CLOSED ON A FAILED PROBE. A probe that exits non-zero refuses the
 *     push: its own output first, then one fleet line. A probe that exits 0
 *     with no ref lines is a probe that genuinely found nothing to push, and
 *     THAT is handed over so git reports its own "Everything up-to-date".
 *     The two look identical in the output alone — an empty `$out` either
 *     way — and reading the first as the second is exactly what let eight
 *     measured pushes reach the default branch: a remote that failed only
 *     the probe's connection and succeeded on the retry, an alias expansion
 *     carrying literal quotes that only the probe choked on, and a push
 *     option the receiving end could not take. The exit code is the only
 *     thing that separates them, so it is captured and checked.
 *   - Otherwise `exec /usr/bin/git "$@"` with the caller's ORIGINAL argv —
 *     no injected `--no-verify`, no rewritten refspec — so the repo's own
 *     hooks run exactly as they would without this wrapper.
 *
 * RESIDUAL GAP, named rather than papered over. Git prepends its own
 * exec-path onto the PATH of anything it runs, and the studio image keeps a
 * SECOND real git binary there: `/usr/lib/git-core/git`, a different inode
 * from `/usr/bin/git`. So a `git` word inside anything git itself spawns
 * reaches the real git and never this wrapper. Refusing a `!` alias closes
 * that one door; `git rebase -x '<cmd>'`, a repo's own hooks, `git submodule
 * foreach` and `git bisect run` stay open (the round-2 review measured
 * `rebase -x` and a pushing hook each moving the default branch). Replacing
 * `/usr/lib/git-core/git` is NOT the fix — measured, it breaks dashed git
 * subcommands and `git clone file://` — so closing those is its own piece of
 * work, not a line in this one.
 *
 * OUT OF SCOPE BY CONSTRUCTION, and covered by a stated rule instead (see
 * blueprint.ts's HOUSE_RULES, "studios never push the default branch"). A
 * wrapper on PATH cannot see what does not resolve through PATH — the real
 * git called as `/usr/bin/git` or `/usr/lib/git-core/git-push` — and cannot
 * see what never runs git at all: a `gh api` call that updates a ref,
 * `gh repo sync`, `gh pr merge`. No wrapper change closes those; the rule
 * naming them is the whole of their cover.
 */
export function studioGitWrapperScript(realGit = STUDIO_REAL_GIT_PATH): string {
  return [
    `#!/bin/bash`,
    `# fleet: issue #253. Installed at ${STUDIO_GIT_WRAPPER_PATH}, which comes`,
    `# before ${realGit} on PATH, so every git call in this container arrives`,
    `# here first. A push whose dry run says it would move the remote's`,
    `# default branch is refused; everything else is handed to the real git`,
    `# untouched, repo hooks and all. Deliberately NOT a git hook: see`,
    `# credentials.ts's studioGitWrapperScript for the three measured reasons.`,
    `real='${realGit}'`,
    ``,
    `args=("$@")`,
    `globals=()`,
    `sub=''`,
    `rest=()`,
    `depth=0`,
    ``,
    `# Splits "$@" into git's own global options, the subcommand, and the`,
    `# subcommand's arguments. The first group listed takes a separate value,`,
    `# which is consumed with it; --opt=value spellings fall through to the`,
    `# bare-flag branch and consume one token.`,
    `scan() {`,
    `  globals=(); sub=''; rest=()`,
    `  local n=\${#args[@]} i=0 a`,
    `  while [ "$i" -lt "$n" ]; do`,
    `    a=\${args[$i]}`,
    `    case "$a" in`,
    `      -C|-c|--git-dir|--work-tree|--namespace|--config-env|--attr-source)`,
    `        globals+=("$a"); i=$((i + 1))`,
    `        [ "$i" -lt "$n" ] && globals+=("\${args[$i]}")`,
    `        ;;`,
    `      -*)`,
    `        globals+=("$a")`,
    `        ;;`,
    `      *)`,
    `        sub=$a`,
    `        i=$((i + 1))`,
    `        while [ "$i" -lt "$n" ]; do rest+=("\${args[$i]}"); i=$((i + 1)); done`,
    `        return 0`,
    `        ;;`,
    `    esac`,
    `    i=$((i + 1))`,
    `  done`,
    `}`,
    ``,
    `# Git ignores an alias that shadows a builtin, so a name on this list is`,
    `# final and costs no alias read at all. "push" is deliberately absent.`,
    `builtins=' ${STUDIO_GIT_BUILTINS.join(" ")} '`,
    ``,
    `scan`,
    `while :; do`,
    `  # No subcommand at all: bare "git", "git --version", "git --help".`,
    `  [ -n "$sub" ] || exec "$real" "$@"`,
    `  [ "$sub" = 'push' ] && break`,
    `  # The PLUMBING that pushes without going through the push porcelain. Round`,
    `  # 2 recognized only "push", so these two fell straight through to the real`,
    `  # git: measured, git 2.34.1, "git send-pack <url> HEAD:refs/heads/trunk"`,
    `  # moved the remote ref with nothing looking at it. Refused outright rather`,
    `  # than guarded -- send-pack has --dry-run but no --porcelain, so guarding`,
    `  # it would need a refspec parser of this wrapper's own, and "git push" is`,
    `  # right there.`,
    `  case "$sub" in`,
    `    send-pack|http-push)`,
    `      echo "${STUDIO_PUSH_PLUMBING_REFUSAL}" >&2`,
    `      exit 1`,
    `      ;;`,
    `  esac`,
    `  case "$builtins" in *" $sub "*) exec "$real" "$@" ;; esac`,
    `  depth=$((depth + 1))`,
    `  # Out of alias-resolving depth. Round 2 spent this cap on`,
    `  # exec "$real" "$@" -- handing an argv it had given up reading to the real`,
    `  # git, which resolves alias chains of any length itself (measured: a`,
    `  # ten-link chain ending in "push origin HEAD:trunk" pushed for real). A`,
    `  # resolver that gave up knows nothing about the push, so it refuses.`,
    `  if [ "$depth" -gt 8 ]; then`,
    `    echo "${STUDIO_PUSH_ALIAS_DEPTH_REFUSAL}" >&2`,
    `    exit 1`,
    `  fi`,
    `  expansion=$("$real" "\${globals[@]}" config --get "alias.$sub" 2>/dev/null)`,
    `  [ -n "$expansion" ] || exec "$real" "$@"`,
    `  # A '!' alias runs an arbitrary SHELL command, and git prepends its own`,
    `  # exec-path onto that command's PATH. The studio image keeps a SECOND real`,
    `  # git binary there (/usr/lib/git-core/git, measured: a different inode`,
    `  # from /usr/bin/git), so a plain "git" word inside a '!' alias reaches the`,
    `  # real git directly and never this wrapper. Its argv cannot be rewritten`,
    `  # from here either.`,
    `  #`,
    `  # Rounds 2 and 3 tried to make that survivable by SCANNING the alias text:`,
    `  # strip the quote/expansion characters a word can hide a literal substring`,
    `  # behind, then refuse anything whose stripped text still contained "push",`,
    `  # "send-pack", or a bare "git" word. That is a losing arms race against`,
    `  # ARBITRARY shell obfuscation, not a closed set of tricks to enumerate --`,
    `  # measured, issue #310: \`alias.p = '!/usr/bin/g?t $(printf "\\160ush")`,
    `  # origin HEAD:main'\` moved main for real. "g?t" is a shell GLOB (a`,
    `  # single-char wildcard) that only expands to the literal word "git" when`,
    `  # bash actually RUNS the alias, so this wrapper's own string scan never sees`,
    `  # "git", only "g?t"; \`$(printf "\\160ush")\` computes the string "push" from`,
    `  # an OCTAL escape at runtime inside a command substitution, and after`,
    `  # stripping the scan's quote/expansion characters the leftover text is`,
    `  # "printf 160ush", which does not contain the literal substring "push"`,
    `  # either. Globbing, hex/octal/base64 encoding, variable indirection, eval,`,
    `  # and "printf %b" can each hide any substring a scan might look for, so no`,
    `  # text scan -- however many triggers it has -- can ever close this door.`,
    `  #`,
    `  # So every '!' alias is refused OUTRIGHT, unconditionally, with no text`,
    `  # inspection at all: it runs a shell command outside anything this wrapper`,
    `  # can audit, whether or not its stored text happens to mention git or push.`,
    `  # NOT closed by this: the same exec-path prepend leaves "rebase -x", a`,
    `  # repo's own hooks, "submodule foreach" and "bisect run" unguarded`,
    `  # (measured: rebase -x and a pushing hook each moved the default branch).`,
    `  # Replacing /usr/lib/git-core/git is not the answer -- measured, it breaks`,
    `  # dashed subcommands and clone file://.`,
    `  case "$expansion" in`,
    `    '!'*)`,
    `      echo "${STUDIO_PUSH_SHELL_ALIAS_REFUSAL}" >&2`,
    `      exit 1`,
    `      ;;`,
    `  esac`,
    `  read -r -a words <<< "$expansion"`,
    `  args=("\${globals[@]}" "\${words[@]}" "\${rest[@]}")`,
    `  scan`,
    `done`,
    ``,
    `# --- this is a push -------------------------------------------------`,
    `# WHERE it goes is GIT's decision, not this wrapper's reading of the argv`,
    `# (issue #310 round 2). Round 1 parsed the positional <repository> and fell`,
    `# back to "origin", and git picks the remote from branch.<b>.remote,`,
    `# branch.<b>.pushRemote, remote.pushDefault and --repo too, then sends to the`,
    `# PUSH url (pushurl, pushInsteadOf) while ls-remote on a remote NAME reads`,
    `# its FETCH url. Measured, git 2.43: a bare push after renaming the real`,
    `# remote, --repo=up, pushDefault=up, a pushurl behind a decoy url and a`,
    `# pushInsteadOf each moved the default branch. So the destination is read`,
    `# from the dry-run probe below -- its porcelain "To <url>" line is the URL git`,
    `# will really push to -- and that exact URL is asked for its HEAD.`,
    ``,
    `# Ask git what this push WOULD move. The guard's OWN flags go LAST, after`,
    `# everything the caller wrote: git's option parse is last-wins, so no`,
    `# spelling earlier in the argv can override them (measured on 2.34.1 and`,
    `# 2.43 -- with these flags FIRST, a caller's --no-dry-run made this very`,
    `# probe perform the real push, and --no-porcelain, --quie, -qf and --verify`,
    `# each disarmed it).`,
    `#`,
    `# THE LEADING --no-verify IS SACRIFICIAL, and is the whole reason this line`,
    `# has five flags for four jobs. Going last puts the guard's flags directly`,
    `# behind the caller's LAST token, and if that token is an option expecting a`,
    `# separate value the caller never supplied -- a DANGLING option -- git's`,
    `# parser eats the next token as its value. The next token would be`,
    `# --dry-run, and a probe with no --dry-run is the real push, carrying the`,
    `# guard's own --no-verify (still parsed as itself once the parser resumes),`,
    `# so the repo's hooks are skipped too. Measured, git 2.34.1: a trailing`,
    `# --repo, --rep (an abbreviation git resolves) or -o/--push-option against a`,
    `# remote advertising push options each moved the default branch, and the`,
    `# refusal printed afterwards off the ref line of the push it had just made.`,
    `# A dangling option eats THIS flag instead and the four behind it survive`,
    `# intact; nothing is dangling and it is an ordinary redundant flag. A pure`,
    `# flag is the only safe thing to sacrifice: being consumed as some other`,
    `# option's value costs nothing, because the real --no-verify follows it.`,
    `#`,
    `# --no-quiet is explicit rather than stripping the`,
    `# caller's -q: --quiet suppresses --porcelain's ref lines outright, and`,
    `# overriding it outright covers every spelling, bundled and abbreviated`,
    `# ones included. A bare "--" ends git's option parsing, so everything from`,
    `# the caller's own "--" onward is split into "post" and re-appended AFTER`,
    `# the flags -- past a "--" they would be read as refspecs, not flags.`,
    `pre=()`,
    `post=()`,
    `ddash=0`,
    `for a in "\${rest[@]}"; do`,
    `  if [ "$ddash" = 0 ]; then`,
    `    case "$a" in '--') ddash=1; post+=("$a"); continue ;; esac`,
    `    pre+=("$a")`,
    `  else`,
    `    post+=("$a")`,
    `  fi`,
    `done`,
    `out=$("$real" "\${globals[@]}" push "\${pre[@]}" --no-verify --dry-run --porcelain --no-verify --no-quiet "\${post[@]}" 2>&1)`,
    `rc=$?`,
    ``,
    `# The probe prints "To <url>" and then one "<flag>\\t<src>:<dst>\\t<summary>"`,
    `# line per ref; a remote with several push urls prints one such block per`,
    `# url, and each block is judged against ITS url's default branch. The`,
    `# default is ASKED OF that URL (ls-remote --symref), never read from`,
    `# anything this container can rewrite (refs/remotes/<name>/HEAD: set-head).`,
    `#`,
    `# Default known: a line whose <dst> is refs/heads/<default> and whose flag`,
    `# is not "=" (git's "up to date") refuses the whole push. Default UNKNOWN`,
    `# (no HEAD symref at that url -- a fresh empty repo, or HEAD on an unborn`,
    `# branch): any EXISTING ref moving might be the default, so only a new ref`,
    `# ("*") passes -- a plain feature branch to a fresh remote goes through. A`,
    `# ref line with no "To" line before it has no known destination: refused.`,
    `# A herestring, never a pipe: the loop must run in THIS shell so its exit`,
    `# actually refuses the push.`,
    `#`,
    `# Issue #344: ls-remote applies FETCH-side insteadOf, the push does not.`,
    `# url.<decoy>.insteadOf=<real> + url.<real>.pushInsteadOf=<real> (repo`,
    `# config, a prefix rewrite, or "git -c") sends the push to the real repo`,
    `# while ls-remote asks the decoy for HEAD -- measured, git 2.43, the real`,
    `# default branch moved. So ls-remote's answer counts only when`,
    `# "ls-remote --get-url" names that same url (no rewrite) AND the query`,
    `# itself succeeds. Otherwise the default is unknowable from the remote:`,
    `# refuse any branch that could be the default (main, master,`,
    `# init.defaultBranch, every local refs/remotes/*/HEAD target) and any`,
    `# destination outside refs/heads/ and refs/tags/; a feature branch still`,
    `# goes through. "--" before the url: a url is never read as an option.`,
    `# The candidate reads carry the caller's globals (-C, --git-dir,`,
    `# --work-tree): they must read the repo the push targets, not our cwd.`,
    `url=''`,
    `def=''`,
    `trusted=0`,
    `cands=''`,
    `while IFS= read -r line; do`,
    `  case "$line" in`,
    `    'To '*)`,
    `      url=\${line#To }`,
    `      def=''`,
    `      trusted=0`,
    `      if [ "$("$real" "\${globals[@]}" ls-remote --get-url -- "$url" 2>/dev/null)" = "$url" ] &&`,
    `         sym=$("$real" "\${globals[@]}" ls-remote --symref -- "$url" HEAD 2>/dev/null); then`,
    `        trusted=1`,
    `        def=$(printf '%s\\n' "$sym" | sed -n 's|^ref: refs/heads/||p')`,
    `        def=\${def%%[[:space:]]*}`,
    `      fi`,
    `      continue`,
    `      ;;`,
    `  esac`,
    `  IFS=$'\\t' read -r flag pair summary <<< "$line"`,
    `  case "$flag" in ' '|'+'|'-'|'*'|'!'|'=') ;; *) continue ;; esac`,
    `  [ "$flag" = "=" ] && continue`,
    `  dst=\${pair#*:}`,
    `  if [ -z "$url" ]; then`,
    `    echo "${STUDIO_PUSH_UNRESOLVED_DEFAULT}" >&2`,
    `    exit 1`,
    `  fi`,
    `  if [ "$trusted" = 0 ]; then`,
    `    case "$dst" in`,
    `      refs/heads/*|refs/tags/*) ;;`,
    `      *) echo "${STUDIO_PUSH_UNRESOLVED_DEFAULT}" >&2; exit 1 ;;`,
    `    esac`,
    `    if [ -z "$cands" ]; then`,
    `      cands=" main master $("$real" "\${globals[@]}" config init.defaultBranch 2>/dev/null) $("$real" "\${globals[@]}" for-each-ref --format='%(symref)' 'refs/remotes/*/HEAD' 2>/dev/null | sed 's|^refs/remotes/[^/]*/||' | tr '\\n' ' ') "`,
    `    fi`,
    `    case "$cands" in`,
    `      *" \${dst#refs/heads/} "*)`,
    `        if [ "$dst" != "\${dst#refs/heads/}" ]; then`,
    `          echo "${STUDIO_PUSH_REFUSAL}" >&2`,
    `          exit 1`,
    `        fi`,
    `        ;;`,
    `    esac`,
    `    continue`,
    `  fi`,
    `  if [ -n "$def" ]; then`,
    `    if [ "$dst" = "refs/heads/$def" ]; then`,
    `      echo "${STUDIO_PUSH_REFUSAL}" >&2`,
    `      exit 1`,
    `    fi`,
    `  elif [ "$flag" != '*' ]; then`,
    `    echo "${STUDIO_PUSH_UNRESOLVED_DEFAULT}" >&2`,
    `    exit 1`,
    `  fi`,
    `done <<< "$out"`,
    ``,
    `# The probe is the only thing that knows what this push would move, so a`,
    `# probe that FAILED leaves the guard blind, and a blind guard refuses. The`,
    `# exit code is the whole point: an empty "$out" from a failed probe looks`,
    `# exactly like an empty "$out" from a probe that found nothing to push, and`,
    `# reading the first as the second is what let a transient connection`,
    `# failure, an alias expansion carrying literal quotes, and an unsupported`,
    `# push option each land on the default branch. Checked AFTER the parse`,
    `# above, so a probe that both failed and named the default branch still`,
    `# gets the specific refusal rather than this generic one.`,
    `if [ "$rc" -ne 0 ]; then`,
    `  printf '%s\\n' "$out" >&2`,
    `  echo "${STUDIO_PUSH_PROBE_FAILED}" >&2`,
    `  exit 1`,
    `fi`,
    ``,
    `exec "$real" "$@"`,
  ].join("\n") + "\n";
}

/**
 * Provision-time git safety (issue #253), Worker-side exec — no container
 * image change. Three parts, all repeat-safe (idempotent) the same way
 * `blueprintCredentialWriteCmd` already is, run on every provision AND every
 * restart (see do.ts's `deps()` and provision.ts's `applyStudioGitSafety`
 * call sites):
 *
 *   1. `push.default=current` — a bare `git push` pushes the CURRENT branch
 *      to a same-named branch on the remote, independent of whatever
 *      upstream the branch happens to carry. Kept as defense in depth, not
 *      as the fix: `simple`, git's own default, already refuses a bare push
 *      whose upstream is named differently (measured in review, exit 128),
 *      and neither setting would have stopped the #253 incident on its own.
 *   2. `branch.autoSetupMerge=false` — the incident's own mechanism. A local
 *      branch created FROM `origin/main` (`git checkout -b work
 *      origin/main`, or checking out `main` and committing to it directly)
 *      no longer silently gets `origin/main` as its upstream, so a bare
 *      `git push` has nothing on `origin/main` to push INTO.
 *   3. The `/usr/local/bin/git` wrapper — the only part that actually
 *      inspects a push's TARGET, and the only one nothing can route around.
 *      See `studioGitWrapperScript` above for what it does and why it
 *      replaced the `core.hooksPath` hook the first cut of this fix used.
 *
 * Both config keys are single-valued (unlike `credential.helper`'s
 * multivalued list above), so plain `git config --global <key> <value>`
 * overwrites cleanly on every repeat call — no `--unset-all` dance needed.
 *
 * EVERY GIT WORD HERE IS THE ABSOLUTE REAL GIT, never a bare `git`. This
 * command's whole job is to install the wrapper, and a bare `git` resolves
 * through PATH — which finds the WRAPPER, the very thing that may be broken
 * and in need of replacing. Measured: with a live `/usr/local/bin/git` that
 * exits 1 unconditionally, the two `git config` steps above failed, the `&&`
 * chain aborted, and the re-provision never reached the step that would have
 * repaired it. A broken wrapper could never repair itself. Routing them
 * through `realGit` makes self-repair work from any state.
 *
 * ONE `&&` CHAIN, no heredoc. The wrapper rides as base64 through
 * `printf | base64 -d` rather than a heredoc for two reasons: base64 is
 * `A-Za-z0-9+/=` only, so nothing in the script's own text — quotes, `$`,
 * tabs, the em dash in the refusal message — can interact with the outer
 * shell's quoting; and a heredoc's body sits in the MIDDLE of the chain,
 * where a failing step's exit code is no longer what the exec reports.
 * Every step here is `&&`-joined, so the one exit code this exec returns
 * genuinely covers all of them, and a failure anywhere leaves the staged tmp
 * file behind rather than a broken `/usr/local/bin/git`.
 *
 * The last link is a read-only CONFIRMATION, not an action: after the
 * install, a plain `git` must resolve to the wrapper. `hash -r` first
 * because this same bash already ran `git config` above and cached the
 * pre-install resolution. It is the end-to-end form of "PATH puts
 * /usr/local/bin before /usr/bin" — if the ordering were ever otherwise, the
 * wrapper would be installed and inert, and this is what says so.
 */
export function studioGitSafetyCmd(
  opts: { wrapperPath?: string; realGit?: string } = {},
): string {
  const wrapper = opts.wrapperPath ?? STUDIO_GIT_WRAPPER_PATH;
  const real = opts.realGit ?? STUDIO_REAL_GIT_PATH;
  const tmp = `${wrapper}.fleet-install`;
  const b64 = base64EncodeUtf8(studioGitWrapperScript(real));
  return (
    `'${real}' config --global push.default current && ` +
    `'${real}' config --global branch.autoSetupMerge false && ` +
    `printf '%s' '${b64}' | base64 -d > '${tmp}' && ` +
    `chmod 0755 '${tmp}' && ` +
    `mv -f '${tmp}' '${wrapper}' && ` +
    `hash -r && ` +
    `[ "$(command -v git)" = '${wrapper}' ]`
  );
}

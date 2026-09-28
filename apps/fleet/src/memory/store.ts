import { resolveOpsRepo } from "../ops-repo";

/**
 * Issue #341 (public-release prereq for #335): WHERE the fleet's memory lives.
 *
 * Harvested learnings used to be committed into `fleet/memory/` of the
 * blueprint repo that fleet.json names -- the fleet repo itself, which is
 * going public. Operator learnings must never land there. The operator's
 * private ops repo (`FLEET_OPS_REPO`, src/ops-repo.ts; shared with the #330
 * house-rules overlay) is now the memory STORE that every memory
 * writer (harvest, compaction) and reader (survey, provision index, the lead's
 * on-disk copy) uses. Unset is OFF: nothing is harvested, nothing is read, and
 * the survey/compaction routes say so. That is the public default.
 *
 * The store keeps the `fleet/memory/` layout (index-file.ts's MEMORY_DIR): the
 * migration preserves the prefix, so no path in this feature changed.
 *
 * Imports only ../ops-repo (itself import-free): the bun:test lane and the
 * Worker both reach it.
 */

/** The store is read at its DEFAULT branch. A memory repo has no blueprint
 *  ref to pin; the Contents API resolves `HEAD` to the default branch
 *  (measured: `?ref=HEAD` -> 200). */
export const MEMORY_REF = "HEAD";

/** Where the lead finds the memory FILES on disk. The prompt names it. */
export const MEMORY_CLONE_DIR = "/opt/memory";

/** The exec-env variable the clone reads its token from (#110 pattern: a
 *  token rides the exec env, never the command text). */
export const MEMORY_TOKEN_ENV = "FLEET_MEMORY_TOKEN";

/** The memory store: the ops repo (FLEET_OPS_REPO, src/ops-repo.ts), or null
 *  when memory is off. Memory lives at `fleet/memory/` inside it. */
export function resolveMemoryRepo(env: { FLEET_OPS_REPO?: string }): string | null {
  return resolveOpsRepo(env);
}

/**
 * Clone the store for the lead at MEMORY_CLONE_DIR, swapped in whole (a failed
 * or partial clone never replaces a good copy). The store is usually PRIVATE:
 * the Worker mints a token for its owner and passes it in the exec env as
 * MEMORY_TOKEN_ENV; it reaches git only through a credential helper that reads
 * the variable at auth time -- never argv text, never an http header.
 * Never fails provisioning: a failed clone is one stderr line, exit status 0.
 * A subshell, so nothing leaks into the shared exec session. `base`/`dir` are
 * test seams (a local bare repo, a temp dir).
 */
export function memoryCloneCmd(repo: string, opts: { base?: string; dir?: string } = {}): string {
  const base = opts.base ?? "https://github.com/";
  const dir = opts.dir ?? MEMORY_CLONE_DIR;
  return (
    `( d='${dir}'; t="$d.tmp.$$"; rm -rf "$t"; set --; ` +
    // #346 review: a credential HELPER, never an http header -- git's argv
    // (visible in `ps` to everything in the container) then carries only the
    // variable's NAME; the helper's own shell expands it at auth time.
    `if [ -n "\${${MEMORY_TOKEN_ENV}:-}" ]; then ` +
    `set -- -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo "password=\${${MEMORY_TOKEN_ENV}}"; }; f'; fi; ` +
    `if GIT_TERMINAL_PROMPT=0 git "$@" clone -q --depth 1 '${base}${repo}.git' "$t" 2>/dev/null; then rm -rf "$d" && mv "$t" "$d"; ` +
    `else rm -rf "$t"; echo "studio-bringup: memory clone skipped (${repo})" >&2; fi )`
  );
}

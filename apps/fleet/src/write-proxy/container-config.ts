/**
 * Issue #7: the studio's git config for its write mode, run Worker-side at
 * provision/restart (provision.ts's applyLeakGate).
 *
 * proxy: `git push` to github.com is rewritten (pushInsteadOf -- fetch is
 * untouched and stays direct, on the read credential) to the Worker's
 * /fleet/git proxy, and a credential helper scoped to that URL answers the
 * spawn token. The helper reads $FLEET_SPAWN_TOKEN when git runs it, so the
 * token never sits in .gitconfig or an argv. The list is reset first (an
 * empty helper value), the same measured shape as credentials.ts's
 * blueprintCredentialWriteCmd: git concatenates matching helpers and the
 * bare github.com store would otherwise answer first. The marker tells the
 * gh wrapper to hand write verbs to fleet-gh-proxy.
 *
 * direct: all of it removed. Both branches repeat-safe. Every git word is the
 * REAL git, never the PATH wrapper (credentials.ts's studioGitSafetyCmd).
 * Imports nothing Worker-only: the bun lane runs it against real git.
 */
import { STUDIO_REAL_GIT_PATH } from "../studio/credentials";

/** Present = proxy mode; content = the Worker URL. Read by the gh wrapper. */
export const WRITE_PROXY_MARKER = "/opt/fleet/write-proxy";

/** Baked into the studio image (container/gh-proxy.ts, Dockerfile.studio). */
export const GH_PROXY_CLIENT = "fleet-gh-proxy";

export function writeProxyConfigCmd(
  mode: "direct" | "proxy", workerUrl: string, opts: { realGit?: string; marker?: string } = {},
): string {
  const git = `'${opts.realGit ?? STUDIO_REAL_GIT_PATH}'`;
  const marker = opts.marker ?? WRITE_PROXY_MARKER;
  const base = `${workerUrl.replace(/\/+$/, "")}/fleet/git/`;
  const insteadOf = `url.${base}github.com/.pushInsteadOf`;
  const helperKey = `credential.${base}.helper`;
  const drop = (k: string) => `{ ${git} config --global --unset-all '${k}' 2>/dev/null || true; }`;
  const clear = `${drop(insteadOf)} && ${drop(helperKey)}`;
  if (mode === "direct") return `${clear} && rm -f '${marker}'`;
  const helper = `!f() { [ "$1" = get ] || return 0; echo username=x-fleet-spawn; echo "password=\${FLEET_SPAWN_TOKEN}"; }; f`;
  return (
    `${clear} && ` +
    `${git} config --global --add '${insteadOf}' 'https://github.com/' && ` +
    `${git} config --global --add '${helperKey}' '' && ` +
    `${git} config --global --add '${helperKey}' '${helper}' && ` +
    `mkdir -p '${marker.slice(0, marker.lastIndexOf("/")) || "/"}' && ` +
    `printf '%s\\n' '${workerUrl.replace(/\/+$/, "")}' > '${marker}'`
  );
}

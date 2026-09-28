import { LEAK_DENYLIST_PATH, LEAK_SCAN_PATH, leakScanScript } from "../leak-gate";
import { GH_PROXY_CLIENT, WRITE_PROXY_MARKER } from "../write-proxy/container-config";

/**
 * Issue #1: the container `gh` wrapper. Installed at STUDIO_GH_WRAPPER_PATH,
 * ahead of the real gh on PATH, so every gh write a studio makes is scanned
 * by fleet-leak-scan (src/leak-gate.ts) before it can reach GitHub.
 *
 * Default deny: EVERY gh invocation is scanned -- aliases, extensions and
 * subcommands gh adds later included. The scanner reads:
 *   - every argv word (titles, bodies, -f/-F values, positional text);
 *   - files named by --body-file, --notes-file, --input, `-F|--field
 *     key=@file`, and -F <file> outside api/workflow (where -F is a body or
 *     notes file); `-` / `@-` = stdin, captured to a temp file, scanned,
 *     then handed to the real gh as its stdin;
 *   - for gist and release, every argument naming an existing file, a
 *     trailing `#label` stripped (gist uploads it, release attaches it);
 *   - `gist create` with no file argument reads stdin: captured and scanned.
 *   - `--recover <file>` (issue/pr create) contents; `workflow run --json`
 *     reads inputs JSON from stdin: captured, scanned, passed through.
 * Aliases expand inside the real gh, past the scan: a non-builtin first word
 * that `gh alias list` names (shell `!` aliases too) is refused with
 * STUDIO_GH_ALIAS_REFUSAL; a failed lookup refuses too. Extensions pass
 * with the argv scan.
 * Any scanner non-zero -- hit, no gate file, bad pattern, unreadable file,
 * scanner absent -- refuses with STUDIO_GH_LEAK_REFUSAL. The term is never
 * printed; the scanner names pattern indexes only.
 *
 * Imports only ../leak-gate and write-proxy/container-config (constants).
 */

export const STUDIO_GH_LEAK_REFUSAL = "fleet: leak gate refused this gh write";
export const STUDIO_GH_ALIAS_REFUSAL = "fleet: leak gate refused a gh alias -- run the gh command directly";

/** Issue #7: proxy mode, but the image predates fleet-gh-proxy. The token is
 *  read-only, so the real gh would only 403; say why instead. */
export const STUDIO_GH_PROXY_MISSING =
  `fleet: this studio writes to GitHub through the fleet Worker, but ${GH_PROXY_CLIENT} is missing -- restart the studio on a current image`;

/** Issue #7: the gh verbs fleet-gh-proxy carries to the Worker's /fleet/gh. */
export const GH_PROXY_VERBS = [
  "pr create", "pr edit", "pr ready", "pr comment", "pr review", "issue create", "issue edit", "issue comment",
];

/**
 * gh's built-in top-level commands (gh 2.95, hidden ones included). A first
 * word outside this list is an alias or an extension: aliases are refused
 * (their expansion is never scanned), extensions get the argv scan.
 */
export const GH_BUILTIN_COMMANDS = [
  "a11y", "accessibility", "actions", "agent-task", "alias", "api", "attestation", "auth", "browse",
  "cache", "codespace", "completion", "config", "copilot", "credits", "discussion", "extension", "gist",
  "gpg-key", "help", "issue", "label", "licenses", "org", "pr", "preview", "project", "release", "repo",
  "ruleset", "run", "search", "secret", "skill", "ssh-key", "status", "variable", "version", "workflow",
];
export const STUDIO_REAL_GH_PATH = "/usr/bin/gh";
export const STUDIO_GH_WRAPPER_PATH = "/usr/local/bin/gh";

export function studioGhWrapperScript(
  realGh = STUDIO_REAL_GH_PATH, scanPath = LEAK_SCAN_PATH, marker = WRITE_PROXY_MARKER,
): string {
  return [
    `#!/bin/bash`,
    `# fleet: issue #1 leak gate. gh writes are scanned before the real gh runs.`,
    `real='${realGh}'`,
    `scan='${scanPath}'`,
    `refuse() { echo "${STUDIO_GH_LEAK_REFUSAL}" >&2; exit 1; }`,
    `refuse_alias() { echo "${STUDIO_GH_ALIAS_REFUSAL}" >&2; exit 1; }`,
    `args=("$@")`,
    `n=\${#args[@]}`,
    ``,
    `# Top-level command and subcommand: first two non-flag words.`,
    `# -R/--repo take a value. Other flag values may be misread as sub;`,
    `# sub only widens what is scanned, never narrows it.`,
    `cmd=''; sub=''`,
    `i=0`,
    `while [ "$i" -lt "$n" ]; do`,
    `  case "\${args[$i]}" in`,
    `    -R|--repo) i=$((i + 1)) ;;`,
    `    -*) ;;`,
    `    *) if [ -z "$cmd" ]; then cmd=\${args[$i]}; else sub=\${args[$i]}; break; fi ;;`,
    `  esac`,
    `  i=$((i + 1))`,
    `done`,
    ``,
    `# Aliases expand inside the real gh, past the scan: refuse any first word`,
    `# that is not builtin and is a defined alias. Lookup failure = refuse.`,
    `case "$cmd" in`,
    `  ''|${GH_BUILTIN_COMMANDS.join("|")}) ;;`,
    `  *)`,
    `    aliases=$("$real" alias list </dev/null 2>/dev/null) || refuse_alias`,
    `    while IFS= read -r l; do [ "\${l%%:*}" = "$cmd" ] && refuse_alias; done <<< "$aliases"`,
    `    ;;`,
    `esac`,
    ``,
    `files=()`,
    `stdin=0`,
    `gfile=0`,
    `addf() { if [ "$1" = '-' ]; then stdin=1; else files+=("$1"); fi; }`,
    `field() { case "$1" in *=@*) addf "\${1#*=@}" ;; esac; }`,
    `bodyf() { case "$cmd" in api|workflow) field "$1" ;; *) addf "$1" ;; esac; }`,
    `i=0`,
    `while [ "$i" -lt "$n" ]; do`,
    `  a=\${args[$i]}`,
    `  v=\${args[$((i + 1))]}`,
    `  case "$a" in`,
    `    --body-file|--notes-file|--input|--recover) addf "$v"; i=$((i + 1)) ;;`,
    `    --body-file=*|--notes-file=*|--input=*|--recover=*) addf "\${a#*=}" ;;`,
    `    --json) if [ "$cmd $sub" = 'workflow run' ]; then stdin=1; fi ;;`,
    `    -F) bodyf "$v"; i=$((i + 1)) ;;`,
    `    -F?*) bodyf "\${a#-F}" ;;`,
    `    --field) field "$v"; i=$((i + 1)) ;;`,
    `    --field=*) field "\${a#--field=}" ;;`,
    `    *)`,
    `      case "$cmd" in`,
    `        gist|release)`,
    `          if [ "$a" = '-' ]; then stdin=1; gfile=1`,
    `          elif [ -f "$a" ]; then files+=("$a"); gfile=1`,
    `          elif [ -f "\${a%#*}" ]; then files+=("\${a%#*}"); gfile=1`,
    `          fi`,
    `          ;;`,
    `      esac`,
    `      ;;`,
    `  esac`,
    `  i=$((i + 1))`,
    `done`,
    `# gist create with no file argument uploads stdin.`,
    `if [ "$cmd" = 'gist' ] && [ "$sub" = 'create' ] && [ "$gfile" = 0 ]; then stdin=1; fi`,
    ``,
    `argv=''; in=''`,
    `trap 'rm -f "$argv" "$in"' EXIT`,
    `argv=$(mktemp) || refuse`,
    `printf '%s\\n' "$@" > "$argv" || refuse`,
    `if [ "$stdin" = 1 ]; then`,
    `  in=$(mktemp) || refuse`,
    `  cat > "$in" || refuse`,
    `  files+=("$in")`,
    `fi`,
    `"$scan" "$argv" "\${files[@]}" || refuse`,
    `rm -f "$argv"`,
    `# exec skips the EXIT trap: open the captured stdin, then unlink it.`,
    `if [ -n "$in" ]; then exec 0<"$in" || refuse; rm -f "$in"; fi`,
    `# Issue #7: proxy mode = read-only token; write verbs go to the Worker.`,
    `if [ -f '${marker}' ]; then`,
    `  case "$cmd $sub" in`,
    `    ${GH_PROXY_VERBS.map((v) => `'${v}'`).join("|")})`,
    `      command -v ${GH_PROXY_CLIENT} >/dev/null 2>&1 || { echo "${STUDIO_GH_PROXY_MISSING}" >&2; exit 1; }`,
    `      exec ${GH_PROXY_CLIENT} "$@"`,
    `      ;;`,
    `  esac`,
    `fi`,
    `exec "$real" "$@"`,
  ].join("\n") + "\n";
}

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function dirOf(p: string): string {
  return p.slice(0, p.lastIndexOf("/")) || "/";
}

function installStep(path: string, script: string): string {
  const tmp = `${path}.fleet-install`;
  return (
    `mkdir -p '${dirOf(path)}' && ` +
    `printf '%s' '${b64(script)}' | base64 -d > '${tmp}' && ` +
    `chmod 0755 '${tmp}' && ` +
    `mv -f '${tmp}' '${path}'`
  );
}

/**
 * One `&&` chain installing the scanner and the gh wrapper, same shape as
 * credentials.ts's studioGitSafetyCmd: base64 -> tmp -> chmod -> mv -f, so a
 * failed step leaves the old file, never a half-written one. Idempotent. The
 * last link confirms a bare `gh` now resolves to the wrapper. The denylist
 * itself is NOT written here: the Worker writes it via writeFile.
 */
export function leakGateInstallCmd(
  opts: { scanPath?: string; ghWrapperPath?: string; realGh?: string; denylistPath?: string; writeProxyMarker?: string } = {},
): string {
  const scan = opts.scanPath ?? LEAK_SCAN_PATH;
  const wrapper = opts.ghWrapperPath ?? STUDIO_GH_WRAPPER_PATH;
  const real = opts.realGh ?? STUDIO_REAL_GH_PATH;
  return (
    `${installStep(scan, leakScanScript(opts.denylistPath ?? LEAK_DENYLIST_PATH))} && ` +
    `${installStep(wrapper, studioGhWrapperScript(real, scan, opts.writeProxyMarker))} && ` +
    `hash -r && ` +
    `[ "$(command -v gh)" = '${wrapper}' ] && ` +
    `chmod 0755 '${real}'`
  );
}

/**
 * Install failed: make gh fail loudly rather than run ungated. The real gh
 * and the wrapper path lose their exec bit; the command fails unless neither
 * is executable afterwards. Only these two paths, never a PATH walk: the
 * image ships gh nowhere else, and a walk would chmod a host's own gh (a CI
 * runner's root-owned /usr/bin/gh, where a non-root chmod fails). A later
 * leakGateInstallCmd rewrites the wrapper (fresh 0755) and restores the real
 * gh only once the wrapper is confirmed.
 */
export function ghBlockCmd(opts: { realGh?: string; ghWrapperPath?: string } = {}): string {
  const real = opts.realGh ?? STUDIO_REAL_GH_PATH;
  const wrapper = opts.ghWrapperPath ?? STUDIO_GH_WRAPPER_PATH;
  return (
    `for g in '${real}' '${wrapper}'; do [ ! -e "$g" ] || chmod a-x "$g"; done; ` +
    `[ ! -x '${real}' ] && [ ! -x '${wrapper}' ]`
  );
}


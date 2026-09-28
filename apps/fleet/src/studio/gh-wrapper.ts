import { LEAK_DENYLIST_PATH, LEAK_SCAN_PATH, leakScanScript } from "../leak-gate";

/**
 * Issue #1: the container `gh` wrapper. Installed at STUDIO_GH_WRAPPER_PATH,
 * ahead of the real gh on PATH, so every gh write a studio makes is scanned
 * by fleet-leak-scan (src/leak-gate.ts) before it can reach GitHub.
 *
 * Gated top-level commands: issue, pr, api, release, gist. Everything else
 * execs the real gh untouched. For a gated call the scanner reads:
 *   - every argv word (titles, bodies, -f/-F values, positional text);
 *   - files named by --body-file, --notes-file, --input, non-api -F, and
 *     api `-F|--field key=@file`; `-` / `@-` = stdin, captured to a temp
 *     file, scanned, then handed to the real gh as its stdin;
 *   - for gist, every argument naming an existing file (gist uploads it).
 * Any scanner non-zero -- hit, no gate file, bad pattern, unreadable file,
 * scanner absent -- refuses with STUDIO_GH_LEAK_REFUSAL. The term is never
 * printed; the scanner names pattern indexes only.
 *
 * Imports only ../leak-gate: the install command is built in the Worker.
 */

export const STUDIO_GH_LEAK_REFUSAL = "fleet: leak gate refused this gh write";
export const STUDIO_REAL_GH_PATH = "/usr/bin/gh";
export const STUDIO_GH_WRAPPER_PATH = "/usr/local/bin/gh";

export function studioGhWrapperScript(realGh = STUDIO_REAL_GH_PATH, scanPath = LEAK_SCAN_PATH): string {
  return [
    `#!/bin/bash`,
    `# fleet: issue #1 leak gate. gh writes are scanned before the real gh runs.`,
    `real='${realGh}'`,
    `scan='${scanPath}'`,
    `refuse() { echo "${STUDIO_GH_LEAK_REFUSAL}" >&2; exit 1; }`,
    `args=("$@")`,
    `n=\${#args[@]}`,
    ``,
    `# Top-level command: first non-flag word. -R/--repo take a value.`,
    `cmd=''`,
    `i=0`,
    `while [ "$i" -lt "$n" ]; do`,
    `  case "\${args[$i]}" in`,
    `    -R|--repo) i=$((i + 1)) ;;`,
    `    -*) ;;`,
    `    *) cmd=\${args[$i]}; break ;;`,
    `  esac`,
    `  i=$((i + 1))`,
    `done`,
    `case "$cmd" in`,
    `  issue|pr|api|release|gist) ;;`,
    `  *) exec "$real" "$@" ;;`,
    `esac`,
    ``,
    `files=()`,
    `stdin=0`,
    `addf() { if [ "$1" = '-' ]; then stdin=1; else files+=("$1"); fi; }`,
    `field() { case "$1" in *=@*) addf "\${1#*=@}" ;; esac; }`,
    `bodyf() { if [ "$cmd" = 'api' ]; then field "$1"; else addf "$1"; fi; }`,
    `i=0`,
    `while [ "$i" -lt "$n" ]; do`,
    `  a=\${args[$i]}`,
    `  v=\${args[$((i + 1))]}`,
    `  case "$a" in`,
    `    --body-file|--notes-file|--input) addf "$v"; i=$((i + 1)) ;;`,
    `    --body-file=*|--notes-file=*|--input=*) addf "\${a#*=}" ;;`,
    `    -F) bodyf "$v"; i=$((i + 1)) ;;`,
    `    -F?*) bodyf "\${a#-F}" ;;`,
    `    --field) field "$v"; i=$((i + 1)) ;;`,
    `    --field=*) field "\${a#--field=}" ;;`,
    `    *)`,
    `      if [ "$cmd" = 'gist' ]; then`,
    `        if [ "$a" = '-' ]; then stdin=1; elif [ -f "$a" ]; then files+=("$a"); fi`,
    `      fi`,
    `      ;;`,
    `  esac`,
    `  i=$((i + 1))`,
    `done`,
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
  opts: { scanPath?: string; ghWrapperPath?: string; realGh?: string; denylistPath?: string } = {},
): string {
  const scan = opts.scanPath ?? LEAK_SCAN_PATH;
  const wrapper = opts.ghWrapperPath ?? STUDIO_GH_WRAPPER_PATH;
  const real = opts.realGh ?? STUDIO_REAL_GH_PATH;
  return (
    `${installStep(scan, leakScanScript(opts.denylistPath ?? LEAK_DENYLIST_PATH))} && ` +
    `${installStep(wrapper, studioGhWrapperScript(real, scan))} && ` +
    `hash -r && ` +
    `[ "$(command -v gh)" = '${wrapper}' ]`
  );
}

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Pull a heredoc body out of shell source. studio-bringup.sh emits its hook
 * scripts as `cat > path <<'MARKER' ... MARKER`; the quoted marker means the
 * body is literal, so what is extracted here is byte-identical to what lands
 * in the container.
 */
export function extractHeredoc(src: string, marker: string): string {
  const open = `<<'${marker}'`;
  const openAt = src.indexOf(open);
  if (openAt === -1) throw new Error(`heredoc opener <<'${marker}' not found in source`);
  const bodyStart = src.indexOf("\n", openAt);
  if (bodyStart === -1) throw new Error(`heredoc <<'${marker}' has no body`);
  const rest = src.slice(bodyStart + 1);
  const lines = rest.split("\n");
  const endIdx = lines.findIndex((l) => l === marker);
  if (endIdx === -1) throw new Error(`heredoc terminator ${marker} not found in source`);
  return lines.slice(0, endIdx).join("\n");
}

/**
 * Pull a shell function definition out of shell source, verbatim. The
 * companion to extractHeredoc for logic that studio-bringup.sh RUNS itself
 * rather than emitting into a file: the function is defined once in the real
 * script and executed here byte-identically, so a test exercises the shipped
 * code rather than a re-typed copy of it.
 *
 * Boundaries are the opener line `<name>() {` and the first later line that
 * is exactly `}` — the closing brace at column 0, which the script's own
 * style guarantees for a top-level function. Nested blocks inside the body
 * are always indented, so they cannot terminate the scan early.
 */
export function extractShellFunc(src: string, name: string): string {
  const open = `${name}() {`;
  const openAt = src.indexOf(open);
  if (openAt === -1) throw new Error(`shell function ${name}() not found in source`);
  const lines = src.slice(openAt).split("\n");
  const endIdx = lines.findIndex((l) => l === "}");
  if (endIdx === -1) throw new Error(`shell function ${name}() has no closing brace at column 0`);
  return lines.slice(0, endIdx + 1).join("\n");
}

const PARENT_SENTINEL = "__PARENT_STILL_ALIVE__";

export interface RunSnippetOpts {
  script: string;
  stdin?: string;
  env?: Record<string, string>;
  shell?: "sh" | "bash" | "dash";
  timeout?: number;
  sourced?: boolean;
}

export interface RunSnippetResult {
  code: number;
  stdout: string;
  stderr: string;
  parentAlive: boolean;
}

/**
 * Run an emitted snippet, then echo a sentinel to detect if the parent shell survived.
 *
 * Two execution modes model our two real contexts:
 *
 * **sourced: false (default)** — Runs snippet as CHILD: `sh path; ... echo SENTINEL; ...`
 * Models hook scripts: claude spawns these as real subprocesses. An `exit` in the child
 * only kills the child; parent continues and sentinel is always printed. This is the
 * faithful model for Task 3's hook scripts.
 *
 * **sourced: true** — Runs snippet via SOURCE: `. path; ... echo SENTINEL; ...`
 * Models sbExec's shared session: commands run inside ONE long-lived container-server shell.
 * An `exit` in sourced code terminates that shell; wrapper never reaches sentinel.
 * This is the faithful model for commands like provisionedCheckCmd that run in sbExec.
 *
 * Picking the wrong mode silently disarms the check. Always use `sourced: true` for
 * sbExec commands, `sourced: false` for spawned subprocesses.
 *
 * `parentAlive` false means the snippet took its parent shell down with it.
 */
export function runSnippet(opts: RunSnippetOpts): RunSnippetResult {
  const dir = mkdtempSync(join(tmpdir(), "fleet-snippet-"));
  try {
    const scriptPath = join(dir, "snippet.sh");
    writeFileSync(scriptPath, opts.script, { mode: 0o755 });
    const shell = opts.shell ?? "sh";
    const sourced = opts.sourced ?? false;
    const cmdPrefix = sourced ? "." : shell;
    const wrapper = `${cmdPrefix} ${JSON.stringify(scriptPath)}; __rc=$?; echo ${PARENT_SENTINEL}; exit $__rc`;
    const proc = Bun.spawnSync({
      cmd: [shell, "-c", wrapper],
      stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
      env: { ...process.env, ...(opts.env ?? {}) },
      stdout: "pipe",
      stderr: "pipe",
      timeout: opts.timeout ?? 10000,
    });
    const stdout = proc.stdout.toString();
    return {
      code: proc.exitCode ?? -1,
      stdout: stdout.replace(PARENT_SENTINEL, "").trimEnd(),
      stderr: proc.stderr.toString(),
      parentAlive: stdout.includes(PARENT_SENTINEL),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

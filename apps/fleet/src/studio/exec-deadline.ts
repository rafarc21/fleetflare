// Issue #104's kill half, kept free of any SDK import so the real-shell
// test (test/bun/exec-deadline.test.ts) can run the exact emitted string
// under bun. sandbox-api.ts's sbExec is the only production caller.

/** SIGKILL follows SIGTERM this many seconds after the deadline (`timeout -k`). */
export const KILL_GRACE_SECONDS = 5;

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The kill half of the deadline: the SDK's own `timeout` option only stops
 * the Worker waiting (the container's COMMAND_TIMEOUT_MS is 0 and nothing
 * kills the process), so the command itself runs under coreutils `timeout`,
 * which signals its whole process group — children included. `bash -c`, not
 * `sh -c`: these commands were written for the session's bash shell, and the
 * image's /bin/sh is dash.
 */
export function withKillDeadline(cmd: string, timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return `timeout -k ${KILL_GRACE_SECONDS} ${seconds} bash -c ${shellQuote(cmd)}`;
}


/**
 * `timeout`'s own exit (124) or a SIGKILL (137 — the `-k` grace, or the
 * kernel OOM killer): the command was stopped, so its output answers
 * nothing. Callers treat it as UNKNOWN, never as a "no" (#110 review).
 */
export function isDeadlineExit(code: number): boolean {
  return code === 124 || code === 137;
}

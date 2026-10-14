type ShResult = { code: number; out: string; err: string };

/** Bun-lane shared `sh()` for suites whose copies were identical modulo
 *  defaults. Git identity env is injected unless `git: false` is passed. */
export function sh(
  cmd: string,
  opts: { cwd?: string; env?: Record<string, string>; git?: boolean; throwOnError?: boolean } = {},
): ShResult {
  const gitEnv = opts.git === false ? {} : {
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  const r = Bun.spawnSync({ cmd: ["bash", "-c", cmd], cwd: opts.cwd, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...gitEnv, ...opts.env } });
  const res = { code: r.exitCode ?? -1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
  if (opts.throwOnError && res.code !== 0) throw new Error(`${cmd}: ${res.err}`);
  return res;
}

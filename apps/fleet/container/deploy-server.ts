/**
 * The deploy container. bun, git, wrangler — no Claude Code, no `claude`
 * binary, no CLAUDE_CODE_OAUTH_TOKEN. This process can only clone a repo and
 * run one command an operator already approved; it cannot reason about what
 * that command should be. See Dockerfile.deploy's own comment and spec §18
 * negative 8.
 */
const PORT = Number(process.env.PORT ?? 8080);
const WORKDIR = "/workspace";

interface DeployState {
  state: "idle" | "running" | "done" | "failed";
  targetId: string | null;
  result: string | null;
  error: string | null;
}

let job: DeployState = { state: "idle", targetId: null, result: null, error: null };

// Secret value(s) for the in-flight (or just-finished) deploy. Task 4's
// lesson was that a URL-shaped pattern can't see a bare token a command
// happened to echo — only matching by exact value can. Replaced wholesale
// at the START of each run(), not cleared at the end: the Worker's poll of
// the FINAL /status (the one whose result/error actually reach Telegram and
// D1, in advanceDeploy) lands AFTER run() returns, so clearing on exit
// would unprotect the exact read that matters most. /run 409s a second call
// while state is "running", so only one deploy runs at a time and replacing
// here can never clobber a different, still-live deploy's secret.
//
// Fix round 2, new Important 1: every write to job.error/job.result now
// calls scrub() itself, BEFORE truncating with slice() — not only at the
// /status boundary as round 1 had it. Truncating first and scrubbing later
// let a secret straddling the cut point survive as an unredacted fragment:
// the full value is no longer present in the truncated text for
// split()/join() to match. container/server.ts's sh() already learned this
// (redactCreds runs before its own .slice(0, 500)); this file's round-1
// redactCreds addition inherited the wrong order silently. scrubbedStatus()
// below still scrubs again at /status — harmless on already-scrubbed text,
// and a backstop for a future write site that forgets to scrub at write
// time, which is the whole reason a shared scrub() exists in one place
// rather than as ad hoc logic per call site.
let secrets: string[] = [];

// Fix round 1, Important 3: container/server.ts deliberately runs BOTH a
// URL-shaped redactCreds AND the value scrub below, because each catches
// what the other cannot. Value scrubbing (below) only redacts a value this
// process already knows — target.token and whatever CLOUDFLARE_DEPLOY_TOKEN
// happens to be. It is blind to a credential embedded in a URL whose value
// this process never learned: a registry token in a repo's own .npmrc that
// `bun install` echoes, a private submodule URL, a nested clone triggered by
// the operator's own command. redactCreds catches those by shape instead.
function redactCreds(s: string): string {
  return s.replace(/(:\/\/[^:@/\s]+:)[^@/\s]+(@)/g, "$1***$2");
}

/** Replace every secret value with a marker — by exact value, not a
 *  URL-shaped pattern. Guarded at >= 8 chars: every real secret here
 *  (a GitHub installation token, CLOUDFLARE_DEPLOY_TOKEN) is far longer, and
 *  the guard stops a pathologically short value from mangling every
 *  occurrence of a common substring in ordinary output. Runs on top of
 *  redactCreds so both layers apply — see redactCreds' own comment. */
function scrub(text: string): string {
  let out = redactCreds(text);
  for (const v of secrets) {
    if (v.length >= 8) out = out.split(v).join("«redacted»");
  }
  return out;
}

function scrubbedStatus(j: DeployState): DeployState {
  return {
    ...j,
    result: j.result === null ? null : scrub(j.result),
    error: j.error === null ? null : scrub(j.error),
  };
}

async function spawnCapture(
  cmd: string[], cwd: string, env: Record<string, string>,
): Promise<{ code: number; err: string }> {
  const p = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  return { code, err };
}

async function run(target: {
  id: string; repo: string; ref: string; workdir: string;
  command: string; secrets: string[]; token: string;
}): Promise<void> {
  // Token first, unconditionally: any exception below this point — even one
  // from Bun.spawn itself (a bad cwd from a mistyped workdir, most
  // realistically) — must still scrub at the /status boundary, and this is
  // the last point before the catch that mutates `secrets`.
  secrets = [target.token];
  // Fix round 1, Important 1: DeployDO.envVars injects CLOUDFLARE_DEPLOY_TOKEN
  // into this whole process unconditionally, so it is always in childEnv
  // below regardless of what the D1 row's `secrets` column names — the
  // brief's own seed row uses `secrets: '[]'`. Scrubbing it only when a row
  // happens to ask for it left it unscrubbed in exactly that common case:
  // any command output containing it (a `set -x`, a build tool dumping env
  // on error) would reach Telegram and D1 unredacted. Scrub it
  // unconditionally, matching how it is unconditionally forwarded.
  if (process.env.CLOUDFLARE_DEPLOY_TOKEN) secrets.push(process.env.CLOUDFLARE_DEPLOY_TOKEN);
  try {
    const childEnv: Record<string, string> = { ...process.env as Record<string, string> };
    for (const name of target.secrets) {
      const v = process.env[name];
      if (!v) {
        job = { ...job, state: "failed", error: `missing secret ${name}` };
        return;
      }
      childEnv[name] = v;
      secrets.push(v);
    }

    const dir = `${WORKDIR}/${target.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const url = `https://x-access-token:${target.token}@github.com/${target.repo}.git`;
    const tokenlessUrl = `https://github.com/${target.repo}.git`;

    const rm = await spawnCapture(["rm", "-rf", dir], WORKDIR, childEnv);
    if (rm.code !== 0) {
      // Fix round 2, new Important 1: scrub BEFORE truncating, not after.
      // slice() at write time used to run on raw text, and scrub() only ran
      // later at the /status boundary — so a secret straddling the cut
      // point survived as an unredacted fragment (the full value is no
      // longer present in the truncated text for split()/join() to match).
      // container/server.ts's sh() already learned this the hard way
      // (redactCreds runs before its own .slice(0, 500)); this file's own
      // redactCreds addition (round 1) inherited the wrong order silently.
      job = { ...job, state: "failed", error: scrub(`rm failed (${rm.code}): ${rm.err}`).slice(0, 2000) };
      return;
    }

    let clone: { code: number; err: string };
    try {
      clone = await spawnCapture(
        ["git", "clone", "--depth", "1", "--branch", target.ref, url, dir], WORKDIR, childEnv,
      );
    } finally {
      // Fix round 1, Important 2: reset the remote to a tokenless URL the
      // instant the clone attempt is over — success or failure — so the
      // operator's own `sh -c command` (below) never runs with a tokenful
      // .git/config sitting in its cwd. A build that bundles the tree, or
      // any tooling that reads remote.origin.url, would otherwise carry the
      // clone token out. In a finally, not a statement placed after the
      // clone, because container/server.ts's mountRepo found live that a
      // reset placed there never runs when the risky step itself fails —
      // the token would then sit at rest for the rest of this run() call.
      // Guarded on the config actually existing (a fully failed clone may
      // leave nothing on disk) and best-effort: this cleanup step's own
      // failure must not mask the clone's real result, checked right below.
      if (await Bun.file(`${dir}/.git/config`).exists()) {
        try {
          await spawnCapture(["git", "remote", "set-url", "origin", tokenlessUrl], dir, childEnv);
        } catch {
          // best-effort; see comment above
        }
      }
    }
    if (clone.code !== 0) {
      // Fix round 2, new Important 1: scrub before truncating — see the
      // comment on the rm failure branch above.
      job = { ...job, state: "failed", error: scrub(`git clone failed (${clone.code}): ${clone.err}`).slice(0, 2000) };
      return;
    }

    const p = Bun.spawn(["sh", "-c", target.command], {
      cwd: `${dir}/${target.workdir}`,
      env: childEnv,
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    // Fix round 2, new Important 1: scrub the full, untruncated output
    // before slicing to the last 2000 chars — same reason as the rm/clone
    // branches above. This is the highest-risk site: arbitrary
    // operator-approved command output, exactly Important 1's (round 1)
    // threat model, and the one most likely to actually be long enough for
    // a straddle to occur in practice.
    const tail = scrub(`${out}\n${err}`).slice(-2000);
    job = code === 0
      ? { ...job, state: "done", result: `exit 0\n${tail}` }
      : { ...job, state: "failed", error: `exit ${code}\n${tail}` };
  } catch (err) {
    // Without this, an uncaught throw (Bun.spawn on a bad cwd/missing
    // binary, a rejected promise anywhere above) leaves `job.state` wedged
    // at "running" forever — nothing else ever sets it to a terminal state.
    // DeployDO's poll loop would then wait out the full maxSeconds budget
    // and report a misleading "aborted: exceeded budget" instead of the
    // real reason. Mirrors container/server.ts's runTask, which wraps its
    // entire body the same way for the same reason.
    job = {
      ...job, state: "failed",
      // Fix round 2, new Important 1: scrub before truncating.
      error: scrub(err instanceof Error ? err.message : String(err)).slice(0, 2000),
    };
  }
}

Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") return Response.json({ ok: true });

    if (url.pathname === "/status") return Response.json(scrubbedStatus(job));

    if (url.pathname === "/run" && req.method === "POST") {
      if (job.state === "running") {
        return Response.json({ error: "a deploy is already running" }, { status: 409 });
      }
      const target = await req.json() as Parameters<typeof run>[0];
      if (!target?.id || !target?.command || !target?.repo || !target?.token) {
        return Response.json({ error: "id, repo, command, token required" }, { status: 400 });
      }
      job = { state: "running", targetId: target.id, result: null, error: null };
      // Deliberately not awaited: the caller gets 202 and DeployDO polls /status.
      void run(target);
      return Response.json({ accepted: true }, { status: 202 });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`deploy container listening on ${PORT}`);

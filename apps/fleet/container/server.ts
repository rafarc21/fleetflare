const PORT = Number(process.env.PORT ?? 8080);
const WORKDIR = process.env.AGENT_WORKDIR ?? "/workspace";

// Measured in a real container: with no --model flag, headless `claude`
// resolved to claude-sonnet-5. The CTO is the agent a human argues with, so
// pin it rather than inheriting whatever the account default happens to be.
const MODEL = process.env.AGENT_MODEL ?? "claude-opus-5";

interface ClaudeResult {
  is_error?: boolean;
  result?: string;
  terminal_reason?: string;
  session_id?: string;
  total_cost_usd?: number;
}

type Proc = ReturnType<typeof Bun.spawn>;

// Day 1's single implementation, widened (cwd/env/onSpawn) so runTask can
// reuse it instead of duplicating the spawn/parse shape. The auth gate was
// never in here — it lived in the deleted ask() — so nothing about the gate
// moves; it stays in runTask, unchanged in shape.
async function runClaude(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; onSpawn?: (p: Proc) => void } = {},
): Promise<{ text: string; raw: ClaudeResult | null; code: number; stderr: string }> {
  const proc = Bun.spawn(["claude", ...args], {
    cwd: opts.cwd ?? WORKDIR,
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  opts.onSpawn?.(proc);
  const [out, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let raw: ClaudeResult | null = null;
  try {
    raw = JSON.parse(out) as ClaudeResult;
  } catch {
    raw = null;
  }
  return { text: raw?.result ?? out.trim(), raw, code, stderr };
}

// --- task state -------------------------------------------------------------

interface Milestone { ts: number; text: string }
interface PendingApproval { action: string; params: Record<string, string> }

// Mirrors src/tasks/types.ts's GATE_ACTIONS and fleet-cli.ts's own copy.
// container/ cannot import across the tsconfig boundary (see the module
// docs above sh()), so this is a third hand-kept copy — keep all three in
// sync. This one is the sole server-side validator: /internal/approval is
// reachable directly (the agent has a shell and can curl it, bypassing
// fleet-cli's client-side check), and loop.ts indexes GATE_LABELS[action]
// unguarded on whatever this route accepts.
const GATE_ACTIONS = ["merge_staging", "deploy_staging", "merge_main", "deploy_prod"];

interface TaskState {
  state: "idle" | "running" | "done" | "failed";
  taskId: string | null;
  milestones: Milestone[];
  pendingApproval: PendingApproval | null;
  result: string | null;
  error: string | null;
  costUsd: number | null;
}

let task: TaskState = {
  state: "idle", taskId: null, milestones: [], pendingApproval: null,
  result: null, error: null, costUsd: null,
};

let current: Proc | null = null;

// Secret value(s) for the in-flight (or just-finished) task, scrubbed out of
// every /status response regardless of which field they surface in — see
// scrub() below. Replaced wholesale at the START of each runTask, not
// cleared at the end: the Worker's poll of a task's FINAL /status (the one
// whose result/error actually reaches Telegram and D1, in advanceTask) lands
// AFTER runTask returns, so clearing on exit would unprotect the exact read
// that matters most. Only one task runs at a time (the /task handler 409s a
// second one while state is "running"), so replacing here can never clobber
// a different, still-live task's secret.
let secrets: string[] = [];

// --- repo mount -------------------------------------------------------------

// mountRepo's clone/fetch/set-url commands embed the per-task GitHub token in
// a URL argv element (https://x-access-token:TOKEN@github.com/...). Verified
// live: on a failed clone, git's own stderr already redacts the URL it prints
// ("fatal: Authentication failed for 'https://github.com/owner/repo.git/'",
// no credential) but our own error message used to echo cmd.join(" ")
// verbatim, token included — and that string becomes task.error, which
// /status exposes straight into the operator's Telegram message and the D1
// event log on failure. Redact both the command and the captured stderr
// before either can reach task.error. Belt and braces alongside the
// value-based scrub() below: this one catches anything URL-shaped, scrub()
// catches an exact token value however it surfaces (e.g. a bare token with
// no URL around it at all, which this can't see).
function redactCreds(s: string): string {
  return s.replace(/(:\/\/[^:@/\s]+:)[^@/\s]+(@)/g, "$1***$2");
}

async function sh(cmd: string[], cwd: string, env?: Record<string, string>): Promise<void> {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) {
    throw new Error(`${redactCreds(cmd.join(" "))} failed (${code}): ${redactCreds(err).slice(0, 500)}`);
  }
}

/**
 * Clone on first use, fetch afterwards. The token is embedded in the remote
 * URL only long enough to authenticate that call. A `finally` around the
 * clone/fetch/checkout resets the remote to a tokenless URL on every exit,
 * not just success: `set-url` (existing-repo branch) writes the token to
 * `<dir>/.git/config` and always succeeds, before the `fetch` that can then
 * fail on its own (expired token, deleted ref, rate limit, network blip) —
 * a statement placed after these calls, rather than in `finally`, would
 * never run on that failure, and verified live it did not: a failed fetch
 * left the token in `.git/config` with no reset until this was a `finally`.
 * The reset is itself guarded: a fresh clone that fails leaves nothing on
 * disk at all (verified live — git cleans up its own partial directory), so
 * `.git/HEAD` existing is checked before attempting it, and the attempt's
 * own failure is swallowed so it cannot mask the error the `finally` is
 * running because of.
 *
 * The checkout deliberately survives between tasks (that's what the
 * `.git/HEAD` check is for: each repo keeps its own directory across
 * tasks), so without this reset the token would sit at rest, readable by
 * any later task's agent that goes looking — not just a task reusing this
 * same repo (whose own mountRepo call overwrites it with a fresh token
 * first anyway), but a later task on a *different* repo, whose agent has
 * full shell access and no reason not to `cat` a sibling directory's
 * `.git/config` under /workspace.
 *
 * Resetting to tokenless does not break the agent's own later git operations
 * (commit/push, run after this function returns): `git config --global
 * credential.helper '!gh auth git-credential'` (set in the Dockerfile) makes
 * git shell out to `gh` for credentials on demand, and `gh` resolves those
 * from GH_TOKEN in its process environment — which runTask sets on the
 * claude child below, so every git subprocess the agent spawns inherits it.
 * Verified live with GIT_TRACE=1: git invokes `gh auth git-credential get`
 * (and `erase` after a bad one) against a real GitHub endpoint with no other
 * setup — no `gh auth login`, nothing on disk.
 *
 * `git remote set-url` with the new token at the top of every task (the
 * `.git/HEAD`-exists branch) keeps a stale hour-old token from being reused
 * after it expires.
 */
async function mountRepo(repo: string, ref: string, ghToken: string): Promise<string> {
  const dir = `${WORKDIR}/${repo.split("/")[1]}`;
  const url = `https://x-access-token:${ghToken}@github.com/${repo}.git`;
  const tokenlessUrl = `https://github.com/${repo}.git`;
  try {
    if (await Bun.file(`${dir}/.git/HEAD`).exists()) {
      await sh(["git", "remote", "set-url", "origin", url], dir);
      await sh(["git", "fetch", "origin", ref], dir);
      await sh(["git", "checkout", "-B", ref, `origin/${ref}`], dir);
    } else {
      await sh(["git", "clone", "--branch", ref, url, dir], WORKDIR);
    }
  } finally {
    if (await Bun.file(`${dir}/.git/HEAD`).exists()) {
      try {
        await sh(["git", "remote", "set-url", "origin", tokenlessUrl], dir);
      } catch {
        // Best-effort: the caller needs to see the original clone/fetch/
        // checkout error (if any), not a failure from this cleanup step.
      }
    }
  }
  // Issue #335 (public-release scrub): FLEET_BOT_NAME/_EMAIL come from
  // do.ts's studioEnvVars (env.FLEET_BOT_NAME/_EMAIL, "" when unset — same
  // "empty and unset identically" shape as TS_AUTHKEY); falsy check (not
  // `??`) so an empty string ALSO falls through to the neutral default.
  await sh(["git", "config", "user.name", process.env.FLEET_BOT_NAME || "fleetflare[bot]"], dir);
  await sh(["git", "config", "user.email",
            process.env.FLEET_BOT_EMAIL || "fleetflare[bot]@users.noreply.github.com"], dir);
  return dir;
}

// --- task execution ---------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are a cloud agent. The repository is cloned in your working directory and",
  "`gh` is authenticated. Report progress with `fleet milestone \"<text>\"` as you go —",
  "it is the operator's only view of what you are doing.",
  "You may commit, push branches and open pull requests.",
  "You must NEVER merge a pull request and NEVER deploy. Those are the operator's,",
  "and requesting one ends your turn:",
  "  fleet request-approval merge_staging --pr <N>",
  "  fleet request-approval deploy_staging --target <id>",
  "  fleet request-approval merge_main --pr <N>",
  "  fleet request-approval deploy_prod --target <id>",
  "After calling request-approval, stop. Do not wait, do not poll, do not continue.",
  "Your memory resets when the container sleeps (20 minutes idle). If asked about a",
  "prior conversation you have no record of, say you cannot know rather than guessing.",
].join(" ");

async function runTask(input: {
  taskId: string; prompt: string; repo: string; ref: string; ghToken: string;
}): Promise<void> {
  secrets = [input.ghToken];
  try {
    const dir = await mountRepo(input.repo, input.ref, input.ghToken);
    task.milestones.push({ ts: Date.now(), text: `mounted ${input.repo}@${input.ref}` });

    // Headless (`-p`) sessions have no TTY, so any Bash/Edit/Write call that
    // would normally prompt for approval has no one to answer it. Verified
    // live in production: the agent could read what mountRepo cloned and
    // nothing else — `git fetch`, `git ls-tree`, and `git grep` all hit the
    // default permission prompt and were denied, three separate times, in
    // the same task.
    //
    // `--dangerously-skip-permissions` (confirmed in Anthropic's docs to be
    // equivalent to `--permission-mode bypassPermissions`) was tried FIRST
    // and rejected on evidence, not preference — HISTORICAL, superseded
    // below: run against this exact pinned image, both spellings refused
    // outright as this container's root user — "--dangerously-skip-permissions
    // cannot be used with root/sudo privileges for security reasons" — with
    // no env var in play at the time.
    //
    // `--allowedTools` is what actually worked headless as this user at that
    // point (tried live, same image, same root user: clean argv parse, no
    // permission prompt, fails only at the expected auth step). Scoped to
    // the four things this agent's job requires — git, gh, bun, and the
    // `fleet` CLI — plus Edit/Write for file changes; Read is already
    // auto-approved by Claude Code's default mode and needs nothing here.
    // Written in the exact pattern form Claude Code's own `--help` documents
    // for this flag ("Bash(git *) Edit"). Known gap, accepted deliberately
    // rather than silently: this does not cover bare filesystem verbs
    // outside those four prefixes (`mkdir`, `mv`, `rm`, `sed`, ...) — a task
    // that needs one hits the same denial this originally closed, for that
    // command. Widen this list (or fall back to `Bash` unscoped, also
    // verified to parse clean as this root user) if that happens; do not
    // chase it preemptively.
    //
    // Operator directive 2026-08-19, on evidence the controller reproduced
    // live: setting `IS_SANDBOX=1` (now baked into this image's Dockerfile —
    // these containers ARE Firecracker microVMs, so the declaration is
    // honest, not a workaround) unlocks `--dangerously-skip-permissions` for
    // this SAME root user on this SAME pinned CLI (2.1.224) — without it,
    // the refusal above; with it, launches, reaches the auth step. So the
    // flag is now passed too. `--allowedTools` stays alongside it, belt and
    // braces: a second, independent restriction that still applies even
    // though skip-permissions no longer needs it to get past the root
    // refusal — the "known gap" note above still holds if skip-permissions
    // is ever removed again.
    //
    // Either way, this does not widen what the container can reach. It is a
    // Firecracker microVM holding a GitHub App installation token that
    // GitHub expires after 1 hour (src/github/app.ts) and that this Worker
    // mints scoped to one installation. It holds no Cloudflare credentials —
    // CLOUDFLARE_DEPLOY_TOKEN exists only in the separate deploy container
    // (Dockerfile.deploy / deploy-server.ts) — and has no network route to
    // it either; AgentDO and DeployDO are separate container classes
    // (wrangler.jsonc) with nothing wiring them together. Merge and deploy
    // are gated by GATE_ACTIONS above and `fleet request-approval`, enforced
    // by the Worker on the operator's side, not by claude's own tool
    // prompts — so bypassing claude's own in-container permission prompts
    // changes nothing about what can reach production without a button
    // press.
    const { text, raw, code, stderr } = await runClaude([
      "-p", input.prompt,
      "--output-format", "json",
      "--effort", "high",
      "--model", MODEL,
      "--append-system-prompt", SYSTEM_PROMPT,
      "--continue",
      "--allowedTools", "Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Edit Write",
      "--dangerously-skip-permissions",
    ], {
      cwd: dir,
      env: { GH_TOKEN: input.ghToken, GITHUB_TOKEN: input.ghToken },
      onSpawn: (p) => { current = p; },
    });
    current = null;

    // Identical gate to Day 1. Exit code alone is not sufficient: a missing
    // credential exits 0 with "Not logged in". Never read `subtype`.
    if (code !== 0 || raw == null || raw.is_error !== false) {
      // `||`, not `??`: out.trim() (folded into `text` by runClaude) is
      // always a string, never nullish, even when empty — `??` would stop
      // there and never reach stderr. When claude dies before emitting JSON
      // (crash, OOM, missing binary) `text` is "" and the real reason is in
      // stderr; `||` is what actually falls through to it.
      const detail = text || stderr || `exit ${code}`;
      const why = raw?.terminal_reason ?? `exit ${code}`;
      task = { ...task, state: "failed", error: `claude failed (${why}): ${detail.slice(0, 500)}` };
      return;
    }

    task = {
      ...task,
      state: "done",
      result: raw.result ?? "",
      costUsd: raw.total_cost_usd ?? null,
    };
  } catch (err) {
    current = null;
    task = { ...task, state: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

// --- status scrubbing --------------------------------------------------------

/**
 * /status is the one place the whole TaskState is serialised, so it is the
 * single boundary to scrub rather than treating every write site (result,
 * error, a milestone, approval params) as its own boundary. redactCreds
 * catches URL-shaped credentials; matching by exact value also catches a
 * bare token with no URL around it at all — `echo $GH_TOKEN`, a pasted
 * `.git/config` line, `git remote -v` — which redactCreds cannot see since
 * it has no URL shape to match against. Both channels are live: the token
 * sits in the claude child's env for the whole task, and briefly in
 * .git/config until mountRepo's post-clone reset.
 */
function scrub(s: string): string {
  return secrets.reduce((acc, t) => (t.length > 0 ? acc.split(t).join("***") : acc), redactCreds(s));
}

function scrubbedStatus(t: TaskState): TaskState {
  const scrubbedParams: Record<string, string> = {};
  if (t.pendingApproval) {
    for (const [k, v] of Object.entries(t.pendingApproval.params)) {
      // Both sides: /internal/approval is reachable directly (the agent has
      // a shell and can curl it, bypassing fleet-cli's fixed-key
      // construction), so a token placed as a key, not just a value, must
      // not reach loop.ts's JSON.stringify(params) unredacted.
      scrubbedParams[scrub(k)] = scrub(v);
    }
  }
  return {
    ...t,
    milestones: t.milestones.map((m) => ({ ...m, text: scrub(m.text) })),
    pendingApproval: t.pendingApproval === null ? null : {
      action: t.pendingApproval.action,
      params: scrubbedParams,
    },
    result: t.result === null ? null : scrub(t.result),
    error: t.error === null ? null : scrub(t.error),
  };
}

Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      // Presence, not validity — an expired or revoked token still reads true here.
      return Response.json({
        ok: true,
        tokenPresent: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
      });
    }

    if (url.pathname === "/task" && req.method === "POST") {
      if (task.state === "running") {
        return Response.json({ error: "a task is already running" }, { status: 409 });
      }
      const input = await req.json() as {
        taskId: string; prompt: string; repo: string; ref: string; ghToken: string;
      };
      if (!input?.taskId || !input?.prompt || !input?.repo || !input?.ref || !input?.ghToken) {
        return Response.json({ error: "taskId, prompt, repo, ref, ghToken required" }, { status: 400 });
      }
      task = {
        state: "running", taskId: input.taskId, milestones: [],
        pendingApproval: null, result: null, error: null, costUsd: null,
      };
      // Deliberately not awaited: the caller gets 202 and the DO polls /status.
      void runTask(input);
      return Response.json({ accepted: true }, { status: 202 });
    }

    if (url.pathname === "/status") {
      return Response.json(scrubbedStatus(task));
    }

    if (url.pathname === "/abort" && req.method === "POST") {
      current?.kill();
      current = null;
      task = { ...task, state: "failed", error: "aborted" };
      return Response.json({ ok: true });
    }

    if (url.pathname === "/internal/milestone" && req.method === "POST") {
      const { text } = await req.json() as { text?: string };
      if (!text) return new Response("text required", { status: 400 });
      task.milestones.push({ ts: Date.now(), text });
      return Response.json({ ok: true });
    }

    if (url.pathname === "/internal/approval" && req.method === "POST") {
      const body = await req.json() as { action?: string; params?: Record<string, string> };
      if (!body?.action || !GATE_ACTIONS.includes(body.action)) {
        return new Response(`action must be one of: ${GATE_ACTIONS.join(", ")}`, { status: 400 });
      }
      task.pendingApproval = { action: body.action, params: body.params ?? {} };
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`agent container listening on ${PORT}`);

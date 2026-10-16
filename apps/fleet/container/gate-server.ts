// apps/fleet/container/gate-server.ts
//
// GateRunnerDO's container-side HTTP server (#715 Phase 1). Self-contained,
// no imports from apps/fleet/src/ — same style container/server.ts already
// uses. A public repo clones anonymously from github.com. A private repo
// (GATE_PRIVATE=1) clones through the Worker git proxy, which holds the read
// grant, so the clone URL carries no credential either way.
//
// Result upload and baseline restore both go through one fixed internal path,
// http://gate-r2.internal/<key>. The request carries a plain R2 key and
// nothing else. The Worker-side outbound handler (Task 16) is what turns it
// into an authorized R2 call before it leaves the Worker's network boundary.
import { resolveMergeTree, type ExecFn } from "./gate-merge-tree";

const PORT = Number(process.env.PORT ?? 8080);
const WORKDIR = "/workspace/repo";
const R2_INTERNAL_BASE = "http://gate-r2.internal";
const GIT_PROXY_BASE = "http://git-proxy.internal";
/** #1080: where a leg's bundle lands before it is fetched into the repo. */
const BUNDLE_PATH = "/workspace/gate.bundle";
/** The one leg that clones, builds the run's bundle and uploads it. Same literal as BUNDLE_LEG in src/gate/leg-env.ts. */
const BUNDLE_LEG = "bundle";

/** #715: a private repo clones through the Worker git proxy (outbound-handler.ts),
 *  which holds the read grant. A public repo clones anonymously from github.com.
 *  Neither URL carries a credential. */
export function cloneUrl(repo: string, privateRepo: boolean): string {
  return privateRepo ? `${GIT_PROXY_BASE}/${repo}.git` : `https://github.com/${repo}.git`;
}

/** Live: vite builds and bun test died with EMFILE (too many open files): the
 *  container's soft open-file limit is low. Every spawned command runs with the
 *  soft limit raised to the hard limit; `exec "$@"` keeps its argv and exit code. */
export function withRaisedFileLimit(cmd: string, args: string[]): string[] {
  return ["bash", "-c", 'ulimit -n "$(ulimit -Hn)" 2>/dev/null; exec "$@"', "gate-exec", cmd, ...args];
}

const exec: ExecFn = async (cmd, args, opts) => {
  const proc = Bun.spawn(withRaisedFileLimit(cmd, args), { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { code, stdout, stderr };
};

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface BaselineDeps {
  fetchFn: FetchFn;
  exec: ExecFn;
  workdir: string;
}

/** One leg's request, read from the container env the Worker set. */
export interface GateRun {
  repo: string; commit: string; leg: string;
  installCmd: string; legCmd: string;
  resultKey: string; baselineKeys: string[];
  /** The PR's base branch name: the stale-base check reads refs/remotes/origin/<baseRef>. */
  baseRef: string;
  /** The PR number: a fork PR's head is fetched from refs/pull/<pr>/head. */
  pr: string;
  /** #715: a private repo clones through the Worker git proxy (GATE_PRIVATE=1). */
  private?: boolean;
  /** #1080: the run's bundle key. A leg reads it instead of cloning; absent means clone. */
  bundleKey?: string;
}

export interface GateDeps {
  exec: ExecFn;
  fetchFn: FetchFn;
  workdir: string;
  /** Backoff between clone attempts; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source for the clone backoff; tests pin it. */
  random?: () => number;
  /** #1080: where the bundle file is written. Tests point it at a scratch dir. */
  bundlePath?: string;
}

/** Live: concurrent legs got HTTP 429 from GitHub on clone. A rate limit or a
 *  5xx is worth another try; anything else (repository not found) is not. */
const TRANSIENT_CLONE = /returned error: (429|5\d\d)\b/;
const CLONE_ATTEMPTS = 5;
/** Live: 9 legs cloning at once got 429 again after 2 s + 4 s. Exponential
 *  from 3 s with ±50% jitter de-syncs the legs: ~3, 6, 12, 24 s (~45 s total). */
const CLONE_BACKOFF_BASE_MS = 3_000;

export interface GateBody {
  state: "success" | "failure" | "error";
  description?: string;
  commit?: string;
  stdout?: string;
  stderr?: string;
  /** "<soft> <hard>" open-file limit the leg ran under (EMFILE triage). */
  limits?: string;
  /** The leg's own test summary line (#1049); absent when its output has none. */
  summary?: string;
}

/** Tail kept of a leg's stdout and stderr in its R2 result. 4000 chars cut
 *  every assertion message of a CF-only failure; 32k keeps them. */
export const OUTPUT_TAIL_CHARS = 32_000;

export function readRunEnv(env: Record<string, string | undefined>): GateRun {
  return {
    repo: env.GATE_REPO ?? "",
    commit: env.GATE_COMMIT ?? "",
    leg: env.GATE_LEG ?? "",
    installCmd: env.GATE_INSTALL_CMD ?? "",
    legCmd: env.GATE_LEG_CMD ?? "",
    resultKey: env.GATE_RESULT_KEY ?? "",
    baselineKeys: (env.GATE_BASELINE_KEYS ?? "").split(",").filter((k) => k.length > 0),
    baseRef: env.GATE_BASE_REF ?? "",
    pr: env.GATE_PR ?? "",
    private: env.GATE_PRIVATE === "1",
    bundleKey: env.GATE_BUNDLE_KEY || undefined,
  };
}

// Snapshot restore (the primary path) happens before this process starts:
// GateRunnerDO boots the container from a snapshot keyed by (main-sha,
// lockfile-hash) when one exists. This is only the fallback for the first PR
// against a new main SHA. The first key that answers and extracts wins; a
// later key is tried only when the earlier one failed.
export async function restoreBaseline(baselineKeys: string[], deps: BaselineDeps): Promise<boolean> {
  const tarPath = `${deps.workdir}/.gate-baseline.tar`;
  for (const key of baselineKeys) {
    try {
      const res = await deps.fetchFn(`${R2_INTERNAL_BASE}/${key}`);
      if (!res.ok) continue;
      await Bun.write(tarPath, await res.arrayBuffer());
      const untar = await deps.exec("tar", ["-xf", tarPath, "-C", deps.workdir], { cwd: deps.workdir });
      if (untar.code === 0) return true;
      console.error("gate-server: baseline extract failed", untar.stderr.split("\n")[0]);
    } catch (err) {
      console.error("gate-server: baseline restore failed", err instanceof Error ? err.message : String(err));
    }
  }
  return false;
}

export async function putResult(key: string, body: unknown, fetchFn: FetchFn = fetch): Promise<void> {
  if (!key) return;
  try {
    const res = await fetchFn(`${R2_INTERNAL_BASE}/${key}`, { method: "PUT", body: JSON.stringify(body) });
    // #1100: a refused PUT (e.g. a key the outbound allow-list rejects) must not vanish silently.
    if (!res.ok) console.error(`gate-server: result PUT ${key} -> ${res.status}`);
  } catch (err) {
    console.error("gate-server: result PUT failed", err instanceof Error ? err.message : String(err));
  }
}

const firstLine = (s: string) => s.split("\n")[0].trim();

const ANSI_CODES = /\x1b\[[0-9;]*[A-Za-z]/g;

/** One leg's test summary, read from its own output (#1049). Pure. vitest's
 *  last "Tests ... (N)" line wins; otherwise bun test's last " N pass" and
 *  " N fail" lines, joined. No match -> undefined. ANSI codes go first. */
export function parseTestSummary(stdout: string, stderr: string): string | undefined {
  const lines = `${stdout}\n${stderr}`.replace(ANSI_CODES, "").split("\n").map((l) => l.trim());
  const lastMatch = (re: RegExp) => [...lines].reverse().find((l) => re.test(l));
  const vitest = lastMatch(/Tests\s+.*\(\d+\)/);
  if (vitest !== undefined) return vitest;
  const parts = [lastMatch(/^\d+ pass$/), lastMatch(/^\d+ fail$/)].filter((p): p is string => p !== undefined);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** Runs one leg and writes its R2 result on every return path, including a
 *  throw: a leg never ends without a result object for the Workflow to read. */
export async function runGate(req: GateRun, deps: GateDeps): Promise<RunOutcome> {
  let body: GateBody;
  try {
    body = await runSteps(req, deps);
  } catch (err) {
    body = { state: "error", description: `gate-server: ${err instanceof Error ? err.message : String(err)}` };
  }
  await putResult(req.resultKey, body, deps.fetchFn);
  return { state: body.state, description: body.description, summary: body.summary };
}

/** #1080: fills `workdir` from the run's bundle. True when the bundle was fetched
 *  into a repo. False (a missing or refused bundle, a bad fetch) means the caller
 *  clones instead, and the bundle path is left empty of the failed attempt. */
async function cloneFromBundle(bundleKey: string, shas: string[], bundlePath: string, deps: GateDeps): Promise<boolean> {
  const { exec: run, workdir } = deps;
  try {
    const res = await deps.fetchFn(`${R2_INTERNAL_BASE}/${bundleKey}`);
    if (!res.ok) return false;
    await Bun.write(bundlePath, await res.arrayBuffer());
  } catch (err) {
    console.error("gate-server: bundle read failed", err instanceof Error ? err.message : String(err));
    return false;
  }
  const init = await run("git", ["init", "--quiet", workdir], { cwd: "/workspace" });
  const fetched = init.code === 0
    ? await run("git", ["fetch", "--quiet", bundlePath, "refs/gate/*:refs/gate/*", "refs/remotes/origin/*:refs/remotes/origin/*"], { cwd: workdir })
    : init;
  // A bundle that unpacked but lacks the base or head commit cannot run the leg: clone instead.
  let complete = fetched.code === 0;
  for (const sha of shas) {
    if (!complete) break;
    complete = (await run("git", ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], { cwd: workdir })).code === 0;
  }
  if (complete) return true;
  console.error("gate-server: bundle unusable, cloning", firstLine(fetched.stderr));
  await run("rm", ["-rf", workdir], { cwd: "/workspace" });
  return false;
}

async function runSteps(req: GateRun, deps: GateDeps): Promise<GateBody> {
  const { exec: run, workdir } = deps;
  const { repo } = req;
  const [base, head] = req.commit.split("..");
  const bundlePath = deps.bundlePath ?? BUNDLE_PATH;
  const isBundleLeg = req.leg === BUNDLE_LEG;

  // Every leg but the bundle leg reads the run's bundle when it exists (#1080):
  // no clone, so no git-proxy burst. A missing bundle falls through to the clone.
  const fromBundle = !isBundleLeg && req.bundleKey !== undefined
    && await cloneFromBundle(req.bundleKey, [base, head], bundlePath, deps);
  if (!fromBundle) {
    // Blobless and without a checkout: commits and trees come down now, file
    // contents only when a step reads them. The bundle leg keeps the blobs, because its bundle must hold them.
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const random = deps.random ?? Math.random;
    const filter = isBundleLeg ? [] : ["--filter=blob:none"];
    const cloneArgs = ["clone", ...filter, "--no-checkout", "--quiet", cloneUrl(repo, req.private === true), workdir];
    let clone = await run("git", cloneArgs, { cwd: "/workspace" });
    for (let attempt = 2; clone.code !== 0 && attempt <= CLONE_ATTEMPTS && TRANSIENT_CLONE.test(clone.stderr); attempt++) {
      // A failed clone can leave a partial directory that the next clone refuses.
      await run("rm", ["-rf", workdir], { cwd: "/workspace" });
      await sleep(CLONE_BACKOFF_BASE_MS * 2 ** (attempt - 2) * (0.5 + random()));
      clone = await run("git", cloneArgs, { cwd: "/workspace" });
    }
    if (clone.code !== 0) return { state: "error", description: `clone failed: ${firstLine(clone.stderr)}` };
  }

  // A fork PR's head is not on any branch of the base repo, so the clone lacks it.
  const headKnown = (await run("git", ["rev-parse", "--verify", "--quiet", `${head}^{commit}`], { cwd: workdir })).code === 0;
  if (!headKnown) {
    const fetched = await run("git", ["fetch", "--quiet", "origin", `+refs/pull/${req.pr}/head`], { cwd: workdir });
    if (fetched.code !== 0) return { state: "error", description: `fetch failed: ${firstLine(fetched.stderr)}` };
  }

  if (isBundleLeg) return buildBundle(req, deps, base, head, bundlePath);

  // Every leg tests the merge result (PR head merged onto its base), not the bare branch.
  const merged = await resolveMergeTree(run, workdir, base, head, req.baseRef);
  if (!merged.ok) {
    if (merged.kind === "conflict") return { state: "failure", description: `merge conflict against ${req.baseRef}` };
    return { state: "error", description: merged.message };
  }
  // A base that moved mid-run is info, not a leg error. The leg still tested the
  // pinned base, so the note names both commits. It only fills a leg with no description.
  const baseNote = merged.baseMoved === undefined
    ? undefined
    : `base moved: origin/${req.baseRef} now ${merged.baseMoved.slice(0, 7)}, tested ${base.slice(0, 7)}`;
  if (req.leg === "merge-tree") return { state: "success", commit: merged.commit, description: baseNote };

  const checkout = await run("git", ["checkout", "--quiet", merged.commit], { cwd: workdir });
  if (checkout.code !== 0) return { state: "error", description: `checkout failed: ${firstLine(checkout.stderr)}` };

  // Restored after checkout: a baseline tar must never block the checkout.
  await restoreBaseline(req.baselineKeys, { fetchFn: deps.fetchFn, exec: run, workdir });

  const limitsRun = await run("bash", ["-c", 'echo "$(ulimit -Sn) $(ulimit -Hn)"'], { cwd: workdir });
  const limits = limitsRun.stdout.trim();
  const install = await run("bash", ["-c", req.installCmd], { cwd: workdir });
  if (install.code !== 0) {
    return {
      state: "error", description: `install failed: ${firstLine(install.stderr)}`,
      stdout: install.stdout.slice(-OUTPUT_TAIL_CHARS), stderr: install.stderr.slice(-OUTPUT_TAIL_CHARS), limits,
    };
  }

  const test = await run("bash", ["-c", req.legCmd], { cwd: workdir });
  const tail = { stdout: test.stdout.slice(-OUTPUT_TAIL_CHARS), stderr: test.stderr.slice(-OUTPUT_TAIL_CHARS), limits };
  const summary = parseTestSummary(test.stdout, test.stderr);
  return test.code === 0
    ? { state: "success", description: baseNote, ...tail, summary }
    : { state: "failure", description: `${req.leg} exited ${test.code}`, ...tail, summary };
}

/** #1080: the bundle leg's work. It pins the base, head and origin base refs
 *  under names the bundle keeps, bundles them (every object they reach), and
 *  uploads the file under the run's bundle key. Any failure is an error result,
 *  and the legs then clone. */
async function buildBundle(
  req: GateRun, deps: GateDeps, base: string, head: string, bundlePath: string,
): Promise<GateBody> {
  const { exec: run, workdir } = deps;
  if (req.bundleKey === undefined) return { state: "error", description: "bundle failed: no bundle key" };
  for (const [name, sha] of [["refs/gate/base", base], ["refs/gate/head", head]] as const) {
    const pinned = await run("git", ["update-ref", name, sha], { cwd: workdir });
    if (pinned.code !== 0) return { state: "error", description: `bundle failed: ${firstLine(pinned.stderr)}` };
  }
  const refs = ["refs/gate/base", "refs/gate/head", `refs/remotes/origin/${req.baseRef}`];
  const created = await run("git", ["bundle", "create", bundlePath, ...refs], { cwd: workdir });
  if (created.code !== 0) return { state: "error", description: `bundle failed: ${firstLine(created.stderr)}` };
  const put = await deps.fetchFn(`${R2_INTERNAL_BASE}/${req.bundleKey}`, {
    method: "PUT", body: await Bun.file(bundlePath).arrayBuffer(),
  }).catch((err: unknown) => err instanceof Error ? err : new Error(String(err)));
  if (put instanceof Error) return { state: "error", description: `bundle failed: ${put.message}` };
  if (!put.ok) return { state: "error", description: `bundle failed: upload HTTP ${put.status}` };
  return { state: "success", description: "bundle built" };
}

export type RunOutcome = { state: GateBody["state"]; description?: string; summary?: string };

/** The container's HTTP surface. One leg per container: POST /run starts it
 *  in the background and answers at once, so no request is held open for the
 *  whole leg. A repeat POST /run never starts a second run (a second clone
 *  would hit the first run's /workspace/repo). GET /result polls the leg:
 *  202 while it runs, 200 with its outcome once it has finished. */
export function createRunServer(env: Record<string, string | undefined>, deps: GateDeps) {
  let outcome: RunOutcome | undefined;
  let started = false;
  const running = () => Response.json({ state: "running" }, { status: 202 });

  return async function handle(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/run" && req.method === "POST") {
      if (!started) {
        started = true;
        void runGate(readRunEnv(env), deps).then((done) => { outcome = done; });
      }
      return outcome ? Response.json(outcome) : running();
    }
    if (pathname === "/result" && req.method === "GET") {
      if (!started) return new Response("no run started", { status: 404 });
      return outcome ? Response.json(outcome) : running();
    }
    return new Response("not found", { status: 404 });
  };
}

// Only when run directly: importing this module (the tests do) must not bind a port.
if (import.meta.main) {
  Bun.serve({ port: PORT, fetch: createRunServer(process.env, { exec, fetchFn: fetch, workdir: WORKDIR }) });
}

// apps/fleet/container/gate-server.ts
//
// GateRunnerDO's container-side HTTP server (#715 Phase 1). Self-contained,
// no imports from apps/fleet/src/ — same style container/server.ts already
// uses. Clones anonymously: the Phase 1 repo is public, so the clone URL
// carries no credential.
//
// Result upload and baseline restore both go through one fixed internal path,
// http://gate-r2.internal/<key>. The request carries a plain R2 key and
// nothing else. The Worker-side outbound handler (Task 16) is what turns it
// into an authorized R2 call before it leaves the Worker's network boundary.
import { resolveMergeTree, type ExecFn } from "./gate-merge-tree";

const PORT = Number(process.env.PORT ?? 8080);
const WORKDIR = "/workspace/repo";
const R2_INTERNAL_BASE = "http://gate-r2.internal";

const exec: ExecFn = async (cmd, args, opts) => {
  const proc = Bun.spawn([cmd, ...args], { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
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
    await fetchFn(`${R2_INTERNAL_BASE}/${key}`, { method: "PUT", body: JSON.stringify(body) });
  } catch (err) {
    console.error("gate-server: result PUT failed", err instanceof Error ? err.message : String(err));
  }
}

async function run(): Promise<{ state: "success" | "failure" | "error"; description?: string }> {
  const repo = process.env.GATE_REPO ?? "";
  const commit = process.env.GATE_COMMIT ?? "";
  const leg = process.env.GATE_LEG ?? "";
  const installCmd = process.env.GATE_INSTALL_CMD ?? "";
  const legCmd = process.env.GATE_LEG_CMD ?? "";
  const resultKey = process.env.GATE_RESULT_KEY ?? "";
  const baselineKeys = (process.env.GATE_BASELINE_KEYS ?? "").split(",").filter((k) => k.length > 0);

  const clone = await exec("git", ["clone", "--quiet", `https://github.com/${repo}.git`, WORKDIR], { cwd: "/workspace" });
  if (clone.code !== 0) return { state: "error", description: `clone failed: ${clone.stderr.split("\n")[0]}` };

  if (leg === "merge-tree") {
    const [base, head] = commit.split("..");
    const result = await resolveMergeTree(exec, WORKDIR, base, head);
    const outcome = result.ok
      ? { state: "success" as const }
      : result.kind === "conflict"
        ? { state: "failure" as const, description: "merge conflict against main" }
        : { state: "error" as const, description: result.message };
    await putResult(resultKey, { ...outcome, commit: result.ok ? result.commit : undefined });
    return outcome;
  }

  await restoreBaseline(baselineKeys, { fetchFn: fetch, exec, workdir: WORKDIR });

  const checkout = await exec("git", ["checkout", "--quiet", commit], { cwd: WORKDIR });
  if (checkout.code !== 0) return { state: "error", description: `checkout failed: ${checkout.stderr.split("\n")[0]}` };

  const install = await exec("bash", ["-c", installCmd], { cwd: WORKDIR });
  if (install.code !== 0) {
    const outcome = { state: "error" as const, description: `install failed: ${install.stderr.split("\n")[0]}` };
    await putResult(resultKey, outcome);
    return outcome;
  }

  const test = await exec("bash", ["-c", legCmd], { cwd: WORKDIR });
  const outcome = test.code === 0
    ? { state: "success" as const }
    : { state: "failure" as const, description: `${leg} exited ${test.code}` };
  await putResult(resultKey, { ...outcome, stdout: test.stdout.slice(-4000), stderr: test.stderr.slice(-4000) });
  return outcome;
}

// Only when run directly: importing this module (the tests do) must not bind a port.
if (import.meta.main) {
  Bun.serve({
    port: PORT,
    async fetch(req) {
      if (new URL(req.url).pathname === "/run" && req.method === "POST") {
        const outcome = await run();
        return Response.json(outcome);
      }
      return new Response("not found", { status: 404 });
    },
  });
}

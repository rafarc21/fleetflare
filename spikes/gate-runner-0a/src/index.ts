// THROWAWAY Task 0a spike. Measures container snapshot restore and fan-out timing
// on a durable_object-policy Container DO. Not production code. Do not merge.
import { DurableObject } from "cloudflare:workers";

// Pinned main SHA baked into the image (see Dockerfile ARG FLEET_SHA). Echoed in responses.
const FLEET_SHA = "3e8ef2ad42a3ef4ce39bf57f167d07141195806d";
const BASELINE_CWD = "/baseline/fleet";
const FIXED_TEST = ["bun", "test", "test/bun/base64.test.ts"];
const INSTANCE = "standard-2" as const;
const MAX_N = 48;
const SNAPSHOT_KEY = "snapshot-id";
const CMD_TIMEOUT_MS = 600_000;
const RUNNING_TIMEOUT_MS = 180_000;
const OUTPUT_TAIL_CHARS = 4000;

export interface Env {
  SPIKE_TOKEN: string;
  GATE_SPIKE: DurableObjectNamespace<GateSpikeDO>;
}

type RunCmd = { exit: number; stdout: string; stderr: string };

type LegResult = {
  leg: number;
  name: string;
  start_ms: number;
  restore_ms?: number;
  cmd_ms?: number;
  exit?: number;
  stdout_tail?: string;
  stderr_tail?: string;
  error?: string;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tail = (s: string, n = OUTPUT_TAIL_CHARS) => (s.length > n ? s.slice(-n) : s);

// Constant-time compare of the x-spike-token header against the SPIKE_TOKEN secret.
function authorized(req: Request, env: Env): boolean {
  const want = env.SPIKE_TOKEN ?? "";
  const got = req.headers.get("x-spike-token") ?? "";
  if (want.length === 0 || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

function parseN(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_N ? n : null;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.SPIKE_TOKEN) return json({ error: "SPIKE_TOKEN secret not set" }, 500);
    if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);

    const url = new URL(req.url);
    const baseline = env.GATE_SPIKE.get(env.GATE_SPIKE.idFromName("baseline"));

    if (req.method === "POST" && url.pathname === "/snapshot") {
      const r = await baseline.fetch("https://do/snapshot", { method: "POST" });
      return new Response(r.body, { status: r.status, headers: r.headers });
    }

    if (req.method === "POST" && url.pathname === "/fanout") {
      const n = parseN(url.searchParams.get("n"));
      if (n === null) return json({ error: `n must be an integer 1..${MAX_N}` }, 400);

      const snap = await baseline.fetch("https://do/snapshot-id");
      if (!snap.ok) return json({ error: "no baseline snapshot; POST /snapshot first" }, 409);
      const { id: snapshotId } = (await snap.json()) as { id: string };

      const runId = crypto.randomUUID().slice(0, 8);
      const t0 = Date.now();
      const settled = await Promise.allSettled(
        Array.from({ length: n }, (_, leg) => {
          const name = `fan-${runId}-${leg}`;
          const stub = env.GATE_SPIKE.get(env.GATE_SPIKE.idFromName(name));
          return stub
            .fetch("https://do/run", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ snapshotId, t0, leg, name }),
            })
            .then((r) => r.json() as Promise<LegResult>);
        }),
      );
      const instances: (LegResult | { leg: number; error: string })[] = settled.map((s, leg) =>
        s.status === "fulfilled" ? s.value : { leg, error: String(s.reason) },
      );
      return json({
        run_id: runId,
        n,
        fleet_sha: FLEET_SHA,
        snapshot_id: snapshotId,
        total_wall_ms: Date.now() - t0,
        instances,
      });
    }

    if (req.method === "GET" && url.pathname === "/probe") {
      const runId = crypto.randomUUID().slice(0, 8);
      const stub = env.GATE_SPIKE.get(env.GATE_SPIKE.idFromName(`probe-${runId}`));
      const r = await stub.fetch("https://do/probe", { method: "POST" });
      return new Response(r.body, { status: r.status, headers: r.headers });
    }

    return json({ error: "not found" }, 404);
  },
};

export class GateSpikeDO extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const c = this.ctx.container;
    if (!c) return json({ error: "ctx.container missing: class not on durable_object policy" }, 500);
    const { pathname } = new URL(req.url);

    try {
      if (pathname === "/snapshot") return json(await this.snapshot());
      if (pathname === "/snapshot-id") {
        const id = await this.ctx.storage.get<string>(SNAPSHOT_KEY);
        return id ? json({ id }) : json({ error: "no snapshot" }, 404);
      }
      if (pathname === "/run") return json(await this.run(await req.json()));
      if (pathname === "/probe") return json(await this.probe());
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  private async snapshot() {
    const c = this.ctx.container!;
    const image = c.images?.baseline;
    if (!image) throw new Error("no images.baseline in wrangler containers config");

    const t0 = Date.now();
    c.start({ image, enableInternet: false, instance: INSTANCE });
    await waitRunning(c);
    const boot_ms = Date.now() - t0;

    const bun = await runCmd(c, ["bun", "--version"]);

    const t1 = Date.now();
    const snap = await c.snapshotContainer({ name: `baseline-${FLEET_SHA.slice(0, 12)}` });
    const snapshot_ms = Date.now() - t1;
    await this.ctx.storage.put(SNAPSHOT_KEY, snap.id);

    // Baseline is only a source for restores; stop it so it stops billing.
    await c.destroy().catch(() => {});

    return {
      snapshot_id: snap.id,
      snapshot_size: snap.size,
      boot_ms,
      snapshot_ms,
      bun_version: bun.stdout.trim(),
      fleet_sha: FLEET_SHA,
    };
  }

  private async run(body: { snapshotId: string; t0: number; leg: number; name: string }): Promise<LegResult> {
    const c = this.ctx.container!;
    // start_ms: Worker dispatch -> this DO's handler entry (DO activation latency).
    const result: LegResult = { leg: body.leg, name: body.name, start_ms: Date.now() - body.t0 };
    try {
      const t1 = Date.now();
      c.start({ containerSnapshot: { id: body.snapshotId }, enableInternet: false, instance: INSTANCE });
      await waitRunning(c);
      result.restore_ms = Date.now() - t1;

      const t2 = Date.now();
      const out = await runCmd(c, FIXED_TEST, BASELINE_CWD);
      result.cmd_ms = Date.now() - t2;
      result.exit = out.exit;
      result.stdout_tail = tail(out.stdout);
      result.stderr_tail = tail(out.stderr);
    } catch (e) {
      result.error = String(e);
    } finally {
      await c.destroy().catch(() => {});
    }
    return result;
  }

  private async probe() {
    const c = this.ctx.container!;
    const image = c.images?.baseline;
    if (!image) throw new Error("no images.baseline in wrangler containers config");
    c.start({ image, enableInternet: false, instance: INSTANCE });
    await waitRunning(c);

    const cmds = [
      ["unshare", "-r", "true"],
      ["nproc"],
      ["free", "-m"],
      ["df", "-h"],
      ["docker", "info"],
    ];
    const results: { cmd: string; exit?: number; stdout?: string; stderr?: string; error?: string }[] = [];
    try {
      for (const cmd of cmds) {
        try {
          const o = await runCmd(c, cmd, undefined, Infinity);
          results.push({ cmd: cmd.join(" "), exit: o.exit, stdout: o.stdout, stderr: o.stderr });
        } catch (e) {
          results.push({ cmd: cmd.join(" "), error: String(e) });
        }
      }
    } finally {
      await c.destroy().catch(() => {});
    }
    return { results };
  }
}

async function waitRunning(c: Container, timeoutMs = RUNNING_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!c.running) {
    if (Date.now() > deadline) throw new Error(`container not running within ${timeoutMs}ms`);
    await sleep(250);
  }
}

async function runCmd(c: Container, cmd: string[], cwd?: string, keep = OUTPUT_TAIL_CHARS): Promise<RunCmd> {
  const p = await c.exec(cmd, { cwd, signal: AbortSignal.timeout(CMD_TIMEOUT_MS) });
  const o = await p.output();
  const dec = new TextDecoder();
  const stdout = dec.decode(o.stdout);
  const stderr = dec.decode(o.stderr);
  return {
    exit: o.exitCode,
    stdout: keep === Infinity ? stdout : tail(stdout, keep),
    stderr: keep === Infinity ? stderr : tail(stderr, keep),
  };
}

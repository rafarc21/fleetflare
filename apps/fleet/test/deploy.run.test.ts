import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  advanceDeploy, runDeploy, pollDeployOnce,
  type DeployJob, type DeployStatus, type DeployDeps, type DeployPoll, type RunDeployDeps,
} from "../src/deploy/do";
import { readSince } from "../src/events/log";
import type { DeployTarget } from "../src/deploy/targets";

let calls: { url: string; body: any }[] = [];
let realFetch: typeof globalThis.fetch;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM events").run();
  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    calls.push({
      url: typeof input === "string" ? input : input.url,
      body: JSON.parse(init.body as string),
    });
    return Response.json({ ok: true, result: { message_id: 700 + calls.length } });
  }) as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

const job = (over: Partial<DeployJob> = {}): DeployJob => ({
  targetId: "websites:beta:staging",
  project: "websites",
  chatId: "100000001",
  startedTs: 1000,
  failedPolls: 0,
  ...over,
});

const deps = (over: Partial<DeployDeps> = {}): DeployDeps => ({
  db: env.DB,
  botToken: "T",
  now: 2000,
  maxSeconds: 1800,
  maxFailedPolls: 3,
  ...over,
});

const status = (over: Partial<DeployStatus> = {}): DeployStatus => ({
  state: "running",
  targetId: "websites:beta:staging",
  result: null,
  error: null,
  ...over,
});

/** Fix round 1, Important 4: advanceDeploy now takes the ALREADY-ATTEMPTED
 *  status fetch (ok or failed) rather than a bare DeployStatus, so the
 *  "container unreachable" counting/threshold/terminal logic lives here,
 *  testable, instead of DeployDO.pollDeploy's untestable catch block. */
const ok = (over: Partial<DeployStatus> = {}): DeployPoll => ({ ok: true, status: status(over) });
const failed = (error: unknown = new Error("boom")): DeployPoll => ({ ok: false, error });

describe("advanceDeploy", () => {
  it("keeps polling while running and inside budget, with no Telegram call", async () => {
    const out = await advanceDeploy(deps(), job(), ok({ state: "running" }));
    expect(out.done).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await readSince(env.DB, "human", 0)).toHaveLength(0);
  });

  it("reports success as one report event and one Telegram message", async () => {
    const out = await advanceDeploy(
      deps(),
      job(),
      ok({ state: "done", result: "exit 0\nbuilt and deployed" }),
    );
    expect(out.done).toBe(true);

    const events = await readSince(env.DB, "human", 0);
    expect(events).toHaveLength(1);
    expect(events[0].from).toBe("deploy");
    expect(events[0].kind).toBe("report");
    expect(events[0].body).toMatch(/succeeded/);
    expect(events[0].body).toContain("built and deployed");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/sendMessage");
    expect(calls[0].body.text).toMatch(/succeeded/);
  });

  it("carries the failure text to both the event and the Telegram message", async () => {
    const out = await advanceDeploy(
      deps(),
      job(),
      ok({ state: "failed", error: "exit 1\nwrangler deploy failed" }),
    );
    expect(out.done).toBe(true);

    const events = await readSince(env.DB, "human", 0);
    expect(events).toHaveLength(1);
    expect(events[0].body).toMatch(/FAILED/);
    expect(events[0].body).toContain("wrangler deploy failed");

    expect(calls).toHaveLength(1);
    expect(calls[0].body.text).toContain("wrangler deploy failed");
  });

  it("treats a deploy still running past maxSeconds as terminal with honest wording", async () => {
    // Fix round 1, Important 5: the operator must not be told the deploy was
    // "aborted" — nothing kills the container's command (no /abort route,
    // deliberately not added). Say what actually happened instead.
    const out = await advanceDeploy(
      deps({ now: 1000 + 1800 * 1000 + 1 }),
      job({ startedTs: 1000 }),
      ok({ state: "running" }),
    );
    expect(out.done).toBe(true);

    const events = await readSince(env.DB, "human", 0);
    expect(events).toHaveLength(1);
    expect(events[0].body).toMatch(/budget/i);
    expect(events[0].body).toMatch(/1800s/);
    // Must NOT claim an action that did not happen.
    expect(events[0].body).not.toMatch(/aborted/i);
    // Must be honest that the command may still be running and its outcome
    // will not be reported.
    expect(events[0].body).toMatch(/may still be running/i);
    expect(events[0].body).toMatch(/will not be reported/i);

    expect(calls).toHaveLength(1);
    expect(calls[0].body.text).not.toMatch(/aborted/i);
  });

  it("is exclusive at exactly the budget threshold", async () => {
    // Same boundary-exactness discipline as staleTasks (tasks/watchdog.ts):
    // pins > vs >= so a mutation that swaps them is actually caught, unlike
    // a fixture that is 1ms over, which is true under either operator.
    const atThreshold = await advanceDeploy(
      deps({ now: 1000 + 1800 * 1000 }),
      job({ startedTs: 1000 }),
      ok({ state: "running" }),
    );
    expect(atThreshold.done).toBe(false);

    const justOver = await advanceDeploy(
      deps({ now: 1000 + 1800 * 1000 + 1 }),
      job({ startedTs: 1000 }),
      ok({ state: "running" }),
    );
    expect(justOver.done).toBe(true);
  });

  it("does not crash the poll cycle when the Telegram notification itself fails", async () => {
    // Same always-fail-open reasoning as terminalMessage in tasks/loop.ts:
    // the report event is already committed, so a Telegram delivery failure
    // must not throw out of advanceDeploy.
    globalThis.fetch = (async () => Response.json({ ok: false, description: "blocked" })) as typeof globalThis.fetch;
    const out = await advanceDeploy(deps(), job(), ok({ state: "done", result: "ok" }));
    expect(out.done).toBe(true);
    expect(await readSince(env.DB, "human", 0)).toHaveLength(1);
  });

  it("resets failedPolls to 0 on any successful status read", async () => {
    const out = await advanceDeploy(deps(), job({ failedPolls: 2 }), ok({ state: "running" }));
    expect(out.job.failedPolls).toBe(0);
  });

  describe("container unreachable (Fix round 1, Important 4)", () => {
    // Before this fix, DeployDO.pollDeploy's own catch around containerFetch
    // rescheduled unconditionally forever — no counter, no budget check
    // reachable (advanceDeploy is never even called on that path), and
    // renewActivityTimeout() ran before the try — so an unreachable
    // container becomes a permanent 10s loop that re-cold-starts it every
    // tick and never tells the operator anything. Same wedge class f970d85
    // fixed for AgentDO via MAX_FAILED_POLLS/shouldAbortOnTerminal.

    it("below the threshold: keeps polling, logs a self-addressed report, no Telegram noise", async () => {
      const out = await advanceDeploy(deps(), job({ failedPolls: 0 }), failed(new Error("container unreachable")));
      expect(out.done).toBe(false);
      expect(out.job.failedPolls).toBe(1);
      expect(calls).toHaveLength(0); // no operator-facing message for a single blip

      const selfReports = await readSince(env.DB, "deploy", 0);
      expect(selfReports).toHaveLength(1);
      expect(selfReports[0].body).toMatch(/poll 1\/3 failed/);
      expect(selfReports[0].body).toMatch(/container unreachable/);
    });

    it("at the threshold: gives up, tells the operator honestly, and stops (no /abort claim)", async () => {
      const out = await advanceDeploy(deps(), job({ failedPolls: 2 }), failed(new Error("connection refused")));
      expect(out.done).toBe(true);
      expect(out.job.failedPolls).toBe(3);

      const events = await readSince(env.DB, "human", 0);
      expect(events).toHaveLength(1);
      expect(events[0].from).toBe("deploy");
      expect(events[0].body).toMatch(/unreachable after 3 polls/);
      expect(events[0].body).toMatch(/connection refused/);
      // Same honesty bar as the budget path: no claim that anything was
      // stopped, since there is no way to reach the container to stop it.
      expect(events[0].body).not.toMatch(/aborted/i);
      expect(events[0].body).toMatch(/will not be reported/i);

      expect(calls).toHaveLength(1);
      expect(calls[0].body.text).toMatch(/unreachable after 3 polls/);
    });

    it("is exclusive at exactly the failure threshold", async () => {
      const below = await advanceDeploy(deps({ maxFailedPolls: 3 }), job({ failedPolls: 1 }), failed());
      expect(below.done).toBe(false); // 2nd failure, 2 < 3

      const at = await advanceDeploy(deps({ maxFailedPolls: 3 }), job({ failedPolls: 2 }), failed());
      expect(at.done).toBe(true); // 3rd failure, 3 >= 3
    });

    it("does not crash when the failure has no .message (a non-Error thrown value)", async () => {
      const out = await advanceDeploy(deps(), job({ failedPolls: 2 }), failed("a plain string rejection"));
      expect(out.done).toBe(true);
      const events = await readSince(env.DB, "human", 0);
      expect(events[0].body).toContain("a plain string rejection");
    });
  });
});

// Fix round 2, new Important 2: pollDeploy's own try/catch only boxed the
// containerFetch/.json() attempt into a DeployPoll — the `await
// advanceDeploy(...)` call itself was unwrapped. advanceDeploy calls
// appendEvent unguarded on two paths (the below-threshold self-report, and
// terminalReport, which every terminal branch goes through), a real D1
// write that can reject. An uncaught throw there leaves pollDeploy uncaught
// entirely: the Container library's alarm() deletes the firing schedule row
// UNCONDITIONALLY whether the callback threw or not, so nothing reschedules,
// JOB_KEY is never cleared, and the deploy is wedged forever with the
// operator never told — the exact class f970d85 fixed for AgentDO via
// pollOnce, which wraps the WHOLE advance() call for precisely this reason.
// pollDeployOnce is the identical extraction: DeployDO.pollDeploy is reduced
// to attempting the containerFetch and calling this, which cannot itself be
// constructed under vitest-pool-workers, so this is the seam.
describe("pollDeployOnce (fix round 2, new Important 2)", () => {
  it("passes a continuing outcome through unchanged", async () => {
    const result = await pollDeployOnce(deps(), job(), ok({ state: "running" }));
    expect(result.kind).toBe("continue");
  });

  it("still reaches terminal normally when advanceDeploy resolves done", async () => {
    const result = await pollDeployOnce(deps(), job(), ok({ state: "done", result: "ok" }));
    expect(result.kind).toBe("terminal");
  });

  it("converts an advanceDeploy throw into kind:'error' with the pre-poll job, instead of propagating it", async () => {
    // Simulated via the injected `advance` param, mirroring
    // test/agents.do.test.ts's identical pollOnce test — forcing one of
    // advanceDeploy's own appendEvent call sites to throw specifically is
    // covered by the next test instead, against the real function.
    const boom = async (): Promise<{ done: boolean; job: DeployJob }> => {
      throw new Error("D1 write failed");
    };
    const original = job({ failedPolls: 1 });

    const result = await pollDeployOnce(deps(), original, ok({ state: "running" }), boom);

    expect(result.kind).toBe("error");
    // The pre-poll job coming back unchanged — not the throw propagating
    // uncaught — is what stops the wedge: DeployDO.pollDeploy persists this
    // and reschedules on any non-terminal kind, same as AgentDO's pollTask.
    expect(result.job).toEqual(original);
  });

  it("does not wedge when advanceDeploy's own appendEvent write genuinely fails", async () => {
    // Against the REAL advanceDeploy (no injected stand-in), poisoning only
    // the events INSERT so every other D1 statement still hits the real
    // test database — same technique as
    // test/approvals.gates.test.ts's "does not tell the operator a merge
    // failed when only finishApproval(executed) throws".
    const realPrepare = env.DB.prepare.bind(env.DB);
    const poisonedDb = {
      prepare(sql: string) {
        if (sql.startsWith("INSERT INTO events")) {
          return { bind: () => ({ run: async () => { throw new Error("D1 write failed"); } }) };
        }
        return realPrepare(sql);
      },
    } as unknown as D1Database;

    const original = job({ failedPolls: 0 });
    const result = await pollDeployOnce(deps({ db: poisonedDb }), original, ok({ state: "done", result: "ok" }));

    expect(result.kind).toBe("error");
    expect(result.job).toEqual(original);
    // No Telegram call either: advanceDeploy never got past the poisoned
    // appendEvent to reach sendCard.
    expect(calls).toHaveLength(0);
  });

  it("does not wedge when the below-threshold self-report's appendEvent fails", async () => {
    // Distinct code path from the test above: this one goes through the
    // failedPolls < maxFailedPolls branch, not terminalReport.
    const realPrepare = env.DB.prepare.bind(env.DB);
    const poisonedDb = {
      prepare(sql: string) {
        if (sql.startsWith("INSERT INTO events")) {
          return { bind: () => ({ run: async () => { throw new Error("D1 write failed"); } }) };
        }
        return realPrepare(sql);
      },
    } as unknown as D1Database;

    const original = job({ failedPolls: 0 });
    const result = await pollDeployOnce(deps({ db: poisonedDb }), original, failed(new Error("container unreachable")));

    expect(result.kind).toBe("error");
    expect(result.job).toEqual(original);
  });
});

describe("runDeploy", () => {
  const target: DeployTarget = {
    id: "websites:beta:staging",
    project: "websites",
    repo: "acme-org/websites",
    ref: "staging",
    workdir: "sites/beta",
    command: "bun install && bun run build",
    secrets: ["CLOUDFLARE_DEPLOY_TOKEN"],
    env: "staging",
  };

  function fakeDeploy(
    fetchImpl: (input: string, init?: RequestInit) => Promise<Response> | Response,
    onName?: (name: string) => void,
  ): RunDeployDeps["deploy"] {
    return {
      idFromName: (n: string) => { onName?.(n); return n; },
      get: () => ({ fetch: fetchImpl }),
    } as unknown as RunDeployDeps["deploy"];
  }

  it("posts the target plus chatId and token, and namespaces the DO by target id", async () => {
    let seenUrl = "";
    let seenBody: any;
    let seenName = "";
    const deploy = fakeDeploy((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(init!.body as string);
      return Response.json({ started: target.id });
    }, (n) => { seenName = n; });

    const result = await runDeploy({ deploy, chatId: "100000001", token: "ghs_test" }, target);

    expect(result).toBe(`deploy ${target.id} started`);
    expect(seenName).toBe(target.id);
    expect(seenUrl).toBe("https://deploy/run");
    expect(seenBody).toMatchObject({
      id: target.id,
      repo: target.repo,
      ref: target.ref,
      workdir: target.workdir,
      command: target.command,
      secrets: target.secrets,
      chatId: "100000001",
      token: "ghs_test",
    });
  });

  it("throws with the container's own refusal reason on a non-2xx", async () => {
    const deploy = fakeDeploy(() => new Response("a deploy is already running", { status: 409 }));
    await expect(
      runDeploy({ deploy, chatId: "100000001", token: "ghs_test" }, target),
    ).rejects.toThrow(/refused \(409\).*already running/s);
  });
});

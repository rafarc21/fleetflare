import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { handleCallbackQuery, makeExecutor, type GateExecutor } from "../src/approvals/gates";
import { createApproval, getApproval } from "../src/approvals/store";
import { readSince } from "../src/events/log";
import type { Env } from "../src/env";

const OPERATOR = 100000001;
let calls: { url: string; body: any }[] = [];
let executed: { action: string; params: Record<string, string> }[] = [];
let realFetch: typeof globalThis.fetch;

const executor: GateExecutor = async (action, params) => {
  executed.push({ action, params });
  return "merged abc12345";
};
const boomExecutor: GateExecutor = async () => {
  throw new Error("Pull Request is not mergeable");
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM approvals").run();
  await env.DB.prepare("DELETE FROM events").run();
  calls = []; executed = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    calls.push({
      url: typeof input === "string" ? input : input.url,
      body: JSON.parse(init.body as string),
    });
    return Response.json({ ok: true, result: { message_id: 900 } });
  }) as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

async function seed(id = "appr_1") {
  await createApproval(env.DB, {
    id, eventId: "evt_1", project: "websites", action: "merge_staging",
    params: { repo: "o/r", pr: "7" }, chatId: String(OPERATOR),
  }, 1000);
  await env.DB.prepare("UPDATE approvals SET message_id = 77 WHERE id = ?").bind(id).run();
}

const cq = (over: any = {}) => ({
  id: "cbq1", from: { id: OPERATOR }, data: "appr_1:yes",
  message: { message_id: 77, chat: { id: OPERATOR } },
  ...over,
});

describe("handleCallbackQuery", () => {
  it("rejects a callback from a non-operator id and executes nothing", async () => {
    await seed();
    await handleCallbackQuery(env, cq({ from: { id: 999999 } }), executor, 2000);
    expect(executed).toEqual([]);
    expect((await getApproval(env.DB, "appr_1"))?.state).toBe("pending");
    expect(calls.every((c) => c.url.includes("answerCallbackQuery"))).toBe(true);
  });

  it("is the only writer of an approval event", async () => {
    await seed();
    await handleCallbackQuery(env, cq({ from: { id: 999999 } }), executor, 2000);
    const all = await readSince(env.DB, "cto", 0);
    expect(all.filter((e) => e.kind === "approval")).toEqual([]);
    await handleCallbackQuery(env, cq(), executor, 2000);
    const after = await readSince(env.DB, "cto", 0);
    expect(after.filter((e) => e.kind === "approval")).toHaveLength(1);
  });

  it("approves, executes once, and strips the keyboard", async () => {
    await seed();
    await handleCallbackQuery(env, cq(), executor, 2000);
    expect(executed).toEqual([{ action: "merge_staging", params: { repo: "o/r", pr: "7" } }]);
    const row = await getApproval(env.DB, "appr_1");
    expect(row?.state).toBe("executed");
    expect(row?.result).toBe("merged abc12345");
    const edit = calls.find((c) => c.url.includes("editMessageText"))!;
    expect(edit.body.message_id).toBe(77);
    expect(edit.body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("keeps an executed outcome when the success notification itself fails", async () => {
    // The "done" sendCard after a successful execute can throw on its own
    // (telegram/api.ts's call() throws on !res.ok or a body ok !== true).
    // Regression coverage for a real bug: left unguarded, that throw used to
    // fall into handleCallbackQuery's outer catch, which re-runs
    // finishApproval with "failed" and the NOTIFICATION's message —
    // overwriting a merge that genuinely succeeded. Only the final "done"
    // sendMessage fails here; the CAS ack and the keyboard-strip edit above
    // it still succeed.
    await seed();
    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({ url, body: JSON.parse(init.body as string) });
      if (url.includes("/sendMessage")) {
        return Response.json({ ok: false, description: "bot was blocked by the user" });
      }
      return Response.json({ ok: true, result: { message_id: 900 } });
    }) as typeof globalThis.fetch;

    await handleCallbackQuery(env, cq(), executor, 2000);

    expect(executed).toEqual([{ action: "merge_staging", params: { repo: "o/r", pr: "7" } }]);
    const row = await getApproval(env.DB, "appr_1");
    expect(row?.state).toBe("executed");
    expect(row?.result).toBe("merged abc12345");
    const sent = calls.find((c) => c.url.includes("/sendMessage"));
    expect(sent?.body.text).toMatch(/done/);
  });

  it("does not tell the operator a merge failed when only finishApproval(executed) throws", async () => {
    // Review round 1, Important 1: execute() succeeding is a real-world
    // side effect (a merge lands on GitHub) that already happened. Guarding
    // the notification wasn't enough — finishApproval(..., "executed", ...)
    // itself throwing (a transient D1 error) fell into the very same outer
    // catch and got reported to the operator as "FAILED", with the D1
    // error's text, for a PR that is merged. Poisons only that one UPDATE;
    // getApproval/decideApproval/appendEvent (seed, the CAS, the event log)
    // still hit the real DB.
    await seed();
    const realPrepare = env.DB.prepare.bind(env.DB);
    const poisonedDb = {
      prepare(sql: string) {
        if (sql.startsWith("UPDATE approvals SET state = ?, result = ?")) {
          return { bind: () => ({ run: async () => { throw new Error("D1 write failed"); } }) };
        }
        return realPrepare(sql);
      },
    } as unknown as D1Database;

    await handleCallbackQuery({ ...env, DB: poisonedDb }, cq(), executor, 2000);

    expect(executed).toEqual([{ action: "merge_staging", params: { repo: "o/r", pr: "7" } }]);
    const failedNotice = calls.find((c) => /FAILED/.test(c.body?.text ?? ""));
    expect(failedNotice).toBeUndefined();
    const doneNotice = calls.find(
      (c) => c.url.includes("/sendMessage") && /done/.test(c.body?.text ?? ""),
    );
    expect(doneNotice).toBeDefined();
  });

  it("still reaches execute() when the approval event's appendEvent throws (MUST FIX 3)", async () => {
    // :80. Left as a bare await, this used to mean a transient D1 error
    // writing the "approval" event stopped handleCallbackQuery before it
    // ever reached execute() — a decision the CAS above already committed
    // as "approved" that then never executes and never tells anyone why.
    await seed();
    const realPrepare = env.DB.prepare.bind(env.DB);
    const poisonedDb = {
      prepare(sql: string) {
        if (sql.startsWith("INSERT INTO events")) {
          return { bind: () => ({ run: async () => { throw new Error("D1 write failed"); } }) };
        }
        return realPrepare(sql);
      },
    } as unknown as D1Database;

    await handleCallbackQuery({ ...env, DB: poisonedDb }, cq(), executor, 2000);

    expect(executed).toEqual([{ action: "merge_staging", params: { repo: "o/r", pr: "7" } }]);
    const row = await getApproval(env.DB, "appr_1");
    expect(row?.state).toBe("executed");
  });

  it("still notifies the operator when finishApproval(failed) itself throws (MUST FIX 3)", async () => {
    // :122, on the executor-throws branch. Left as a bare await, a D1 error
    // recording "failed" used to skip the FAILED sendCard entirely — a
    // genuine merge failure reported to nobody, with Telegram's own retry
    // pre-suppressed by the callback_query dedupe marker
    // (telegram/webhook.ts:61), so nothing would ever prompt a second try.
    await seed();
    const realPrepare = env.DB.prepare.bind(env.DB);
    const poisonedDb = {
      prepare(sql: string) {
        if (sql.startsWith("UPDATE approvals SET state = ?, result = ?")) {
          return { bind: () => ({ run: async () => { throw new Error("D1 write failed"); } }) };
        }
        return realPrepare(sql);
      },
    } as unknown as D1Database;

    await handleCallbackQuery({ ...env, DB: poisonedDb }, cq(), boomExecutor, 2000);

    const failedNotice = calls.find((c) => /FAILED/.test(c.body?.text ?? ""));
    expect(failedNotice).toBeDefined();
    expect(failedNotice?.body.text).toMatch(/not mergeable/);
  });

  it("completes the decision end to end when answerCallbackQuery itself fails", async () => {
    await seed();
    // The success ack (no text, right after the CAS) exists only to stop the
    // tapping device's spinner. A 429, a 5xx, or Telegram's own very common
    // {ok:false, "query is too old..."} must not unwind a decision the CAS
    // already committed: log to D1 before notifying Telegram, and a failed
    // notification must never undo a logged event.
    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({ url, body: JSON.parse(init.body as string) });
      if (url.includes("answerCallbackQuery")) {
        return Response.json({
          ok: false,
          description: "query is too old and response timeout expired or query id is invalid",
        });
      }
      return Response.json({ ok: true, result: { message_id: 900 } });
    }) as typeof globalThis.fetch;

    await handleCallbackQuery(env, cq(), executor, 2000);

    expect(executed).toEqual([{ action: "merge_staging", params: { repo: "o/r", pr: "7" } }]);
    const row = await getApproval(env.DB, "appr_1");
    expect(row?.state).toBe("executed");
    const events = await readSince(env.DB, "cto", 0);
    expect(events.some((e) => e.kind === "approval")).toBe(true);
    const edit = calls.find((c) => c.url.includes("editMessageText"));
    expect(edit?.body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("ignores a second tap", async () => {
    await seed();
    await handleCallbackQuery(env, cq(), executor, 2000);
    calls = [];
    await handleCallbackQuery(env, cq({ id: "cbq2" }), executor, 3000);
    expect(executed).toHaveLength(1);
    const answer = calls.find((c) => c.url.includes("answerCallbackQuery"))!;
    expect(answer.body.text).toMatch(/already decided/i);
  });

  it("rejects without executing and tells the agent to stop", async () => {
    await seed();
    await handleCallbackQuery(env, cq({ data: "appr_1:no" }), executor, 2000);
    expect(executed).toEqual([]);
    expect((await getApproval(env.DB, "appr_1"))?.state).toBe("failed");
    const events = await readSince(env.DB, "cto", 0);
    expect(events.some((e) => e.kind === "report" && /rejected/i.test(e.body))).toBe(true);
  });

  it("records an executor failure without crashing", async () => {
    await seed();
    await handleCallbackQuery(env, cq(), boomExecutor, 2000);
    const row = await getApproval(env.DB, "appr_1");
    expect(row?.state).toBe("failed");
    expect(row?.result).toMatch(/not mergeable/);
    expect(calls.some((c) => /FAILED/.test(c.body?.text ?? ""))).toBe(true);
  });

  it("answers an unknown approval id and writes nothing", async () => {
    await handleCallbackQuery(env, cq({ data: "appr_nope:yes" }), executor, 2000);
    expect(executed).toEqual([]);
    expect(await readSince(env.DB, "cto", 0)).toEqual([]);
  });

  it("answers unreadable callback data without throwing", async () => {
    await seed();
    await handleCallbackQuery(env, cq({ data: "garbage" }), executor, 2000);
    expect(executed).toEqual([]);
    expect((await getApproval(env.DB, "appr_1"))?.state).toBe("pending");
  });
});

describe("makeExecutor", () => {
  let pem: string;

  beforeAll(async () => {
    // See test/github.app.test.ts's beforeAll for why these are cast:
    // @cloudflare/workers-types has no overloads to narrow generateKey /
    // exportKey's return type from the arguments given.
    const kp = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"],
    )) as CryptoKeyPair;
    const pkcs8 = (await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer;
    const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
    pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
  });

  // AGENT_REPO pinned, not inherited. `env` is wrangler.jsonc's own `vars`
  // (vitest.config.ts binds the real config), and the fallback test below
  // asserts the literal acme-org/websites URL — so a repoint of the
  // deployed AGENT_REPO silently rewrote what this file was testing.
  // Measured 2026-09-12, when it moved to rafarc21/fleetflare: the fallback
  // test failed on a URL that was correct for the new config.
  //
  // Same pin, same reason, as test/board.routes.test.ts, board.fleet-routes,
  // memory.routes, studio.spawn and studio.routes already carry.
  const ghEnv = () => ({
    ...env,
    AGENT_REPO: "acme-org/websites",
    GITHUB_APP_ID: "1111111",
    GITHUB_INSTALLATION_ID: "2222222",
    GITHUB_APP_PRIVATE_KEY: pem,
  });

  // Routes the installation-token mint and the merge PUT to their own fixed
  // responses; only the merge call is recorded into `calls`, so calls[0] in
  // a test below is unambiguously the merge request, not the mint.
  function mockGithub(mergeStatus = 200, mergeBody: unknown = { sha: "deadbeef00" }) {
    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/access_tokens")) return Response.json({ token: "ghs_test" });
      if (url.includes("/merge")) {
        calls.push({ url, body: JSON.parse(init.body as string) });
        return new Response(JSON.stringify(mergeBody), { status: mergeStatus });
      }
      return Response.json({ ok: true, result: { message_id: 900 } });
    }) as typeof globalThis.fetch;
  }

  it("merges the approved PR into staging as a squash, and returns the short sha", async () => {
    mockGithub();
    const result = await makeExecutor(ghEnv())("merge_staging", { repo: "o/r", pr: "7" });
    expect(result).toBe("merged PR #7 as deadbeef");
    expect(calls[0].body.commit_title).toBe("Merge into staging (PR #7)");
    expect(calls[0].body.merge_method).toBe("squash");
  });

  it("merges into main as a real merge commit, not a squash", async () => {
    // Review round 1, Important 3: staging accumulates many feature
    // squashes; squashing THAT into main would flatten it to one commit
    // sharing no history with staging, so every later promotion replays
    // already-integrated work as conflicts. main gets an ordinary merge
    // commit that preserves ancestry instead.
    mockGithub();
    await makeExecutor(ghEnv())("merge_main", { repo: "o/r", pr: "9" });
    expect(calls[0].body.commit_title).toBe("Merge into main (PR #9)");
    expect(calls[0].body.merge_method).toBe("merge");
  });

  it("falls back to AGENT_REPO when the gate carries no repo param", async () => {
    mockGithub();
    await makeExecutor(ghEnv())("merge_staging", { pr: "3" });
    expect(calls[0].url).toBe("https://api.github.com/repos/acme-org/websites/pulls/3/merge");
  });

  it("refuses to merge without a PR number", async () => {
    await expect(makeExecutor(ghEnv())("merge_staging", {})).rejects.toThrow(/--pr/);
  });

  it("surfaces GitHub's merge failure reason", async () => {
    mockGithub(405, { message: "Pull Request is not mergeable" });
    await expect(makeExecutor(ghEnv())("merge_staging", { repo: "o/r", pr: "7" }))
      .rejects.toThrow(/not mergeable/);
  });

  describe("deploy_staging / deploy_prod (Task 9)", () => {
    beforeEach(async () => {
      await env.DB.prepare("DELETE FROM deploy_targets").run();
      await env.DB.prepare(
        `INSERT INTO deploy_targets (id, project, repo, ref, workdir, command, secrets, env)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        "websites:beta:staging", "websites", "acme-org/websites", "staging",
        "sites/beta", "bun install && bun run build", '["CLOUDFLARE_DEPLOY_TOKEN"]', "staging",
      ).run();
    });

    function fakeDeployEnv(
      fetchImpl: (input: string, init?: RequestInit) => Promise<Response> | Response,
    ) {
      mockGithub();
      return {
        ...ghEnv(),
        DEPLOY: {
          idFromName: (n: string) => n,
          get: () => ({ fetch: fetchImpl }),
        } as unknown as Env["DEPLOY"],
      };
    }

    it("requires --target", async () => {
      await expect(makeExecutor(ghEnv())("deploy_staging", {})).rejects.toThrow(/--target/);
    });

    it("refuses an unknown deploy target rather than running a default command", async () => {
      await expect(
        makeExecutor(ghEnv())("deploy_staging", { target: "websites:beta:production" }),
      ).rejects.toThrow(/unknown deploy target/);
    });

    it("starts the target's deploy with a fresh clone token and the project's chat id", async () => {
      let seenBody: any;
      const e = fakeDeployEnv((_url, init) => {
        seenBody = JSON.parse(init!.body as string);
        return Response.json({ started: "websites:beta:staging" });
      });

      const result = await makeExecutor(e)("deploy_staging", { target: "websites:beta:staging" });

      expect(result).toBe("deploy websites:beta:staging started");
      expect(seenBody.command).toBe("bun install && bun run build");
      expect(seenBody.repo).toBe("acme-org/websites");
      expect(seenBody.chatId).toBe(String(OPERATOR));
      expect(seenBody.token).toBe("ghs_test");
    });

    it("surfaces the deploy container's own refusal reason", async () => {
      const e = fakeDeployEnv(() => new Response("a deploy is already running", { status: 409 }));
      await expect(
        makeExecutor(e)("deploy_prod", { target: "websites:beta:staging" }),
      ).rejects.toThrow(/refused \(409\)/);
    });
  });
});

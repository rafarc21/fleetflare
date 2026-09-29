import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { readSince } from "../src/events/log";
import { handleTelegramWebhook } from "../src/telegram/webhook";
import type { Env } from "../src/env";

const SECRET = "test-secret";

function update(text: string, fromId = 100000001, chatId = 100000001) {
  return new Request("https://fleet.test/tg/websites", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": SECRET,
    },
    body: JSON.stringify({
      update_id: 1,
      message: { message_id: 1, from: { id: fromId }, chat: { id: chatId }, text },
    }),
  });
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM events").run();
});

// Load-flake diagnosis (2026-08-28): T5 (task-5-report.md, Finding 4) measured
// this file failing 6, 5, 2 and 1 of 9 under a machine-load full-suite run,
// 9/9 in 21.8s alone — "times out under machine load", slowest failing
// assertion at 5132ms. Confirmed here two ways: (1) this is the ONLY test
// file in the whole suite that calls SELF.fetch (grep across test/*.ts) —
// every other file exercises its handler directly; (2) a microbenchmark (50x
// SELF.fetch vs 50x handleTelegramWebhook(...) direct, same request, same
// env, same assertions) measured SELF.fetch ~50x slower (53ms vs 1.0ms for
// 50 calls). SELF is a real Fetcher service-binding dispatch (workerd request/
// response marshalling), not a plain function call — every one of those extra
// internal round trips is an independent point where OS scheduling can stall
// it, which is exactly what a hard 5000ms-per-test default (vitest's
// testTimeout, unconfigured here — see vitest.config.ts) turns into an
// occasional failure once something else on the machine (another studio's
// build/deploy) is competing for CPU. No shared mutable state, no wall-clock
// assertion, no cloudflare:test storage-isolation break found (checked: D1
// row counts stay file-isolated even under a 4x-concurrent full-suite run) —
// this file's own tests run in 2-9ms each alone, so the fix is not "the
// suite is slow", it's "most of these assertions pay SELF's ~50x tax for no
// reason", the same reason the two tests below that already call
// handleTelegramWebhook directly never needed it.
//
// Fix: keep exactly ONE test on SELF.fetch — enough to prove index.ts's own
// `/tg/:project` route regex still matches and dispatches (nothing else in
// the suite covers that route table; telegram.callback.test.ts builds a
// same-shaped URL but only ever hands it to handleTelegramWebhook directly,
// never through SELF) — and move the rest to the direct-call pattern this
// file already trusts elsewhere. Same assertions, same coverage, ~50x less
// exposure to scheduler jitter per test.
describe("telegram webhook", () => {
  it("rejects a request with a wrong secret token", async () => {
    const req = update("hello");
    req.headers.set("x-telegram-bot-api-secret-token", "wrong");
    const res = await handleTelegramWebhook(req, env, "websites");
    expect(res.status).toBe(403);
    expect(await readSince(env.DB, "cto", 0)).toHaveLength(0);
  });

  it("rejects a request with no secret token at all", async () => {
    const res = await handleTelegramWebhook(new Request("https://fleet.test/tg/websites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: 2, message: { message_id: 2, from: { id: 100000001 }, chat: { id: 100000001 }, text: "x" } }),
    }), env, "websites");
    expect(res.status).toBe(403);
  });

  it("drops a message from a user who is not the operator", async () => {
    const res = await handleTelegramWebhook(update("hello", 999999), env, "websites");
    expect(res.status).toBe(200);
    expect(await readSince(env.DB, "cto", 0)).toHaveLength(0);
  });

  // Reproduced live (2026-08-28, 6x-concurrent full-suite stress on this
  // exact fix): with every OTHER test in this file moved off SELF.fetch,
  // this lone holdout still timed out once in 6 runs — "Test timed out in
  // 5000ms" at 5076ms, the same signature T5 measured before this fix
  // (5132ms, Finding 4). SELF.fetch is a real Fetcher service-binding
  // dispatch (see the load-flake comment above this describe block), and
  // proving index.ts's own route wiring needs exactly this mechanism — there
  // is no cheaper way to exercise it. vitest's default testTimeout (5000ms,
  // unconfigured — vitest.config.ts) assumes an idle machine; this one
  // remaining call still occasionally exceeds that under genuinely heavy
  // concurrent load, external to this test's own logic (it runs in
  // single-digit ms alone). A per-test override, not a suite-wide bump: only
  // the one test that provably needs the margin gets it, everything else
  // keeps the default and still fails fast if it ever hangs for real.
  it("accepts the operator and appends a human event addressed to the cto — the one test this file keeps on SELF.fetch, to prove index.ts's /tg/:project route itself still dispatches here (see the load-flake comment above)", async () => {
    const res = await SELF.fetch(update("what is the status?"));
    expect(res.status).toBe(200);
    const rows = await readSince(env.DB, "cto", 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].from).toBe("human");
    expect(rows[0].kind).toBe("human");
    expect(rows[0].project).toBe("websites");
    expect(rows[0].body).toBe("what is the status?");
  }, 15000);

  it("returns 200 and writes nothing for a body that is not JSON", async () => {
    // A throw here would surface as a 500, which Telegram retries — the retry
    // storm the always-200 contract exists to prevent.
    const res = await handleTelegramWebhook(new Request("https://fleet.test/tg/websites", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
      body: "not json at all",
    }), env, "websites");
    expect(res.status).toBe(200);
    expect(await readSince(env.DB, "cto", 0)).toHaveLength(0);
  });

  it("returns 200 and writes nothing for a JSON body of literal null", async () => {
    // Parses fine, then `update.message` throws: optional chaining guards the
    // children of `message`, not `update` itself.
    const res = await handleTelegramWebhook(new Request("https://fleet.test/tg/websites", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
      body: "null",
    }), env, "websites");
    expect(res.status).toBe(200);
    expect(await readSince(env.DB, "cto", 0)).toHaveLength(0);
  });

  it("still returns 200 when the agent dispatch throws", async () => {
    // Recovers what was the one accepted red at this spot: a live AgentDO
    // cannot be constructed under this harness (enableContainers: false —
    // see the dedupe test below and docs/fleet/README.md's "Known gap"), so
    // runInDurableObject can never reach far enough to break its fetch().
    // Goes through handleTelegramWebhook directly with a hand-built AGENT
    // namespace instead — the same route the dedupe test below already
    // proved works.
    //
    // mintRepoToken (src/github/auth.ts, P6a) is real, but still throws
    // here: the shared test env configures NEITHER provider — no
    // GITHUB_APP_PRIVATE_KEY and no GITHUB_TOKEN (only in-test-generated
    // values are, in github.app.test.ts / github.auth.test.ts) — so this
    // exercises the always-200 contract via its own "no GitHub repo auth
    // configured" throw — the fakeAgent's own rejecting fetch() below
    // is still not reached (see the evaluation-order note on the dedupe
    // test), and stays untested by this file. Exercising "DO fetch rejects
    // -> still 200" needs a valid key in the test env; belongs with a later
    // pass, not a change here.
    const fakeAgent = {
      idFromName: (n: string) => n,
      get: () => ({ fetch: () => Promise.reject(new Error("boom")) }),
    } as unknown as Env["AGENT"];

    const res = await handleTelegramWebhook(
      new Request("https://x/tg/websites", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET! },
        body: JSON.stringify({
          update_id: 4242,
          message: { from: { id: 100000001 }, chat: { id: 100000001 }, text: "hi" },
        }),
      }),
      { ...env, AGENT: fakeAgent },
      "websites",
    );
    expect(res.status).toBe(200);

    const events = await readSince(env.DB, "cto", 0);
    expect(events).toHaveLength(1);
    expect(events[0].from).toBe("human");
    expect(events[0].body).toBe("hi");
  });

  it("ignores an update with no text without erroring", async () => {
    const res = await handleTelegramWebhook(new Request("https://fleet.test/tg/websites", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
      body: JSON.stringify({ update_id: 3, message: { message_id: 3, from: { id: 100000001 }, chat: { id: 100000001 } } }),
    }), env, "websites");
    expect(res.status).toBe(200);
    expect(await readSince(env.DB, "cto", 0)).toHaveLength(0);
  });

  it("dedupes a retried update_id: one event, one dispatch, both responses 200", async () => {
    // A Telegram retry redelivers the exact same update_id — simulated here
    // by calling the handler twice with the same fixture (update()'s body
    // hardcodes update_id: 1).
    //
    // Goes through handleTelegramWebhook directly with a fake AGENT binding
    // instead of SELF.fetch, the same reason agents.do.test.ts calls
    // deliver() directly instead of going through AgentDO: a live AgentDO
    // cannot be constructed under this harness (enableContainers: false —
    // see the recovered test above and docs/fleet/README.md's "Known
    // gap"), so "one dispatch" has to be observed at the binding call
    // (env.AGENT.get(...)), not by reaching inside a real DO.
    // The counter increments in get(), not fetch(): mintRepoToken
    // (src/github/auth.ts) is real, but the shared test env configures no
    // provider at all (see the note on the recovered test above), so it
    // still throws "not configured", and it is awaited while building
    // stub.fetch()'s own request body — so that throw aborts the whole call
    // before fetch() itself is ever invoked (an await inside an object
    // literal's property blocks the call it's an argument to). get() runs
    // synchronously one line earlier in webhook.ts, so it is reached on
    // every dispatch attempt regardless — fetch() itself stays unreached
    // here either way.
    let attempts = 0;
    const fakeAgent = {
      idFromName: (_name: string): DurableObjectId => ({}) as DurableObjectId,
      get: (_id: DurableObjectId) => {
        attempts++;
        return {
          fetch: async (): Promise<Response> => new Response("ok"),
        };
      },
    } as unknown as Env["AGENT"];
    const fakeEnv: Env = { ...env, AGENT: fakeAgent };

    const res1 = await handleTelegramWebhook(update("status?"), fakeEnv, "websites");
    const res2 = await handleTelegramWebhook(update("status?"), fakeEnv, "websites");

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(attempts).toBe(1);
    expect(await readSince(env.DB, "cto", 0)).toHaveLength(1);
  });

  // Issue #7 (#13 review): the legacy AgentDO container gets a WRITE token
  // for AGENT_REPO and has no write-proxy wrappers. A repo routed through the
  // write proxy must not get one this way: the dispatch is skipped.
  // Same env both ways (a PAT, so the mint needs no network): only the list
  // differs, so the listed case's `0` is the skip, not a failed mint.
  const agentEnv = (listed: boolean) => {
    const calls = { started: 0 };
    const e = {
      ...env, GITHUB_TOKEN: "github_pat_fake", GITHUB_APP_ID: undefined, GITHUB_REPO_AUTH: undefined,
      FLEET_WRITE_PROXY_REPOS: listed ? env.AGENT_REPO : "",
      AGENT: { idFromName: (n: string) => n, get: () => ({ fetch: async () => { calls.started++; return new Response("{}"); } }) },
    } as unknown as Env;
    return { e, calls };
  };

  it("AGENT_REPO not listed: the agent starts as before", async () => {
    const { e, calls } = agentEnv(false);
    expect((await handleTelegramWebhook(update("do the thing"), e, "websites")).status).toBe(200);
    expect(calls.started).toBe(1);
  });

  it("AGENT_REPO on FLEET_WRITE_PROXY_REPOS: the agent is never started, no write token minted", async () => {
    const { e, calls } = agentEnv(true);
    const res = await handleTelegramWebhook(update("do the thing"), e, "websites");
    expect(res.status).toBe(200);
    expect(calls.started).toBe(0);
    expect(await readSince(env.DB, "cto", 0)).toHaveLength(1);
  });
});


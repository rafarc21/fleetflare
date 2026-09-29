import { describe, it, expect, vi } from "vitest";
import { handleGhProxy, parseGhOp, GhOpError, type GhCall, type GhProxyPorts } from "../src/write-proxy/gh-route";
import { LeakGateError, leakGuard } from "../src/board/leak";
import { SPAWN_TOKEN_HEADER } from "../src/studio/spawn";
import { hashSpawnToken, mintSpawnToken } from "../src/studio/org";
import type { StudioStatus } from "../src/studio/types";

// Issue #7: /fleet/gh -- the studio's only gh write path on a public repo.
// Fake names and terms only: this file ships in a public repo.

const REPO = "example-org/demo";
const ME = "demo--web-studio";

function row(hash: string, repoSlug: string | null = REPO): StudioStatus {
  return { id: ME, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: hash, repoSlug };
}

async function setup(opts: {
  list?: string | Error; isPrivate?: boolean; github?: (call: GhCall) => Response; repoSlug?: string | null;
} = {}) {
  const token = mintSpawnToken();
  const calls: GhCall[] = [];
  const ports: GhProxyPorts = {
    rows: async () => [row(await hashSpawnToken(token), opts.repoSlug === undefined ? REPO : opts.repoSlug)],
    defaultRepo: "example-org/fleet",
    github: vi.fn(async (call: GhCall, repo: string) => {
      expect(repo).toBe(REPO);
      calls.push(call);
      return opts.github?.(call) ?? Response.json({ number: 12, html_url: "https://github.com/example-org/demo/pull/12" }, { status: 201 });
    }),
    check: leakGuard({
      isPrivate: async () => opts.isPrivate ?? false,
      fetchDenylist: async () => {
        const l = opts.list ?? "acmeclient\n9{9}\n";
        if (l instanceof Error) throw l;
        return l;
      },
    }),
  };
  const send = (body: unknown, headers: Record<string, string> = { [SPAWN_TOKEN_HEADER]: token }) =>
    handleGhProxy(new Request("https://fleet.example/fleet/gh", {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    }), ports);
  return { send, calls, ports, token };
}

describe("parseGhOp", () => {
  it("accepts each allowlisted op", () => {
    expect(parseGhOp({ op: "pr-create", title: "t", body: "b", head: "h", base: "main", draft: true }).op).toBe("pr-create");
    expect(parseGhOp({ op: "pr-edit", number: 3, body: "b" }).op).toBe("pr-edit");
    expect(parseGhOp({ op: "pr-ready", number: 3 }).op).toBe("pr-ready");
    expect(parseGhOp({ op: "comment", number: 3, body: "b" }).op).toBe("comment");
    expect(parseGhOp({ op: "issue-create", title: "t", body: "b", labels: ["x"] }).op).toBe("issue-create");
    expect(parseGhOp({ op: "issue-edit", number: 3, title: "t" }).op).toBe("issue-edit");
    expect(parseGhOp({ op: "pr-review", number: 3, event: "APPROVE", body: "" }).op).toBe("pr-review");
  });

  it("refuses unknown ops, extra fields, wrong types and empty edits", () => {
    for (const bad of [
      null, [], { op: "pr-merge", number: 1 },
      { op: "comment", number: 3, body: "b", extra: "x" },
      { op: "comment", number: 3, body: "b", repo: 7 },
      { op: "comment", number: "3", body: "b" },
      { op: "comment", number: 0, body: "b" },
      { op: "comment", number: 3 },
      { op: "issue-create", title: "t", body: "b", labels: [1] },
      { op: "pr-edit", number: 3 },
      { op: "pr-review", number: 3, event: "DISMISS", body: "" },
      { op: "pr-create", title: "t", body: "b", head: "h", base: "main" },
    ]) {
      expect(() => parseGhOp(bad), JSON.stringify(bad)).toThrow(GhOpError);
    }
  });
});

describe("handleGhProxy", () => {
  it("401 without a valid spawn token; GitHub never called", async () => {
    const { send, calls } = await setup();
    expect((await send({ op: "comment", number: 3, body: "b" }, {})).status).toBe(401);
    expect((await send({ op: "comment", number: 3, body: "b" }, { [SPAWN_TOKEN_HEADER]: "fsp_" + "0".repeat(64) })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("405 on anything but POST", async () => {
    const { ports, token } = await setup();
    const res = await handleGhProxy(new Request("https://fleet.example/fleet/gh", { headers: { [SPAWN_TOKEN_HEADER]: token } }), ports);
    expect(res.status).toBe(405);
  });

  it("clean pr-create reaches GitHub on the studio's own repo, status and body passed through", async () => {
    const { send, calls } = await setup();
    const res = await send({ op: "pr-create", title: "Add demo", body: "Closes #1", head: "feat", base: "main", draft: true });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { html_url: string }).html_url).toContain("/pull/12");
    expect(calls).toEqual([{ method: "POST", path: `/repos/${REPO}/pulls`,
      body: { title: "Add demo", body: "Closes #1", head: "feat", base: "main", draft: true } }]);
  });

  it("maps every op to its REST call", async () => {
    const { send, calls } = await setup();
    await send({ op: "pr-edit", number: 4, title: "T2" });
    await send({ op: "comment", number: 5, body: "hi" });
    await send({ op: "issue-create", title: "T", body: "B", labels: ["bug"] });
    await send({ op: "issue-edit", number: 6, body: "B2" });
    await send({ op: "pr-review", number: 7, event: "COMMENT", body: "looks fine" });
    expect(calls).toEqual([
      { method: "PATCH", path: `/repos/${REPO}/pulls/4`, body: { title: "T2" } },
      { method: "POST", path: `/repos/${REPO}/issues/5/comments`, body: { body: "hi" } },
      { method: "POST", path: `/repos/${REPO}/issues`, body: { title: "T", body: "B", labels: ["bug"] } },
      { method: "PATCH", path: `/repos/${REPO}/issues/6`, body: { body: "B2" } },
      { method: "POST", path: `/repos/${REPO}/pulls/7/reviews`, body: { event: "COMMENT", body: "looks fine" } },
    ]);
  });

  it("pr-ready reads the node id, then runs the one fixed mutation", async () => {
    const { send, calls } = await setup({
      github: (call) => call.method === "GET"
        ? Response.json({ node_id: "PR_node1", html_url: "https://github.com/example-org/demo/pull/8" })
        : Response.json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }),
    });
    const res = await send({ op: "pr-ready", number: 8 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { html_url: string }).html_url).toContain("/pull/8");
    expect(calls[0]).toEqual({ method: "GET", path: `/repos/${REPO}/pulls/8`, body: undefined });
    expect(calls[1].method).toBe("POST");
    expect(calls[1].path).toBe("/graphql");
    expect(calls[1].body).toEqual({
      query: "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }",
      variables: { id: "PR_node1" },
    });
  });

  it("pr-ready surfaces a GraphQL error as 502", async () => {
    const { send } = await setup({
      github: (call) => call.method === "GET"
        ? Response.json({ node_id: "PR_node1", html_url: "u" })
        : Response.json({ errors: [{ message: "not allowed" }] }),
    });
    const res = await send({ op: "pr-ready", number: 8 });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("not allowed");
  });

  it("a denylist hit refuses with the pattern index, never the term; GitHub never called", async () => {
    const { send, calls } = await setup();
    const res = await send({ op: "comment", number: 5, body: "shipped for AcmeClient today" });
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).toContain("#1");
    expect(text.toLowerCase()).not.toContain("acmeclient");
    expect(calls).toHaveLength(0);
  });

  it("scans labels and titles too", async () => {
    const { send, calls } = await setup();
    expect((await send({ op: "issue-create", title: "t", body: "b", labels: ["id-999999999"] })).status).toBe(422);
    expect((await send({ op: "pr-edit", number: 2, title: "acmeclient" })).status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it("a missing denylist refuses with 503 (fail closed)", async () => {
    const { send, calls } = await setup({ list: new Error("404") });
    expect((await send({ op: "comment", number: 5, body: "clean" })).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("a scanner that throws (not a LeakGateError) refuses with 503; GitHub never called", async () => {
    const { send, ports, calls } = await setup();
    ports.check = async () => { throw new Error("regex engine exploded"); };
    const res = await send({ op: "comment", number: 5, body: "clean" });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("exploded");
    expect(calls).toHaveLength(0);
  });

  it("a confirmed-private work repo skips the scan", async () => {
    const { send, calls } = await setup({ isPrivate: true });
    expect((await send({ op: "comment", number: 5, body: "acmeclient" })).status).toBe(201);
    expect(calls).toHaveLength(1);
  });

  // Review finding 5: the client names the repo it meant (-R, an issue URL);
  // a different one is refused rather than silently written to the work repo.
  it("an op naming another repo is 403; naming its own repo passes", async () => {
    const { send, calls } = await setup();
    expect((await send({ op: "comment", number: 5, body: "x", repo: "example-org/private-ops" })).status).toBe(403);
    expect(calls).toHaveLength(0);
    expect((await send({ op: "comment", number: 5, body: "x", repo: "Example-Org/Demo" })).status).toBe(201);
  });

  it("a body over the cap is 413", async () => {
    const { ports, token } = await setup();
    const big = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(1024 * 1024 + 1)); c.close(); } });
    const res = await handleGhProxy(new Request("https://fleet.example/fleet/gh", {
      method: "POST", headers: { [SPAWN_TOKEN_HEADER]: token }, body: big,
    }), ports);
    expect(res.status).toBe(413);
  });

  it("bad JSON and a bad op are 400", async () => {
    const { send, ports, token } = await setup();
    expect((await send({ op: "pr-merge", number: 1 })).status).toBe(400);
    const res = await handleGhProxy(new Request("https://fleet.example/fleet/gh", {
      method: "POST", headers: { [SPAWN_TOKEN_HEADER]: token }, body: "{nope",
    }), ports);
    expect(res.status).toBe(400);
  });

  it("GitHub's own error status and body pass through", async () => {
    const { send } = await setup({ github: () => new Response('{"message":"Validation Failed"}', { status: 422 }) });
    const res = await send({ op: "comment", number: 5, body: "x" });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Validation Failed");
  });

  it("LeakGateError is the refusal class", () => {
    expect(new LeakGateError(422, "m").status).toBe(422);
  });
});

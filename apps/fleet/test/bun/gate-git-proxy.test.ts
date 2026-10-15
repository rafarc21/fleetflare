import { describe, it, expect } from "bun:test";
import {
  GIT_PROXY_HOST,
  handleGateOutbound,
  type GateOutboundProps,
  type GitProxyDeps,
  type OutboundBucket,
} from "../../src/gate/outbound-handler";

// #715: private-repo clones. The container clones http://git-proxy.internal/<owner>/<repo>.git,
// the Worker-side outbound handler mints a read-only token for the ONE repo in
// props, and proxies git smart-HTTP upload-pack traffic to github.com. These
// tests pin what may pass and what must never leave the Worker.

const REPO = "acme/example";
const OWN: GateOutboundProps = { resultKey: "gate/acme/example/runs/715/run-a/shard-typecheck.json", repo: REPO };
const TOKEN = "ghs_TESTONLY_not_a_real_token_0000";
const ADVERT = "001e# service=git-upload-pack\n0000";

const noBucket: OutboundBucket = {
  async get() { throw new Error("bucket must not be touched by a git request"); },
  async head() { throw new Error("bucket must not be touched by a git request"); },
  async put() { throw new Error("bucket must not be touched by a git request"); },
};

/** Records every call the Worker makes to GitHub. The token is minted by the
 *  injected minter, never read from anywhere else. */
function fakeGit(opts: { status?: number; body?: string; mintFails?: boolean } = {}) {
  const status = opts.status ?? 200;
  const upstream: Array<{ url: string; init: RequestInit }> = [];
  const minted: string[] = [];
  const deps: GitProxyDeps = {
    async mint(repo) {
      if (opts.mintFails) throw new Error(`mint refused for ${repo}: ${TOKEN}`);
      minted.push(repo);
      return TOKEN;
    },
    async fetch(url, init) {
      upstream.push({ url, init });
      if (status !== 200) {
        return new Response(null, {
          status,
          headers: { location: "https://github.com/elsewhere/x.git/info/refs", "set-cookie": "sid=1" },
        });
      }
      return new Response(opts.body ?? ADVERT, {
        status: 200,
        headers: {
          "content-type": "application/x-git-upload-pack-advertisement",
          "set-cookie": "sid=1",
          "x-github-request-id": "req-1",
        },
      });
    },
  };
  return { deps, upstream, minted };
}

function gitReq(method: string, url: string, init: { body?: string; headers?: Record<string, string> } = {}) {
  return new Request(url, { method, body: init.body, headers: init.headers });
}

const infoRefs = (repo = "acme/example.git", service = "git-upload-pack") =>
  `http://${GIT_PROXY_HOST}/${repo}/info/refs?service=${service}`;
const uploadPack = (repo = "acme/example.git") => `http://${GIT_PROXY_HOST}/${repo}/git-upload-pack`;

describe("git proxy: upload-pack is allowed for props.repo", () => {
  it("GET info/refs?service=git-upload-pack proxies to github.com for that repo", async () => {
    const git = fakeGit();
    const res = await handleGateOutbound(gitReq("GET", infoRefs()), noBucket, OWN, git.deps);
    expect(res.status).toBe(200);
    expect(git.upstream.length).toBe(1);
    expect(git.upstream[0].url).toBe("https://github.com/acme/example.git/info/refs?service=git-upload-pack");
    expect(git.upstream[0].init.method).toBe("GET");
  });

  it("POST git-upload-pack proxies the request body to github.com", async () => {
    const git = fakeGit({ body: "PACKDATA" });
    const body = "0032want 0123456789abcdef0123456789abcdef01234567\n00000009done\n";
    const res = await handleGateOutbound(
      gitReq("POST", uploadPack(), {
        body,
        headers: { "content-type": "application/x-git-upload-pack-request" },
      }),
      noBucket,
      OWN,
      git.deps,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PACKDATA");
    expect(git.upstream[0].url).toBe("https://github.com/acme/example.git/git-upload-pack");
    expect(git.upstream[0].init.method).toBe("POST");
    expect(await new Response(git.upstream[0].init.body as ReadableStream).text()).toBe(body);
  });

  it("the match is case-insensitive: GitHub names are not case-sensitive", async () => {
    const git = fakeGit();
    const res = await handleGateOutbound(gitReq("GET", infoRefs("Acme/Example.git")), noBucket, OWN, git.deps);
    expect(res.status).toBe(200);
    expect(git.minted).toEqual([REPO]);
  });
});

describe("git proxy: receive-pack (push) is never proxied", () => {
  it("GET info/refs?service=git-receive-pack is refused, GitHub never called", async () => {
    const git = fakeGit();
    const res = await handleGateOutbound(gitReq("GET", infoRefs("acme/example.git", "git-receive-pack")), noBucket, OWN, git.deps);
    expect(res.status).toBe(403);
    expect(git.upstream.length).toBe(0);
    expect(git.minted.length).toBe(0);
  });

  it("POST git-receive-pack is refused, GitHub never called", async () => {
    const git = fakeGit();
    const res = await handleGateOutbound(
      gitReq("POST", `http://${GIT_PROXY_HOST}/acme/example.git/git-receive-pack`, { body: "push" }),
      noBucket,
      OWN,
      git.deps,
    );
    expect(res.status).toBe(403);
    expect(git.upstream.length).toBe(0);
  });
});

describe("git proxy: only the exact smart-HTTP fetch shapes pass", () => {
  it("a POST to info/refs is refused", async () => {
    const git = fakeGit();
    expect((await handleGateOutbound(gitReq("POST", infoRefs()), noBucket, OWN, git.deps)).status).toBe(403);
    expect(git.upstream.length).toBe(0);
  });

  it("a GET to git-upload-pack is refused", async () => {
    const git = fakeGit();
    expect((await handleGateOutbound(gitReq("GET", uploadPack()), noBucket, OWN, git.deps)).status).toBe(403);
    expect(git.upstream.length).toBe(0);
  });

  it("a PUT or DELETE is refused, no GitHub call", async () => {
    const git = fakeGit();
    expect((await handleGateOutbound(gitReq("PUT", uploadPack(), { body: "x" }), noBucket, OWN, git.deps)).status).toBe(403);
    expect((await handleGateOutbound(gitReq("DELETE", infoRefs()), noBucket, OWN, git.deps)).status).toBe(403);
    expect(git.upstream.length).toBe(0);
  });

  it("any other path under the repo is refused (objects, refs, the repo's API root)", async () => {
    const git = fakeGit();
    for (const path of [
      "/acme/example.git/objects/info/packs",
      "/acme/example.git/HEAD",
      "/acme/example/info/refs?service=git-upload-pack",
      "/acme/example.git",
    ]) {
      const res = await handleGateOutbound(gitReq("GET", `http://${GIT_PROXY_HOST}${path}`), noBucket, OWN, git.deps);
      expect(res.status).toBe(403);
    }
    expect(git.upstream.length).toBe(0);
  });

  it("extra query parameters on info/refs are refused", async () => {
    const git = fakeGit();
    const res = await handleGateOutbound(gitReq("GET", `${infoRefs()}&x=1`), noBucket, OWN, git.deps);
    expect(res.status).toBe(403);
    expect(git.upstream.length).toBe(0);
  });

  it("a dot segment that climbs to a different repo is refused after URL normalization", async () => {
    const git = fakeGit();
    const res = await handleGateOutbound(
      gitReq("GET", `http://${GIT_PROXY_HOST}/acme/../evil/example.git/info/refs?service=git-upload-pack`),
      noBucket,
      OWN,
      git.deps,
    );
    expect(res.status).toBe(403);
    expect(git.upstream.length).toBe(0);
  });
});

describe("git proxy: scoped to props.repo", () => {
  it("another repo under the same owner is refused, GitHub never called", async () => {
    const git = fakeGit();
    const res = await handleGateOutbound(gitReq("GET", infoRefs("acme/other.git")), noBucket, OWN, git.deps);
    expect(res.status).toBe(403);
    expect(git.upstream.length).toBe(0);
    expect(git.minted.length).toBe(0);
  });

  it("another owner's repo is refused, no token is minted for it", async () => {
    const git = fakeGit();
    const res = await handleGateOutbound(gitReq("POST", uploadPack("evil-org/example.git")), noBucket, OWN, git.deps);
    expect(res.status).toBe(403);
    expect(git.minted.length).toBe(0);
  });

  it("props without a repo deny every git request, even an otherwise valid one", async () => {
    const git = fakeGit();
    const res = await handleGateOutbound(gitReq("GET", infoRefs()), noBucket, { resultKey: OWN.resultKey } as GateOutboundProps, git.deps);
    expect(res.status).toBe(403);
    expect(git.upstream.length).toBe(0);
  });

  it("no git deps wired means the proxy is closed: 403, nothing fetched", async () => {
    const res = await handleGateOutbound(gitReq("GET", infoRefs()), noBucket, OWN);
    expect(res.status).toBe(403);
  });
});

describe("git proxy: other hosts are refused", () => {
  it("github.com reached directly from the container is refused", async () => {
    const git = fakeGit();
    const res = await handleGateOutbound(
      gitReq("GET", "http://github.com/acme/example.git/info/refs?service=git-upload-pack"),
      noBucket,
      OWN,
      git.deps,
    );
    expect(res.status).toBe(403);
    expect(git.upstream.length).toBe(0);
  });

  it("an arbitrary host serving the same path is refused", async () => {
    const git = fakeGit();
    const res = await handleGateOutbound(gitReq("GET", "http://evil.example/acme/example.git/info/refs?service=git-upload-pack"), noBucket, OWN, git.deps);
    expect(res.status).toBe(403);
    expect(git.upstream.length).toBe(0);
  });
});

describe("git proxy: the token never reaches the container", () => {
  it("the container's own Authorization and Cookie headers are never forwarded", async () => {
    const git = fakeGit();
    await handleGateOutbound(
      gitReq("GET", infoRefs(), { headers: { authorization: "Bearer attacker", cookie: "a=b" } }),
      noBucket,
      OWN,
      git.deps,
    );
    const sent = new Headers(git.upstream[0].init.headers);
    expect(sent.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(sent.get("cookie")).toBeNull();
  });

  it("the Git-Protocol version header is forwarded so protocol v2 still works", async () => {
    const git = fakeGit();
    await handleGateOutbound(gitReq("GET", infoRefs(), { headers: { "git-protocol": "version=2" } }), noBucket, OWN, git.deps);
    expect(new Headers(git.upstream[0].init.headers).get("git-protocol")).toBe("version=2");
  });

  it("the response carries only content-type: no set-cookie, no GitHub request id", async () => {
    const git = fakeGit();
    const res = await handleGateOutbound(gitReq("GET", infoRefs()), noBucket, OWN, git.deps);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-github-request-id")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
  });

  it("no token string appears in any header or body the container receives", async () => {
    const git = fakeGit();
    const ok = await handleGateOutbound(gitReq("GET", infoRefs()), noBucket, OWN, git.deps);
    const headerText = [...ok.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    expect(headerText).not.toContain(TOKEN);
    expect(await ok.text()).not.toContain(TOKEN);
  });

  it("an upstream 401 reaches the container as a bare status with no body and no token", async () => {
    const git = fakeGit({ status: 401 });
    const res = await handleGateOutbound(gitReq("GET", infoRefs()), noBucket, OWN, git.deps);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
    expect([...res.headers.values()].join(" ")).not.toContain(TOKEN);
  });

  it("an upstream redirect is refused (502), so a renamed repo cannot leave the scope", async () => {
    const git = fakeGit({ status: 301 });
    const res = await handleGateOutbound(gitReq("GET", infoRefs()), noBucket, OWN, git.deps);
    expect(res.status).toBe(502);
    expect(res.headers.get("location")).toBeNull();
  });

  it("a failed mint is a 502 that echoes no error text, and nothing is fetched", async () => {
    const git = fakeGit({ mintFails: true });
    const res = await handleGateOutbound(gitReq("GET", infoRefs()), noBucket, OWN, git.deps);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(TOKEN);
    expect(git.upstream.length).toBe(0);
  });
});

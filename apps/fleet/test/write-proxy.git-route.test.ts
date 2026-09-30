import { describe, it, expect, vi } from "vitest";
import { handleGitProxy, PUSH_BODY_CAP, defaultBranchCache, type GitProxyPorts } from "../src/write-proxy/git-route";
import { leakGuard } from "../src/board/leak";
import { pkt, FLUSH, ZERO_OID } from "../src/write-proxy/pktline";
import { SPAWN_TOKEN_HEADER } from "../src/studio/spawn";
import { hashSpawnToken, mintSpawnToken } from "../src/studio/org";
import type { StudioStatus } from "../src/studio/types";

// Issue #7: /fleet/git -- the receive-pack proxy. Packs are built by hand here
// (zlib stored blocks); test/bun/write-proxy-e2e.test.ts drives real git.
// Fake names and terms only: this file ships in a public repo.

const REPO = "example-org/demo";
const BASE = "https://fleet.example/fleet/git/github.com/example-org/demo.git";
const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const enc = new TextEncoder();

function adler32(d: Uint8Array): number {
  let a = 1, b = 0;
  for (const x of d) { a = (a + x) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

function zlibStored(d: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + 5 + d.length + 4);
  out.set([0x78, 0x01, 0x01, d.length & 0xff, d.length >> 8, ~d.length & 0xff, (~d.length >> 8) & 0xff]);
  out.set(d, 7);
  new DataView(out.buffer).setUint32(7 + d.length, adler32(d));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function makePack(objs: { type: 1 | 2 | 3 | 4; data: string }[]): Promise<Uint8Array> {
  const head = new Uint8Array(12);
  head.set(enc.encode("PACK"));
  new DataView(head.buffer).setUint32(4, 2);
  new DataView(head.buffer).setUint32(8, objs.length);
  const entries = objs.map(({ type, data }) => {
    const bytes = enc.encode(data);
    let size = bytes.length;
    const hdr = [((type << 4) | (size & 0x0f)) | (size > 15 ? 0x80 : 0)];
    size >>= 4;
    while (size > 0) { hdr.push((size & 0x7f) | (size > 127 ? 0x80 : 0)); size >>= 7; }
    return concat([new Uint8Array(hdr), zlibStored(bytes)]);
  });
  const body = concat([head, ...entries]);
  const sha = new Uint8Array(await crypto.subtle.digest("SHA-1", body));
  return concat([body, sha]);
}

const commit = (msg: string) => `tree ${"3".repeat(40)}\nauthor A <a@example.org> 1 +0000\ncommitter A <a@example.org> 1 +0000\n\n${msg}\n`;

async function pushBody(opts: { msg?: string; ref?: string; caps?: string; del?: boolean } = {}): Promise<Uint8Array> {
  const ref = opts.ref ?? "refs/heads/feature";
  const caps = opts.caps ?? "report-status side-band-64k ofs-delta agent=git/2.50";
  if (opts.del) return concat([pkt(`${OLD} ${ZERO_OID} ${ref}\0${caps}\n`), FLUSH]);
  return concat([
    pkt(`${OLD} ${NEW} ${ref}\0${caps}\n`), FLUSH,
    await makePack([{ type: 1, data: commit(opts.msg ?? "clean change") }, { type: 3, data: "hello\n" }]),
  ]);
}

const ADVERT = concat([
  pkt("# service=git-receive-pack\n"), FLUSH,
  pkt(`${OLD} refs/heads/main\0report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta push-options agent=github/x\n`),
  FLUSH,
]);

async function setup(opts: {
  list?: string | Error; repoSlug?: string | null; isPrivate?: boolean;
  defaultBranch?: string | Error; allowDefaultBranch?: boolean;
} = {}) {
  const token = mintSpawnToken();
  const upstreamCalls: { url: string; method: string; access: string; body: Uint8Array | null; headers: Headers }[] = [];
  const ports: GitProxyPorts = {
    rows: async (): Promise<StudioStatus[]> => [{
      id: "demo--web-studio", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: await hashSpawnToken(token),
      repoSlug: opts.repoSlug === undefined ? REPO : opts.repoSlug,
    }],
    defaultRepo: "example-org/fleet",
    upstream: vi.fn(async (url: string, init: RequestInit, access: "read" | "write", repo: string) => {
      expect(repo).toBe(REPO);
      const body = init.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : null;
      upstreamCalls.push({ url, method: init.method ?? "GET", access, body, headers: new Headers(init.headers) });
      if (url.endsWith("service=git-receive-pack")) return new Response(ADVERT, { headers: { "content-type": "application/x-git-receive-pack-advertisement" } });
      if (url.endsWith("git-receive-pack")) return new Response("upstream-report", { headers: { "content-type": "application/x-git-receive-pack-result" } });
      return new Response("upload-pack-reply", { headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
    }),
    defaultBranch: async () => {
      const b = opts.defaultBranch ?? "main";
      if (b instanceof Error) throw b;
      return b;
    },
    allowDefaultBranch: () => opts.allowDefaultBranch ?? false,
    check: leakGuard({
      isPrivate: async () => opts.isPrivate ?? false,
      fetchDenylist: async () => {
        const l = opts.list ?? "acmeclient\n9{9}\n";
        if (l instanceof Error) throw l;
        return l;
      },
    }),
  };
  const auth = { authorization: `Basic ${btoa(`x-fleet-spawn:${token}`)}` };
  const push = (body: Uint8Array | ReadableStream, headers: Record<string, string> = {}) =>
    handleGitProxy(new Request(`${BASE}/git-receive-pack`, {
      method: "POST", headers: { ...auth, "content-type": "application/x-git-receive-pack-request", ...headers }, body,
    }), ports);
  return { ports, token, auth, push, upstreamCalls };
}

const decode = async (res: Response) => new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));

describe("handleGitProxy: auth and scope", () => {
  it("no credential = 401 with a Basic challenge, so git asks its helper", async () => {
    const { ports, upstreamCalls } = await setup();
    const res = await handleGitProxy(new Request(`${BASE}/info/refs?service=git-receive-pack`), ports);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Basic /);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("the X-Fleet-Spawn-Token header is accepted too", async () => {
    const { ports, token } = await setup();
    const res = await handleGitProxy(new Request(`${BASE}/info/refs?service=git-upload-pack`, { headers: { [SPAWN_TOKEN_HEADER]: token } }), ports);
    expect(res.status).toBe(200);
  });

  it("a repo other than the studio's own = 403, upstream never called", async () => {
    const { ports, auth, upstreamCalls } = await setup();
    const res = await handleGitProxy(new Request("https://fleet.example/fleet/git/github.com/example-org/other.git/info/refs?service=git-receive-pack", { headers: auth }), ports);
    expect(res.status).toBe(403);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("repo match is case-insensitive and .git optional", async () => {
    const { ports, auth } = await setup();
    const res = await handleGitProxy(new Request("https://fleet.example/fleet/git/github.com/Example-Org/Demo/info/refs?service=git-upload-pack", { headers: auth }), ports);
    expect(res.status).toBe(200);
  });

  it("unknown path or service = 404/400", async () => {
    const { ports, auth } = await setup();
    expect((await handleGitProxy(new Request(`${BASE}/objects/info/packs`, { headers: auth }), ports)).status).toBe(404);
    expect((await handleGitProxy(new Request(`${BASE}/info/refs?service=git-archive`, { headers: auth }), ports)).status).toBe(400);
  });
});

describe("handleGitProxy: upload-pack passes through on the read token", () => {
  it("GET info/refs and POST git-upload-pack forwarded with Git-Protocol", async () => {
    const { ports, auth, upstreamCalls } = await setup();
    const a = await handleGitProxy(new Request(`${BASE}/info/refs?service=git-upload-pack`, { headers: { ...auth, "git-protocol": "version=2" } }), ports);
    expect(await a.text()).toBe("upload-pack-reply");
    await handleGitProxy(new Request(`${BASE}/git-upload-pack`, { method: "POST", headers: { ...auth, "git-protocol": "version=2", "content-type": "application/x-git-upload-pack-request" }, body: "0000" }), ports);
    expect(upstreamCalls.map((c) => [c.method, c.url, c.access])).toEqual([
      ["GET", "https://github.com/example-org/demo.git/info/refs?service=git-upload-pack", "read"],
      ["POST", "https://github.com/example-org/demo.git/git-upload-pack", "read"],
    ]);
    expect(upstreamCalls[0].headers.get("git-protocol")).toBe("version=2");
    expect(upstreamCalls[0].headers.get("authorization")).toBeNull();
  });
});

describe("handleGitProxy: receive-pack", () => {
  it("advertisement rewritten: no-thin added, push-options/report-status-v2 dropped", async () => {
    const { ports, auth, upstreamCalls } = await setup();
    const res = await handleGitProxy(new Request(`${BASE}/info/refs?service=git-receive-pack`, { headers: auth }), ports);
    const body = await decode(res);
    expect(res.headers.get("content-type")).toBe("application/x-git-receive-pack-advertisement");
    expect(body).toContain("no-thin");
    expect(body).not.toContain("push-options");
    expect(body).not.toContain("report-status-v2");
    expect(upstreamCalls[0].access).toBe("write");
  });

  it("clean push forwarded byte-identical on the write token; upstream reply streamed back", async () => {
    const { push, upstreamCalls } = await setup();
    const body = await pushBody();
    const res = await push(body);
    expect(await res.text()).toBe("upstream-report");
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0].url).toBe("https://github.com/example-org/demo.git/git-receive-pack");
    expect(upstreamCalls[0].access).toBe("write");
    expect(upstreamCalls[0].body).toEqual(body);
    expect(upstreamCalls[0].headers.get("content-type")).toBe("application/x-git-receive-pack-request");
  });

  it("a denylist hit in a commit message: report-status ng naming the index, upstream never called", async () => {
    const { push, upstreamCalls } = await setup();
    const res = await push(await pushBody({ msg: "ship for AcmeClient" }));
    expect(res.status).toBe(200);
    const text = await decode(res);
    expect(text).toContain("ng refs/heads/feature");
    expect(text).toContain("#1");
    expect(text.toLowerCase()).not.toContain("acmeclient");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("a hit in a ref name is refused", async () => {
    const { push, upstreamCalls } = await setup();
    const res = await push(await pushBody({ ref: "refs/heads/id-999999999" }));
    expect(await decode(res)).toContain("#2");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("a delete-only push carries no pack; ref name still scanned", async () => {
    const { push, upstreamCalls } = await setup();
    expect(await (await push(await pushBody({ del: true }))).text()).toBe("upstream-report");
    expect(upstreamCalls).toHaveLength(1);
    const bad = await push(await pushBody({ del: true, ref: "refs/heads/acmeclient" }));
    expect(await decode(bad)).toContain("ng refs/heads/acmeclient");
    expect(upstreamCalls).toHaveLength(1);
  });

  it("missing denylist = refused (fail closed)", async () => {
    const { push, upstreamCalls } = await setup({ list: new Error("404") });
    expect(await decode(await push(await pushBody()))).toContain("ng refs/heads/feature fleet: leak gate: no denylist");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("a corrupt pack is refused, never forwarded", async () => {
    const { push, upstreamCalls } = await setup();
    const body = await pushBody();
    body[body.length - 1] ^= 0xff;
    expect(await decode(await push(body))).toContain("ng refs/heads/feature fleet: write proxy:");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("no report-status requested: refusal is a plain 403", async () => {
    const { push } = await setup();
    const res = await push(await pushBody({ msg: "acmeclient", caps: "ofs-delta" }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("#1");
  });

  it("a refusal for a ref too long for one pkt-line is still a clean refusal, not a 500", async () => {
    const { push, upstreamCalls } = await setup();
    // Fits the request's own pkt-line (caps kept short), but "ng <ref> <msg>"
    // does not.
    const ref = `refs/heads/acmeclient-${"x".repeat(65_417 - 22)}`;
    const res = await push(await pushBody({ ref, caps: "report-status" }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("#1");
    expect(upstreamCalls).toHaveLength(0);
  });

  // #13 review, surviving mutants.
  it("a scanner that throws (not a LeakGateError) refuses, never forwards", async () => {
    const { ports, auth, upstreamCalls } = await setup();
    ports.check = async () => { throw new Error("regex engine exploded"); };
    const res = await handleGitProxy(new Request(`${BASE}/git-receive-pack`, {
      method: "POST", headers: { ...auth, "content-type": "application/x-git-receive-pack-request" }, body: await pushBody(),
    }), ports);
    const text = await decode(res);
    expect(text).toContain("ng refs/heads/feature fleet: leak gate: scanner error");
    expect(text).not.toContain("exploded");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("a shallow line in the push request is refused, never forwarded", async () => {
    const { push, upstreamCalls } = await setup();
    const body = await pushBody();
    const shallow = concat([pkt(`shallow ${"4".repeat(40)}\n`), body]);
    expect((await push(shallow)).status).toBe(400);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("bytes after the pack trailer are refused, never forwarded", async () => {
    const { push, upstreamCalls } = await setup();
    const res = await push(concat([await pushBody(), new Uint8Array([0x00])]));
    expect(await decode(res)).toContain("ng refs/heads/feature fleet: write proxy:");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("an unparseable request is 400", async () => {
    const { push, upstreamCalls } = await setup();
    expect((await push(enc.encode("zzzz"))).status).toBe(400);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("over the body cap = 413, declared or streamed", async () => {
    const { push } = await setup();
    expect((await push(enc.encode("0000"), { "content-length": String(PUSH_BODY_CAP + 1) })).status).toBe(413);
    const big = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < 17; i++) c.enqueue(new Uint8Array(1024 * 1024)); c.close(); },
    });
    expect((await push(big)).status).toBe(413);
  });

  it("a gzip request body is decompressed, scanned, and forwarded decompressed", async () => {
    const { push, upstreamCalls } = await setup();
    const body = await pushBody();
    const gz = new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    expect(await (await push(gz, { "content-encoding": "gzip" })).text()).toBe("upstream-report");
    expect(upstreamCalls[0].body).toEqual(body);
    expect(upstreamCalls[0].headers.get("content-encoding")).toBeNull();
  });

  it("an unknown content-encoding is refused", async () => {
    const { push } = await setup();
    expect((await push(await pushBody(), { "content-encoding": "br" })).status).toBe(415);
  });

  it("a confirmed-private work repo skips the scan", async () => {
    const { push, upstreamCalls } = await setup({ isPrivate: true });
    expect(await (await push(await pushBody({ msg: "acmeclient" }))).text()).toBe("upstream-report");
    expect(upstreamCalls).toHaveLength(1);
  });
});

// Issue #34: the proxy sees every ref a push moves, so it refuses the default
// branch itself -- update, force, delete -- which the in-container wrapper
// cannot guarantee (rebase -x, hooks, real git by path). Fail closed when the
// default branch cannot be read. Only operator config lifts it.
describe("handleGitProxy: default branch (issue #34)", () => {
  it("a push to the default branch is refused with a clear message; upstream never called", async () => {
    const { push, upstreamCalls } = await setup();
    const text = await decode(await push(await pushBody({ ref: "refs/heads/main" })));
    expect(text).toContain("ng refs/heads/main fleet: write proxy: refs/heads/main is the default branch");
    expect(upstreamCalls).toHaveLength(0);
  });

  // Refs #34: every command counts, not the first. A mutant checking only
  // the first ref survived.
  it("several refs, default branch NOT first: the whole push is refused", async () => {
    const { push, upstreamCalls } = await setup();
    const caps = "report-status side-band-64k ofs-delta agent=git/2.50";
    const body = concat([
      pkt(`${OLD} ${NEW} refs/heads/feature\0${caps}\n`),
      pkt(`${OLD} ${NEW} refs/heads/other\n`),
      pkt(`${OLD} ${NEW} refs/heads/main\n`),
      FLUSH,
      await makePack([{ type: 1, data: commit("clean change") }]),
    ]);
    const text = await decode(await push(body));
    expect(text).toContain("is the default branch");
    for (const ref of ["refs/heads/feature", "refs/heads/other", "refs/heads/main"]) expect(text).toContain(`ng ${ref}`);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("deleting the default branch is refused", async () => {
    const { push, upstreamCalls } = await setup();
    expect(await decode(await push(await pushBody({ del: true, ref: "refs/heads/main" })))).toContain("is the default branch");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("the repo's real default branch is what counts, not the word main", async () => {
    const { push, upstreamCalls } = await setup({ defaultBranch: "trunk" });
    expect(await decode(await push(await pushBody({ ref: "refs/heads/trunk" })))).toContain("is the default branch");
    expect(await (await push(await pushBody({ ref: "refs/heads/main" }))).text()).toBe("upstream-report");
    expect(upstreamCalls).toHaveLength(1);
  });

  it("default branch unknown: every push refused (fail closed)", async () => {
    const { push, upstreamCalls } = await setup({ defaultBranch: new Error("github down") });
    const text = await decode(await push(await pushBody()));
    expect(text).toContain("ng refs/heads/feature fleet: write proxy: cannot confirm the default branch");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("no report-status requested: a plain 403", async () => {
    const { push } = await setup();
    const res = await push(await pushBody({ ref: "refs/heads/main", caps: "ofs-delta" }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("default branch");
  });

  it("operator override (config) lets it through, lookup not needed", async () => {
    const { push, upstreamCalls } = await setup({ allowDefaultBranch: true, defaultBranch: new Error("never asked") });
    expect(await (await push(await pushBody({ ref: "refs/heads/main" }))).text()).toBe("upstream-report");
    expect(upstreamCalls).toHaveLength(1);
  });

  it("a feature push is unaffected (guard on)", async () => {
    const { push, upstreamCalls } = await setup();
    expect(await (await push(await pushBody())).text()).toBe("upstream-report");
    expect(upstreamCalls).toHaveLength(1);
  });
});

describe("defaultBranchCache (issue #34)", () => {
  it("one lookup per repo per TTL; a failure is never cached", async () => {
    let now = 0;
    let calls = 0;
    let fail = true;
    const get = defaultBranchCache(async () => { calls++; if (fail) throw new Error("502"); return "main"; }, 60_000, () => now);
    await expect(get("o/r")).rejects.toThrow("502");
    fail = false;
    expect(await get("o/r")).toBe("main");
    expect(await get("O/R")).toBe("main");
    expect(calls).toBe(2);
    now = 60_001;
    expect(await get("o/r")).toBe("main");
    expect(calls).toBe(3);
  });
});


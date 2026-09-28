import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const R = "2026-07-29-fixround";
const readH = { authorization: "Bearer read-tok" };
const writeH = { authorization: "Bearer write-tok" };

describe("worker", () => {
  it("401s without a token; read needs read token", async () => {
    expect((await SELF.fetch(`https://w/r/${R}`)).status).toBe(401);
    expect((await SELF.fetch(`https://w/r/${R}`, { headers: writeH })).status).toBe(401); // write can't read
    expect((await SELF.fetch(`https://w/r/${R}`, { headers: readH })).status).toBe(200);
  });

  it("write token PUTs an item, read GET sees it", async () => {
    await SELF.fetch(`https://w/r/${R}/item/xyz`, {
      method: "PUT", headers: { ...writeH, "content-type": "application/json" },
      body: JSON.stringify({ status: "approved", note: "ok" }),
    });
    const s: any = await (await SELF.fetch(`https://w/r/${R}`, { headers: readH })).json();
    expect(s.items.xyz.status).toBe("approved");
  });

  it("media roundtrips through R2", async () => {
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array([1, 2, 3, 4])], "s.png", { type: "image/png" }));
    const up = await SELF.fetch(`https://w/r/${R}/media?id=xyz`, { method: "POST", headers: writeH, body: fd });
    expect(up.status).toBe(200);
    const { key }: any = await up.json();
    const got = await SELF.fetch(`https://w/m/${encodeURIComponent(key)}`, { headers: readH });
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    // write token cannot read media
    expect((await SELF.fetch(`https://w/m/${encodeURIComponent(key)}`, { headers: writeH })).status).toBe(401);
  });

  // Fetch and FULLY DRAIN the body before returning the status. A response routed
  // from a DO stub must be consumed or vitest-pool-workers' isolated-storage teardown
  // can't confirm the DO's storage transaction closed — it fails the whole file with
  // "Isolated storage failed" (see the relay() comment in src/index.ts). Any test that
  // opens a NEW DO room and only asserts .status will trip this.
  const st = async (url: string, init?: RequestInit): Promise<number> => {
    const r = await SELF.fetch(url, init);
    await r.arrayBuffer();
    return r.status;
  };

  it("a scoped read token reaches only its own namespace", async () => {
    const scopedH = { authorization: "Bearer acme-read-tok" };
    // in-namespace: allowed
    expect(await st(`https://w/r/acme--spec-smoke`, { headers: scopedH })).toBe(200);
    // other repo's namespace: rejected
    expect(await st(`https://w/r/other--x`, { headers: scopedH })).toBe(401);
    // legacy unprefixed release: rejected for a scoped token, still open to the unscoped one
    expect(await st(`https://w/r/${R}`, { headers: scopedH })).toBe(401);
    expect(await st(`https://w/r/${R}`, { headers: readH })).toBe(200);
  });

  it("a scoped read token cannot read another namespace's media", async () => {
    const scopedH = { authorization: "Bearer acme-read-tok" };
    await env.MEDIA.put("other--x/shot.png", new Uint8Array([9, 9]));
    expect(await st(`https://w/m/${encodeURIComponent("other--x/shot.png")}`, { headers: scopedH })).toBe(401);
    await env.MEDIA.put("acme--spec-smoke/shot.png", new Uint8Array([9, 9]));
    expect(await st(`https://w/m/${encodeURIComponent("acme--spec-smoke/shot.png")}`, { headers: scopedH })).toBe(200);
  });

  it("a namespaced release id routes end to end", async () => {
    const NS = "acme--ns-route";
    expect(await st(`https://w/r/${NS}/item/i1`, {
      method: "PUT", headers: { ...writeH, "content-type": "application/json" },
      body: JSON.stringify({ status: "approved", note: "namespaced" }),
    })).toBe(200);
    const s: any = await (await SELF.fetch(`https://w/r/${NS}`, { headers: readH })).json();
    expect(s.items.i1.status).toBe("approved");
    expect(s.items.i1.note).toBe("namespaced");
  });

  it("preflight returns CORS", async () => {
    const res = await SELF.fetch(`https://w/r/${R}/item/xyz`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("serves the checklist page from R2 with the write token injected", async () => {
    await env.MEDIA.put(`pages/${R}.html`, "<html>tok=__WRITE_TOKEN__ end</html>");
    const res = await SELF.fetch(`https://w/c/${R}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("tok=write-tok end"); // REVIEW_WRITE_TOKEN (test env) injected
    expect(html).not.toContain("__WRITE_TOKEN__");
    expect((await SELF.fetch(`https://w/c/nope`)).status).toBe(404); // no page for release
  });
});

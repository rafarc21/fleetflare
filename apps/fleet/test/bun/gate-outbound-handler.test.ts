import { describe, it, expect } from "bun:test";
import {
  GATE_R2_HOST,
  handleGateOutbound,
  resolveOutboundTarget,
  type GateOutboundProps,
  type OutboundBucket,
} from "../../src/gate/outbound-handler";

const RUN_KEY = "gate/acme/example/runs/715/shard-typecheck.json";
const OTHER_RUN_KEY = "gate/acme/example/runs/716/shard-typecheck.json";
const BASELINE_KEY = "gate/acme/example/baselines/abc123-def456.tar";

/** The props a leg's container is registered with: its own result key only. */
const OWN: GateOutboundProps = { resultKey: RUN_KEY };

/** In-memory stand-in for the STUDIO_ARCHIVE binding. `put` returns null when
 *  an `etagDoesNotMatch: "*"` precondition finds the key already present,
 *  matching R2's own conditional-put contract. */
function fakeBucket(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const calls: Array<{ op: string; key: string; opts?: unknown }> = [];
  const bucket: OutboundBucket = {
    async get(key) {
      calls.push({ op: "get", key });
      const v = store.get(key);
      return v === undefined ? null : { body: new Response(v).body, size: v.length };
    },
    async head(key) {
      calls.push({ op: "head", key });
      const v = store.get(key);
      return v === undefined ? null : { size: v.length };
    },
    async put(key, value, opts) {
      calls.push({ op: "put", key, opts });
      if (opts?.onlyIf?.etagDoesNotMatch === "*" && store.has(key)) return null;
      store.set(key, await new Response(value).text());
      return { key };
    },
  };
  return { bucket, store, calls };
}

function req(method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}) {
  return new Request(`http://${GATE_R2_HOST}${path}`, { method, body: init.body, headers: init.headers });
}

describe("resolveOutboundTarget", () => {
  it("a run result key resolves to STUDIO_ARCHIVE + that key", () => {
    expect(resolveOutboundTarget(`/${RUN_KEY}`)).toEqual({ bucket: "STUDIO_ARCHIVE", key: RUN_KEY });
  });

  it("a baseline tarball key resolves the same way", () => {
    expect(resolveOutboundTarget(`/${BASELINE_KEY}`)).toEqual({ bucket: "STUDIO_ARCHIVE", key: BASELINE_KEY });
  });

  it("anything outside the gate/ prefix is refused, never authorized", () => {
    expect(resolveOutboundTarget("/caches/install/anything")).toBeNull();
    expect(resolveOutboundTarget("/studio/archive/secret.json")).toBeNull();
  });

  it("path traversal is refused even under the gate/ prefix", () => {
    expect(resolveOutboundTarget("/gate/acme/example/runs/../../../../x.json")).toBeNull();
    expect(resolveOutboundTarget("/gate/acme/../secret.tar")).toBeNull();
  });

  it("an empty or malformed path is refused", () => {
    expect(resolveOutboundTarget("")).toBeNull();
    expect(resolveOutboundTarget("/")).toBeNull();
    expect(resolveOutboundTarget("/gate/acme/example/runs/715/shard-typecheck.txt")).toBeNull();
    expect(resolveOutboundTarget("/gate/acme/example/other/thing.json")).toBeNull();
  });
});

describe("handleGateOutbound", () => {
  it("refuses a request whose host is not the gate R2 host", async () => {
    const { bucket } = fakeBucket();
    const res = await handleGateOutbound(new Request(`http://evil.example/${RUN_KEY}`), bucket, OWN);
    expect(res.status).toBe(403);
  });

  it("GET of an allowed baseline key streams the stored object", async () => {
    const { bucket } = fakeBucket({ [BASELINE_KEY]: "TARBYTES" });
    const res = await handleGateOutbound(req("GET", `/${BASELINE_KEY}`), bucket, OWN);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("TARBYTES");
  });

  it("GET of a missing allowed key is a 404, not a 500", async () => {
    const { bucket } = fakeBucket();
    expect((await handleGateOutbound(req("GET", `/${BASELINE_KEY}`), bucket, OWN)).status).toBe(404);
  });

  it("HEAD of an allowed key reports existence without a body", async () => {
    const { bucket } = fakeBucket({ [BASELINE_KEY]: "TARBYTES" });
    const res = await handleGateOutbound(req("HEAD", `/${BASELINE_KEY}`), bucket, OWN);
    expect(res.status).toBe(200);
  });

  it("PUT of a result JSON to its own runs/ key writes it write-once and returns 201", async () => {
    const { bucket, store, calls } = fakeBucket();
    const res = await handleGateOutbound(
      req("PUT", `/${RUN_KEY}`, { body: '{"state":"success"}', headers: { "content-type": "application/json" } }),
      bucket,
      OWN,
    );
    expect(res.status).toBe(201);
    expect(store.get(RUN_KEY)).toBe('{"state":"success"}');
    const put = calls.find((c) => c.op === "put");
    expect(put?.opts).toEqual({ onlyIf: { etagDoesNotMatch: "*" } });
  });

  it("a second PUT to the same result key is refused (412), never overwrites a verdict", async () => {
    const { bucket, store } = fakeBucket({ [RUN_KEY]: '{"state":"success"}' });
    const res = await handleGateOutbound(req("PUT", `/${RUN_KEY}`, { body: '{"state":"failure"}' }), bucket, OWN);
    expect(res.status).toBe(412);
    expect(store.get(RUN_KEY)).toBe('{"state":"success"}');
  });

  it("PUT to a baseline key is refused: PR code can read a baseline but never poison one", async () => {
    const { bucket, store } = fakeBucket();
    const res = await handleGateOutbound(req("PUT", `/${BASELINE_KEY}`, { body: "EVIL" }), bucket, OWN);
    expect(res.status).toBe(403);
    expect(store.has(BASELINE_KEY)).toBe(false);
  });

  it("PUT whose declared body is over the result-size cap is refused (413)", async () => {
    const { bucket, calls } = fakeBucket();
    const res = await handleGateOutbound(
      req("PUT", `/${RUN_KEY}`, { body: "x", headers: { "content-length": String(2 * 1024 * 1024) } }),
      bucket,
      OWN,
    );
    expect(res.status).toBe(413);
    expect(calls.length).toBe(0);
  });

  it("an unknown method is a 405 and touches nothing", async () => {
    const { bucket, calls } = fakeBucket();
    expect((await handleGateOutbound(req("DELETE", `/${RUN_KEY}`), bucket, OWN)).status).toBe(405);
    expect(calls.length).toBe(0);
  });

  it("a request outside the allow-list is a 403 and never reaches the bucket", async () => {
    const { bucket, calls } = fakeBucket();
    expect((await handleGateOutbound(req("GET", "/studio/archive/x"), bucket, OWN)).status).toBe(403);
    expect(calls.length).toBe(0);
  });
});

describe("PUT is scoped to the leg's own result key (GateOutbound props)", () => {
  it("a container with props for run A cannot PUT run B's key: 403, bucket untouched", async () => {
    const { bucket, store, calls } = fakeBucket();
    const res = await handleGateOutbound(req("PUT", `/${OTHER_RUN_KEY}`, { body: '{"state":"success"}' }), bucket, OWN);
    expect(res.status).toBe(403);
    expect(store.has(OTHER_RUN_KEY)).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("a container with props for run A can PUT its own key once (201), then 412", async () => {
    const { bucket, store } = fakeBucket();
    const first = await handleGateOutbound(req("PUT", `/${RUN_KEY}`, { body: '{"state":"success"}' }), bucket, OWN);
    expect(first.status).toBe(201);
    const second = await handleGateOutbound(req("PUT", `/${RUN_KEY}`, { body: '{"state":"failure"}' }), bucket, OWN);
    expect(second.status).toBe(412);
    expect(store.get(RUN_KEY)).toBe('{"state":"success"}');
  });

  it("a missing props value denies every write: no PUT reaches the bucket", async () => {
    const { bucket, store, calls } = fakeBucket();
    const res = await handleGateOutbound(req("PUT", `/${RUN_KEY}`, { body: '{"state":"success"}' }), bucket, undefined);
    expect(res.status).toBe(403);
    expect(store.has(RUN_KEY)).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("an empty resultKey in props denies every write", async () => {
    const { bucket, calls } = fakeBucket();
    const res = await handleGateOutbound(req("PUT", `/${RUN_KEY}`, { body: "{}" }), bucket, { resultKey: "" });
    expect(res.status).toBe(403);
    expect(calls.length).toBe(0);
  });

  it("props naming a baseline cannot authorize a PUT to that baseline", async () => {
    const { bucket, store } = fakeBucket();
    const res = await handleGateOutbound(req("PUT", `/${BASELINE_KEY}`, { body: "EVIL" }), bucket, {
      resultKey: BASELINE_KEY,
    });
    expect(res.status).toBe(403);
    expect(store.has(BASELINE_KEY)).toBe(false);
  });

  it("props naming a traversal path cannot authorize a PUT outside the allow-list", async () => {
    const traversal = "gate/acme/example/runs/715/../../../x.json";
    const { bucket, calls } = fakeBucket();
    const res = await handleGateOutbound(req("PUT", `/${traversal}`, { body: "{}" }), bucket, { resultKey: traversal });
    expect(res.status).toBe(403);
    expect(calls.length).toBe(0);
  });

  it("reads are not narrowed by props: a baseline GET still streams with run A's props", async () => {
    const { bucket } = fakeBucket({ [BASELINE_KEY]: "TARBYTES" });
    const res = await handleGateOutbound(req("GET", `/${BASELINE_KEY}`), bucket, OWN);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("TARBYTES");
  });

  it("a missing props value does not block reads of an allowed baseline", async () => {
    const { bucket } = fakeBucket({ [BASELINE_KEY]: "TARBYTES" });
    const res = await handleGateOutbound(req("GET", `/${BASELINE_KEY}`), bucket, undefined);
    expect(res.status).toBe(200);
  });
});

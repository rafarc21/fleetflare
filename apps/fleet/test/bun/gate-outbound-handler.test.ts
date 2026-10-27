import { describe, it, expect, spyOn } from "bun:test";
import {
  GATE_R2_HOST,
  handleGateOutbound,
  resolveOutboundTarget,
  type GateOutboundProps,
  type OutboundBucket,
} from "../../src/gate/outbound-handler";

const RUN_KEY = "gate/acme/example/runs/715/run-a/shard-typecheck.json";
const OTHER_RUN_KEY = "gate/acme/example/runs/715/run-b/shard-typecheck.json";
const BASELINE_KEY = "gate/acme/example/baselines/abc123-def456.tar";
/** A leg's retry log (#1063 flaky evidence) and a union leg's @head result (#1095). */
const RETRY_KEY = "gate/acme/example/runs/715/run-a/shard-typecheck.retry.json";
const HEAD_KEY = "gate/acme/example/runs/715/run-a/shard-typecheck@head.json";

/** The props a leg's container is registered with: its own result key only. */
const OWN: GateOutboundProps = { resultKey: RUN_KEY, repo: "acme/example" };

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
    async list({ prefix }) {
      calls.push({ op: "list", key: prefix });
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
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
    expect(resolveOutboundTarget("/gate/acme/example/runs/715/run-a/shard-typecheck.txt")).toBeNull();
    expect(resolveOutboundTarget("/gate/acme/example/other/thing.json")).toBeNull();
  });

  it("a result key without the per-run segment is refused (the pre-#1015 shape)", () => {
    expect(resolveOutboundTarget("/gate/acme/example/runs/715/shard-typecheck.json")).toBeNull();
  });

  it("a retry log key (shard-<leg>.retry.json) resolves to its own run key", () => {
    expect(resolveOutboundTarget(`/${RETRY_KEY}`)).toEqual({ bucket: "STUDIO_ARCHIVE", key: RETRY_KEY });
  });

  it("a union-leg head key (shard-<leg>@head.json) resolves to its own run key", () => {
    expect(resolveOutboundTarget(`/${HEAD_KEY}`)).toEqual({ bucket: "STUDIO_ARCHIVE", key: HEAD_KEY });
  });

  it("a head retry key (shard-<leg>@head.retry.json) resolves to its own run key", () => {
    const key = "gate/acme/example/runs/715/run-a/shard-typecheck@head.retry.json";
    expect(resolveOutboundTarget(`/${key}`)).toEqual({ bucket: "STUDIO_ARCHIVE", key });
  });

  it("a shard name outside the exact shape is refused: path separators, uppercase, other suffixes, repeats", () => {
    const prefix = "/gate/acme/example/runs/715/run-a/";
    for (const name of [
      "shard-a/b.json",
      "../x.json",
      "shard-Typecheck.json",
      "shard-typecheck.txt",
      "shard-typecheck.retry.txt",
      "shard-typecheck.retry.retry.json",
      "shard-typecheck@base.json",
      "shard-typecheck@head@head.json",
      "shard-typecheck@head.retry.retry.json",
    ]) {
      expect(resolveOutboundTarget(prefix + name)).toBeNull();
    }
  });
});

describe("PUT of a retry or head result key (write-once, leg's own key only)", () => {
  it("the leg's own retry log PUTs write-once (201)", async () => {
    const { bucket, store } = fakeBucket();
    const res = await handleGateOutbound(req("PUT", `/${RETRY_KEY}`, { body: "{}" }), bucket, { resultKey: RETRY_KEY, repo: "acme/example" });
    expect(res.status).toBe(201);
    expect(store.has(RETRY_KEY)).toBe(true);
  });

  it("the leg's own @head result PUTs write-once (201)", async () => {
    const { bucket, store } = fakeBucket();
    const res = await handleGateOutbound(req("PUT", `/${HEAD_KEY}`, { body: "{}" }), bucket, { resultKey: HEAD_KEY, repo: "acme/example" });
    expect(res.status).toBe(201);
    expect(store.has(HEAD_KEY)).toBe(true);
  });

  it("a retry key under props for the plain result key is refused (403), bucket untouched", async () => {
    const { bucket, calls } = fakeBucket();
    const res = await handleGateOutbound(req("PUT", `/${RETRY_KEY}`, { body: "{}" }), bucket, OWN);
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("a malformed shard name never reaches the bucket, even when props name it", async () => {
    const bad = "gate/acme/example/runs/715/run-a/shard-Typecheck.json";
    const { bucket, calls } = fakeBucket();
    const res = await handleGateOutbound(req("PUT", `/${bad}`, { body: "{}" }), bucket, { resultKey: bad, repo: "acme/example" });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("a retry step's own 2nd/3rd internal try (shard-<leg>.retry-try2.json) PUTs write-once (201) (#1398)", async () => {
    const key = "gate/acme/example/runs/715/run-a/shard-typecheck.retry-try2.json";
    const { bucket, store } = fakeBucket();
    const res = await handleGateOutbound(req("PUT", `/${key}`, { body: "{}" }), bucket, { resultKey: key, repo: "acme/example" });
    expect(res.status).toBe(201);
    expect(store.has(key)).toBe(true);
  });

  it("a DOUBLE .retry (shard-<leg>.retry.retry-try2.json) is still refused, same as the existing .retry.retry.json case", async () => {
    const bad = "gate/acme/example/runs/715/run-a/shard-typecheck.retry.retry-try2.json";
    const { bucket, calls } = fakeBucket();
    const res = await handleGateOutbound(req("PUT", `/${bad}`, { body: "{}" }), bucket, { resultKey: bad, repo: "acme/example" });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
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
    const res = await handleGateOutbound(req("PUT", `/${RUN_KEY}`, { body: "{}" }), bucket, { resultKey: "", repo: "acme/example" });
    expect(res.status).toBe(403);
    expect(calls.length).toBe(0);
  });

  it("props naming a baseline cannot authorize a PUT to that baseline", async () => {
    const { bucket, store } = fakeBucket();
    const res = await handleGateOutbound(req("PUT", `/${BASELINE_KEY}`, { body: "EVIL" }), bucket, {
      resultKey: BASELINE_KEY, repo: "acme/example",
    });
    expect(res.status).toBe(403);
    expect(store.has(BASELINE_KEY)).toBe(false);
  });

  it("props naming a traversal path cannot authorize a PUT outside the allow-list", async () => {
    const traversal = "gate/acme/example/runs/715/../../../x.json";
    const { bucket, calls } = fakeBucket();
    const res = await handleGateOutbound(req("PUT", `/${traversal}`, { body: "{}" }), bucket, {
      resultKey: traversal, repo: "acme/example",
    });
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

// #1343: a browser leg's spec evidence is written under its own evidence dir,
// and only by a browser leg (props.evidenceKey). Plain legs deny every
// evidence PUT; a browser leg never writes another leg's dir.
describe("evidence PUT: scoped to the browser leg's own evidence dir (#1343)", () => {
  const EVIDENCE = "gate/acme/example/runs/715/run-a/evidence/shard-e2e/console.json";
  const OTHER_EVIDENCE = "gate/acme/example/runs/715/run-a/evidence/shard-other/console.json";
  const EVIDENCE_DIR = "gate/acme/example/runs/715/run-a/evidence/shard-e2e/";

  it("an evidence key resolves to STUDIO_ARCHIVE, alongside results and baselines", () => {
    expect(resolveOutboundTarget(`/${EVIDENCE}`)).toEqual({ bucket: "STUDIO_ARCHIVE", key: EVIDENCE });
  });

  it("a browser leg PUTs its own evidence write-once (201), then 412", async () => {
    const { bucket, store } = fakeBucket();
    const props: GateOutboundProps = { resultKey: RUN_KEY, evidenceKey: EVIDENCE_DIR };
    const first = await handleGateOutbound(req("PUT", `/${EVIDENCE}`, { body: "{}" }), bucket, props);
    expect(first.status).toBe(201);
    expect(store.has(EVIDENCE)).toBe(true);
    const second = await handleGateOutbound(req("PUT", `/${EVIDENCE}`, { body: "{}" }), bucket, props);
    expect(second.status).toBe(412);
  });

  // #1381: the duplicate is logged per file so a harness notices its evidence
  // key collided on name — the 412 response itself is unchanged.
  it("logs the duplicate evidence key on 412, per file", async () => {
    const { bucket } = fakeBucket();
    const props: GateOutboundProps = { resultKey: RUN_KEY, evidenceKey: EVIDENCE_DIR };
    await handleGateOutbound(req("PUT", `/${EVIDENCE}`, { body: "{}" }), bucket, props);
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const second = await handleGateOutbound(req("PUT", `/${EVIDENCE}`, { body: "{}" }), bucket, props);
    expect(second.status).toBe(412);
    expect(logSpy).toHaveBeenCalledWith(`gate outbound: evidence already written ${EVIDENCE}`);
    logSpy.mockRestore();
  });

  it("a browser leg cannot PUT another leg's evidence dir (403)", async () => {
    const { bucket, calls } = fakeBucket();
    const res = await handleGateOutbound(req("PUT", `/${OTHER_EVIDENCE}`, { body: "{}" }), bucket, { resultKey: RUN_KEY, evidenceKey: EVIDENCE_DIR });
    expect(res.status).toBe(403);
    expect(calls.length).toBe(0);
  });

  it("a plain leg (no evidenceKey) denies every evidence PUT (403)", async () => {
    const { bucket, calls } = fakeBucket();
    const res = await handleGateOutbound(req("PUT", `/${EVIDENCE}`, { body: "{}" }), bucket, OWN);
    expect(res.status).toBe(403);
    expect(calls.length).toBe(0);
  });

  it("an evidence key with traversal or a non-shard name is refused", () => {
    expect(resolveOutboundTarget("/gate/acme/example/runs/715/run-a/evidence/../x.json")).toBeNull();
    expect(resolveOutboundTarget("/gate/acme/example/runs/715/run-a/evidence/shard-e2e.json/x")).toBeNull();
    expect(resolveOutboundTarget("/gate/acme/example/runs/715/run-a/evidence/x.json")).toBeNull();
  });

  it("GET of a stored evidence file streams it, independent of props", async () => {
    const { bucket } = fakeBucket({ [EVIDENCE]: "SCREENCAP" });
    const res = await handleGateOutbound(req("GET", `/${EVIDENCE}`), bucket, undefined);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("SCREENCAP");
  });
});

// #1343 HIGH3: a granted secret echoed into TEXT evidence is scrubbed before
// it reaches R2. Screenshots (binary) are never scanned.
describe("evidence PUT: text redaction (#1343 HIGH3)", () => {
  const DIR = "gate/acme/example/runs/715/run-a/evidence/shard-e2e/";
  const props: GateOutboundProps = { resultKey: RUN_KEY, evidenceKey: DIR, secretValues: ["sup3r-s3cret"] };

  it("redacts a secret value out of console JSON evidence before R2", async () => {
    const { bucket, store } = fakeBucket();
    const res = await handleGateOutbound(req("PUT", `/${DIR}console.json`, { body: '{"stdout":"token sup3r-s3cret leaked"}' }), bucket, props);
    expect(res.status).toBe(201);
    expect(store.get(`${DIR}console.json`)).toContain("«redacted»");
    expect(store.get(`${DIR}console.json`)).not.toContain("sup3r-s3cret");
  });

  it("a leg with no secretValues stores text evidence untouched", async () => {
    const { bucket, store } = fakeBucket();
    const plain: GateOutboundProps = { resultKey: RUN_KEY, evidenceKey: DIR };
    await handleGateOutbound(req("PUT", `/${DIR}console.json`, { body: '{"stdout":"ok"}' }), bucket, plain);
    expect(store.get(`${DIR}console.json`)).toBe('{"stdout":"ok"}');
  });

  it("image evidence is never text-scanned (screenshots cannot be redacted)", async () => {
    const { bucket, store } = fakeBucket();
    const res = await handleGateOutbound(req("PUT", `/${DIR}screenshot.png`, { body: "PNGBYTES" }), bucket, props);
    expect(res.status).toBe(201);
    expect(store.get(`${DIR}screenshot.png`)).toBe("PNGBYTES");
  });
});

// #1343 MED6: image evidence gets a larger cap than the 1 MiB result cap, and
// a leg may write at most MAX_EVIDENCE_FILES_PER_LEG per attempt dir.
describe("evidence PUT: size + file-count caps (#1343 MED6)", () => {
  const DIR = "gate/acme/example/runs/715/run-a/evidence/shard-e2e/";
  const props: GateOutboundProps = { resultKey: RUN_KEY, evidenceKey: DIR };

  it("a PNG over the 1 MiB result cap but under the image cap is accepted", async () => {
    const { bucket, store } = fakeBucket();
    // The image cap is 8 MiB; a 2 MiB declared body clears the image cap but
    // would exceed the 1 MiB text cap.
    const res = await handleGateOutbound(
      req("PUT", `/${DIR}shot.png`, { headers: { "content-length": String(2 * 1024 * 1024) } }),
      bucket, props,
    );
    expect(res.status).toBe(201);
  });

  it("a text file over 1 MiB is refused (413)", async () => {
    const { bucket, calls } = fakeBucket();
    const res = await handleGateOutbound(
      req("PUT", `/${DIR}console.json`, { headers: { "content-length": String(2 * 1024 * 1024) } }),
      bucket, props,
    );
    expect(res.status).toBe(413);
    // The file-cap list may have run, but no PUT ever reaches the bucket.
    expect(calls.some((c) => c.op === "put")).toBe(false);
  });

  it("a leg at the file cap is refused (413)", async () => {
    const seeded: Record<string, string> = {};
    for (let i = 0; i < 64; i++) seeded[`${DIR}file-${i}.txt`] = "x";
    const { bucket } = fakeBucket(seeded);
    const res = await handleGateOutbound(req("PUT", `/${DIR}one-more.txt`, { body: "y" }), bucket, props);
    expect(res.status).toBe(413);
  });
});

// #1343 r2 blocker 1: evidence JSON is walked whole — every string value,
// arrays kept as arrays, nested objects scrubbed, shape preserved.
describe("evidence PUT: deep JSON redaction (#1343 r2)", () => {
  const DIR = "gate/acme/example/runs/715/run-a/evidence/shard-e2e/";
  const props: GateOutboundProps = { resultKey: RUN_KEY, evidenceKey: DIR, secretValues: ["sup3r-s3cret"] };

  it("redacts a console probe array entry's text, keeping it an array", async () => {
    const { bucket, store } = fakeBucket();
    const body = JSON.stringify([{ type: "log", text: "token sup3r-s3cret leaked" }]);
    await handleGateOutbound(req("PUT", `/${DIR}console.json`, { body }), bucket, props);
    const stored = JSON.parse(store.get(`${DIR}console.json`)!);
    expect(Array.isArray(stored)).toBe(true);
    expect(stored[0].type).toBe("log");
    expect(stored[0].text).toContain("«redacted»");
    expect(stored[0].text).not.toContain("sup3r-s3cret");
  });

  it("redacts a nested object's text, shape preserved", async () => {
    const { bucket, store } = fakeBucket();
    const body = JSON.stringify({ messages: [{ text: "secret is sup3r-s3cret" }], count: 2 });
    await handleGateOutbound(req("PUT", `/${DIR}console.json`, { body }), bucket, props);
    const stored = JSON.parse(store.get(`${DIR}console.json`)!);
    expect(stored.messages[0].text).toContain("«redacted»");
    expect(stored.messages[0].text).not.toContain("sup3r-s3cret");
    expect(stored.count).toBe(2); // number untouched
    expect(Array.isArray(stored.messages)).toBe(true); // nested array stays array
  });

  it("preserves non-string scalars and null exactly", async () => {
    const { bucket, store } = fakeBucket();
    const body = JSON.stringify({ a: true, b: 5, c: null, d: [1, 2, 3] });
    await handleGateOutbound(req("PUT", `/${DIR}console.json`, { body }), bucket, props);
    expect(JSON.parse(store.get(`${DIR}console.json`)!)).toEqual({ a: true, b: 5, c: null, d: [1, 2, 3] });
  });
});

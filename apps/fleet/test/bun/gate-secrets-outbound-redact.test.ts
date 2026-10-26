// #1346: a leg's own result PUT (outbound-handler.ts) redacts every value in
// props.secretValues before the body reaches R2 -- this is the one place a
// granted secret echoed into a leg's stdout/stderr must never persist.
import { describe, it, expect } from "bun:test";
import { GATE_R2_HOST, handleGateOutbound, type GateOutboundProps, type OutboundBucket } from "../../src/gate/outbound-handler";

const RUN_KEY = "gate/acme/example/runs/715/run-a/shard-browser-e2e.json";

function fakeBucket(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const bucket: OutboundBucket = {
    async get(key) {
      const v = store.get(key);
      return v === undefined ? null : { body: new Response(v).body, size: v.length };
    },
    async head(key) {
      const v = store.get(key);
      return v === undefined ? null : { size: v.length };
    },
    async put(key, value, opts) {
      if (opts?.onlyIf?.etagDoesNotMatch === "*" && store.has(key)) return null;
      store.set(key, await new Response(value).text());
      return { key };
    },
  };
  return { bucket, store };
}

function req(method: string, path: string, body: string) {
  return new Request(`http://${GATE_R2_HOST}${path}`, { method, body });
}

describe("gate-scoped secrets are redacted from a leg's own result before R2", () => {
  it("scrubs a granted value that leaked into stdout", async () => {
    const { bucket, store } = fakeBucket();
    const props: GateOutboundProps = { resultKey: RUN_KEY, secretValues: ["sup3r-s3cret"] };
    const body = JSON.stringify({ state: "failure", stdout: "login failed with sup3r-s3cret" });
    const res = await handleGateOutbound(req("PUT", `/${RUN_KEY}`, body), bucket, props);
    expect(res.status).toBe(201);
    const stored = store.get(RUN_KEY) ?? "";
    expect(stored).not.toContain("sup3r-s3cret");
    expect(JSON.parse(stored).stdout).toBe("login failed with «redacted»");
  });

  it("a leg with no grants (no secretValues) is written through unchanged", async () => {
    const { bucket, store } = fakeBucket();
    const props: GateOutboundProps = { resultKey: RUN_KEY };
    const body = JSON.stringify({ state: "success", stdout: "all good" });
    await handleGateOutbound(req("PUT", `/${RUN_KEY}`, body), bucket, props);
    expect(store.get(RUN_KEY)).toBe(body);
  });

  it("does not redact a value this leg was never granted (no cross-leg scrub)", async () => {
    const { bucket, store } = fakeBucket();
    const props: GateOutboundProps = { resultKey: RUN_KEY, secretValues: ["this-legs-secret"] };
    const body = JSON.stringify({ state: "failure", stdout: "some-other-legs-secret appears here" });
    await handleGateOutbound(req("PUT", `/${RUN_KEY}`, body), bucket, props);
    expect(store.get(RUN_KEY)).toBe(body);
  });
});

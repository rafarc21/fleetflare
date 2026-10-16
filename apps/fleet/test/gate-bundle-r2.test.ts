// #1080 (review): the bundle PUT streams into a real R2 binding. R2 needs a
// stream of known length; the Bun fake bucket accepts any stream, so only this
// workerd test proves the upload is stored. The Workers runtime, not Bun.
import { describe, it, expect, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { handleGateOutbound, type GateOutboundProps } from "../src/gate/outbound-handler";

const KEY = `gate-bundles/acme/example/run-real/${"f".repeat(40)}.bundle`;
const PROPS: GateOutboundProps = {
  resultKey: "gate/acme/example/runs/7/run-real/shard-bundle.json", bundleKey: KEY, bundleWriter: true,
};
const BYTES = new TextEncoder().encode("bundle-bytes-for-real-r2");

function put(body: BodyInit, declared: number): Request {
  return new Request(`http://gate-r2.internal/${KEY}`, {
    method: "PUT", body, headers: { "content-length": String(declared) },
  });
}

afterEach(async () => { await env.STUDIO_ARCHIVE.delete(KEY); });

describe("bundle PUT into the real STUDIO_ARCHIVE binding (#1080 review)", () => {
  it("stores a streamed bundle whose length matches its declared content-length", async () => {
    const res = await handleGateOutbound(put(BYTES, BYTES.byteLength), env.STUDIO_ARCHIVE, PROPS);
    expect(res.status).toBe(201);
    expect((await env.STUDIO_ARCHIVE.head(KEY))?.size).toBe(BYTES.byteLength);
  });

  it("a body longer than its declared length stores nothing", async () => {
    const res = await handleGateOutbound(put(BYTES, BYTES.byteLength - 4), env.STUDIO_ARCHIVE, PROPS);
    expect(res.status).not.toBe(201);
    expect(await env.STUDIO_ARCHIVE.head(KEY)).toBeNull();
  });
});

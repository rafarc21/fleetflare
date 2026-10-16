// Issue #1147 (review round 2, maestro): a client-drop path only counts when
// workerd delivers the disconnect. These tests run the real pump under
// `wrangler dev` (workerd) and drop a live socket from the client side. A
// hand-made AbortController cannot stand in for that, so none is used here.
//
// Measured on workerd 1.20260730 (see the PR): a silent upstream sends nothing
// to the client after its first bytes, so a dropped client is only noticed
// through a write. The keepalive ping is that write. Without pings nothing
// reports the drop until the idle timer.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const FLEET = path.resolve(import.meta.dir, "../..");
const EXAMPLE_CONFIG = path.join(FLEET, "wrangler.example.jsonc");
const FLAGGED_CONFIG = "test/workerd/wrangler.jsonc";
const CONTROL_CONFIG = "test/workerd/wrangler.noflag.jsonc";

const flagsOf = (file: string): string[] =>
  (Bun.JSONC.parse(readFileSync(file, "utf8")) as { compatibility_flags?: string[] }).compatibility_flags ?? [];

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port as number;
  s.stop(true);
  return port;
}

async function startWrangler(configRel: string): Promise<{ url: string; stop: () => void }> {
  const port = await freePort();
  const proc = Bun.spawn(
    ["bunx", "wrangler", "dev", "--config", configRel, "--port", String(port), "--ip", "127.0.0.1",
      "--log-level", "error", "--show-interactive-dev-session=false"],
    { cwd: FLEET, stdout: "ignore", stderr: "ignore" },
  );
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/state`)).ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) { proc.kill(); throw new Error(`wrangler dev did not start (${configRel})`); }
    await Bun.sleep(300);
  }
  return { url, stop: () => proc.kill() };
}

type Row = { route: string; id: string; ok: boolean; failure?: string };

/** Opens one reply, lets it run 400ms, then drops the socket from the client side. */
async function dropClient(url: string, route: "stream" | "collect", id: string, pingMs: number) {
  const ac = new AbortController();
  const reply = fetch(`${url}/${route}?ping=${pingMs}&id=${id}`, { signal: ac.signal }).catch(() => undefined);
  await Bun.sleep(400);
  ac.abort();
  await reply;
}

/** The pump's row for one request id, polled until it shows up or `ms` passes. */
async function rowFor(url: string, id: string, ms: number): Promise<Row | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const { results } = (await (await fetch(`${url}/state`)).json()) as { results: Row[] };
    const row = results.find((r) => r.id === id);
    if (row || Date.now() > deadline) return row;
    await Bun.sleep(50);
  }
}

describe("client drop under workerd (issue #1147, review round 2)", () => {
  it("the example config enables request signals, and the fixture config matches it", () => {
    expect(flagsOf(EXAMPLE_CONFIG)).toContain("enable_request_signal");
    expect(flagsOf(path.join(FLEET, FLAGGED_CONFIG))).toEqual(flagsOf(EXAMPLE_CONFIG));
  });

  describe("flagged worker (wrangler.jsonc)", () => {
    let url = "";
    let stop = () => {};
    beforeAll(async () => {
      ({ url, stop } = await startWrangler(FLAGGED_CONFIG));
    }, 150_000);
    afterAll(() => stop());

    it("a silent stream with keepalive: a dropped client ends the real pump as client_abort within 2s", async () => {
      await dropClient(url, "stream", "keepalive-on", 50);
      const row = await rowFor(url, "keepalive-on", 2_000);
      expect(row).toMatchObject({ ok: false, failure: "client_abort" });
    }, 20_000);

    it("a silent stream without keepalive: nothing reports the drop within 3s (the control; pings are the detector)", async () => {
      await dropClient(url, "stream", "keepalive-off", 0);
      expect(await rowFor(url, "keepalive-off", 3_000)).toBeUndefined();
    }, 20_000);

    it("a non-streaming reply with keepalive: workerd reports no drop before the reply (characterizes the 499 branch)", async () => {
      await dropClient(url, "collect", "collect-on", 50);
      expect(await rowFor(url, "collect-on", 3_000)).toBeUndefined();
    }, 20_000);
  });

  describe("no-flag control worker (wrangler.noflag.jsonc)", () => {
    let url = "";
    let stop = () => {};
    beforeAll(async () => {
      ({ url, stop } = await startWrangler(CONTROL_CONFIG));
    }, 150_000);
    afterAll(() => stop());

    it("the bounded keepalive write still detects a dropped client without the request-signal flag", async () => {
      await dropClient(url, "stream", "noflag-on", 50);
      const row = await rowFor(url, "noflag-on", 2_000);
      expect(row).toMatchObject({ ok: false, failure: "client_abort" });
    }, 20_000);
  });
});

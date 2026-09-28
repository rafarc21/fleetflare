// Fresh review of PR #359 round 2, Finding 1 (most severe): Bun's own
// `fetch` carries a HARDCODED, non-configurable ~300s connection ceiling
// that `AbortSignal.timeout` alone does NOT extend or override — every
// `rescue-all` studio whose real rescue took anywhere close to its own
// server-side budget (up to ~307s: EXEC_CLASSES.rescue's 300s + sbExec's
// own 7s DEADLINE_SLACK_MS) was reported as a false client-side TIMEOUT
// before the server's real answer ever reached the CLI, because Bun's own
// ceiling fired first — regardless of the caller's own longer
// `AbortSignal.timeout(360_000)`.
//
// What this file DOES prove, fast and live (a real Bun.serve server, a real
// unmocked `fetch` — never a mock):
//   1. `rescueFetchInit` (cli/fleet.ts) genuinely sets `timeout: false` on
//      the returned init object — a fast, deterministic, source-level check
//      that the fix is actually present in the shipped code (not merely
//      described in a comment).
//   2. That init object, used against a REAL local HTTP server that delays
//      its response, is genuinely usable — a real, live fetch call
//      completes normally and returns the real response body, proving
//      `timeout: false` does not itself break or disable fetch.
//   3. The caller's OWN `signal` still genuinely governs abort timing when
//      `timeout: false` is set — a short signal against a slower real
//      server still aborts at (approximately) the signal's own duration,
//      not later and not never.
//
// What this file does NOT and CANNOT directly re-prove at CI speed: that
// `timeout: false` is the thing standing between "Bun's own ~300s ceiling
// fires" and "our own, deliberately-longer signal governs instead". That
// specific claim requires a real request that would otherwise run PAST
// Bun's ~300-SECOND hardcoded ceiling to see the difference — literally
// waiting five-plus minutes per assertion, impractical for this suite (and
// for a mutation mutation-testing round: RED+GREEN would cost 10+ minutes).
// It WAS verified live, once, outside this committed suite, immediately
// before writing this fix (see this fix's own commit message / the #359
// plan doc for the transcript): a fetch with `signal:
// AbortSignal.timeout(310_000)` and no `timeout` field, against a real
// local server (its own idle timeout disabled) delaying 305s, died at
// ~300005ms with `TimeoutError` — discarding the real response that would
// have landed 5 real seconds later. The IDENTICAL call with `timeout: false`
// added waited the full ~305000ms and returned the real response. Bun's own
// published TypeScript types (`BunFetchRequestInit`, bun-types) do not
// document a `timeout` field at all — this is real, respected runtime
// behavior confirmed by direct measurement, not documented API surface.
import { afterEach, expect, test } from "bun:test";
import { cmdRescueAll, rescueFetchInit, type Credentials } from "../../cli/fleet";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});

function slowServer(delayMs: number, body = "ok"): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    idleTimeout: 0, // Bun.serve's own default idle timeout (10s) would otherwise
                     // kill the connection server-side before any of these tests'
                     // own short client-side signals get a chance to matter.
    async fetch(req, srv) {
      srv.timeout(req, 0);
      await new Promise((r) => setTimeout(r, delayMs));
      return new Response(body);
    },
  });
}

test("rescueFetchInit sets timeout:false — the flag that disables Bun's own hardcoded fetch ceiling", () => {
  const init = rescueFetchInit({ "X-Test": "1" }, 5_000);
  expect(init.timeout).toBe(false);
  expect(init.method).toBe("POST");
  expect(init.headers).toEqual({ "X-Test": "1" });
  expect(init.signal).toBeInstanceOf(AbortSignal);
});

test("a real, live fetch using rescueFetchInit's own init genuinely completes against a real (slow) server", async () => {
  server = slowServer(150);
  const res = await fetch(server.url.toString(), rescueFetchInit({}, 5_000));
  expect(res.ok).toBe(true);
  expect(await res.text()).toBe("ok");
});

test("the caller's own signal still genuinely governs abort timing with timeout:false set — a short budget still aborts on a slower real server", async () => {
  server = slowServer(2_000);
  const start = performance.now();
  await expect(fetch(server.url.toString(), rescueFetchInit({}, 200))).rejects.toMatchObject({ name: "TimeoutError" });
  const elapsed = performance.now() - start;
  // Bounded well under the server's own 2s delay — proves OUR signal (not
  // the server, not Bun's own ~300s default) is what aborted this call.
  expect(elapsed).toBeLessThan(1_000);
});

/**
 * Fresh review of PR #359 round 2, Blocker 2: the three tests above only ever
 * exercise `rescueFetchInit` directly — they prove the FUNCTION sets
 * `timeout: false`, but nothing proves `cmdRescueAll`'s own real fetch call
 * (cli/fleet.ts) actually BUILDS its init by calling that function. An inline
 * object literal at that call site instead (silently dropping `timeout:
 * false`, e.g. a future edit that didn't know why it mattered) would leave
 * every test in this file, and every test in rescue-all-scope.test.ts (which
 * only ever exercises a FAKE `rescueStudio`, never this real fetch wiring at
 * all), green.
 *
 * `cmdRescueAll` is exported specifically for this test (see its own doc
 * comment in cli/fleet.ts): the same "spy on `globalThis.fetch`, call the
 * real production function" seam this codebase already uses throughout (e.g.
 * test/bun/ff-file-task-retry.test.ts's own `fileTask`), rather than a new
 * pattern.
 *
 * Bite-proof (2026-09-26): with `timeout: false` temporarily removed from
 * `rescueFetchInit`'s own return object, this test went RED — `capturedInit
 * ?.timeout` read `undefined` instead of `false` — while the pre-existing
 * "rescueFetchInit sets timeout:false" test above (which calls
 * `rescueFetchInit` directly, not through `cmdRescueAll`) stayed GREEN, and
 * all 24 pre-round-2-review tests across this file plus
 * rescue-all-scope.test.ts stayed green throughout — confirming this is a
 * genuinely NEW assertion, not a duplicate of existing coverage. Restored,
 * re-confirmed GREEN.
 */
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const creds: Credentials = { workerUrl: "https://board.example", accessClientId: "id", accessClientSecret: "secret" };

test("cmdRescueAll's real fetch call to a studio's /rescue route is built via rescueFetchInit — carries timeout:false, not an inline init that silently dropped it", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/studio/")) return Response.json([{ id: "acme--pilot", state: "running" }]);
    return Response.json({ ok: true, pushes: [] });
  }) as typeof fetch;

  await cmdRescueAll(creds, { repo: null, dryRun: false });

  const rescueCall = calls.find((c) => c.url.includes("/rescue"));
  expect(rescueCall).toBeDefined();
  expect(rescueCall?.init).toMatchObject({ method: "POST", timeout: false });
  expect((rescueCall?.init as { signal?: AbortSignal } | undefined)?.signal).toBeInstanceOf(AbortSignal);
});

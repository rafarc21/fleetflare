import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { reconnectDelayMs, nextAttempt, attachRefusal } from "../cli/backoff";

describe("reconnectDelayMs", () => {
  it("attempt 1 falls in [500,625] — base 500ms, plus-only jitter up to +25%", () => {
    expect(reconnectDelayMs(1, () => 0)).toBe(500);
    expect(reconnectDelayMs(1, () => 1)).toBe(625);
  });

  it("attempt 2 falls in [1000,1250] — exponential doubling", () => {
    expect(reconnectDelayMs(2, () => 0)).toBe(1000);
    expect(reconnectDelayMs(2, () => 1)).toBe(1250);
  });

  it("attempt 20 stays at or under 12_500 — cap 10_000 plus jitter, not unbounded growth", () => {
    expect(reconnectDelayMs(20, () => 1)).toBe(12_500);
    expect(reconnectDelayMs(20, () => 0)).toBe(10_000);
  });

  it("rnd: () => 0 gives the exact doubling sequence 500/1000/2000/4000/8000, capped at 10_000 from attempt 6 on", () => {
    const zero = () => 0;
    expect(reconnectDelayMs(1, zero)).toBe(500);
    expect(reconnectDelayMs(2, zero)).toBe(1000);
    expect(reconnectDelayMs(3, zero)).toBe(2000);
    expect(reconnectDelayMs(4, zero)).toBe(4000);
    expect(reconnectDelayMs(5, zero)).toBe(8000);
    expect(reconnectDelayMs(6, zero)).toBe(10_000);
    expect(reconnectDelayMs(7, zero)).toBe(10_000);
  });

  it("cap holds indefinitely — a very large attempt number never exceeds 12_500 and never overflows", () => {
    expect(reconnectDelayMs(1000, () => 0)).toBe(10_000);
    expect(reconnectDelayMs(1000, () => 1)).toBe(12_500);
  });

  it("jitter is plus-only — never returns less than the unjittered exponential value", () => {
    for (const attempt of [1, 2, 3, 6, 20]) {
      const floor = reconnectDelayMs(attempt, () => 0);
      const withJitter = reconnectDelayMs(attempt, () => 0.5);
      expect(withJitter).toBeGreaterThanOrEqual(floor);
    }
  });

  it("defaults to real randomness when rnd is omitted, always within the jittered bounds", () => {
    for (let i = 0; i < 50; i++) {
      const d1 = reconnectDelayMs(1);
      expect(d1).toBeGreaterThanOrEqual(500);
      expect(d1).toBeLessThanOrEqual(625);
      const d20 = reconnectDelayMs(20);
      expect(d20).toBeGreaterThanOrEqual(10_000);
      expect(d20).toBeLessThanOrEqual(12_500);
    }
  });
});

// P1 T10 ledger / P2 ride-along: a connection that closes within 5s of
// opening must NOT reset the reconnect counter — otherwise an open-then-1011
// studio (server accepts the WS, then kills it almost immediately, e.g. a
// crash-looping pty) gets hammered at the ~500ms base delay forever instead
// of backing off, because the OLD code reset `attempt` to 0 unconditionally
// on every "open" event, regardless of how quickly that connection then
// died.
describe("nextAttempt", () => {
  it("connection lifetime at/above the 5s floor resets to 0, regardless of prevAttempt", () => {
    expect(nextAttempt(0, 5000)).toBe(0);
    expect(nextAttempt(1, 5000)).toBe(0);
    expect(nextAttempt(7, 9999)).toBe(0);
    expect(nextAttempt(7, 600_000)).toBe(0); // a healthy connection open for 10 minutes
  });

  it("connection lifetime below the 5s floor carries prevAttempt forward unchanged", () => {
    expect(nextAttempt(0, 4999)).toBe(0);
    expect(nextAttempt(1, 50)).toBe(1);
    expect(nextAttempt(4, 0)).toBe(4); // never opened at all (e.g. connection refused)
  });

  it("the floor is inclusive at exactly 5000ms", () => {
    expect(nextAttempt(3, 5000)).toBe(0);
    expect(nextAttempt(3, 4999)).toBe(3);
  });
});

describe("backoff progresses across fast-close cycles (the bug this closes)", () => {
  it("an open-then-instant-close loop backs off exponentially instead of hammering at the base delay forever", () => {
    // Mirrors cli/fleet.ts's reconnect loop: attempt = nextAttempt(attempt,
    // lifetimeMs) + 1, then delay = reconnectDelayMs(attempt) — each cycle
    // "opens" and dies again after 50ms, well under the 5s floor.
    let attempt = 0;
    const delays: number[] = [];
    for (let cycle = 0; cycle < 5; cycle++) {
      const lifetimeMs = 50;
      attempt = nextAttempt(attempt, lifetimeMs) + 1;
      delays.push(reconnectDelayMs(attempt, () => 0)); // zero jitter: pin exact values
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000]); // strictly increasing, doubling — never flat at 500
  });

  it("a connection that finally survives past the floor resets the run back to the base delay", () => {
    let attempt = 0;
    for (let cycle = 0; cycle < 4; cycle++) {
      attempt = nextAttempt(attempt, 50) + 1; // 4 fast-close cycles: attempt climbs to 4
    }
    expect(attempt).toBe(4);

    attempt = nextAttempt(attempt, 600_000) + 1; // this connection stayed up 10 minutes, then dropped
    expect(attempt).toBe(1); // back to the first attempt, not still climbing from 4
    expect(reconnectDelayMs(attempt, () => 0)).toBe(500);
  });
});

// page/terminal.template.html ships as one static file with no bundler of
// its own (see that file's own header comment) — its copy of nextAttempt is
// hand-inlined, the same way it already hand-inlines reconnectDelayMs. Pinned
// here (source-pin, same technique test/container.args.test.ts's argv pin
// and test/studio.session.test.ts's bring-up-script pins already use for
// text that can't be imported/exercised directly) so a future edit to
// either side's copy without updating the other fails a test immediately,
// instead of silently drifting.
describe("nextAttempt — page mirror (source-pin, terminal.template.html)", () => {
  it("terminal.template.html inlines the identical 3-line nextAttempt body", () => {
    expect(env.TEST_TERMINAL_TEMPLATE_SRC).toContain(
      "function nextAttempt(prevAttempt, connLifetimeMs) {\n" +
        "    return connLifetimeMs >= 5000 ? 0 : prevAttempt;\n" +
        "  }",
    );
  });
});

// Issue #123: a stopped or destroying studio answers the terminal route with a
// 409 refusal instead of booting a container. The attach client must stop on
// it — before this, it reconnected forever, and each reconnect was a start.
describe("attachRefusal — fleet attach stops on the studio's refusal", () => {
  const body = JSON.stringify({ code: "STUDIO_STOPPED", message: "studio x is stopped — `ff x` to start it", httpStatus: 409 });

  it("409 answers the refusal's own message", async () => {
    expect(await attachRefusal(async () => new Response(body, { status: 409 }))).toBe("studio x is stopped — `ff x` to start it");
  });

  it("409 with a non-JSON body still refuses, with the raw text", async () => {
    expect(await attachRefusal(async () => new Response("nope", { status: 409 }))).toBe("nope");
  });

  it.each([426, 503, 500, 401])("%i is not a refusal — keep reconnecting", async (status) => {
    expect(await attachRefusal(async () => new Response("x", { status }))).toBeNull();
  });

  it("a probe that cannot connect is not a refusal — keep reconnecting", async () => {
    expect(await attachRefusal(async () => { throw new Error("offline"); })).toBeNull();
  });

  it("cli/fleet.ts's reconnect loop consults it and exits non-zero", () => {
    const src = env.TEST_CLI_FLEET_SRC;
    const from = src.indexOf("const { outcome, lifetimeMs } = await connectOnce();");
    const loop = src.slice(from, src.indexOf("process.exit(0);", from));
    expect(loop).toMatch(/const refusal = await attachRefusal\(/);
    expect(loop).toMatch(/if \(refusal !== null\) \{[\s\S]*?process\.exit\(1\);/);
  });

  it("the probe carries a 5s timeout, so a hung probe keeps reconnecting instead of hanging", () => {
    const src = env.TEST_CLI_FLEET_SRC;
    const from = src.indexOf("const refusal = await attachRefusal(");
    expect(src.slice(from, src.indexOf("process.exit(1);", from))).toContain("signal: AbortSignal.timeout(5000)");
  });

  it("connectOnce gives up on an upgrade that never opens (a pending attach hangs forever otherwise)", () => {
    const src = env.TEST_CLI_FLEET_SRC;
    const from = src.indexOf("function connectOnce()");
    const body = src.slice(from, src.indexOf("function waitOrExit(", from));
    const timer = body.slice(body.indexOf("const connectTimer = setTimeout("), body.indexOf("}, ATTACH_CONNECT_TIMEOUT_MS);"));
    expect(timer).toContain("if (openedAt === null) {");
    expect(timer).toContain('finish("closed");');
  });
});

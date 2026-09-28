// #151 — `fleet attach` liveness. Drives the REAL cli/fleet.ts as a
// subprocess against a local fake Worker (HOME -> temp dir whose
// ~/.fleet/credentials names the fake). Measured 2026-09-24: a joiner went
// silent on its first frame while the TCP stayed ESTABLISHED for hours, and
// the CLI showed that frozen frame with no hint it was stale.
//
// Production change each test pins:
//   T1: frame-age watchdog — a connected socket silent for
//       FLEET_ATTACH_STALE_MS is declared stale (with its age) and replaced.
//   T2: connect timeout — an upgrade that never answers is abandoned after
//       FLEET_ATTACH_CONNECT_TIMEOUT_MS and retried.
//   T3: the terminal title says "live" on open and "STALE <age> since
//       <HH:MM:SS>Z" once the view goes stale.
//   T4: a frame every 300ms with a 1500ms stale threshold never goes stale —
//       pins that a real frame resets the watchdog's lastFrameAt.
//
// T1/T3 use a hand-rolled raw-TCP zombie, not Bun.serve's own WebSocket
// server: Bun.serve answers a client's close frame with its own close frame
// automatically, which never exercises the production failure (a joiner's
// TCP leg stays ESTABLISHED for hours, answering NOTHING — not even a close).
// The raw server upgrades, sends one frame, and then silently swallows every
// byte it receives afterward, including the CLI's own close(4000, ...) frame.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { attachTitle } from "../../cli/attach-liveness";

const CLI = join(import.meta.dir, "../../cli/fleet.ts");
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function fakeHome(workerUrl: string): string {
  const home = mkdtempSync(join(tmpdir(), "attach-liveness-"));
  mkdirSync(join(home, ".fleet"));
  const p = join(home, ".fleet", "credentials");
  writeFileSync(p, JSON.stringify({ workerUrl, accessClientId: "x", accessClientSecret: "y" }));
  chmodSync(p, 0o600);
  return home;
}

function runAttach(home: string, extraEnv: Record<string, string>) {
  // Inherited ORCA_* would make any Orca-aware path shell the real orca.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ORCA_")));
  const proc = Bun.spawn(["bun", CLI, "attach", "websites--pilot"], {
    env: { ...base, HOME: home, ...extraEnv },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  cleanups.push(() => { try { proc.kill(); } catch {} });
  let err = "";
  let out = "";
  (async () => { for await (const c of proc.stderr) err += new TextDecoder().decode(c); })();
  (async () => { for await (const c of proc.stdout) out += new TextDecoder().decode(c); })();
  return { proc, stderr: () => err, stdout: () => out };
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function wsTextFrame(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const header =
    payload.length < 126
      ? [0x81, payload.length]
      : [0x81, 126, (payload.length >> 8) & 0xff, payload.length & 0xff];
  return new Uint8Array([...header, ...payload]);
}

/** Zombie: upgrades by hand, sends ONE frame, then swallows every byte it
 *  receives afterward — including a close frame — while keeping the TCP
 *  connection ESTABLISHED. This is the exact prod shape (issue #151): no
 *  webSocketMessage, no close, nothing, ever, on that socket again. */
function zombieWorker() {
  let upgrades = 0;
  const sockets = new Set<import("bun").Socket>();
  const upgraded = new WeakSet<import("bun").Socket>();
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) { sockets.add(socket); },
      data(socket, data) {
        // Any byte on an already-upgraded socket (incl. the CLI's own close
        // frame) is swallowed and never answered — the exact prod shape.
        if (upgraded.has(socket)) return;
        const text = new TextDecoder().decode(data);
        const key = /Sec-WebSocket-Key:\s*(\S+)/i.exec(text)?.[1];
        if (key === undefined) {
          // The CLI's plain-GET refusal probe (attachRefusal) — answered
          // immediately, same as the old Bun.serve zombie, so the watchdog's
          // reconnect isn't mistaken for a second hang on THIS request.
          socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
          socket.end();
          return;
        }
        upgrades++;
        upgraded.add(socket);
        const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        socket.write(wsTextFrame("frame-at-open"));
      },
      close(socket) { sockets.delete(socket); },
    },
  });
  cleanups.push(() => {
    for (const socket of sockets) { try { socket.end(); } catch { /* already gone */ } }
    server.stop(true);
  });
  return { url: `http://127.0.0.1:${server.port}`, upgrades: () => upgrades };
}

/** A well-behaved server that sends a real frame every `intervalMs` — the
 *  live-view case T4 pins: never stale, exactly one upgrade. */
function tickingWorker(intervalMs: number) {
  let upgrades = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) { upgrades++; if (srv.upgrade(req)) return; return new Response("no", { status: 400 }); },
    websocket: {
      open(ws) {
        const timer = setInterval(() => {
          if (ws.readyState === 1) ws.send(new TextEncoder().encode("tick"));
        }, intervalMs);
        cleanups.push(() => clearInterval(timer));
      },
      message() {},
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, upgrades: () => upgrades };
}

test("T1: a connected socket that goes silent is declared stale (with its age) and replaced", async () => {
  const w = zombieWorker();
  const { stderr } = runAttach(fakeHome(w.url), { FLEET_ATTACH_STALE_MS: "1500" });
  await Bun.sleep(5000);
  expect(w.upgrades()).toBeGreaterThanOrEqual(2);
  expect(stderr()).toMatch(/no output for \d+s/);
}, 15000);

test("T2: an upgrade that never answers is abandoned and retried", async () => {
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch() { requests++; return new Promise<Response>(() => {}); } });
  cleanups.push(() => server.stop(true));
  runAttach(fakeHome(`http://127.0.0.1:${server.port}`), { FLEET_ATTACH_CONNECT_TIMEOUT_MS: "1000" });
  await Bun.sleep(4000);
  expect(requests).toBeGreaterThanOrEqual(2);
}, 15000);

test("T3: the terminal title waits for the first frame, reads live once it arrives, then STALE with age and since", async () => {
  const w = zombieWorker();
  const { stdout } = runAttach(fakeHome(w.url), { FLEET_ATTACH_STALE_MS: "1500" });
  await Bun.sleep(4000);
  expect(stdout()).toContain("\x1b]0;fleet websites--pilot · waiting for first frame\x07");
  expect(stdout()).toContain("\x1b]0;fleet websites--pilot · live\x07");
  expect(stdout()).toMatch(/\x1b\]0;fleet websites--pilot · STALE \d+s since \d\d:\d\d:\d\dZ\x07/);
}, 15000);

test("T5: a socket that opens and then never sends a single frame never claims live", async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) { requests++; if (srv.upgrade(req)) return; return new Response("no", { status: 400 }); },
    websocket: { open() {}, message() {} }, // opens, then silent forever — no frame, ever
  });
  cleanups.push(() => server.stop(true));
  const { stdout } = runAttach(fakeHome(`http://127.0.0.1:${server.port}`), { FLEET_ATTACH_STALE_MS: "1500" });
  await Bun.sleep(3000);
  expect(stdout()).toContain("\x1b]0;fleet websites--pilot · waiting for first frame\x07");
  expect(stdout()).not.toContain("\x1b]0;fleet websites--pilot · live\x07");
}, 15000);

test("T4: a live view that keeps getting frames never goes stale and never reconnects", async () => {
  const w = tickingWorker(300);
  const { stderr } = runAttach(fakeHome(w.url), { FLEET_ATTACH_STALE_MS: "1500" });
  await Bun.sleep(4000);
  expect(stderr()).not.toMatch(/no output for \d+s/);
  expect(w.upgrades()).toBe(1);
}, 15000);

test("attachTitle formats waiting, live and stale states", () => {
  expect(attachTitle("a--b", "waiting")).toBe("fleet a--b · waiting for first frame");
  expect(attachTitle("a--b", "live")).toBe("fleet a--b · live");
  const since = Date.parse("2026-09-24T17:50:00.400Z");
  expect(attachTitle("a--b", { since, now: since + 95_000 })).toBe("fleet a--b · STALE 95s since 17:50:00Z");
});

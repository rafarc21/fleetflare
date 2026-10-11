import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonEndpoint } from "./endpoint";
import { type EgoBrowserPaths, resolvePaths } from "./paths";
import { encodeMessage, isRpcFailure, MessageFramer, type RpcResponse } from "./rpc";

const DAEMON_PATH = join(dirname(fileURLToPath(import.meta.url)), "daemon.ts");

const DAEMON_STARTUP_TIMEOUT_MS = 20000;
const DAEMON_POLL_INTERVAL_MS = 100;
const DEFAULT_CALL_TIMEOUT_MS = 60000;

/**
 * Ensures a daemon is running and its socket is live, spawning one if not.
 * Failure chain per the design doc: stale pidfile, dead pid, or an
 * unresponsive socket all fall through to "clean up and spawn fresh" --
 * never a silent no-op, and a daemon that never comes up fails loudly
 * rather than hanging forever.
 *
 * Concurrent callers (two `ego-browser` invocations racing before any
 * daemon exists, or two concurrent RPC calls from the same process before
 * the first one has finished spawning) must NOT each spawn their own
 * daemon+Chromium -- see DaemonEndpoint.claimSpawnLock. Only the process
 * that wins the spawn claim touches the pidfile/sockfile cleanup and the
 * actual spawn; every loser just polls for the winner's socket to come up.
 */
export async function ensureDaemonAlive(paths: EgoBrowserPaths = resolvePaths()): Promise<void> {
  mkdirSync(paths.home, { recursive: true });
  const endpoint = new DaemonEndpoint(paths);

  if (await endpoint.isAlive()) return;

  const deadline = Date.now() + DAEMON_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // Always check for an already-live daemon BEFORE ever attempting to
    // claim the spawn lock -- crucial ordering, not just an optimization.
    // The winner releases its claim the instant ITS OWN probeConnect
    // succeeds (see below), which reopens a window where a loser could
    // otherwise grab the now-free lock and needlessly spawn a second
    // daemon on top of the one that just came up. Checking "is someone
    // already reachable?" first closes that window: once a daemon is
    // live, every other caller returns here and never touches the lock at
    // all, regardless of how the claim/release timing lines up.
    if (await endpoint.probeConnect()) return;

    if (endpoint.claimSpawnLock()) {
      try {
        // Re-check immediately after winning the claim: closes the same
        // window from the other side, in case a daemon became reachable
        // in the gap between the probeConnect above and actually winning
        // the lock.
        if (await endpoint.probeConnect()) return;

        // Stale (or absent) -- clean up whatever is left and spawn fresh.
        // Safe to do here (and only here): we hold the spawn claim, so no
        // other racing caller can be mid-spawn right now for this cleanup
        // to pull the rug out from under.
        endpoint.removePidAndSockFiles();

        const child = spawn(process.execPath, [DAEMON_PATH], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, EGO_BROWSER_HOME: paths.home },
        });
        child.unref();

        while (Date.now() < deadline) {
          if (await endpoint.probeConnect()) return;
          await new Promise((r) => setTimeout(r, DAEMON_POLL_INTERVAL_MS));
        }
        break; // timed out waiting on our own spawn -- fall through to the error below
      } finally {
        // Release the claim regardless of outcome -- on failure this also
        // lets a would-be loser retry the spawn itself instead of being
        // stuck forever behind a claim nobody will ever release.
        endpoint.releaseSpawnLock();
      }
    }

    // Someone else currently holds the spawn claim -- wait for their
    // daemon's socket rather than also spawning one of our own. If the
    // claim gets released (winner succeeded, or failed and gave up) before
    // a socket ever appears, the next loop iteration gets a fair shot at
    // claiming it and spawning itself.
    await new Promise((r) => setTimeout(r, DAEMON_POLL_INTERVAL_MS));
  }

  throw new Error(
    `ego-browser: daemon did not come up within ${DAEMON_STARTUP_TIMEOUT_MS}ms ` +
      `(socket ${paths.sockFile} never accepted a connection) -- check ${paths.logFile}`,
  );
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Connection {
  socket: Bun.Socket;
  framer: MessageFramer<RpcResponse>;
  pending: Map<number, PendingCall>;
  nextId: number;
}

const connections = new Map<string, Promise<Connection>>();

function failAllPending(conn: Connection, err: Error): void {
  for (const [id, p] of conn.pending) {
    clearTimeout(p.timer);
    p.reject(err);
    conn.pending.delete(id);
  }
}

async function getConnection(paths: EgoBrowserPaths): Promise<Connection> {
  const cached = connections.get(paths.sockFile);
  if (cached) return cached;

  const connPromise = (async (): Promise<Connection> => {
    const conn: Connection = {
      socket: undefined as unknown as Bun.Socket,
      framer: new MessageFramer<RpcResponse>(),
      pending: new Map(),
      nextId: 1,
    };
    const socket = await Bun.connect<undefined>({
      unix: paths.sockFile,
      socket: {
        data(_socket, data) {
          const text = Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
          for (const msg of conn.framer.push(text)) {
            const pending = conn.pending.get(msg.id);
            if (!pending) continue;
            conn.pending.delete(msg.id);
            clearTimeout(pending.timer);
            if (isRpcFailure(msg)) pending.reject(new Error(msg.error.message));
            else pending.resolve(msg.result);
          }
        },
        close() {
          failAllPending(conn, new Error("ego-browser: daemon connection closed"));
          connections.delete(paths.sockFile);
        },
        error(_socket, err) {
          failAllPending(conn, err instanceof Error ? err : new Error(String(err)));
          connections.delete(paths.sockFile);
        },
      },
    });
    conn.socket = socket;
    return conn;
  })();

  connections.set(paths.sockFile, connPromise);
  return connPromise;
}

/**
 * Calls an RPC method on the daemon, spawning/resuming it as needed. The
 * connection is opened once per (process, socket path) and reused for
 * every call after that -- multiple calls can be in flight concurrently
 * (e.g. `Promise.all([page1.url(), page2.title()])`); each is matched back
 * to its own response by `id`, never by arrival order.
 */
export async function call(method: string, params?: unknown, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
  const paths = resolvePaths();
  await ensureDaemonAlive(paths);
  const conn = await getConnection(paths);

  const id = conn.nextId++;
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error(`ego-browser: RPC call "${method}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    conn.pending.set(id, { resolve, reject, timer });
    conn.socket.write(encodeMessage({ id, method, params }));
  });
}

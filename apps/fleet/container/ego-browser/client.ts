import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type EgoBrowserPaths, resolvePaths } from "./paths";
import { createRpcClient, decodeChunk, type RpcClient, type RpcTransport } from "./rpc";

const DAEMON_PATH = join(dirname(fileURLToPath(import.meta.url)), "daemon.ts");

const DAEMON_STARTUP_TIMEOUT_MS = 20000;
const DAEMON_POLL_INTERVAL_MS = 100;
const DEFAULT_CALL_TIMEOUT_MS = 60000;

function processAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing -- it only probes whether the pid exists and
    // is signalable, the standard "is this process alive" check.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Quick connect-and-drop probe: does anything answer on this socket right now? */
async function probeConnect(sockFile: string): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      unix: sockFile,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

async function isAliveNow(paths: EgoBrowserPaths): Promise<boolean> {
  if (!existsSync(paths.pidFile)) return false;
  const pidText = readFileSync(paths.pidFile, "utf8").trim();
  const pid = Number(pidText);
  if (!(Number.isInteger(pid) && pid > 0 && processAlive(pid))) return false;
  return probeConnect(paths.sockFile);
}

/**
 * Atomically claims the right to spawn a fresh daemon: `open(..., "wx")`
 * (O_CREAT|O_EXCL) either creates the file or fails with EEXIST, with no
 * check-then-act window in between -- the OS itself is the arbiter, so this
 * is safe across both concurrent processes AND concurrent same-process
 * callers (JS execution of this synchronous call can't interleave with
 * itself). Whoever wins spawns; everyone else falls through to polling for
 * the winner's socket instead of also spawning their own daemon.
 */
function claimSpawnLock(paths: EgoBrowserPaths): boolean {
  try {
    closeSync(openSync(paths.spawnLockFile, "wx"));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

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
 * daemon+Chromium -- see claimSpawnLock. Only the process that wins the
 * spawn claim touches the pidfile/sockfile cleanup and the actual spawn;
 * every loser just polls for the winner's socket to come up.
 */
export async function ensureDaemonAlive(paths: EgoBrowserPaths = resolvePaths()): Promise<void> {
  mkdirSync(paths.home, { recursive: true });

  if (await isAliveNow(paths)) return;

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
    if (await probeConnect(paths.sockFile)) return;

    if (claimSpawnLock(paths)) {
      try {
        // Re-check immediately after winning the claim: closes the same
        // window from the other side, in case a daemon became reachable
        // in the gap between the probeConnect above and actually winning
        // the lock.
        if (await probeConnect(paths.sockFile)) return;

        // Stale (or absent) -- clean up whatever is left and spawn fresh.
        // Safe to do here (and only here): we hold the spawn claim, so no
        // other racing caller can be mid-spawn right now to have these
        // rmSync calls pull the rug out from under it.
        rmSync(paths.pidFile, { force: true });
        rmSync(paths.sockFile, { force: true });

        const child = spawn(process.execPath, [DAEMON_PATH], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, EGO_BROWSER_HOME: paths.home },
        });
        child.unref();

        while (Date.now() < deadline) {
          if (await probeConnect(paths.sockFile)) return;
          await new Promise((r) => setTimeout(r, DAEMON_POLL_INTERVAL_MS));
        }
        break; // timed out waiting on our own spawn -- fall through to the error below
      } finally {
        // Release the claim regardless of outcome -- on failure this also
        // lets a would-be loser retry the spawn itself instead of being
        // stuck forever behind a claim nobody will ever release.
        rmSync(paths.spawnLockFile, { force: true });
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

interface Connection {
  socket: Bun.Socket;
  client: RpcClient;
}

const connections = new Map<string, Promise<Connection>>();

async function getConnection(paths: EgoBrowserPaths): Promise<Connection> {
  const cached = connections.get(paths.sockFile);
  if (cached) return cached;

  const connPromise = (async (): Promise<Connection> => {
    // Bun registers socket handlers ONCE at Bun.connect time, so the
    // transport's callback slots must be late-bound: the data/close/error
    // handlers below route through these, and createRpcClient fills them
    // during its own setup. The socket itself only exists once connect
    // resolves -- transport.write closes over conn.socket, assigned after.
    const conn: Connection = {
      socket: undefined as unknown as Bun.Socket,
      client: undefined as unknown as RpcClient,
    };
    let onData: (chunk: string) => void = () => {};
    let onClose: (err?: Error) => void = () => {};
    const transport: RpcTransport = {
      write: (data: string) => {
        conn.socket.write(data);
      },
      onData: (cb: (chunk: string) => void) => {
        onData = cb;
      },
      onClose: (cb: (err?: Error) => void) => {
        onClose = cb;
      },
    };
    const client = createRpcClient(transport);
    // The connection is dead: no response can ever arrive on it again, so
    // drop the cache entry -- the next call() opens a fresh one. Same move
    // the old inline close/error handlers made.
    client.onClosed(() => connections.delete(paths.sockFile));

    const socket = await Bun.connect<undefined>({
      unix: paths.sockFile,
      socket: {
        data(_socket, data) {
          onData(decodeChunk(data));
        },
        close() {
          onClose();
        },
        error(_socket, err) {
          onClose(err instanceof Error ? err : new Error(String(err)));
        },
      },
    });
    conn.socket = socket;
    conn.client = client;
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
  return conn.client.call(method, params, timeoutMs);
}

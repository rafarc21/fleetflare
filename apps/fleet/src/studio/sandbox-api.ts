// Sole file that touches the @cloudflare/sandbox SDK surface. Everything
// below is implemented against the exact d.ts names/signatures recorded by
// Task 1 from @cloudflare/sandbox@0.12.7 (exact-pinned — see package.json).
// The original scratch-note research is kept below the implementation
// (unchanged) as provenance for future readers; re-verify against the d.ts
// on file if the pin ever moves.
//
// ---------------------------------------------------------------------------
// Adapter design note (Task 4)
// ---------------------------------------------------------------------------
//
// `sb`'s parameter type below is a MINIMAL STRUCTURAL interface
// (SandboxHandle), not the SDK's own `Sandbox` class. Two reasons:
//   1. `Sandbox` has private fields, so a plain test object can never BE one
//      — every test would need an `as unknown as Sandbox<any>` cast. A real
//      StudioDO instance (StudioDO extends Sandbox<Env>) satisfies
//      SandboxHandle automatically (structural typing on the interface
//      side), so production callers pay nothing for this.
//   2. It keeps this adapter's actual dependency honest: sbExec/sbWriteFile/
//      sbSetKeepAlive only ever call `.exec`/`.writeFile`/`.setKeepAlive`,
//      so that is all the type demands.
//
// Through Task 4 this file also had to avoid a VALUE import of
// "@cloudflare/sandbox" entirely: the package statically does `import
// { tracing } from "cloudflare:workers"`, an export the then-pinned test-pool
// workerd did not provide, so merely importing it threw under `bun run test`.
// Task 5's Step 0 upgraded the pool to a workerd that has `tracing` (see
// task-5-report.md), which is what makes the `proxyTerminal` value import
// below — and StudioDO's export from index.ts — possible at all. routes.ts
// still deliberately imports nothing from here, since it needs neither.

import { proxyTerminal } from "@cloudflare/sandbox";
import { withKillDeadline, KILL_GRACE_SECONDS } from "./exec-deadline";

export { withKillDeadline, KILL_GRACE_SECONDS, isDeadlineExit } from "./exec-deadline";

/** Minimal structural slice of ISandbox this adapter needs. See the design
 *  note above for why this is a local interface, not the SDK's own type. */
export interface SandboxHandle {
  // Task 11: `options.env` is the one slice of the real ISandbox.exec's much
  // wider ExecOptions (see the scratch notes below, section (d):
  // `BaseExecOptions.env?: Record<string,string|undefined>`) this adapter
  // needs — the bring-up exec is the first caller, passing ROLE_PROMPT_B64/
  // ROLE_ALLOWED_TOOLS through to the container process environment. Kept
  // minimal same as the rest of this interface (see the design note above).
  exec(
    command: string, options?: { env?: Record<string, string> },
  ): Promise<{ success: boolean; exitCode: number; stdout: string; stderr: string }>;
  // Issue #104: the SDK's public exec against a NAMED container session.
  // `exec` above always lands on the default session, which the container
  // serializes (session-manager lock.runExclusive); the container creates an
  // unknown session id on first use, inheriting the container's own env.
  execWithSessionToken(
    command: string, sessionId: string, options?: { env?: Record<string, string> },
  ): Promise<{ success: boolean; exitCode: number; stdout: string; stderr: string }>;
  writeFile(
    path: string,
    content: string,
    options?: { encoding?: string },
  ): Promise<{ success: boolean }>;
  setKeepAlive(keepAlive: boolean): Promise<void>;
}

export interface PtyHandle {
  readable: ReadableStream<Uint8Array>;
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/**
 * Issue #104: per-call options. `timeoutMs` gives the exec a deadline AND a
 * kill and is REQUIRED — pass an EXEC_CLASSES entry, so no exec can wait
 * forever; `sessionId` moves it off the shared default session.
 */
export interface SbExecOptions {
  env?: Record<string, string>;
  timeoutMs: number;
  sessionId?: string;
}

/**
 * How much longer than the command's own deadline the Worker waits. The
 * in-container `timeout` normally answers first (124 at the deadline, 137
 * after the kill grace — the slack clears both); this Promise
 * deadline only fires when the container cannot answer at all — the memory
 * ceiling stall issue #104 measured — so the Worker never waits forever.
 */
export const DEADLINE_SLACK_MS = KILL_GRACE_SECONDS * 1000 + 2_000;

/**
 * One budget and one container session per fleet call class. Each session
 * is its own shell in the container (a few MB each, 7 of them), so one
 * command stalled in a class queues only that class — never a tick behind an
 * inspect, a wake behind a ship tick. Provision/bring-up stays on the
 * default session (no tick ever runs there now) with its own long budget.
 *
 *   ship      20s  shipTickCmd/rotateCmd: one tail+stat, every 30s.
 *   sync     120s  tar of ~/.claude/projects (up to 32 MiB) + base64 parts.
 *   readiness 60s  provisionedCheckCmd waits up to PROVISIONED_CHECK_TRIES
 *                  (20) seconds for claude by design.
 *   inspect   15s  INSPECT_EXEC_MS, inspect.ts's own budget.
 *   rescue   300s  rescue-push (git push of a large dirty tree) and harvest.
 *   wake      30s  pane probe + send-keys with a 1s submit gap.
 *   refresh  150s  credential-file write. It is the FIRST touch of provision
 *                  and restart, and the SDK waits for a cold container
 *                  inside that exec (up to ~120s).
 *   provision 600s clone + studio-bringup.sh (tailscale, claude launch waits).
 *   installCache
 *            900s  board #350: the install-cache save tick's tar+zstd+curl
 *                  PUT of up to INSTALL_CACHE_MAX_BYTES (1.5 GiB) to R2 via a
 *                  presigned URL. Its own session, separate from `sync`'s —
 *                  a slow upload (a large node_modules over a middling link)
 *                  must never queue the ordinary 300s session-state sync
 *                  tick behind it.
 */
export const EXEC_CLASSES = {
  ship: { sessionId: "fleet-ship", timeoutMs: 20_000 },
  sync: { sessionId: "fleet-sync", timeoutMs: 120_000 },
  readiness: { sessionId: "fleet-readiness", timeoutMs: 60_000 },
  inspect: { sessionId: "fleet-inspect", timeoutMs: 15_000 },
  rescue: { sessionId: "fleet-rescue", timeoutMs: 300_000 },
  wake: { sessionId: "fleet-wake", timeoutMs: 30_000 },
  refresh: { sessionId: "fleet-refresh", timeoutMs: 150_000 },
  provision: { timeoutMs: 600_000 },
  installCache: { sessionId: "fleet-install-cache", timeoutMs: 900_000 },
} as const satisfies Record<string, SbExecOptions>;

export type ExecClass = keyof typeof EXEC_CLASSES;

export class ExecDeadlineError extends Error {
  constructor(timeoutMs: number, sessionId: string | undefined) {
    super(`sandbox exec exceeded its ${timeoutMs}ms deadline (session ${sessionId ?? "default"})`);
    this.name = "ExecDeadlineError";
  }
}

/** Refused without sending: this session still holds an exec the Worker
 *  already abandoned, and the container would only queue this one behind it. */
export class SessionBusyError extends Error {
  constructor(sessionId: string | undefined) {
    super(`sandbox session ${sessionId ?? "default"} still holds an abandoned exec — refusing to queue behind it`);
    this.name = "SessionBusyError";
  }
}

/** Single-flight per session: each handle's sessions that hold an exec the
 *  Worker stopped waiting for. The container serializes a session, so a
 *  new exec there would only land late, after the wedge clears. Cleared
 *  when the abandoned exec finally settles. */
const abandoned = new WeakMap<SandboxHandle, Set<string>>();
const DEFAULT_SESSION_KEY = "\u0000default";

/** ISandbox.exec -> ExecResult; mapped to the adapter's own narrower shape
 *  (exitCode -> code) per the Task 4 interface contract. `env`, when given,
 *  is forwarded as `{env}` in the options bag (Task 11's bring-up env
 *  contract — see SandboxHandle's own doc comment on `exec`). No second
 *  argument at all when `env` is omitted, so a test can assert the exact
 *  one-argument call.
 *
 *  Issue #104: `timeoutMs` wraps the command in withKillDeadline and races a
 *  Promise deadline DEADLINE_SLACK_MS longer; `sessionId` sends it through
 *  execWithSessionToken instead of the default session. Secrets go in `env`,
 *  never in `cmd`: the wrapper puts `cmd` in `bash -c`'s argv (visible to
 *  `ps`), and a killed command is echoed back as `Killed <cmd>`. */
export async function sbExec(
  sb: SandboxHandle, cmd: string, opts: SbExecOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { env, timeoutMs, sessionId } = opts;
  const key = sessionId ?? DEFAULT_SESSION_KEY;
  if (abandoned.get(sb)?.has(key)) throw new SessionBusyError(sessionId);
  const command = withKillDeadline(cmd, timeoutMs);
  const extra = env ? [{ env }] as const : [] as const;
  const call = sessionId !== undefined
    ? sb.execWithSessionToken(command, sessionId, ...extra)
    : sb.exec(command, ...extra);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      let held = abandoned.get(sb);
      if (!held) abandoned.set(sb, (held = new Set()));
      held.add(key);
      const release = () => { held.delete(key); };
      call.then(release, release);
      reject(new ExecDeadlineError(timeoutMs, sessionId));
    }, timeoutMs + DEADLINE_SLACK_MS);
  });
  try {
    const r = await Promise.race([call, deadline]);
    return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  } finally {
    clearTimeout(timer);
  }
}

// writeFile's `content` param is `string | ReadableStream<Uint8Array>` (no
// raw Uint8Array option) — base64-encode and pass `encoding: "base64"`,
// simpler and safer than constructing a ReadableStream for what's always a
// single already-in-memory buffer (paste images, capped at 10 MB by Task 6).
const B64_CHUNK = 0x8000; // chunked spread avoids a call-stack blowup on large buffers

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(bin);
}

// Task 6 carry-over from Task 4 review: this used to await sb.writeFile and
// discard its {success} result. A failed write resolved silently, so a
// caller (the paste route) could report a path for a file that never
// landed. Throwing on success:false lets that propagate as an error the
// caller can turn into a 500, the same way a non-zero sbExec exit code is
// surfaced as a thrown Error elsewhere in this feature (runProvision).
export async function sbWriteFile(sb: SandboxHandle, path: string, bytes: Uint8Array): Promise<void> {
  const result = await sb.writeFile(path, bytesToBase64(bytes), { encoding: "base64" });
  if (!result.success) throw new Error(`sandbox writeFile failed: ${path}`);
}

/**
 * Review round 2, Spec 4: do.ts was calling `this.setKeepAlive(true)`
 * directly — a real SDK method call on the DO instance, bypassing this
 * adapter, the one file meant to be the sole SDK toucher. Routed through
 * here instead so `class StudioDO extends Sandbox<Env>` stays do.ts's only
 * direct touch of the SDK surface.
 */
export async function sbSetKeepAlive(sb: SandboxHandle, keepAlive: boolean): Promise<void> {
  await sb.setKeepAlive(keepAlive);
}

/**
 * Minimal structural slice for "wait until a container is genuinely ready
 * to accept exec calls" — separate from SandboxHandle (not a new field on
 * it) so every existing SandboxHandle fake in this feature's tests keeps
 * compiling unchanged, the same reason SandboxPtyHost is its own interface
 * rather than folded in. See sbAwaitReady's own doc comment for the exact
 * bug this closes.
 */
export interface SandboxReadyHandle {
  startAndWaitForPorts(
    ports?: number | number[],
    cancellationOptions?: { instanceGetTimeoutMS?: number; portReadyTimeoutMS?: number; waitInterval?: number },
  ): Promise<void>;
}

/**
 * Recycle fix (2026-08-20 live-studio incident, second pass): closes the
 * destroy/reprovision race a real `fleet recycle` run exposed — the fresh
 * container WAS created from the current image (bring-up ran, tmux existed),
 * but provisioning never landed inside it (no clone, no MCP config, no
 * credential file), and the route still reported `state: running, error:
 * null`. Root cause, verified by reading the PINNED @cloudflare/sandbox
 * @0.12.7 compiled source (node_modules/@cloudflare/sandbox/node_modules/
 * @cloudflare/containers/dist/lib/container.js and node_modules/
 * @cloudflare/sandbox/dist/sandbox-CcCJwCbh.js), not guessed from the d.ts
 * alone:
 *   - The base `Container.destroy()` is `async destroy() { await
 *     this.container.destroy() }` — it kills the real container but never
 *     calls `syncPendingStoppedEvents()`, so the DO's OWN persisted `state`
 *     (this.state, a "running"/"healthy"/"stopped"/... machine backed by DO
 *     storage) is not reconciled against that kill. It can still read
 *     "healthy" for a window after `destroy()` resolves.
 *   - `Sandbox.containerFetch` — what every sbExec/writeFile call in this
 *     feature routes through — decides whether to start a fresh container
 *     with `if (state.status !== "healthy" || containerRunning === false)`.
 *     Right after `destroy()`, `state.status` can still be the STALE
 *     "healthy" value, so this check can be FALSE and containerFetch skips
 *     starting anything fresh — it just executes straight against whatever
 *     the container binding currently resolves to (the dying container, or
 *     nothing durable). That's the race: provision()'s own first exec (the
 *     credential write) never gets a confirmed-ready container, so its
 *     clone/bring-up work disappears while the route still reports success.
 *   - `Container.startAndWaitForPorts` (which `Sandbox` does NOT override —
 *     confirmed absent from its own override list) calls
 *     `await this.syncPendingStoppedEvents()` as its FIRST action, forcing
 *     exactly the reconciliation containerFetch skips, then genuinely starts
 *     a fresh instance and POLLS the container-server's own port until it is
 *     actually listening (`this.state.setHealthy()` + `onStart()` only run
 *     after that poll succeeds). This is the one API in this surface whose
 *     OWN contract is "resolves once the container is confirmed ready," not
 *     "resolves once a request was issued" (`start()`'s own doc comment says
 *     the latter) — chosen over a hand-rolled poll loop because it is also
 *     the only path that correctly re-runs the SDK's own onStart bookkeeping
 *     (mounts, generation counters) other internals depend on.
 *   - No port is passed: `Sandbox`'s own `defaultPort` is 3000 (confirmed
 *     via the same compiled bundle: `defaultPort = 3e3` — the container-
 *     server's own control port, the same one containerFetch talks to), and
 *     `getPortsToCheck` falls back to it when no port is given.
 *
 * Timeouts are passed explicitly rather than left at the base class's own
 * defaults (8s/20s — `TIMEOUT_TO_GET_CONTAINER_MS`/`TIMEOUT_TO_GET_PORTS_MS`
 * in the same compiled file): that budget is calibrated for "start if not
 * already running" during ordinary operation, not a genuine cold start right
 * after a destroy. Reused instead: `Sandbox`'s own `DEFAULT_CONTAINER_TIMEOUTS`
 * (same bundle) — 30s to get an instance, 90s for the port to come up,
 * documented there as "conservative for production... containers take
 * several minutes to provision." A cold recycle gets at least as much
 * patience as the SDK's own author judged a cold start needs, not an
 * invented number.
 *
 * Throws (propagates, does not swallow) if the container never becomes
 * ready within that budget — do.ts's recycleWithSync is what turns that into
 * a degraded, recorded StudioStatus and a loud failure; this adapter itself
 * stays a thin, honest wrapper around the one SDK call that can make the
 * "ready" claim truthfully.
 */
/**
 * #129 F2: is the container mid-boot — `start()` called (`ctx.container
 * .running` is already true) but the containers library has not yet seen it
 * healthy? Read from the library's own state, never an exec: an exec is what
 * turns a boot into a race.
 */
export async function sbContainerBooting(sb: { getState(): Promise<{ status: string }> }): Promise<boolean> {
  return (await sb.getState()).status !== "healthy";
}

export async function sbAwaitReady(sb: SandboxReadyHandle): Promise<void> {
  await sb.startAndWaitForPorts(undefined, {
    instanceGetTimeoutMS: 30_000, portReadyTimeoutMS: 90_000, waitInterval: 300,
  });
}

/**
 * The design spec's tmux model is ONE shared terminal per studio, so one
 * named session per DO rather than one per attacher. Fan-out to several
 * simultaneous viewers (Mac + iPhone) happens above this adapter, in
 * terminal.ts, against the single PtyHandle returned here.
 */
export const STUDIO_SESSION_ID = "studio";

/**
 * The pty's root process — container/studio-shell.sh, baked into
 * Dockerfile.studio at this exact path.
 *
 * SDK finding (Task 13, read from the pinned d.ts and then from the pinned
 * container image, not guessed): `PtyOptions` is `{ cols?, rows?, shell? }`
 * and NOTHING else — there is no `command`/`cmd`/`args` field. `shell` is
 * forwarded by proxyTerminal as the `?shell=` query param, and the container
 * spawns it as ONE argv element with no arguments and no shell parsing:
 *
 *     let Y = $.shell ?? "bash";
 *     this.process = Bun.spawn([Y], { terminal: this.terminal, ... });
 *
 * (/container-server/dist/index.js in cloudflare/sandbox:0.12.7, class h8's
 * `initialize`.) So the spec's `tmux attach -t studio 2>/dev/null || tmux
 * new-session -A -s studio` cannot be handed over inline — it is a compound
 * command, and `Bun.spawn` would look for a binary with that entire string as
 * its name. It lives in the baked script instead, which this path names.
 *
 * Two more behaviours of that same container code decide the script's shape,
 * so they are recorded here rather than only in the script: the pty is created
 * ONCE per session and cached (`getPty` returns `session.pty` if set, ignoring
 * the new cols/rows AND the new shell), which is exactly why a reconnect lands
 * back in the same live tmux client; and nothing ever clears that cache when
 * the pty's process exits, which is why the script must never exit.
 */
export const STUDIO_SHELL = "/opt/fleet/studio-shell.sh";

/** Structural slice needed to open a pty. Deliberately NOT folded into
 *  SandboxHandle, for the same reason SandboxHandle is itself minimal (see
 *  the design note at the top): these two calls are all sbAttachPty makes,
 *  so they are all its parameter type should demand. A real StudioDO
 *  satisfies it automatically. */
export interface SandboxPtyHost {
  createSession(options?: { id?: string }): Promise<unknown>;
  fetch(request: Request): Promise<Response>;
}

/**
 * Opens the studio's pty — already attached to the shared tmux session, see
 * STUDIO_SHELL above — and adapts it to the PtyHandle port terminal.ts
 * consumes.
 *
 * Task 5 finding — why this does NOT use `session.terminal()` the way the
 * Task 1 scratch notes below (section (b)) predicted it would: `terminal` is
 * only a real method on the ENHANCED session object that `getSandbox()`'s
 * client-side proxy builds. The session object the Sandbox class hands back
 * to its own subclasses (`getSessionWrapper`, read from the compiled
 * dist/sandbox-CcCJwCbh.js) hard-codes `terminal: null` — server-side code
 * inside the DO cannot call it. The SDK's own answer is the free function
 * `proxyTerminal(stub, sessionId, request, options)`, a public main export,
 * which is exactly what the client-side proxy's `terminal` delegates to. It
 * takes anything with a `fetch`, and inside the DO `this` is that: it builds
 * the container request (`/ws/pty?sessionId=..&cols=..&rows=..`), switches it
 * to the container's port 3000, and returns the upgraded Response.
 *
 * The two resize wire formats in this feature are NOT the same and must not
 * be confused: the browser<->Worker frame is frames.ts's `{t:"resize"}`, and
 * the Worker<->container frame sent here is the SDK's own `{type:"resize"}`
 * (read from the pinned dist/xterm/index.js, which is the reference client
 * for this exact socket). terminal.ts translates between them.
 */
export async function sbAttachPty(
  sb: SandboxPtyHost, opts: { cols: number; rows: number },
): Promise<PtyHandle> {
  // Brings the shared session into existence. A duplicate id is the only
  // expected failure here and simply means a previous attach already created
  // it, so it must not abort the attach — the terminal() upgrade below is the
  // real health check, and it fails loudly if the session is genuinely absent.
  await sb.createSession({ id: STUDIO_SESSION_ID }).catch(() => {});

  const upgrade = new Request("https://studio/pty", {
    headers: { Upgrade: "websocket", Connection: "Upgrade" },
  });
  const res = await proxyTerminal(sb, STUDIO_SESSION_ID, upgrade, {
    cols: opts.cols, rows: opts.rows, shell: STUDIO_SHELL,
  });
  const ws = res.webSocket;
  if (!ws) throw new Error(`studio pty upgrade failed: ${res.status}`);
  // Not cosmetic: workerd defaults a manually-accepted socket's binaryType to
  // "blob", and a Blob's bytes are only reachable through an async
  // .arrayBuffer(). Terminal output would arrive as unreadable Blobs (the
  // SDK's own preview bridge pays for that with an await per message). The
  // SDK's reference pty client, dist/xterm/index.js, sets this same flag for
  // the same reason. The DO Hibernation API on the browser side of the bridge
  // always delivers ArrayBuffer, so only this socket needs it.
  ws.binaryType = "arraybuffer";
  ws.accept();

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      ws.close(1000, "pty reader cancelled");
    },
  });
  /** Clean EOF: the pty exited and the container closed the socket. */
  const endStream = () => {
    try {
      controller?.close();
    } catch {
      // Already settled.
    }
    controller = null;
  };

  /** Not EOF: the socket itself failed. Errored rather than closed so the
   *  consumer can tell a crashed pty from one that exited normally — they
   *  recover the same way, but only one of them is worth alerting on, and a
   *  silent clean close would hide it entirely. */
  const failStream = (err: unknown) => {
    console.error("studio pty socket error", err);
    try {
      controller?.error(err instanceof Error ? err : new Error("studio pty socket error"));
    } catch {
      // Already settled.
    }
    controller = null;
  };

  ws.addEventListener("message", (event) => {
    // Binary frames are terminal bytes. Text frames are the container's own
    // control channel ({"type":"ready"|"error"|"exit"}) — nothing downstream
    // acts on them, and a pty that has exited closes the socket right after,
    // which endStream below already handles.
    if (typeof event.data === "string") return;
    controller?.enqueue(new Uint8Array(event.data as ArrayBuffer));
  });
  ws.addEventListener("close", endStream);
  ws.addEventListener("error", (event) => failStream(event));

  return {
    readable,
    write: (bytes) => ws.send(bytes),
    resize: (cols, rows) => ws.send(JSON.stringify({ type: "resize", cols, rows })),
    close: () => ws.close(1000, "studio detached"),
  };
}

// ---------------------------------------------------------------------------
// SCRATCH NOTES (Task 1 research, unchanged) — provenance for the shapes
// implemented above. Re-verify against the d.ts on file if the pin moves.
// ---------------------------------------------------------------------------
//
// ---------------------------------------------------------------------------
// (a) getSandbox — main export of "@cloudflare/sandbox"
// ---------------------------------------------------------------------------
//
//   declare function getSandbox<T extends Sandbox<any>>(
//     ns: DurableObjectNamespace<T>,
//     id: string,
//     options?: SandboxOptions,
//   ): T;
//
// No doc comment in the d.ts. `T` is the StudioDO class itself (StudioDO
// extends Sandbox). SandboxOptions (subset): sleepAfter?: string|number,
// keepAlive?: boolean, enableDefaultSession?: boolean (default true — an
// implicit shared shell session; set false to run top-level exec/writeFile
// calls sessionless), containerTimeouts?, transport?: 'http'|'websocket'|
// 'rpc', labels?.
//
// Task 4 CONFIRMED (beyond the d.ts — read the compiled
// dist/sandbox-CcCJwCbh.js, not guessed): `id` is used as-is. `getSandbox`
// calls `sanitizeSandboxId(id)`, which only rejects on length (1-63),
// leading/trailing hyphen, and a short reserved-word list ("www", "api",
// "admin", "root", "system", "cloudflare", "workers") — it does NOT reject
// or collapse an embedded "--", and returns the id UNCHANGED otherwise. The
// raw `"repo--role"` studio id (e.g. "websites--pilot") passes through
// untouched and becomes the DO name via `getContainer(ns, id)` (i.e.
// `ns.idFromName(id)` under the hood, same as this repo's own
// AgentDO/DeployDO convention). Confirms the ruling: use the raw id
// directly, no pre-hashing/namespacing needed.
//
// Also confirmed from the same compiled source: `getSandbox()`'s return
// value is `new Proxy(stub, { get(target, prop) { ... return prop in
// enhancedMethods ? enhancedMethods[prop] : target[prop]; } })` —
// `enhancedMethods` only special-cases the SDK's OWN methods (exec,
// writeFile, createSession, tunnels, …). Any OTHER property access —
// including custom RPC methods a Sandbox subclass adds, like StudioDO's
// provision/getStatus/restartStudio — falls through to `target[prop]`,
// i.e. the plain DO stub. So getSandbox() adds nothing beyond a raw
// `ns.get(ns.idFromName(id))` for those methods; Task 4's routes.ts uses
// the plain form directly (see its own file header for why — the
// @cloudflare/sandbox import-safety note above), and replicates the one
// getSandbox side effect that matters (keepAlive) via `sbSetKeepAlive(this,
// true)` (this file's own adapter export — review round 2, Spec 4) inside
// StudioDO.provision instead. See task-4-report.md for the full reasoning.
//
// ---------------------------------------------------------------------------
// (b) Session creation, PTY, stream handles, resize
// ---------------------------------------------------------------------------
//
// IMPORTANT: `terminal()` is NOT a method on Sandbox/StudioDO itself. It is
// only on ExecutionSession (the object createSession()/getSession() return).
// Confirmed by grepping the whole d.ts: "terminal(" appears exactly once,
// inside the ExecutionSession interface — ISandbox (the interface Sandbox
// implements) has no terminal(). The call chain is:
//
//   const session = await sandbox.createSession(options?: SessionOptions);
//   // or: await sandbox.getSession(existingSessionId)
//   const response = await session.terminal(request: Request, options?: PtyOptions);
//   // response IS the upgraded WebSocket response — return it directly
//   // from the Worker's fetch handler for a WS-upgrade request.
//
//   deleteSession(sessionId: string): Promise<SessionDeleteResult>  // cannot delete the default session
//
// SessionOptions: { id?: string; name?: string; env?: Record<string,
// string|undefined>; cwd?: string; isolation?: boolean (PID namespace,
// needs CAP_SYS_ADMIN); commandTimeoutMs?: number }
//
// PtyOptions: { cols?: number; rows?: number; shell?: string } — that's ALL
// three fields. No resize field here; resize is not part of the typed
// surface (see below).
//
// Wire protocol over the PTY WebSocket (NOT in any .d.ts — read from the
// compiled client addon, dist/xterm/index.js, at this pinned version):
//   client -> server  keystrokes:  socket.send(<Uint8Array>)      // BINARY frame
//   client -> server  resize:      socket.send(JSON.stringify({ type: "resize", cols, rows }))  // TEXT frame
//   server -> client  output:      ArrayBuffer                    // BINARY frame, write straight to xterm
//   server -> client  control:     {"type":"ready"}                       // send first resize only after this
//                                  {"type":"error","message":string}
//                                  {"type":"exit","code":number,"signal"?:string}
// So resize is a client-initiated JSON control message sent over the
// already-open PTY socket, not a server-side SDK method call. Task 4/5's
// resize handler must speak this protocol on the Worker side of the bridge.
//
// A ready-made browser widget exists: import { SandboxAddon } from
// "@cloudflare/sandbox/xterm" — implements xterm.js's ITerminalAddon,
// wires the whole protocol above (data, resize-on-terminal-resize,
// reconnect w/ backoff) against a real xterm.js Terminal, given
// getWebSocketUrl({ sandboxId, sessionId, origin }) => string. Needs
// @xterm/xterm as a peer dep (optional peerDependency — not installed by
// this task). Evaluate for the frontend piece instead of hand-rolling.
//
// Also present, unverified: proxyTerminal(stub: { fetch(Request):
// Promise<Response> }, sessionId: string, request: Request, options?:
// PtyOptions): Promise<Response> — a free function (main export) that looks
// like a server-side helper around the createSession/getSession + terminal
// chain above, but has no doc comment and its internals aren't in the d.ts.
// Spike before relying on it.
//
// ---------------------------------------------------------------------------
// (c) writeFile (and the read/list/mkdir/etc. family)
// ---------------------------------------------------------------------------
//
//   // Sandbox (StudioDO instance / getSandbox() result) — class-level:
//   writeFile(
//     path: string,
//     content: string | ReadableStream<Uint8Array>,
//     options?: { encoding?: string; sessionId?: string },
//   ): Promise<{ success: boolean; path: string; bytesWritten: number; timestamp: string } | WriteFileResult>;
//
//   // ExecutionSession — session-scoped, same shape minus sessionId:
//   writeFile(
//     path: string,
//     content: string | ReadableStream<Uint8Array>,
//     options?: { encoding?: string },
//   ): Promise<WriteFileResult>;
//
//   interface WriteFileResult { success: boolean; path: string; timestamp: string; exitCode?: number }
//
// Companion methods with the same sandbox-level-vs-session-level duality:
// readFile (3 overloads — encoding:'none' returns a ReadableStream, 'utf-8'/
// 'base64' or omitted returns a string), readFileStream, mkdir, deleteFile,
// renameFile, moveFile, listFiles, exists, watch (inotify, SSE stream),
// checkChanges. `readFile(..., { encoding: 'none' })` requires
// SANDBOX_TRANSPORT=rpc — throws on http/websocket transport.
//
// ---------------------------------------------------------------------------
// (d) exec (and process management)
// ---------------------------------------------------------------------------
//
//   // Sandbox class-level:
//   exec(command: string, options?: ExecOptions): Promise<ExecResult>;
//   execStream(command: string, options?: StreamOptions): Promise<ReadableStream<Uint8Array>>;
//   execWithSessionToken(command: string, sessionId: string, options?: ExecOptions): Promise<ExecResult>;
//
//   // ExecutionSession — same exec/execStream, scoped to that session.
//
//   interface ExecOptions extends BaseExecOptions {
//     stream?: boolean;
//     onOutput?: (stream: 'stdout' | 'stderr', data: string) => void;
//     onComplete?: (result: ExecResult) => void;
//     onError?: (error: Error) => void;
//     signal?: AbortSignal;
//     origin?: 'user' | 'internal';       // 'internal' just demotes log level
//   }
//   interface BaseExecOptions { timeout?: number; env?: Record<string, string|undefined>; cwd?: string; encoding?: string }
//
//   interface ExecResult {
//     success: boolean; exitCode: number; stdout: string; stderr: string;
//     command: string; duration: number; timestamp: string; sessionId?: string;
//   }
//
// For long-running/background commands (distinct from exec, likely relevant
// to a "watch" feature): startProcess(command, options?, sessionId?),
// listProcesses, getProcess, killProcess, killAllProcesses,
// cleanupCompletedProcesses, getProcessLogs, streamProcessLogs — same
// sandbox-level-vs-session-level duality as above.
//
// ---------------------------------------------------------------------------
// Gotchas found along the way (not asked for by name, but load-bearing)
// ---------------------------------------------------------------------------
//
// 1. STUDIO is bound in wrangler.jsonc but NOT yet added to src/env.ts's
//    Env interface — out of scope for Task 1's file list. Whoever writes
//    `getSandbox(env.STUDIO, id)` first needs to add
//    `STUDIO: DurableObjectNamespace<StudioDO>;` there.
//    Task 4: done (as `import type` — see do.ts's own notes on why the
//    import style matters here).
//
// 2. Version split: @cloudflare/sandbox@0.12.7 bundles its OWN
//    @cloudflare/containers@0.3.7 in
//    node_modules/@cloudflare/sandbox/node_modules/@cloudflare/containers,
//    separate from this repo's top-level @cloudflare/containers@0.0.20 that
//    AgentDO/DeployDO (src/agents/do.ts, src/deploy/do.ts) extend directly.
//    Sandbox (so StudioDO) inherits from ITS OWN nested Container@0.3.7, not
//    the repo's 0.0.20 one — AgentDO/DeployDO idioms (this.ctx.container?.
//    running, renewActivityTimeout, etc.) are not guaranteed to carry over
//    1:1; check the nested 0.3.7 d.ts before reusing a pattern from those
//    two files on StudioDO.
//    Task 4 confirmed: the nested Container<Env> DOES extend
//    `DurableObject<Env>` (cloudflare:workers) same as the top-level one —
//    `this.ctx`/`this.env`/`this.ctx.storage`/`this.schedule()` all carry
//    over fine. What does NOT carry over safely is far more basic than any
//    lifecycle idiom: @cloudflare/sandbox's own bundle does a top-level
//    `import { tracing } from "cloudflare:workers"`, an export this
//    project's pinned test-pool workerd (miniflare 4.20260310.0, bundling
//    workerd 1.20260310.1) does not provide. MERELY IMPORTING
//    "@cloudflare/sandbox" throws `SyntaxError: The requested module
//    'cloudflare:workers' does not provide an export named 'tracing'` under
//    `bun run test` — before any DO construction, and independent of
//    `enableContainers`. See provision.ts's header comment and
//    task-4-report.md for the empirical proof and the full consequence
//    chain (why do.ts is not exported from index.ts yet).
//
// 3. proxyToSandbox(request, env): Promise<Response|null> (main export) is a
//    ready-made router, but its env type is
//    `interface SandboxEnv<T> { Sandbox: DurableObjectNamespace<T> }` — the
//    binding key is hardcoded to the literal name "Sandbox", not
//    configurable. Our binding is named STUDIO. Either pass a shim object
//    (`{ ...env, Sandbox: env.STUDIO }`) or skip this helper and call
//    `getSandbox(env.STUDIO, id)` directly, which is what StudioDO needs
//    regardless.
//    Task 4: moot for provision/status/restart — those are plain RPC calls
//    on the stub (`env.STUDIO.get(env.STUDIO.idFromName(id)).provision(cfg)`),
//    not HTTP-shaped, so neither proxyToSandbox nor getSandbox is used from
//    routes.ts. May matter again for Task 5/6's actual request-proxying
//    needs (WS upgrade, paste) if those want the SDK's own routing.
//
// 4. Sandbox also exposes backup/restore (createBackup/restoreBackup, R2-
//    backed), bucket mounting (mountBucket/unmountBucket), tunnels
//    (sandbox.tunnels.get/list/destroy — quick + named Cloudflare tunnels),
//    and a code interpreter (createCodeContext/runCode/runCodeStream) — all
//    out of scope for a terminal-watch feature. Noted only so later tasks
//    don't reach for them by accident while skimming autocomplete.

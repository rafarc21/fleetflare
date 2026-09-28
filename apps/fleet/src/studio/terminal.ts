import { parseFrame } from "./frames";
import type { PtyHandle } from "./sandbox-api";

// Everything the terminal bridge does, isolated from StudioDO itself.
//
// Same split as provision.ts and for the same reason: StudioDO is a
// container-backed Durable Object and cannot be constructed under
// vitest-pool-workers (`env.STUDIO.get(...).fetch(...)` throws "Containers
// have not been enabled for this Durable Object class"), so any logic left
// inside the class is untestable. do.ts keeps only its `fetch` forward and
// hands the upgrade straight to the class below, which
// test/studio.ws.test.ts drives with real WebSockets.
//
// #151: viewer sockets are accepted HERE with `accept()` and listened to
// directly — never through the DO Hibernation API. 2026-09-24 in production,
// viewers accepted with ctx.acceptWebSocket were silently dropped on their
// first client frame (no webSocketMessage, no webSocketClose, TCP left
// ESTABLISHED): output froze, keystrokes vanished, the pty stayed cached.
// Hibernation bought nothing anyway: the pty's outbound socket pins the DO.

/** Path StudioDO answers the terminal upgrade on. routes.ts rewrites the
 *  public `/studio/:id/ws/terminal` to this before handing the request to the
 *  DO, so the DO's own routing never depends on the outer URL shape (same
 *  convention as `stub.fetch("https://agent/heartbeat")` in src/agents). */
export const TERMINAL_PATH = "/ws/terminal";

/**
 * Per-socket ceiling on output this bridge is willing to hold for a client
 * that has stopped keeping up. Terminal bytes go stale the instant they are
 * superseded, and the studio runs tmux — a redraw restores whatever a client
 * missed — so a backlog is worth less than the memory it costs. Past this,
 * output is dropped OLDEST first (see fanOut).
 */
export const WS_BUFFER_MAX = 1_048_576;

/**
 * Platform finding (Task 5, probed against this project's workerd): a Worker
 * WebSocket does NOT implement the standard `bufferedAmount`. Its whole
 * prototype is accept, send, close, serializeAttachment, deserializeAttachment,
 * readyState, url, protocol, extensions, binaryType — reading `.bufferedAmount`
 * yields undefined, and comparing undefined against a number is false, so a
 * naive `ws.bufferedAmount <= WS_BUFFER_MAX` guard silently sends NOTHING.
 * That is a real bug this cost a debugging round to find, hence this helper
 * rather than an inline read.
 *
 * Absent means "no reason to hold back", which is also the honest answer: with
 * no signal there is nothing to wait for, so output flushes immediately and
 * the queue in fanOut stays empty. The runtime owns the buffering in that
 * case. If workerd ever ships the standard property, the cap below starts
 * enforcing itself with no further change.
 */
function bufferedBytes(ws: WebSocket): number {
  return (ws as WebSocket & { bufferedAmount?: number }).bufferedAmount ?? 0;
}

/** The default the pty is opened at. The first client to send a resize frame
 *  corrects it; tmux redraws at the new size. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export type AttachPty = (opts: { cols: number; rows: number }) => Promise<PtyHandle>;

export class TerminalBridge {
  /** The one shared pty, as a promise so that two clients upgrading at the
   *  same time cannot each open one. Null means "not attached" — either not
   *  yet, or since the last client left. */
  private pty: Promise<PtyHandle> | null = null;
  /** The resolved handle behind `pty`, once it settles. Lets a pump tell
   *  "my pty ended" from "my pty was already replaced/closed", which decides
   *  whether it may tear down the clients attached right now. */
  private live: PtyHandle | null = null;
  /** Output held back for a socket that is over WS_BUFFER_MAX. Keyed weakly
   *  so a socket that goes away takes its backlog with it. */
  private backlog = new WeakMap<WebSocket, Uint8Array[]>();
  /** Every attached viewer — the ONLY record of who is watching (#151). An
   *  instance field is enough: the DO cannot be evicted while a pty is open,
   *  and without a pty there is nothing to watch. */
  private viewers = new Set<WebSocket>();

  constructor(private readonly attachPty: AttachPty) {}

  /** How many viewers are attached right now. */
  viewerCount(): number {
    return this.viewers.size;
  }

  /**
   * Takes ownership of one viewer's server-side socket: accept it, record it,
   * and learn its input and its departure from its OWN events. `attach` calls
   * this for every upgrade; it is public so a test can hand it a socket whose
   * events it fires by hand (an abrupt `error` cannot be provoked from a
   * healthy in-process pair).
   */
  adopt(ws: WebSocket): void {
    ws.binaryType = "arraybuffer";
    ws.accept();
    this.viewers.add(ws);
    ws.addEventListener("message", (event) => {
      this.message(ws, event.data as string | ArrayBuffer).catch((err) => {
        console.error("studio terminal input failed", err);
      });
    });
    // An abrupt drop (a phone losing signal) delivers `error`, not `close`;
    // both must discount the viewer or the pty leaks, pinning the DO billed.
    ws.addEventListener("close", () => this.close(ws));
    ws.addEventListener("error", () => this.close(ws));
  }

  /** Answers the upgrade. Auth and studio-id checks have already run in
   *  routes.ts — a request only reaches here having passed both. */
  async attach(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    // Opened before the 101 rather than after, so a container that cannot
    // give us a pty is reported as an error the client can act on instead of
    // an upgrade that succeeds and then goes silent.
    let pty: PtyHandle;
    try {
      pty = await this.ensurePty();
    } catch (err) {
      console.error("studio terminal attach failed", err);
      // Deliberately does NOT call forgetPty(), for the same reason the
      // success path below does not (see the TOCTOU comment there). This used
      // to, unconditionally, and that was a second defect of exactly the kind
      // that comment forbids: a slow attempt that is superseded before it
      // finally rejects would clear `this.live` — by then some OTHER, healthy
      // pty that clients are already attached to — and the next frame from one
      // of those clients would open a THIRD pty underneath them. Clearing a
      // failed attempt out of `this.pty` is ensurePty's own job now, and it
      // only clears the attempt that actually failed.
      return new Response("terminal unavailable", { status: 503 });
    }

    // TOCTOU guard (P1 T5 ledger): `await` above crossed a microtask
    // boundary, and the pty it resolved with can already be dead by now —
    // ptyEnded (below) clears `this.live` the instant a pty's readable
    // stream ends or errors, and that can happen before THIS continuation
    // gets its own turn (a container that accepts the pty open and exits
    // right after is the realistic case). Comparing against `this.live`,
    // not just "did the await throw", is what catches this: the promise DID
    // resolve successfully, it's just stale by the time we get here.
    //
    // Deliberately does NOT call forgetPty(): if `this.live` is already
    // null, ptyEnded's own call already did that (nothing to repeat); if
    // `this.live` is some OTHER, newer pty (a concurrent attach already
    // replaced this one), clearing it here would wrongly tear down a
    // healthy pty other clients may already be attached to. Either way this
    // stale attempt just answers 503 and steps aside — the client's own
    // backoff (cli/fleet.ts, page/terminal.template.html) retries, and that
    // retry's ensurePty() call picks up whatever is live by then.
    if (pty !== this.live) {
      return new Response("terminal unavailable", { status: 503 });
    }

    const pair = new WebSocketPair();
    this.adopt(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** One client frame. Binary is terminal input; text is control. */
  async message(_ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const frame = parseFrame(data);
    if (frame.type === "ignore") return;

    // Already resolved in the steady state (attach awaited it), so this does
    // not reorder input between clients: continuations of an already-settled
    // promise run in the order they were queued.
    const pty = await this.ensurePty();
    if (frame.type === "data") pty.write(frame.bytes);
    else pty.resize(frame.cols, frame.rows);
  }

  /**
   * One client went away — cleanly (`close`) or abruptly (`error`). The pty outlives any single client — that is the whole
   * point of the studio surviving a phone locking — so it is closed only when
   * the last one leaves.
   *
   * Both socket events land here on purpose (see adopt). An abrupt drop that did NOT
   * run this would leak an attacher: the count never reaches zero, the pty
   * stays open, and its outbound socket pins the DO resident (and billed)
   * for good.
   *
   * THIS IS THE TRIGGER for a pty being forgotten while a pump still owns it
   * (issue #48). The two steps below are not atomic and cannot be: forgetPty()
   * is synchronous and lands immediately, but `pty.close()` is asynchronous
   * all the way down — sandbox-api's close() is `ws.close(1000, "studio
   * detached")`, and the pty's readable stream does not end until that close
   * round-trips to the container. For the whole of that window the pump is
   * still parked in `await reader.read()`, while `this.pty` already reads
   * null. Anyone attaching inside it — the operator closing a terminal and
   * reopening it is the ordinary case — gets a SECOND pty from ensurePty and
   * a second pump, and both fan into the one viewer set.
   *
   * A narrower second ordering reaches the same state: if a NEW attach is
   * already in flight when the last old socket's close is dispatched, `pending`
   * below is that new attempt, so this closes a pty it never opened and that
   * an attach is about to be handed. The pump's own supersession guard is what
   * contains both — see pump().
   */
  close(ws: WebSocket): void {
    this.backlog.delete(ws);
    // workerd fires `close` AND `error` for one departure (measured); only
    // the first may count, or the second tears down a re-attach's new pty.
    if (!this.viewers.delete(ws)) return;
    if (this.viewers.size > 0) return;

    const pending = this.pty;
    this.forgetPty();
    void pending?.then((pty) => pty.close()).catch(() => {});
  }

  /**
   * KNOWN REMAINING WEDGE, measured not guessed (issue #48, point 3): the
   * rejection path below is fixed, but a PENDING attempt that never settles
   * is still cached here forever. attachPty bottoms out in proxyTerminal's
   * fetch to the container and has no timeout anywhere in the chain, so a
   * container that accepts the request and never answers leaves this promise
   * pending; `if (this.pty)` then hands that same promise to every later
   * upgrade, and none of them can ever answer. Nothing clears it either: the
   * only forgetPty callers are close(), which needs an attached socket (none
   * was ever accepted, because no upgrade ever completed), and ptyEnded,
   * which needs a pump (none ever started). Probed against this bridge —
   * three upgrades, one attachPty call, zero responses — so it holds until
   * the DO restarts, and it is the shape that matches an endpoint "hanging at
   * connecting forever". Closing it needs a timeout, i.e. a policy call on
   * how long a cold container start may legitimately take (sbAwaitReady
   * budgets 30s + 90s), which is why it is recorded here rather than
   * invented.
   */
  private ensurePty(): Promise<PtyHandle> {
    if (this.pty) return this.pty;

    const attempt: Promise<PtyHandle> = this.attachPty({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS }).then(
      (pty) => {
        this.live = pty;
        void this.pump(pty);
        return pty;
      },
      (err: unknown) => {
        // `this.pty` caches the PROMISE, not the handle, so without this a
        // failed attempt is cached exactly like a successful one — and a
        // settled rejection is never retried, it just replays. Every later
        // caller would be handed the same dead attempt: message() awaits
        // ensurePty() with no catch at all, so nothing there would ever clear
        // it, and the next upgrade would refuse (503 -> the client's
        // `1002 Expected 101 status code`) against a container that is
        // running and healthy. One failure has to cost one failure.
        //
        // Guarded on identity rather than cleared outright: by the time this
        // runs `this.pty` may already be a NEWER attempt (close() can forget
        // an in-flight one, and the next caller starts a fresh one), and
        // nulling that would forget a pty other clients are live on.
        if (this.pty === attempt) this.pty = null;
        throw err;
      },
    );

    this.pty = attempt;
    return attempt;
  }

  private forgetPty(): void {
    this.pty = null;
    this.live = null;
  }

  /** Drains the pty, fanning every chunk out to every attached client.
   *  Deliberately not awaited by its caller: it only ends when the pty does,
   *  or — see the supersession guard below — when its pty stops being the
   *  live one. */
  private async pump(pty: PtyHandle): Promise<void> {
    const reader = pty.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;

        // This pty is no longer the bridge's. ptyEnded has always guarded on
        // this; the hot loop did not, and that is the interleaving bug: the
        // socket set below is shared by every generation of pty, so a pump
        // whose pty was superseded kept writing into the SAME clients as the
        // live one and the operator saw two byte streams spliced together
        // character by character. The viewer set cannot distinguish them —
        // it lists who is attached to the bridge, not to a pty — so the
        // check has to happen here, before the fan-out.
        //
        // Cancelled rather than merely dropped. Dropping alone would leave
        // this pump parked on `reader.read()` for as long as the superseded
        // pty stays open, and that reader holds the container pty socket —
        // the same "pins the DO resident and billed" leak close()'s comment
        // is written to avoid. Cancelling propagates: sandbox-api's readable
        // closes the pty socket from its own cancel(). The drop is still what
        // makes it correct — cancel() is asynchronous, and THIS chunk is
        // already in hand — so both are needed, not either.
        if (this.live !== pty) {
          await reader.cancel().catch(() => {});
          return;
        }

        if (!value || value.byteLength === 0) continue;
        for (const ws of this.viewers) this.fanOut(ws, value);
      }
    } catch (err) {
      // A pty that failed rather than ended (sandbox-api errors the stream on
      // a socket error, so the two are distinguishable here). Same recovery.
      console.error("studio terminal pty read failed", err);
    } finally {
      reader.releaseLock();
      this.ptyEnded(pty);
    }
  }

  /**
   * The pty is gone — the container recycled, the shell exited, or the socket
   * failed. Without this the bridge degrades silently in two ways at once:
   * attached clients keep a terminal that will never print again, and
   * `this.pty` stays a settled promise, so ensurePty hands every NEW attacher
   * a 101 onto the corpse and only a full detach-and-reattach could recover.
   *
   * Clearing it makes reconnect a working path, and closing the sockets with
   * 1011 is what actually triggers the client's own reconnect logic (the
   * SDK's xterm addon reconnects on close, and stares at a dead screen
   * otherwise).
   */
  private ptyEnded(pty: PtyHandle): void {
    // A pump whose pty was already replaced (or deliberately closed by the
    // last client leaving) must not tear down its successor's clients.
    if (this.live !== pty) return;
    this.forgetPty();

    // Snapshot and clear FIRST: close() below may re-enter via a socket's
    // own close listener, and must find nobody left to count.
    const viewers = [...this.viewers];
    this.viewers.clear();
    for (const ws of viewers) {
      this.backlog.delete(ws);
      try {
        ws.close(1011, "pty ended");
      } catch {
        // Already gone; nothing to notify.
      }
    }
  }

  /** Sends one chunk to one client, enforcing WS_BUFFER_MAX. */
  private fanOut(ws: WebSocket, bytes: Uint8Array): void {
    const queue = this.backlog.get(ws) ?? [];
    queue.push(bytes);

    // Send as much as the socket will take, oldest first. In the ordinary
    // case (a client keeping up) this drains the single chunk just pushed and
    // everything below is a no-op.
    //
    // Guarded per socket, and NOT left to pump's catch: a throw there returns
    // out of the drain loop, so one dead client would end output for every
    // other attacher. `send` on a socket still in the viewer set while its
    // close is in flight is exactly where that throw comes from.
    try {
      while (queue.length > 0 && bufferedBytes(ws) <= WS_BUFFER_MAX) {
        ws.send(queue.shift() as Uint8Array);
      }
    } catch (err) {
      console.error("studio terminal send failed; dropping this client's output", err);
      this.backlog.delete(ws);
      return;
    }

    // Still backed up: hold at most WS_BUFFER_MAX, discarding the OLDEST
    // bytes rather than refusing the newest. Dropping the newest would leave
    // the client's screen permanently behind; dropping the oldest keeps it
    // converging on the current one, which tmux then redraws in full.
    let held = 0;
    for (const chunk of queue) held += chunk.byteLength;
    while (held > WS_BUFFER_MAX) held -= (queue.shift() as Uint8Array).byteLength;

    if (queue.length > 0) this.backlog.set(ws, queue);
    else this.backlog.delete(ws);
  }
}

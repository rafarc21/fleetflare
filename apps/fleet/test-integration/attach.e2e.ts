#!/usr/bin/env bun
/**
 * Studio runtime integration test — `bun run test:integration`.
 *
 * Drives the real Worker, the real StudioDO, and a real container end to end:
 * spawns `wrangler dev`, provisions a studio, opens the terminal WebSocket,
 * and asserts on what comes back out of a real tmux running inside a real
 * container. Nothing here is mocked at the route layer; the only substituted
 * pieces are the three genuinely-external HTTP endpoints listed in
 * test-integration/dev-entry.ts (Access JWKS, GitHub App token exchange,
 * GitHub blueprint file reads).
 *
 * Requires: docker running, and network access for the container's `git
 * clone` of AGENT_REPO. Excluded from `bun run test` (vitest) on purpose —
 * vitest-pool-workers cannot construct a container-backed DO at all.
 *
 * Exits non-zero on any failed check.
 */
import {
  PILOT, SCRATCH, SPAWN_ROLE, DENIED_ROLE,
  check, assert, record, reportAndExit,
  makeAccessIdentity, writeDevVars, removeDevVars, containerWorkerUrl,
  freePort, applyMigrations, resetStudioRows, resetPersistedRunState, requireDocker, startWrangler, api,
  killStudioContainers, waitForContainersGone,
  forceTick, readRawTail, r2List, r2Get,
} from "./harness";
// Wire-format literal (issue #275): transcript.ts's TRANSCRIPT_LOG_PATH went
// module-private when the 22 test-only exports were un-exported, so this
// e2e now pins the container↔Worker script-agreed path as a local literal —
// the same convention test/studio.transcript.test.ts's wire-format block
// established, and the same path container/studio-bringup.sh's pipe-pane
// step writes by its own hardcoded convention.
import type { StudioStatus } from "../src/studio/types";

const TRANSCRIPT_LOG_PATH = "/workspace/.transcript/claude.log";

// ---------------------------------------------------------------------------
// terminal client
// ---------------------------------------------------------------------------
class Term {
  private buf = "";
  private ws: WebSocket;
  private opened: Promise<void>;

  constructor(base: string, id: string, jwt: string) {
    this.ws = new WebSocket(`${base.replace("http", "ws")}/studio/${id}/ws/terminal`, {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    } as unknown as string[]);
    this.ws.binaryType = "arraybuffer";
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error(`ws error: ${String((e as ErrorEvent).message ?? e)}`));
    });
    this.ws.onmessage = (ev) => {
      this.buf +=
        typeof ev.data === "string" ? ev.data : new TextDecoder().decode(new Uint8Array(ev.data as ArrayBuffer));
    };
  }

  ready(): Promise<void> {
    return this.opened;
  }
  get text(): string {
    return this.buf;
  }
  clear(): void {
    this.buf = "";
  }
  send(s: string): void {
    this.ws.send(new TextEncoder().encode(s));
  }
  resize(cols: number, rows: number): void {
    this.ws.send(JSON.stringify({ t: "resize", cols, rows }));
  }
  close(): void {
    this.ws.close();
  }

  async waitFor(needle: string | RegExp, timeoutMs = 30_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (typeof needle === "string" ? this.buf.includes(needle) : needle.test(this.buf)) return this.buf;
      await Bun.sleep(40);
    }
    throw new Error(`timed out waiting for ${needle} — last 600 bytes: ${JSON.stringify(this.buf.slice(-600))}`);
  }

  /**
   * Runs a command in the attached tmux shell and returns what the terminal
   * emitted between two unique sentinels.
   *
   * The sentinels are printed from two concatenated halves on purpose. A
   * terminal echoes the line you type, so a sentinel written literally in the
   * command appears in the buffer BEFORE the command has run — a naive
   * waitFor then returns the echoed command line as if it were the output.
   * (That is not hypothetical: it is what the first version of this file did,
   * and it made a resize assertion read an empty string and an isolation
   * assertion read its own grep command.) Split in two, the contiguous marker
   * exists only in the command's real output.
   */
  async run(cmd: string, timeoutMs = 60_000): Promise<string> {
    const a = `Q${Math.random().toString(36).slice(2, 8)}`;
    const b = `Z${Math.random().toString(36).slice(2, 8)}`;
    const open = `<${a}>`;
    const close = `<${b}>`;
    this.clear();
    this.send(
      `printf '%s%s' '<${a.slice(0, 3)}' '${a.slice(3)}>'; ${cmd}; ` +
      `printf '%s%s' '<${b.slice(0, 3)}' '${b.slice(3)}>'\r`,
    );
    await this.waitFor(close, timeoutMs);
    const start = this.buf.indexOf(open);
    const end = this.buf.indexOf(close, start);
    // ANSI stripped: tmux redraws mid-output, and a status-line repaint can
    // land between the sentinels.
    return this.buf.slice(start + open.length, end).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const devLog: string[] = [];
// An array, not a `let`: TypeScript's control-flow analysis narrows a
// top-level `let` to `null` when its only assignment lives inside a nested
// function, which makes the `?.kill()` in the finally block below an error
// on type `never`.
const spawned: { kill(): void }[] = [];

let access: { jwks: unknown[]; jwt: string };

async function main(): Promise<void> {
  console.log("=== studio runtime integration ===");

  requireDocker();
  // The port is chosen FIRST now: `.dev.vars` has to carry the URL a
  // CONTAINER can reach this run's Worker on (harness.ts's
  // containerWorkerUrl), and that URL embeds the port.
  const port = await freePort();
  access = await makeAccessIdentity();
  await writeDevVars(access, containerWorkerUrl(port));

  console.log("applying local D1 migrations…");
  applyMigrations();
  // Studio rows from an EARLIER run would make this run's spawn a correct
  // "409 studio exists" — see resetStudioRows' own doc comment.
  resetStudioRows();
  // ...and a previous run's DO alarms + R2 objects would collide with this
  // run's own containers and chunk keys (see resetPersistedRunState).
  resetPersistedRunState();

  const base = `http://127.0.0.1:${port}`;
  console.log(`starting wrangler dev on ${port} (building containers may take a few minutes)…`);
  spawned.push(await startWrangler(port, devLog));
  console.log("wrangler dev ready");

  const call = api(base, access.jwt);

  // --- provision -----------------------------------------------------------
  let pilotState = "";
  await check("provision websites--pilot reaches state:running", async () => {
    const res = await call(`/studio/${PILOT}/provision`, { method: "POST", body: "{}" });
    const body = (await res.json()) as { state: string; error: string | null };
    pilotState = body.state;
    assert(res.status === 200, `HTTP ${res.status}`);
    assert(body.state === "running", `state=${body.state} error=${body.error}`);
    return "state=running";
  });
  assert(pilotState === "running", "cannot continue without a provisioned studio");

  // --- attach + echo through real tmux -------------------------------------
  const t = new Term(base, PILOT, access.jwt);
  await t.ready();
  await check("WS attach: pty shell prompt reaches the client", async () => {
    t.send("\r");
    await t.waitFor(/[$#] |root@/, 30_000);
    return "prompt seen";
  });

  // The pty's root process IS `tmux attach` (container/studio-shell.sh, wired
  // in via PtyOptions.shell) — nothing here types it, and nothing the
  // operator runs does either. Asserted from INSIDE the pane: $TMUX is only
  // set for a process tmux itself started, so it cannot be satisfied by a
  // bare shell that merely has tmux on its PATH.
  await check("attach lands INSIDE tmux with zero typing", async () => {
    const inside = await t.run(`test -n "$TMUX" && echo IN_TMUX || echo NOT_IN_TMUX`);
    assert(/IN_TMUX/.test(inside) && !/NOT_IN_TMUX/.test(inside), `not inside tmux: ${JSON.stringify(inside)}`);
    const windows = await t.run("tmux list-windows -t studio -F '#{window_name}' | tr '\\n' ','");
    assert(/claude/.test(windows) && /shell/.test(windows), `windows=${JSON.stringify(windows)}`);
    const clients = await t.run("tmux list-clients -t studio | wc -l");
    assert(/[1-9]/.test(clients), `no attached tmux client: ${JSON.stringify(clients)}`);
    return windows.trim();
  });

  // The tmux SERVER's environment is the bring-up script's own environment,
  // and every pane inherits it (studio-bringup.sh's header), so this is
  // literally what `claude` was launched with. Task 12 found all three of
  // these ABSENT — StudioDO declared no `envVars`, so an unauthenticated
  // claude, no tailnet, and a shared "studio" hostname for every studio. A
  // route-level test cannot see this; only reading the real container can.
  await check("studio container carries CLAUDE_CODE_OAUTH_TOKEN, TS_AUTHKEY and STUDIO_ID", async () => {
    const out = await t.run(
      `for k in CLAUDE_CODE_OAUTH_TOKEN TS_AUTHKEY STUDIO_ID ROLE_PROMPT_B64 ROLE_ALLOWED_TOOLS; do ` +
      `tmux show-environment -g "$k" >/dev/null 2>&1 && echo "$k:present" || echo "$k:MISSING"; done | tr '\\n' ' '`,
    );
    for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "TS_AUTHKEY", "STUDIO_ID", "ROLE_PROMPT_B64", "ROLE_ALLOWED_TOOLS"]) {
      assert(out.includes(`${k}:present`), `${k} is not in the container environment: ${out.trim()}`);
    }
    // STUDIO_ID must be THIS studio, not the bring-up script's "studio"
    // fallback — that fallback is what would collide every tailnet hostname.
    const id = await t.run(`tmux show-environment -g STUDIO_ID | cut -d= -f2`);
    assert(id.includes(PILOT), `STUDIO_ID=${JSON.stringify(id.trim())} (expected ${PILOT})`);
    return `all present; STUDIO_ID=${PILOT}`;
  });

  const echoTag = `E2E_${Math.random().toString(36).slice(2, 10)}`;
  await check("echo round-trip through real tmux", async () => {
    const out = await t.run(`echo ${echoTag}`);
    assert(out.includes(echoTag), `echo output did not contain the marker: ${JSON.stringify(out)}`);
    return echoTag;
  });

  // --- resize --------------------------------------------------------------
  // Every resize in this design arrives while tmux is ALREADY attached (the
  // pty's root process IS the tmux client), so there is no longer a
  // "before attach" case to check separately.
  //
  // This used to be the feature's known limitation: the container opens the
  // pty WITHOUT making it a controlling terminal, so the kernel has no
  // foreground process group to signal, TIOCSWINSZ lands but SIGWINCH is
  // never delivered, and tmux — which only re-reads its size on SIGWINCH —
  // kept drawing at the old size. `setsid --ctty` in container/studio-shell.sh
  // gives the pty a real session and controlling terminal, which is what makes
  // the signal (and therefore these assertions) work.
  await check("resize is reflected inside tmux (client and window follow)", async () => {
    t.resize(132, 43);
    await Bun.sleep(2000);
    const client = (await t.run(`tmux display -p '#{client_width}x#{client_height}'`)).replace(/[^0-9x]/g, "");
    const win = (await t.run(`tmux display -p '#{window_width}x#{window_height}'`)).replace(/[^0-9x]/g, "");
    // The pane is one row shorter than the client: tmux's status line.
    const stty = (await t.run(`stty size`)).replace(/[^0-9 ]/g, "").trim();
    console.log(`      DIAG client=${client} window=${win} pane stty="${stty}"`);
    assert(client === "132x43", `client=${client} (expected 132x43)`);
    assert(win.startsWith("132"), `window=${win} client=${client} (expected window 132 wide)`);
    return `client=${client} window=${win}`;
  });

  // A SECOND resize, with the same client still attached — the ordinary case:
  // drag the window, close the laptop lid, rotate a phone.
  await check("a later resize also follows, with no detach/reattach", async () => {
    t.resize(100, 30);
    await Bun.sleep(2000);
    const client = (await t.run(`tmux display -p '#{client_width}x#{client_height}'`)).replace(/[^0-9x]/g, "");
    const stty = (await t.run(`stty size`)).replace(/[^0-9 ]/g, "").trim();
    console.log(`      DIAG mid-session resize: client=${client} pane stty="${stty}"`);
    assert(client === "100x30", `client=${client} (expected 100x30)`);
    return `client=${client}`;
  });

  // ctrl-b d must be survivable. The container caches ONE pty per session and
  // never clears it when the process exits, so a pty whose root process ended
  // would leave every later attach holding a closed pty — the studio's
  // terminal would be dead until the container recycled. studio-shell.sh's
  // loop is what prevents that, and this is the check that proves it.
  await check("ctrl-b d does not end the pty — the shell re-attaches on its own", async () => {
    t.clear(); // waitFor reads the whole buffer; a stale prompt would match instantly
    t.send("\x02d");
    await t.waitFor("detached", 20_000);
    await Bun.sleep(2500);
    const inside = await t.run(`test -n "$TMUX" && echo IN_TMUX || echo NOT_IN_TMUX`);
    assert(/IN_TMUX/.test(inside) && !/NOT_IN_TMUX/.test(inside), `pty did not re-attach: ${JSON.stringify(inside)}`);
    return "re-attached without operator action";
  });

  // --- paste ---------------------------------------------------------------
  await check("paste route: bytes land in the container with a matching checksum", async () => {
    const bytes = new Uint8Array(4096);
    crypto.getRandomValues(bytes);
    // A real PNG signature so the route's content sniffing sees a png.
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const expected = Array.from(digest).map((b) => b.toString(16).padStart(2, "0")).join("");

    const res = await call(`/studio/${PILOT}/paste`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: bytes,
    });
    // Read the body ONCE. `assert(cond, msg)` evaluates its message eagerly,
    // so an `await res.text()` inside that template literal consumes the body
    // even on the success path and the res.json() below then throws
    // "Body already used".
    const raw = await res.text();
    assert(res.status === 200, `paste HTTP ${res.status}: ${raw.slice(0, 300)}`);
    const { path } = JSON.parse(raw) as { path: string };
    const out = await t.run(`sha256sum ${path} | cut -d' ' -f1`);
    const actual = out.replace(/[^0-9a-f]/g, "").slice(0, 64);
    assert(actual === expected, `container=${actual} local=${expected} path=${path}`);
    return `${path} sha256 match`;
  });

  // --- latency -------------------------------------------------------------
  let latency = "";
  await check("echo round-trip latency (raw pty echo, 20 samples)", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const tag = `L${i}${Math.random().toString(36).slice(2, 8)}`;
      t.clear();
      const started = performance.now();
      t.send(tag);
      await t.waitFor(tag, 15_000);
      samples.push(performance.now() - started);
      t.send("\x15"); // ctrl-U: clear the line we just typed
      await Bun.sleep(60);
    }
    samples.sort((a, b) => a - b);
    latency =
      `min=${samples[0].toFixed(1)}ms p50=${samples[10].toFixed(1)}ms ` +
      `p95=${samples[18].toFixed(1)}ms max=${samples[19].toFixed(1)}ms`;
    return latency;
  });

  // --- P3 Task 6: spawn, end to end ----------------------------------------
  // The one thing no unit test can reach: the REAL in-container CLI
  // (container/studio-fleet, baked into the image and symlinked to
  // /usr/local/bin/fleet) calling the REAL /fleet/spawn route over REAL HTTP,
  // authenticated by the spawn token the Worker minted for THIS container at
  // provision, ending in a REAL second container.
  //
  // Run from the shell window of the parent's own pty — the same exec path
  // every other container-side assertion in this file uses — and placed after
  // the latency samples on purpose, so the second container is not up while
  // they are being measured.
  const listStudios = async (): Promise<{ raw: string; rows: StudioStatus[] }> => {
    const res = await call("/studio/", { headers: { Accept: "application/json" } });
    const raw = await res.text();
    assert(res.status === 200, `GET /studio/ HTTP ${res.status}: ${raw.slice(0, 300)}`);
    return { raw, rows: JSON.parse(raw) as StudioStatus[] };
  };

  await check("studio-fleet spawn: the parent container spawns a real child through /fleet/spawn", async () => {
    // Asserted on the PANE's own environment, not `tmux show-environment`:
    // this is what the `fleet` process will actually read. The token is
    // tested for emptiness, never printed — the URL is not a credential and
    // is echoed, since "which Worker did the container actually call" is the
    // first thing worth knowing if this ever fails.
    const token = await t.run(`test -n "$FLEET_SPAWN_TOKEN" && echo TOKEN_PRESENT || echo TOKEN_MISSING`);
    assert(/TOKEN_PRESENT/.test(token) && !/TOKEN_MISSING/.test(token), `FLEET_SPAWN_TOKEN absent in the pane: ${JSON.stringify(token)}`);
    const workerUrl = (await t.run(`printf '%s' "$FLEET_WORKER_URL"`)).trim();
    assert(workerUrl.startsWith("http"), `FLEET_WORKER_URL absent in the pane: ${JSON.stringify(workerUrl)}`);

    // Precondition, asserted separately so its failure names the real fault
    // instead of surfacing as an opaque 401: the token the container is
    // holding must be the one the Worker published a hash for. This is what
    // caught the provision-order bug (do.ts's provision(), Task 6 FIX) — the
    // container had a perfectly valid-looking token that hashed to nothing in
    // the registry. Computed INSIDE the container so only the digest crosses
    // back; the token itself never reaches this process or its log.
    const digest = (await t.run(`printf '%s' "$FLEET_SPAWN_TOKEN" | sha256sum | cut -d' ' -f1`))
      .replace(/[^0-9a-f]/g, "").slice(0, 64);
    assert(digest.length === 64, `could not read a sha256 back from the container: ${JSON.stringify(digest)}`);
    const parentRow = (await listStudios()).rows.find((r) => r.id === PILOT);
    assert(parentRow !== undefined, `no ${PILOT} row in the registry before spawning`);
    assert(
      parentRow.spawnTokenHash === digest,
      `the container's token hashes to ${digest} but the registry holds ${parentRow.spawnTokenHash} — ` +
      "the container was started with a token the Worker never persisted",
    );

    // Generous budget: this single command runs a whole child provision —
    // blueprint reads, a real guarded clone, a real bring-up — inside the
    // /fleet/spawn request it makes.
    const out = await t.run(`fleet spawn ${SPAWN_ROLE}; echo "EXIT:$?"`, 420_000);
    assert(out.includes("EXIT:0"), `studio-fleet exited non-zero: ${JSON.stringify(out.slice(-600))}`);
    assert(out.includes(`spawned ${SCRATCH}`), `unexpected studio-fleet output: ${JSON.stringify(out.slice(-600))}`);
    assert(/\(running\)/.test(out), `child did not come up running: ${JSON.stringify(out.slice(-600))}`);
    return `${workerUrl} -> spawned ${SCRATCH} (running)`;
  });

  await check("registry read-back: parent + child, spawnedBy pins the parent, no raw token anywhere", async () => {
    const { raw, rows } = await listStudios();
    const parent = rows.find((r) => r.id === PILOT);
    const child = rows.find((r) => r.id === SCRATCH);
    assert(parent !== undefined, `no ${PILOT} row: ${rows.map((r) => r.id).join(", ")}`);
    assert(child !== undefined, `no ${SCRATCH} row: ${rows.map((r) => r.id).join(", ")}`);
    assert(child.spawnedBy === PILOT, `child spawnedBy=${JSON.stringify(child.spawnedBy)} (expected ${PILOT})`);
    // The parent was provisioned directly, by an operator — it has no parent
    // of its own, and a spawn must not retroactively give it one.
    assert(parent.spawnedBy === null, `parent spawnedBy=${JSON.stringify(parent.spawnedBy)} (expected null)`);

    // R-P3-1: the registry stores a DIGEST, never the token. Checked over the
    // whole served body (every field of every row), not just the field it is
    // supposed to be in — a leak would most likely appear somewhere else.
    assert(!/fsp_[0-9a-f]{64}/.test(raw), "registry read-back carried a raw fsp_ spawn token");
    // What it DOES store is a digest — 64 lowercase hex, for both rows. (That
    // this particular digest is the digest of the token the container really
    // holds is asserted in the spawn check above, where a mismatch is the
    // more useful diagnosis.)
    for (const row of [parent, child]) {
      assert(
        typeof row.spawnTokenHash === "string" && /^[0-9a-f]{64}$/.test(row.spawnTokenHash),
        `${row.id} spawnTokenHash is not a sha256 digest: ${JSON.stringify(row.spawnTokenHash)}`,
      );
    }
    return `child.spawnedBy=${PILOT}; both rows carry a digest; no raw token in the body`;
  });

  await check("org-denied spawn: a role the chart does not edge from pilot is refused 403", async () => {
    // The parent's OWN role file advertises this role in `may_spawn`
    // (dev-entry.ts's PILOT_MAY_SPAWN) — advisory documentation the agent's
    // own container carries. org.json does not edge pilot -> cto, and org.json
    // is the only thing the Worker reads. That gap is the whole point: this
    // fails even though the container has every reason to believe it may.
    const out = await t.run(`fleet spawn ${DENIED_ROLE}; echo "EXIT:$?"`, 120_000);
    assert(/EXIT:[1-9]/.test(out), `expected a non-zero exit: ${JSON.stringify(out.slice(-600))}`);
    assert(out.includes("spawn failed (403)"), `expected a 403 from the Worker: ${JSON.stringify(out.slice(-600))}`);
    assert(
      out.includes("spawn not permitted by org chart"),
      `403 body did not reach the container: ${JSON.stringify(out.slice(-600))}`,
    );

    const { rows } = await listStudios();
    const denied = `websites--${DENIED_ROLE}`;
    assert(!rows.some((r) => r.id === denied), `a denied spawn still created ${denied}`);
    return `403 surfaced to the container; no ${denied} row created`;
  });

  // --- drop + reconnect ----------------------------------------------------
  await check("WS drop + reconnect shows the same tmux screen (capture-pane byte-identical)", async () => {
    // Captured from the claude window, which this test never types into, so
    // an exact byte comparison is meaningful.
    await t.run(`tmux capture-pane -p -t studio:claude > /tmp/e2e-before.txt`);
    await t.run(`echo ${echoTag}_SURVIVOR`);
    t.close();
    await Bun.sleep(2000);

    const t2 = new Term(base, PILOT, access.jwt);
    await t2.ready();
    t2.send("\r");
    await t2.waitFor(/[$#] |root@/, 30_000);
    // No `tmux attach` typed here: the reconnect reuses the container's
    // cached pty, whose root process is still the live tmux client.
    const inside = await t2.run(`test -n "$TMUX" && echo IN_TMUX || echo NOT_IN_TMUX`);
    assert(/IN_TMUX/.test(inside) && !/NOT_IN_TMUX/.test(inside), `reconnect left tmux: ${JSON.stringify(inside)}`);

    await t2.run(`tmux capture-pane -p -t studio:claude > /tmp/e2e-after.txt`);
    const cmp = await t2.run(`cmp -s /tmp/e2e-before.txt /tmp/e2e-after.txt && echo SAME || echo DIFFERENT`);
    assert(/SAME/.test(cmp), `claude pane changed across the reconnect: ${JSON.stringify(cmp)}`);

    // Captured to a FILE first, then grepped. Grepping the live pane directly
    // would match the grep command line itself (it contains the marker), so
    // the assertion would pass whether or not the scrollback survived.
    await t2.run(`tmux capture-pane -p -S -2000 -t studio:shell > /tmp/e2e-shell.txt`);
    const shell = await t2.run(`grep -c ${echoTag}_SURVIVOR /tmp/e2e-shell.txt || true`);
    assert(/[1-9]/.test(shell), `shell scrollback lost the pre-drop marker: ${JSON.stringify(shell)}`);
    t2.close();
    return "claude pane identical; shell scrollback intact";
  });

  // --- P2 Task 7: transcript ship -> R2, two forced ticks -------------------
  // Bytes land in the SAME file real pipe-pane writes to
  // (transcript.ts's TRANSCRIPT_LOG_PATH), via the shell window rather than
  // by typing into studio:claude — this file's own established discipline
  // (see the "WS drop + reconnect" check above: "the claude window, which
  // this test never types into") is preserved deliberately, not by
  // oversight. Task 2's own real-container measurement already proved
  // pipe-pane's byte-mirroring mechanics (progress.md: "pipe-pane semantics
  // MEASURED in real image"); what THIS check proves, that a unit test
  // structurally cannot (this file's own header), is the REAL round trip
  // from that file, through a REAL sbExec stat/tail/read, through the REAL
  // R2 binding (miniflare-local under wrangler dev), with REAL DO-storage
  // offset persistence across two independently forced ticks — driven via
  // dev-entry.ts's test-only tick-trigger route (NOT src/; see that file's
  // own containment header), which calls the exact same `shipTranscript()`
  // method a real 30s alarm fire would call.
  const t3 = new Term(base, PILOT, access.jwt);
  await t3.ready();
  t3.send("\r");
  await t3.waitFor(/[$#] |root@/, 30_000);

  const TRANSCRIPT_LOG = TRANSCRIPT_LOG_PATH;
  const MARKER1 = `P2E2E_TICK1_${Math.random().toString(36).slice(2, 10)}`;
  const MARKER2 = `P2E2E_TICK2_${Math.random().toString(36).slice(2, 10)}`;
  // Anthropic-key-shaped (redact.ts's ANTHROPIC_KEY_RE) — fake, never a real
  // credential — used below to prove R-P2-7 (raw archive, scrubbed preview)
  // through the real system: present in the R2 chunk AND the raw DO-storage
  // tail, absent from the served grid page's HTML.
  const SECRET_TOKEN = "sk-ant-api03-FAKETESTNOTREAL00000000000000";

  let keysAfterTick1: string[] = [];
  await check("shipTranscript tick 1: real bytes -> real R2 chunk", async () => {
    await t3.run(`printf '%s\\n' '${MARKER1}' >> ${TRANSCRIPT_LOG}`);
    await forceTick(base, PILOT, "shipTranscript");
    keysAfterTick1 = await r2List(base, `transcripts/${PILOT}/`);
    assert(keysAfterTick1.length > 0, "no transcript chunk in R2 after the first forced tick");
    const contents = await Promise.all(keysAfterTick1.map((k) => r2Get(base, k)));
    const joined = contents.map((b) => (b ? new TextDecoder().decode(b) : "")).join("\n");
    assert(joined.includes(MARKER1), `MARKER1 missing from shipped chunk(s): ${JSON.stringify(keysAfterTick1)}`);
    return `${keysAfterTick1.length} chunk(s), MARKER1 present`;
  });

  await check("shipTranscript tick 2: offset persists — only the NEW bytes ship, no re-ship of tick 1", async () => {
    await t3.run(`printf '%s %s\\n' '${MARKER2}' '${SECRET_TOKEN}' >> ${TRANSCRIPT_LOG}`);
    await forceTick(base, PILOT, "shipTranscript");
    const keysAfterTick2 = await r2List(base, `transcripts/${PILOT}/`);
    const newKeys = keysAfterTick2.filter((k) => !keysAfterTick1.includes(k));
    assert(newKeys.length === 1, `expected exactly 1 new chunk on tick 2, got ${newKeys.length}: ${JSON.stringify(newKeys)}`);
    const bytes = await r2Get(base, newKeys[0]);
    const text = bytes ? new TextDecoder().decode(bytes) : "";
    assert(text.includes(MARKER2), `tick 2's own chunk missing MARKER2: ${JSON.stringify(newKeys[0])}`);
    assert(!text.includes(MARKER1), `tick 2's chunk RE-SHIPPED tick 1's bytes — offset did not persist`);
    return `new chunk ${newKeys[0]}: MARKER2 present, MARKER1 (tick 1) absent`;
  });

  // --- P2 Task 7: grid page serves with a scrubbed preview ------------------
  // "real WS bytes shipped first so transcriptTail exists": the two ticks
  // above shipped through the real WS-attached shell (t3.run), through the
  // real container, through the real ship tick — transcriptTail is
  // therefore already populated with real content by the time this runs,
  // not seeded directly into DO storage by the test.
  await check("grid page (Accept: text/html) embeds a scrubbed preview of real shipped content", async () => {
    const res = await call("/studio/", { headers: { Accept: "text/html" } });
    const html = await res.text();
    assert(res.status === 200, `grid page HTTP ${res.status}`);
    assert(/text\/html/.test(res.headers.get("content-type") ?? ""), `unexpected content-type: ${res.headers.get("content-type")}`);
    assert(html.includes(PILOT), "grid HTML does not mention the pilot studio id");
    assert(html.includes(MARKER2), "grid HTML preview missing MARKER2 — transcriptTail not reflected");
    assert(!html.includes(SECRET_TOKEN), "grid HTML leaked the RAW secret token — preview scrub did not run");

    const rawTail = await readRawTail(base, PILOT);
    assert(rawTail.includes(SECRET_TOKEN), "raw DO-storage tail should still hold the UNSCRUBBED secret (R-P2-7: raw archive)");
    return "preview scrubbed in the served page; raw DO storage still unscrubbed (R-P2-7)";
  });

  // --- P2 Task 7: rotation exec-order — unit layer only ---------------------
  // Deliberately NOT exercised here. ROTATION_THRESHOLD_BYTES (archive.ts)
  // is a plain exported constant with no injection seam — shipTranscriptTick
  // imports it directly via shouldRotate, and nothing in ShipDeps or the
  // schedule wiring takes a threshold override. Reaching it for real would
  // need the container's transcript log to actually grow past 64 MiB (a
  // single dd/yes fill is cheap) AND shipTranscriptTick to fully catch up to
  // it (rotation only fires once `nextManifest.offset >= size` —
  // transcript.ts's own doc comment) — at TRANSCRIPT_PULL_MAX (1 MiB) per
  // tick, that is 64+ forced-tick round trips through the real container,
  // solely to reach the SAME re-stat-before-truncate gate
  // test/studio.transcript.test.ts's "shipTranscriptTick — rotation only
  // when fully shipped" and "...rotation TOCTOU" suites already exercise
  // precisely (rotateCmd's exact shell shape, the re-stat gate passing and
  // failing, the offset reset — Fleet Spawn P3 Task 5 split this into its
  // own exec, separate from the old combined hotTailCmd). An env-gated
  // override consumed only by
  // dev-entry.ts was considered and rejected: `ROTATION_THRESHOLD_BYTES` is
  // an imported const binding, not a function reading `env` — there is no
  // way to override its value from outside archive.ts without editing
  // archive.ts itself, which is exactly the "production code path a test can
  // reach around" containment rule this whole file (and dev-entry.ts) exists
  // to avoid. Per the task brief's own escape hatch: documented here, and
  // asserted at the unit layer only.

  // --- P2 Task 7: session tar -> restore on a FRESH container ---------------
  // Kills PILOT's real sandbox container(s) (harness.ts's killStudioContainers
  // — see its own doc comment for why "all matches", not one picked out by
  // identity) AFTER shipping a real session tar, then re-provisions the SAME
  // studio id: provision.ts's runSessionRestore only ever restores when the
  // container is fresh (~/.claude/projects absent) — a killed-and-recreated
  // container is genuinely fresh, the same as a never-before-provisioned one,
  // and this exercises the FULL real chain (real tar -> real R2 -> real
  // Worker chunked writeFile -> real bring-up verify+untar+atomic-mv in
  // container/studio-bringup.sh) that unit tests (provision.ts's
  // runSessionRestore suite, the bring-up script's own content-assertion
  // tests) can only prove piecewise. Per the spec's own Testing line: "assert
  // file restored, not a claude turn" — this checks file presence only.
  const RESTORE_MARKER = `P2E2E_RESTORE_${Math.random().toString(36).slice(2, 10)}`;
  await check("create real session files on the container, then ship them via a forced syncSession tick", async () => {
    await t3.run(
      `mkdir -p ~/.claude/projects/e2eproj && ` +
      `printf '{"marker":"${RESTORE_MARKER}"}\\n' > ~/.claude/projects/e2eproj/session.jsonl && ` +
      `printf '{}' > ~/.claude.json`,
    );
    const created = await t3.run(`test -f ~/.claude/projects/e2eproj/session.jsonl && echo YES || echo NO`);
    assert(created.includes("YES"), `session files were not created: ${JSON.stringify(created)}`);
    await forceTick(base, PILOT, "syncSession");
    const tar = await r2Get(base, `sessions/${PILOT}/latest.tar.gz`);
    assert(tar !== null && tar.length > 2 && tar[0] === 0x1f && tar[1] === 0x8b, "sessions/<id>/latest.tar.gz missing or not a gzip stream after syncSession");
    return `session tar shipped (${tar!.length} bytes)`;
  });

  await check("kill PILOT's container, re-provision, and confirm session files are restored on the fresh container", async () => {
    t3.close();
    const killed = killStudioContainers();
    await waitForContainersGone(killed);

    const res = await call(`/studio/${PILOT}/provision`, { method: "POST", body: "{}" });
    const body = (await res.json()) as { state: string; error: string | null };
    assert(body.state === "running", `re-provision after kill: state=${body.state} error=${body.error}`);

    const t4 = new Term(base, PILOT, access.jwt);
    await t4.ready();
    t4.send("\r");
    await t4.waitFor(/[$#] |root@/, 30_000);
    const restored = await t4.run(`cat ~/.claude/projects/e2eproj/session.jsonl 2>/dev/null || echo MISSING`);
    t4.close();
    assert(restored.includes(RESTORE_MARKER), `session file not restored on the fresh container: ${JSON.stringify(restored)}`);
    return `killed ${killed.length} container(s); restored file contains the pre-kill marker`;
  });

  // --- isolation -----------------------------------------------------------
  await check("isolation: a second studio's typing never appears in the first", async () => {
    const res = await call(`/studio/${SCRATCH}/provision`, { method: "POST", body: "{}" });
    const body = (await res.json()) as { state: string; error: string | null };
    assert(body.state === "running", `scratch state=${body.state} error=${body.error}`);

    const scratchMark = `SCRATCH_ONLY_${Math.random().toString(36).slice(2, 10)}`;
    const s = new Term(base, SCRATCH, access.jwt);
    await s.ready();
    s.send("\r");
    await s.waitFor(/[$#] |root@/, 30_000);
    const inScratch = await s.run(`echo ${scratchMark}`);
    assert(inScratch.includes(scratchMark), "scratch never echoed its own marker");

    const p = new Term(base, PILOT, access.jwt);
    await p.ready();
    p.send("\r");
    await p.waitFor(/[$#] |root@/, 30_000);
    // Same capture-to-file rule as the reconnect check: grepping the live
    // pane would match the grep command line itself, which necessarily
    // contains the marker, and the isolation assertion would then be
    // guaranteed to fail no matter how well isolated the studios are.
    await p.run(`tmux capture-pane -p -S -2000 -t studio:shell > /tmp/e2e-pilot.txt`);
    const inPilot = await p.run(`grep -c ${scratchMark} /tmp/e2e-pilot.txt || true`);
    assert(/(^|\D)0(\D|$)/.test(inPilot), `pilot saw the scratch marker: ${JSON.stringify(inPilot)}`);
    s.close();
    p.close();
    return `${scratchMark} present in scratch, absent in pilot`;
  });

  // --- restart -------------------------------------------------------------
  await check("restart reuses the persisted role env (Step 0 fix) and returns running", async () => {
    const res = await call(`/studio/${PILOT}/restart`, { method: "POST", body: "{}" });
    const body = (await res.json()) as { state: string; error: string | null };
    assert(body.state === "running", `state=${body.state} error=${body.error}`);
    return "state=running";
  });

  // --- P3 Task 6 (ruling 1): a WARM re-provision must not desync ------------
  // The failure class the "static per studio" ruling exists to kill. A
  // container's environment is fixed when the container starts, so the old
  // remint-on-every-provision behaviour published a hash for a token the
  // already-running container could never hold — re-provisioning a healthy
  // studio silently ended its ability to spawn. Proven here against a REAL
  // warm container (PILOT has been up and re-provisioned since the kill check
  // above), which is the only place the "already running" half is real.
  //
  // Last in the file: it re-runs bring-up, so it must not disturb the tmux
  // state earlier checks assert on.
  await check("warm re-provision keeps the token: registry hash, container env and /fleet/spawn all unchanged", async () => {
    const hashBefore = (await listStudios()).rows.find((r) => r.id === PILOT)?.spawnTokenHash;
    assert(typeof hashBefore === "string", `no ${PILOT} row before the re-provision`);

    const res = await call(`/studio/${PILOT}/provision`, { method: "POST", body: "{}" });
    const body = (await res.json()) as { state: string; error: string | null };
    assert(body.state === "running", `re-provision: state=${body.state} error=${body.error}`);

    const hashAfter = (await listStudios()).rows.find((r) => r.id === PILOT)?.spawnTokenHash;
    assert(hashAfter === hashBefore, `re-provision rotated the registry hash (${hashBefore} -> ${hashAfter})`);

    const t5 = new Term(base, PILOT, access.jwt);
    await t5.ready();
    t5.send("\r");
    await t5.waitFor(/[$#] |root@/, 30_000);
    try {
      const digest = (await t5.run(`printf '%s' "$FLEET_SPAWN_TOKEN" | sha256sum | cut -d' ' -f1`))
        .replace(/[^0-9a-f]/g, "").slice(0, 64);
      assert(digest === hashAfter, `container token hashes to ${digest}, registry holds ${hashAfter}`);

      // The live proof that the token still AUTHENTICATES: a 403 means
      // resolveSpawnParent resolved this container to its studio and the org
      // chart then refused the role. A 401 would mean the token stopped
      // matching any row — exactly the regression this check exists for.
      const out = await t5.run(`fleet spawn ${DENIED_ROLE}; echo "EXIT:$?"`, 120_000);
      assert(
        out.includes("spawn failed (403)"),
        `after a warm re-provision the container's token no longer authenticates: ${JSON.stringify(out.slice(-400))}`,
      );
    } finally {
      t5.close();
    }
    return "hash unchanged; container token still matches; spawn still authenticates (403, not 401)";
  });

  console.log(`\nLATENCY: ${latency}`);
}

// ---------------------------------------------------------------------------
try {
  await main();
} catch (err) {
  record("fatal", false, err instanceof Error ? err.message : String(err));
} finally {
  for (const p of spawned) {
    try {
      p.kill();
    } catch {
      // already gone
    }
  }
  removeDevVars();
}

reportAndExit(devLog);

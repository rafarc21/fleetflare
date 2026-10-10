#!/usr/bin/env bun
/**
 * Transport-level acceptance for `fleet attach` — `bun run test:acceptance`.
 *
 * Covers the headlessly-runnable half of the spec's manual acceptance list:
 * connect, bytes flow, detach/reattach with the screen intact, `ctrl-]`
 * escape, and reconnect after the Worker goes away. It drives the REAL CLI
 * (cli/fleet.ts) as a child process under a REAL pty — the CLI calls
 * `process.stdin.setRawMode(true)` and writes ANSI alt-screen sequences, so a
 * plain pipe would exercise a different program than the operator runs.
 *
 * A full claude turn is NOT part of this: it needs a Max OAuth token, which
 * this environment deliberately does not have. See
 * docs/superpowers/OPERATOR-FINISH-LIST.md for the items that stay manual.
 *
 * Exits non-zero on any failed check.
 */
import { spawn } from "bun";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ROOT, PILOT, SPAWN_ROLE, OPERATOR_SPAWN_CHILD, SERVICE_CLIENT_ID, SERVICE_CLIENT_SECRET,
  check, assert, record, reportAndExit,
  makeAccessIdentity, writeDevVars, removeDevVars, containerWorkerUrl,
  freePort, applyMigrations, resetStudioRows, resetPersistedRunState, requireDocker, startWrangler, api,
  killStudioContainers, waitForContainersGone, forceTick, r2Get,
} from "./harness";
// The exact strings the CLI prints, imported rather than re-typed — the
// "import the real value instead of duplicating the literal" rule. cli/fleet.ts
// guards its own entry point behind `import.meta.main`, so importing it runs
// no CLI.
import { BURN_LEGEND } from "../cli/fleet";

const devLog: string[] = [];
const spawned: { kill(): void }[] = [];

/** Review fix (Task 7): the kill-mid-session check below needs a REAL
 *  byte-for-byte comparison, not a length check — two objects can be the
 *  same size and still not be the same bytes. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** One `fleet <args>` run as a plain (non-pty) child process — the shape
 *  every non-attach command in this file uses. Returns stdout; throws with
 *  stderr attached on a non-zero exit, so a failed command reports the CLI's
 *  own error text rather than an empty-output assertion further down. */
async function fleetCmd(home: string, ...args: string[]): Promise<string> {
  const proc = spawn({
    cmd: ["bun", join(ROOT, "cli", "fleet.ts"), ...args],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home },
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  assert(code === 0, `fleet ${args.join(" ")} exited ${code}: ${err.slice(-500)}`);
  return out;
}

const fleetLs = (home: string) => fleetCmd(home, "ls");

/** cli/fleet.ts's own totals line, matched by its fixed prefix — the numbers
 *  after it are whatever this run's studios have burned. */
const FLEET_TOTALS_PREFIX = "FLEET TOTALS:";

/**
 * Splits `fleet ls` output into its header row and data rows.
 *
 * Fleet Spawn P3, Task 6 — this is the carried break Task 5 found: the table
 * is no longer the whole of stdout. Task 3 prints BURN_LEGEND ABOVE it and
 * Task 5 prints a `FLEET TOTALS:` line BELOW it, so the old `lines[0]` /
 * `lines.slice(1)` split read the legend as the header row and every real
 * column lookup returned -1. The header is found by CONTENT instead (the two
 * columns formatTable has always emitted first), which is stable against any
 * further lines being added above or below it; rows stop at the first line
 * that is not a table row, so the totals line can never be parsed as a studio.
 */
function parseLsTable(out: string): { headers: string[]; rows: string[][] } {
  const lines = out.trim().split("\n");
  const headerIdx = lines.findIndex((l) => {
    const cols = l.split(/ {2,}/).map((s) => s.trim());
    return cols.includes("ID") && cols.includes("STATE");
  });
  assert(headerIdx !== -1, `no ID/STATE header row in fleet ls output: ${out.slice(0, 500)}`);
  const headers = lines[headerIdx].split(/ {2,}/).map((s) => s.trim());
  const rows = lines
    .slice(headerIdx + 1)
    .filter((l) => !l.startsWith(FLEET_TOTALS_PREFIX))
    .map((l) => l.split(/ {2,}/).map((s) => s.trim()));
  return { headers, rows };
}

/**
 * One `fleet attach` running under a real pty, via Bun's own `terminal:`
 * spawn option.
 *
 * The pty is load-bearing, not cosmetic: cli/fleet.ts gates raw mode on
 * `process.stdin.isTTY`, and without raw mode ctrl-] is swallowed by the
 * line discipline and never reaches classifyInput — the exact code path
 * these checks exist to exercise.
 *
 * macOS `script(1)` was tried first and cannot be used from a harness: it
 * calls tcgetattr on its OWN stdin and dies with "tcgetattr/ioctl: Operation
 * not supported on socket" whenever that stdin is a pipe, which it always is
 * when a test spawns it.
 */
class CliSession {
  private buf = "";
  private proc: ReturnType<typeof spawn>;
  exited = false;
  exitCode: number | null = null;

  constructor(home: string, id: string) {
    this.proc = spawn({
      cmd: ["bun", join(ROOT, "cli", "fleet.ts"), "attach", id],
      cwd: ROOT,
      env: { ...process.env, HOME: home },
      terminal: {
        cols: 120,
        rows: 40,
        data: (_t: unknown, chunk: Uint8Array) => {
          this.buf += new TextDecoder().decode(chunk);
        },
      },
    });
    spawned.push(this.proc);
    void this.proc.exited.then((code) => {
      this.exited = true;
      this.exitCode = code;
    });
  }

  get text(): string {
    return this.buf;
  }
  clear(): void {
    this.buf = "";
  }
  send(s: string): void {
    this.proc.terminal?.write(s);
  }
  kill(): void {
    try {
      this.proc.kill();
    } catch {
      // already gone
    }
  }

  async waitFor(needle: string | RegExp, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (typeof needle === "string" ? this.buf.includes(needle) : needle.test(this.buf)) return;
      await Bun.sleep(50);
    }
    throw new Error(`timed out waiting for ${needle} — last 500 bytes: ${JSON.stringify(this.buf.slice(-500))}`);
  }

  async waitExit(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exited) return;
      await Bun.sleep(50);
    }
    throw new Error("CLI did not exit");
  }

  /** Same split-sentinel trick as attach.e2e.ts's Term.run — a terminal
   *  echoes what you type, so a literal marker in the command matches before
   *  the command has run. */
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
    return this.buf.slice(start + open.length, this.buf.indexOf(close, start)).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  }
}

async function main(): Promise<void> {
  console.log("=== fleet CLI acceptance (real pty) ===");
  requireDocker();

  // Port first: `.dev.vars` carries the URL a CONTAINER reaches this run's
  // Worker on (harness.ts's containerWorkerUrl), and that URL embeds the
  // port. `fleet spawn` below is Access-gated and host-side, so nothing in
  // THIS file depends on that URL — but the studio it creates does, and a
  // stale WORKER_PUBLIC_URL would point a live container at production.
  const port = await freePort();
  const access = await makeAccessIdentity();
  await writeDevVars(access, containerWorkerUrl(port));
  applyMigrations();
  // Studio rows survive in .wrangler/state between runs; a leftover child row
  // would make this run's spawn a correct 409 (see resetStudioRows).
  resetStudioRows();
  // ...and a previous run's DO alarms + R2 objects would collide with this
  // run's own containers and chunk keys (see resetPersistedRunState).
  resetPersistedRunState();

  const base = `http://127.0.0.1:${port}`;
  console.log(`starting wrangler dev on ${port}…`);
  spawned.push(await startWrangler(port, devLog));

  // The CLI reads ~/.fleet/credentials. HOME is overridden to a throwaway
  // directory so the operator's own credentials file is never read, written,
  // or backed up — nothing here can touch it.
  const home = mkdtempSync(join(tmpdir(), "fleet-acceptance-"));
  mkdirSync(join(home, ".fleet"), { recursive: true });
  writeFileSync(
    join(home, ".fleet", "credentials"),
    JSON.stringify({
      workerUrl: base,
      accessClientId: SERVICE_CLIENT_ID,
      accessClientSecret: SERVICE_CLIENT_SECRET,
    }),
    { mode: 0o600 },
  );

  await api(base, access.jwt)(`/studio/${PILOT}/provision`, { method: "POST", body: "{}" }).then(async (res) => {
    const body = (await res.json()) as { state: string; error: string | null };
    assert(body.state === "running", `provision failed: ${body.state} ${body.error}`);
  });

  // --- fleet ls ------------------------------------------------------------
  await check("fleet ls lists the provisioned studio through the service token", async () => {
    const out = await fleetLs(home);
    assert(out.includes(PILOT), `fleet ls output missing ${PILOT}: ${out.slice(0, 500)}`);
    return out.trim().split("\n").slice(0, 2).join(" | ");
  });

  // Issue #205: line 1 is the denominator, so `fleet ls | head -N` can never
  // hide how many studios exist. Its exact shape is formatStudioCount's.
  await check("fleet ls line 1 is the STUDIOS denominator, and it counts the provisioned studio", async () => {
    const out = await fleetLs(home);
    const first = out.split("\n")[0];
    assert(first.startsWith("STUDIOS: "), `fleet ls line 1 is not the denominator: ${first.slice(0, 200)}`);
    // Studio rows only: parseLsTable also returns the caveat lines below the table.
    const studios = parseLsTable(out).rows.filter((r) => r[0].includes("--")).length;
    assert(first.startsWith(`STUDIOS: ${studios} total,`), `denominator ${first} disagrees with ${studios} rows`);
    return first;
  });

  // Task 7 (P2): HOST + BURN columns — cli/fleet.ts's formatTable, same
  // process/output-parsing style as the check just above. Column PRESENCE
  // is what's asserted (per the task's own binding wording: "host may be
  // '-' locally — assert column presence"), not an exact format — the cell
  // values are free to change shape later without breaking this.
  await check("fleet ls output shows HOST and BURN columns, under the burn legend", async () => {
    const out = await fleetLs(home);
    const { headers, rows } = parseLsTable(out);
    const hostIdx = headers.indexOf("HOST");
    const burnIdx = headers.indexOf("BURN");
    assert(hostIdx !== -1, `HOST column missing: ${JSON.stringify(headers)}`);
    assert(burnIdx !== -1, `BURN column missing: ${JSON.stringify(headers)}`);

    // Fleet Spawn P3, Task 6 (carried break): the legend line T3 added is
    // asserted here, alongside the columns it explains — the same output,
    // one parse. Imported, not re-typed: cli/fleet.ts exports the exact
    // string it prints (the "import the real value instead of duplicating
    // the literal" rule), so a reworded legend cannot drift past this.
    assert(
      out.split("\n").some((l) => l.trim() === BURN_LEGEND),
      `BURN legend line missing from fleet ls output: ${out.slice(0, 500)}`,
    );

    const pilotRow = rows.find((r) => r[0] === PILOT);
    assert(pilotRow !== undefined, `no row for ${PILOT}: ${out.slice(0, 500)}`);
    const host = pilotRow[hostIdx];
    const burn = pilotRow[burnIdx];
    // Non-empty cell, not a specific value: this harness has no TS_AUTHKEY
    // (Env.TS_AUTHKEY's own doc comment), so HOST reads "-" here — asserted
    // loosely so a future run with a real tailnet hostname still passes.
    assert(!!host, `HOST cell empty for ${PILOT}`);
    assert(!!burn, `BURN cell empty for ${PILOT}`);
    return `HOST=${JSON.stringify(host)} BURN=${JSON.stringify(burn)}`;
  });

  // --- attach: connect + bytes flow ---------------------------------------
  const marker = `CLI_${Math.random().toString(36).slice(2, 10)}`;
  const cli = new CliSession(home, PILOT);

  await check("fleet attach connects, lands in tmux with no typing, and bytes flow both ways", async () => {
    cli.send("\r");
    await cli.waitFor(/[$#] |root@/, 40_000);
    // Nothing types `tmux attach` — the pty's root process already is one
    // (container/studio-shell.sh, via PtyOptions.shell). $TMUX is only set
    // for a process tmux itself started.
    const inside = await cli.run(`test -n "$TMUX" && echo IN_TMUX || echo NOT_IN_TMUX`);
    assert(/IN_TMUX/.test(inside) && !/NOT_IN_TMUX/.test(inside), `not inside tmux: ${JSON.stringify(inside)}`);
    const out = await cli.run(`echo ${marker}`);
    assert(out.includes(marker), `no echo back: ${JSON.stringify(out)}`);
    return marker;
  });

  // --- ctrl-] escape -------------------------------------------------------
  await check("ctrl-] exits the client (and only the client — the studio keeps running)", async () => {
    cli.send("\x1d");
    await cli.waitExit(20_000);
    assert(cli.exitCode === 0, `exit code ${cli.exitCode}`);
    // The studio itself must be untouched by a client leaving.
    const res = await api(base, access.jwt)(`/studio/${PILOT}/status`);
    const body = (await res.json()) as { state: string };
    assert(body.state === "running", `studio state after ctrl-]: ${body.state}`);
    return "client exited 0; studio still running";
  });

  // --- reattach: screen intact --------------------------------------------
  await check("reattach after ctrl-] finds the same tmux session and scrollback", async () => {
    const cli2 = new CliSession(home, PILOT);
    cli2.send("\r");
    await cli2.waitFor(/[$#] |root@/, 40_000);
    // Captured to a file first: grepping the live pane would match the grep
    // command line itself, which contains the marker.
    await cli2.run(`tmux capture-pane -p -S -2000 -t studio:shell > /tmp/cli-shell.txt`);
    const hits = await cli2.run(`grep -c ${marker} /tmp/cli-shell.txt || true`);
    assert(/[1-9]/.test(hits), `pre-detach marker gone from the scrollback: ${JSON.stringify(hits)}`);
    cli2.send("\x1d");
    await cli2.waitExit(20_000);
    return `marker survived the detach/reattach cycle`;
  });

  // --- reconnect after the Worker goes away --------------------------------
  await check("client reconnects on its own after wrangler dev is killed and restarted", async () => {
    const cli3 = new CliSession(home, PILOT);
    cli3.send("\r");
    await cli3.waitFor(/[$#] |root@/, 40_000);

    // Kill the Worker out from under it.
    spawned[0].kill();
    await cli3.waitFor("fleet: disconnected", 30_000);

    // Bring it back on the SAME port — the CLI's backoff loop should find it.
    // A FRESH log buffer: startWrangler's readiness probe scans the buffer it
    // is handed for "Ready on http", and the shared one already contains that
    // line from the first instance, so reusing it would return instantly on a
    // Worker that has not bound its port yet.
    await Bun.sleep(3000);
    const restartLog: string[] = [];
    spawned[0] = await startWrangler(port, restartLog);
    devLog.push(...restartLog);
    cli3.clear();

    // Re-provision: a fresh `wrangler dev` starts a fresh container, so the
    // studio has to come back up before a pty can attach to it.
    await api(base, access.jwt)(`/studio/${PILOT}/provision`, { method: "POST", body: "{}" });

    const deadline = Date.now() + 120_000;
    let reconnected = false;
    while (Date.now() < deadline && !reconnected) {
      cli3.clear();
      cli3.send("\r");
      await Bun.sleep(3000);
      reconnected = /[$#] |root@/.test(cli3.text);
    }
    assert(reconnected, `never got a prompt back: ${JSON.stringify(cli3.text.slice(-400))}`);
    assert(!cli3.exited, "the client gave up and exited instead of reconnecting");
    cli3.send("\x1d");
    await cli3.waitExit(20_000);
    return "reconnected without operator action";
  });

  // --- P2 Task 7: kill the CONTAINER (not the Worker) mid-session -----------
  // A different failure mode from the reconnect check just above: there,
  // `wrangler dev` itself goes away (and — per that check's own comment —
  // its restart already yields a fresh container as a side effect). Here the
  // Worker/DO stay completely untouched and ONLY the studio's sandbox
  // container dies (harness.ts's killStudioContainers — real `docker kill`,
  // same mechanism attach.e2e.ts's own "session tar -> restore on a fresh
  // container" check uses and documents in full). Drives the "reattach"
  // half through the REAL CLI (this file's whole purpose), everything else
  // through the same test-only routes (forceTick/r2Get) attach.e2e.ts uses.
  const CLI_RESTORE_MARKER = `CLI_RESTORE_${Math.random().toString(36).slice(2, 10)}`;
  let tarBeforeKill: Uint8Array | null = null;

  await check("kill the container mid-session: R2 session chunks survive the kill", async () => {
    const cliX = new CliSession(home, PILOT);
    cliX.send("\r");
    await cliX.waitFor(/[$#] |root@/, 40_000);
    await cliX.run(
      `mkdir -p ~/.claude/projects/cliproj && ` +
      `printf '{"marker":"${CLI_RESTORE_MARKER}"}\\n' > ~/.claude/projects/cliproj/session.jsonl && ` +
      `printf '{}' > ~/.claude.json`,
    );
    cliX.send("\x1d");
    await cliX.waitExit(20_000);

    await forceTick(base, PILOT, "syncSession");
    tarBeforeKill = await r2Get(base, `sessions/${PILOT}/latest.tar.gz`);
    assert(tarBeforeKill !== null && tarBeforeKill.length > 2, "session tar missing from R2 before the kill");

    const killed = killStudioContainers();
    await waitForContainersGone(killed);

    const tarAfterKill = await r2Get(base, `sessions/${PILOT}/latest.tar.gz`);
    assert(tarAfterKill !== null, "session tar vanished from R2 after the container was killed");
    // Byte-for-byte, not just length — a same-size-but-different-bytes
    // object would pass a length check while still proving R2 was NOT
    // actually untouched. Same standard the adjacent restore checks already
    // hold themselves to (marker/sha content, not just presence/size).
    assert(bytesEqual(tarBeforeKill!, tarAfterKill), "session tar bytes differ across the kill — R2 must be untouched by a container's own lifecycle");
    return `${killed.length} container(s) killed; session tar (${tarAfterKill.length} bytes) byte-identical before/after`;
  });

  await check("reattach after the kill: re-provision recovers, real CLI finds the restored session file", async () => {
    const res = await api(base, access.jwt)(`/studio/${PILOT}/provision`, { method: "POST", body: "{}" });
    const body = (await res.json()) as { state: string; error: string | null };
    assert(body.state === "running", `re-provision after kill: state=${body.state} error=${body.error}`);

    const cliY = new CliSession(home, PILOT);
    cliY.send("\r");
    await cliY.waitFor(/[$#] |root@/, 40_000);
    const restored = await cliY.run(`cat ~/.claude/projects/cliproj/session.jsonl 2>/dev/null || echo MISSING`);
    cliY.send("\x1d");
    await cliY.waitExit(20_000);
    assert(restored.includes(CLI_RESTORE_MARKER), `session file not restored after reattach: ${JSON.stringify(restored)}`);
    return "reattached via the real CLI; restored session file present";
  });

  // --- P3 Task 6: the operator's own spawn, from the real Mac CLI ----------
  // `fleet spawn` goes to POST /studio/spawn (routes.ts's Access-gated
  // passthrough), NOT the container-facing /fleet/spawn route attach.e2e.ts
  // drives — same runSpawn core, different authentication and a parent fixed
  // to the operator literal. Access is stood in for exactly the way every
  // other check in this file does it (dev-entry.ts's accessEdge swaps this
  // run's service token for the fixture JWT, which the Worker then verifies
  // for real); nothing about the spawn path itself is stubbed.
  //
  // Last in the file on purpose: it creates a second real container, so it
  // cannot perturb the reconnect/kill checks above.
  await check("fleet spawn <role> creates a child studio through the operator route", async () => {
    const out = await fleetCmd(home, "spawn", SPAWN_ROLE);
    const { headers, rows } = parseLsTable(out);
    const stateIdx = headers.indexOf("STATE");
    assert(stateIdx !== -1, `no STATE column in fleet spawn output: ${out.slice(0, 500)}`);
    // The child id is derived from AGENT_REPO's repo half, not from a parent
    // studio — the operator has none. See OPERATOR_SPAWN_CHILD's doc comment.
    const row = rows.find((r) => r[0] === OPERATOR_SPAWN_CHILD);
    assert(row !== undefined, `fleet spawn did not report ${OPERATOR_SPAWN_CHILD}: ${out.slice(0, 500)}`);
    assert(row[stateIdx] === "running", `child state=${row[stateIdx]} (expected running): ${out.slice(0, 500)}`);
    return `${OPERATOR_SPAWN_CHILD} running`;
  });

  await check("fleet ls shows the spawned child alongside the parent, and a fleet-totals line", async () => {
    const out = await fleetLs(home);
    const { headers, rows } = parseLsTable(out);
    const stateIdx = headers.indexOf("STATE");
    const ids = rows.map((r) => r[0]);
    assert(ids.includes(PILOT), `fleet ls missing ${PILOT}: ${JSON.stringify(ids)}`);
    assert(ids.includes(OPERATOR_SPAWN_CHILD), `fleet ls missing the spawned child: ${JSON.stringify(ids)}`);
    const childRow = rows.find((r) => r[0] === OPERATOR_SPAWN_CHILD)!;
    assert(childRow[stateIdx] === "running", `child row state=${childRow[stateIdx]}`);

    // Fleet Spawn P3, Task 5 (R-P3-4): the aggregate line under the table.
    // Shape, not values — what each studio has burned in this run is not
    // something a transport-level acceptance check should pin.
    const totals = out.split("\n").find((l) => l.startsWith(FLEET_TOTALS_PREFIX));
    assert(totals !== undefined, `no fleet-totals line in fleet ls output: ${out.slice(-500)}`);
    assert(
      // Issue #181: "trailing 5h window" -> "current 5h bucket" (the bucket
      // tumbles and expires; it never trailed). Shape only, still.
      /^FLEET TOTALS: \d+ turns, \d+ output tokens, \d+ in the current 5h bucket$/.test(totals.trim()),
      `unexpected fleet-totals shape: ${JSON.stringify(totals)}`,
    );
    return `${ids.length} studios listed; ${totals.trim()}`;
  });

  await check("fleet provision <id> re-provisions an existing studio through the CLI", async () => {
    // The other half of Task 3's CLI pair, and deliberately aimed at a studio
    // that already exists: provision is idempotent by design (do.ts's own
    // provision() doc comment — a re-provision is how an operator heals a
    // degraded studio), so this proves the command end to end without
    // standing up a third container.
    const out = await fleetCmd(home, "provision", PILOT);
    const { headers, rows } = parseLsTable(out);
    const stateIdx = headers.indexOf("STATE");
    const row = rows.find((r) => r[0] === PILOT);
    assert(row !== undefined, `fleet provision did not report ${PILOT}: ${out.slice(0, 500)}`);
    assert(row[stateIdx] === "running", `state=${row[stateIdx]} (expected running): ${out.slice(0, 500)}`);
    return `${PILOT} re-provisioned: running`;
  });
}

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

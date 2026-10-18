import { describe, it, expect, vi } from "vitest";
import {
  restartWithStorage, provisionWithStorage, runRestart, runProvision, STATUS_KEY, ROLE_ENV_KEY,
  BRINGUP_CMD, OPERATION_KEY, LAST_STOP_KEY, recordBringupObservation,
  type ProvisionDeps, type StudioStorage, type RoleEnv, type StudioEnv, type OpCtx, type LastStop,
} from "../src/studio/provision";
import { recycleWithSync, type ResolveMemoryRepo, type CommitLearningFile } from "../src/studio/do";
import { PROVISIONED_OK } from "../src/studio/provision";
import type { SessionSyncDeps, SessionSyncStorage } from "../src/studio/session-sync";
import { sessionLatestKey, sessionDailyKey } from "../src/studio/archive";
import type { StudioStatus, ProvisionConfig } from "../src/studio/types";
import {
  getObserved, mergeObserved, type ObservedStorage,
  BRINGUP_TOKEN_WRITE_SECTION, SESSION_FOUND_SECTION, SESSION_CONTINUE_SECTION, SESSION_CWD_SECTION,
  SESSION_LEAD_AGE_SECTION,
} from "../src/studio/observed";
import {
  runAccountFailover, paneCaptureCmd, RATE_LIMIT_HEADLINES, RATE_LIMIT_MODAL_MARKERS, PANE_CAPTURE_MARKER,
  type FailoverDeps,
} from "../src/studio/failover";
import type { ClaudeAccount } from "../src/studio/accounts";
import { composeSurvivalBrief } from "../src/studio/survival-brief";
import { row } from "./helpers/studio-row";

const REPO = "acme-os";
const STUDIO_ID = `${REPO}--release-studio`;
const ROLE_ID = `${REPO}--scratch`;
const NOW = "2026-09-23T17:42:00.000Z";
const CONTAINER_HAS_PROJECTS_CMD = "[ -d ~/.claude/projects ] && echo yes || echo no";
const CLONE_CHECK = `test -d /workspace/${REPO}/.git`;
const AGENTS_CHECK = 'test -d "$HOME/.claude/agents"';

const ROLE_ENV: RoleEnv = { ROLE_PROMPT_B64: "aGk=", ROLE_ALLOWED_TOOLS: "Bash(git *)", ROLE_EFFORT: "" };

const STUDIO_ENV: StudioEnv = {
  ...ROLE_ENV,
  STUDIO_NAME: "release-studio",
  STUDIO_SKILLS: "qa",
  STUDIO_MEMBERS_B64: btoa(JSON.stringify({ "qa-engineer.md": btoa("# qa") })),
  STUDIO_MCP: "",
  STUDIO_LEAD_DISALLOWED: "Edit",
  BLUEPRINT_REPO: "rafarc21/fleetflare",
};

const status = (o: Partial<StudioStatus> = {}) => row({ id: STUDIO_ID, state: "running", ...o });

/** The same Map-backed StudioStorage fake every other studio suite defines
 *  locally — kept per-file, matching this feature's established convention. */
function fakeStorage(seed: { status?: StudioStatus; roleEnv?: RoleEnv | StudioEnv }): StudioStorage {
  const map = new Map<string, unknown>();
  if (seed.status) map.set(STATUS_KEY, seed.status);
  if (seed.roleEnv) map.set(ROLE_ENV_KEY, seed.roleEnv);
  return {
    get: (async (key: string) => map.get(key)) as StudioStorage["get"],
    put: (async (key: string, value: unknown) => {
      map.set(key, value);
    }) as StudioStorage["put"],
  };
}

/** Same Map-backed fake as fakeStorage above, but the returned object also
 *  structurally satisfies ObservedStorage — mirrors how a real
 *  `this.ctx.storage` is one object satisfying every narrow port at once.
 *  `lastStop` seeds board #129's own onStop record (LAST_STOP_KEY) — StudioStorage
 *  only declares a `get` overload for that key, never a `put` (do.ts's own
 *  onStop is the sole writer in real wiring), so a test that needs one
 *  present seeds it here rather than calling `storage.put` directly. */
function fakeStorageWithObserved(
  seed: { status?: StudioStatus; roleEnv?: RoleEnv | StudioEnv; lastStop?: LastStop },
): StudioStorage & ObservedStorage {
  const map = new Map<string, unknown>();
  if (seed.status) map.set(STATUS_KEY, seed.status);
  if (seed.roleEnv) map.set(ROLE_ENV_KEY, seed.roleEnv);
  if (seed.lastStop) map.set(LAST_STOP_KEY, seed.lastStop);
  return {
    get: (async (key: string) => map.get(key)) as StudioStorage["get"],
    put: (async (key: string, value: unknown) => {
      map.set(key, value);
    }) as StudioStorage["put"],
  } as StudioStorage & ObservedStorage;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The default answer this file's `restartDeps` gives to the combined
 * token-write + pane-probe exec (issue #85, maestro correction #6) when a
 * test's own `onCmd` does not care about it: token write succeeds, no lead
 * pane found (this fake container has no real tmux). Kept as the DEFAULT so
 * every test written before this task's exec-folding change keeps asserting
 * the same "a successful bring-up writes a fresh incarnation token" behavior
 * without having to know the observation exec's own stdout shape.
 */
function defaultObservationStdout(): string {
  return [
    BRINGUP_TOKEN_WRITE_SECTION, "yes",
    SESSION_FOUND_SECTION, "no", SESSION_CONTINUE_SECTION, "no", SESSION_CWD_SECTION, "",
  ].join("\n");
}

/**
 * A container that answers per COMMAND, and counts how many times bring-up
 * was exec'd. `onCmd` returning undefined means "this command succeeded with
 * no output", which is what every real container does for the commands these
 * tests are not about.
 *
 * `bringupResults` is a queue, one entry per bring-up exec, so a test can say
 * "the first attempt comes up hollow, the second lands" — the exact shape of
 * the replacement failure this issue is about.
 */
function restartDeps(
  onCmd: (cmd: string, attempt: number) => ExecResult | undefined,
  // Issue #88's test seam. runSessionRestore returns early when the deps
  // carry no R2 port at all, which is correct and is why the default fake
  // here stays minimal — pass `withR2` only when the restore itself is what
  // is under test.
  withR2 = false,
): ProvisionDeps & { cmds: string[]; bringupCount: () => number } {
  const cmds: string[] = [];
  let bringups = 0;
  const sbExec = vi.fn(async (cmd: string) => {
    if (cmd === BRINGUP_CMD) bringups += 1;
    cmds.push(cmd);
    const custom = onCmd(cmd, bringups);
    if (custom) return custom;
    if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) return { code: 0, stdout: defaultObservationStdout(), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  return {
    sbExec,
    recordStudio: async () => {},
    now: () => NOW,
    fetchBlueprintFile: vi.fn(async () => {
      throw new Error("restart must not refetch the blueprint");
    }),
    ...(withR2
      ? {
          r2Get: vi.fn(async () => null),
          writeFile: vi.fn(async () => {}),
        }
      : {}),
    cmds,
    bringupCount: () => bringups,
  };
}

// ---------------------------------------------------------------------------
// PART 2 — the replacement path is verified
// ---------------------------------------------------------------------------


// Review round 3 (issue #85 PR1), MUST-FIX 3: bring-up NO-OPS when claude is
// already running in the pane (container/studio-bringup.sh: "claude is
// ALREADY running in tmux studio:claude -- launched nothing and left the
// existing lead untouched"), but always answers success regardless. Reading
// the LIVE lead's argv/cwd after such a no-op recomputed a verdict from a
// launch this bring-up never performed — on that lead's first-ever launch
// (no --continue yet) the recompute read LOST even though nothing happened.
function scriptedProbeWithAge(hasContinue: boolean, cwd: string, leadAgeS: number): string {
  return [
    SESSION_FOUND_SECTION, "yes",
    SESSION_CONTINUE_SECTION, hasContinue ? "yes" : "no",
    SESSION_CWD_SECTION, cwd,
    SESSION_LEAD_AGE_SECTION, String(leadAgeS),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Issue #85, Task 11 (maestro correction #14) — the capstone integration
// test. A REAL staged restore (r2Get/writeFile actually run, not stubbed
// away) driven through the SAME heal closure `syncSessionCycle` actually
// calls (do.ts's `syncSession()`: `() => this.restartStudio("heal")`, which
// bottoms out at `restartWithStorage(..., "heal", storage)` — see that
// method's own doc comment). Two outcomes: a live process that genuinely
// resumed, and one that did not — a real restore must never be silently
// reported as "resumed" when the actual pane shows otherwise.
//
// Design note (documented simplification, see this plan's own Task 11): the
// fetched "tar" here is a plain deterministic Uint8Array, never a real
// tar.gz. `runSessionRestore` (provision.ts) never inspects the bytes'
// internal structure — it slices them and writes them via `writeFile`;
// structural/gzip validity is verified entirely container-side, out of scope
// for this Worker-side test (Principle 3: zero container/ changes).
// ---------------------------------------------------------------------------

/** A minimal, correctly-sectioned pane-probe stdout fragment — reused by
 *  every test below so the fixture matches Task 6's real `parsePaneLeadProbe`
 *  section markers exactly, never hand-rolled per test. */
function scriptedProbe(hasContinue: boolean, cwd: string): string {
  return [
    SESSION_FOUND_SECTION, "yes",
    SESSION_CONTINUE_SECTION, hasContinue ? "yes" : "no",
    SESSION_CWD_SECTION, cwd,
  ].join("\n");
}

/**
 * The heal closure `syncSession()` builds (do.ts), boiled down to the one
 * call that actually matters for this test — see do.ts's own comment on
 * that heal wiring (sweep 43 F15, issue #894) for why this distilled form
 * is the whole contract a restore-path test needs.
 */
function healClosure(
  deps: ProvisionDeps, storage: StudioStorage & ObservedStorage, id: string, fleetRepoSlug: string,
) {
  return () => restartWithStorage(deps, storage, id, fleetRepoSlug, "heal", storage);
}

describe("restartWithStorage — a real staged restore through a heal, end to end (issue #85)", () => {
  it("RESUMED: stages a real restore (not skip), and records a resumed session verdict, driven via the real heal closure", async () => {
    const fakeSnapshot = new Uint8Array(new TextEncoder().encode("fake-session-tar-bytes-not-a-real-tar"));
    const writes: { path: string; bytes: Uint8Array }[] = [];
    const deps: ProvisionDeps & { cmds: string[] } = {
      sbExec: vi.fn(async (cmd: string) => {
        deps.cmds.push(cmd);
        if (cmd === CONTAINER_HAS_PROJECTS_CMD) return { code: 0, stdout: "no\n", stderr: "" };
        if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) {
          return {
            code: 0,
            stdout: [BRINGUP_TOKEN_WRITE_SECTION, "yes", scriptedProbe(true, "/workspace/acme-os")].join("\n"),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }),
      recordStudio: async () => {},
      now: () => NOW,
      fetchBlueprintFile: vi.fn(async () => {
        throw new Error("restart must not refetch the blueprint");
      }),
      r2Get: vi.fn(async () => fakeSnapshot),
      writeFile: vi.fn(async (path: string, bytes: Uint8Array) => {
        writes.push({ path, bytes });
      }),
      cmds: [],
    };
    const storage = fakeStorageWithObserved({
      status: status({ id: "acme-os--pilot", repoSlug: `acme-org/acme-os` }), roleEnv: STUDIO_ENV,
    });

    const result = await healClosure(deps, storage, "acme-os--pilot", "rafarc21/fleetflare")();

    expect(result.state).toBe("running");
    expect(writes.some((w) => w.path.endsWith("manifest.json"))).toBe(true);
    expect(writes.some((w) => w.path.includes("part-00"))).toBe(true);

    const observed = await getObserved(storage);
    expect(observed.session).not.toBeNull();
    expect(observed.session?.restore).toBe("restored");
    expect(observed.session?.via).toBe("heal");
    expect(observed.session?.verdict).toBe("resumed");
  });

  it("LOST: a real restore lands, but the probe finds no --continue — records a LOST verdict with lifetime turns, never silently 'resumed' (maestro correction #14)", async () => {
    const fakeSnapshot = new Uint8Array(new TextEncoder().encode("fake-session-tar-bytes-not-a-real-tar"));
    const deps: ProvisionDeps & { cmds: string[] } = {
      sbExec: vi.fn(async (cmd: string) => {
        deps.cmds.push(cmd);
        if (cmd === CONTAINER_HAS_PROJECTS_CMD) return { code: 0, stdout: "no\n", stderr: "" };
        if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) {
          return {
            code: 0,
            stdout: [BRINGUP_TOKEN_WRITE_SECTION, "yes", scriptedProbe(false, "/workspace/acme-os")].join("\n"),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }),
      recordStudio: async () => {},
      now: () => NOW,
      fetchBlueprintFile: vi.fn(async () => { throw new Error("restart must not refetch the blueprint"); }),
      r2Get: vi.fn(async () => fakeSnapshot),
      writeFile: vi.fn(async () => {}),
      cmds: [],
    };
    const storage = fakeStorageWithObserved({
      status: status({
        id: "acme-os--pilot", repoSlug: `acme-org/acme-os`,
        burn: { turns: 88, inputTokens: 0, outputTokens: 0, costUsd: 0, window5hStart: NOW, window5hOutput: 0 },
      }), roleEnv: STUDIO_ENV,
    });

    const result = await healClosure(deps, storage, "acme-os--pilot", "rafarc21/fleetflare")();

    expect(result.state).toBe("running");
    const observed = await getObserved(storage);
    expect(observed.session?.restore).toBe("restored");
    expect(observed.session?.verdict).toBe("lost");
    expect(observed.session?.turnsBefore).toBe(88);
    expect(observed.session?.reason).toBe("no --continue");
  });
});

// Review round 3 (issue #85 PR1), MUST-FIX 8(c)/8(d) — the snapshot age
// recorded on a real restore must reflect work genuinely AT RISK (the OLD
// container's stop time minus the snapshot's own upload time), not restore
// time and never bring-up's own much-later record time.
describe("restartWithStorage — snapshot age reflects work at risk, not restore/record time (issue #85 review round 3, MUST-FIX 8c/8d)", () => {
  const SNAPSHOT_AT = "2026-09-23T08:00:00.000Z";

  /** A `now()` that advances by 1s on every call, so a test can prove the
   *  age actually used corresponds to an EARLY call (the restore-observed
   *  moment) rather than the LAST call (recordBringupObservation's own,
   *  much later, record-time `now`) without having to predict the exact
   *  call count either function makes internally. */
  function advancingNow(baseIso: string): { now: () => string; calls: string[] } {
    const base = Date.parse(baseIso);
    let n = 0;
    const calls: string[] = [];
    return {
      calls,
      now: () => {
        const iso = new Date(base + n * 1000).toISOString();
        n += 1;
        calls.push(iso);
        return iso;
      },
    };
  }

  function restoreDeps(clock: { now: () => string }): ProvisionDeps & { cmds: string[] } {
    const fakeSnapshot = new Uint8Array(new TextEncoder().encode("fake-session-tar-bytes-not-a-real-tar"));
    const deps: ProvisionDeps & { cmds: string[] } = {
      sbExec: vi.fn(async (cmd: string) => {
        deps.cmds.push(cmd);
        if (cmd === CONTAINER_HAS_PROJECTS_CMD) return { code: 0, stdout: "no\n", stderr: "" };
        if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) {
          return {
            code: 0,
            stdout: [BRINGUP_TOKEN_WRITE_SECTION, "yes", scriptedProbe(true, "/workspace/acme-os")].join("\n"),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }),
      recordStudio: async () => {},
      now: clock.now,
      fetchBlueprintFile: vi.fn(async () => { throw new Error("restart must not refetch the blueprint"); }),
      r2Get: vi.fn(async () => fakeSnapshot),
      writeFile: vi.fn(async () => {}),
      cmds: [],
    };
    return deps;
  }

  it("replacedAt known: exact age (stop time - snapshot time), ignores the much-later record time entirely", async () => {
    const clock = advancingNow("2026-09-23T10:00:00.000Z");
    const deps = restoreDeps(clock);
    const storage = fakeStorageWithObserved({
      status: status({ id: "acme-os--pilot", repoSlug: `acme-org/acme-os` }), roleEnv: STUDIO_ENV,
    });
    await mergeObserved(storage, {
      lastSnapshotAt: SNAPSHOT_AT,
      replacedAt: "2026-09-23T08:30:00.000Z", // the OLD container's own stop time — 30m after the snapshot
    });

    await healClosure(deps, storage, "acme-os--pilot", "rafarc21/fleetflare")();

    const observed = await getObserved(storage);
    expect(observed.session?.snapshotAgeS).toBe(30 * 60);
    expect(observed.session?.snapshotAgeIsUpperBound).toBeFalsy();
  });

  it("replacedAt unknown: falls back to the restore-observed time, marked as an upper bound, and is strictly less than a naive record-time age", async () => {
    const clock = advancingNow("2026-09-24T00:00:00.000Z"); // ~16h after the snapshot
    const deps = restoreDeps(clock);
    const storage = fakeStorageWithObserved({
      status: status({ id: "acme-os--pilot", repoSlug: `acme-org/acme-os` }), roleEnv: STUDIO_ENV,
    });
    await mergeObserved(storage, { lastSnapshotAt: SNAPSHOT_AT }); // no replacedAt

    await healClosure(deps, storage, "acme-os--pilot", "rafarc21/fleetflare")();

    const observed = await getObserved(storage);
    expect(observed.session?.snapshotAgeIsUpperBound).toBe(true);
    // clock.calls' LAST entry is recordBringupObservation's own record-time
    // `now` — the naive (pre-fix) formula this age must beat.
    const recordTimeAgeS = Math.floor((Date.parse(clock.calls[clock.calls.length - 1]) - Date.parse(SNAPSHOT_AT)) / 1000);
    expect(observed.session?.snapshotAgeS).not.toBeNull();
    expect(observed.session!.snapshotAgeS!).toBeLessThan(recordTimeAgeS);
  });

  it("no lastSnapshotAt recorded yet, but deps.r2Head answers: falls back to R2's own uploaded timestamp", async () => {
    const clock = advancingNow("2026-09-23T10:00:00.000Z");
    const deps = restoreDeps(clock);
    deps.r2Head = vi.fn(async () => ({ uploaded: new Date(SNAPSHOT_AT) }));
    const storage = fakeStorageWithObserved({
      status: status({ id: "acme-os--pilot", repoSlug: `acme-org/acme-os` }), roleEnv: STUDIO_ENV,
    });
    await mergeObserved(storage, { replacedAt: "2026-09-23T08:30:00.000Z" }); // lastSnapshotAt stays null

    await healClosure(deps, storage, "acme-os--pilot", "rafarc21/fleetflare")();

    const observed = await getObserved(storage);
    expect(deps.r2Head).toHaveBeenCalled();
    expect(observed.session?.snapshotAgeS).toBe(30 * 60);
    expect(observed.session?.snapshotAgeIsUpperBound).toBeFalsy();
  });

  // Board issue #223 fix: `LAST_STOP_KEY` (board #129's own onStop record) is
  // read by `restartWithStorage`/`provisionWithStorage` and passed through to
  // `resolveSnapshotAge` as its priority rung (i) — ahead of `replacedAt` and
  // the `restoreObservedAt` fallback — but no existing test ever seeded it,
  // so nothing would fail if that read were silently dropped. A studio
  // stopped for 8 HOURS, whose FINAL pre-stop sync landed just 30s before the
  // stop itself (almost no unsynced work when it actually stopped), must
  // record an age of ~30s, not ~8h — proving `lastStop.at` is actually being
  // used, not silently falling through to the restoreObservedAt fallback
  // (rung iii), which WOULD show the full 8h figure (as an upper bound) and
  // is exactly what a dropped LAST_STOP_KEY read would produce instead.
  it("lastStop.at known and in-range (issue #85 review round 6, MUST-FIX 4): anchors the age at the real stop time, not the ~8h-later restore time", async () => {
    const clock = advancingNow("2026-09-23T16:00:30.000Z"); // ~8h after the snapshot
    const deps = restoreDeps(clock);
    // The old container's FINAL pre-stop sync landed 30s after the snapshot's
    // own upload — genuinely close, i.e. almost no unsynced work when it
    // actually stopped — even though the restore itself only happens ~8h
    // later.
    const storage = fakeStorageWithObserved({
      status: status({ id: "acme-os--pilot", repoSlug: `acme-org/acme-os` }), roleEnv: STUDIO_ENV,
      lastStop: { exitCode: 0, reason: "exit", at: "2026-09-23T08:00:30.000Z" },
    });
    await mergeObserved(storage, { lastSnapshotAt: SNAPSHOT_AT }); // no replacedAt

    await restartWithStorage(deps, storage, "acme-os--pilot", "rafarc21/fleetflare", "restart", storage);

    const observed = await getObserved(storage);
    // Anchored on lastStop.at (30s after the snapshot), never the ~8h
    // restore-observed fallback: a dropped LAST_STOP_KEY read would fall
    // through to rung (iii) instead, giving a snapshotAgeS in the tens of
    // thousands of seconds, marked as an upper bound — the opposite of what
    // this test pins.
    expect(observed.session?.snapshotAgeS).toBe(30);
    expect(observed.session?.snapshotAgeIsUpperBound).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Board #250 (#85/#118 follow-up) — a keeper restore (`runSessionRestore`'s
// own `source: "daily <date>"`) is from a genuinely OLDER snapshot than
// `latest` by construction (`pickRestoreSource`'s own doc comment). Before
// this fix, `recordBringupObservation` always measured `snapshotAgeS` against
// `latest`'s own upload time regardless of which snapshot the restore
// actually used, understating the real work-at-risk age of a keeper restore.
// A minimal REAL gzip'd single-file tar (same in-test-built-archive shape
// test/studio.backup-guard.test.ts's own fixture section uses, kept local per
// that file's own "own fakes, per file" convention — sessionStats/newestMark
// need real bytes, not a fake placeholder, for pickRestoreSource to ever
// choose a keeper at all).
// ---------------------------------------------------------------------------

const KEEPER_BLOCK = 512;

function keeperField(buf: Uint8Array, off: number, value: string, len: number): void {
  const enc = new TextEncoder().encode(value);
  buf.set(enc.subarray(0, Math.min(enc.length, len)), off);
}

function keeperOctal(buf: Uint8Array, off: number, value: number, len: number): void {
  keeperField(buf, off, value.toString(8).padStart(len - 1, "0"), len);
}

function keeperTarHeader(name: string, size: number, mtime: number): Uint8Array {
  const h = new Uint8Array(KEEPER_BLOCK);
  keeperField(h, 0, name.slice(0, 100), 100);
  keeperOctal(h, 100, 0o644, 8);
  keeperOctal(h, 108, 0, 8);
  keeperOctal(h, 116, 0, 8);
  keeperOctal(h, 124, size, 12);
  keeperOctal(h, 136, mtime, 12);
  h.set(new TextEncoder().encode("        "), 148);
  h[156] = "0".charCodeAt(0);
  keeperField(h, 257, "ustar", 6);
  keeperField(h, 263, "00", 2);
  let sum = 0;
  for (let i = 0; i < KEEPER_BLOCK; i++) sum += h[i];
  keeperField(h, 148, `${sum.toString(8).padStart(6, "0")}\0 `, 8);
  return h;
}

function keeperTarPad(bytes: Uint8Array): Uint8Array {
  const rem = bytes.length % KEEPER_BLOCK;
  if (rem === 0) return bytes;
  const out = new Uint8Array(bytes.length + (KEEPER_BLOCK - rem));
  out.set(bytes);
  return out;
}

async function keeperGzip(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const cs = new CompressionStream("gzip") as unknown as {
    readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  }).pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A real gzip'd tar with exactly one `.claude/projects/.../*.jsonl` member
 *  (a single complete line, timestamped `ts`) — the minimum `sessionStats`/
 *  `newestMark` (burn.ts) need to hand `pickRestoreSource` a real mark. */
async function keeperSessionArchive(ts: string): Promise<Uint8Array<ArrayBuffer>> {
  const name = ".claude/projects/-workspace-acme-os/11111111-1111-1111-1111-111111111111.jsonl";
  const line = `${JSON.stringify({ type: "user", uuid: "u0", timestamp: ts })}\n`;
  const body = new TextEncoder().encode(line);
  const blocks = [
    keeperTarHeader(name, body.length, 1_790_000_000), keeperTarPad(body),
    new Uint8Array(KEEPER_BLOCK), new Uint8Array(KEEPER_BLOCK),
  ];
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return keeperGzip(out);
}

const KEEPER_STUDIO_ID = "acme-os--pilot";
const KEEPER_DATE = "2026-09-10";
const KEEPER_KEY = sessionDailyKey(KEEPER_STUDIO_ID, KEEPER_DATE);
const KEEPER_UPLOADED_AT = "2026-09-10T00:00:00.000Z"; // the keeper's OWN, genuinely old, upload time
const LATEST_UPLOADED_AT = "2026-09-23T23:59:00.000Z"; // recent — what a mutant would wrongly measure against

/** `ProvisionDeps` wired so `runSessionRestore`/`pickRestoreSource` choose the
 *  daily keeper: `latest` is entirely missing (r2Get on `sessionLatestKey`
 *  resolves null), the keeper is a real, mark-bearing archive, and `r2Head`
 *  answers PER KEY — the keeper's own uploaded time for `KEEPER_KEY`, a
 *  recent, clearly-different one for `sessionLatestKey` — so a test can tell
 *  which key `recordBringupObservation` actually read from. */
function keeperRestoreDeps(keeper: Uint8Array<ArrayBuffer>): ProvisionDeps & { cmds: string[] } {
  const deps: ProvisionDeps & { cmds: string[] } = {
    sbExec: vi.fn(async (cmd: string) => {
      deps.cmds.push(cmd);
      if (cmd === CONTAINER_HAS_PROJECTS_CMD) return { code: 0, stdout: "no\n", stderr: "" };
      if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) {
        return {
          code: 0,
          stdout: [BRINGUP_TOKEN_WRITE_SECTION, "yes", scriptedProbe(true, "/workspace/acme-os")].join("\n"),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    }),
    recordStudio: async () => {},
    now: () => NOW,
    fetchBlueprintFile: vi.fn(async () => { throw new Error("restart must not refetch the blueprint"); }),
    r2Get: vi.fn(async (key: string) => {
      if (key === sessionLatestKey(KEEPER_STUDIO_ID)) return null;
      if (key === KEEPER_KEY) return keeper;
      return null;
    }),
    r2List: vi.fn(async (prefix: string) => [KEEPER_KEY].filter((k) => k.startsWith(prefix))),
    r2Head: vi.fn(async (key: string) => {
      if (key === KEEPER_KEY) return { uploaded: new Date(KEEPER_UPLOADED_AT) };
      if (key === sessionLatestKey(KEEPER_STUDIO_ID)) return { uploaded: new Date(LATEST_UPLOADED_AT) };
      return null;
    }),
    writeFile: vi.fn(async () => {}),
    cmds: [],
  };
  return deps;
}

describe("runRestart — onRestoreOutcome forwards runSessionRestore's own `source`, not just the outcome (issue #250)", () => {
  // Mutant 2 bite-proof: if the call site at provision.ts's own
  // `deps.onRestoreOutcome?.(restoreOutcome)` (runRestart's restore try/catch)
  // ever regresses to dropping the second argument, this assertion fails —
  // `source` would read `undefined` where "daily <date>" is expected.
  it("a keeper-sourced restore forwards source: 'daily <date>' to onRestoreOutcome, alongside the outcome", async () => {
    const keeper = await keeperSessionArchive(KEEPER_UPLOADED_AT);
    const deps = keeperRestoreDeps(keeper);
    const onRestoreOutcome = vi.fn();

    await runRestart(
      { ...deps, onRestoreOutcome }, status({ id: KEEPER_STUDIO_ID, repoSlug: "acme-org/acme-os" }),
      KEEPER_STUDIO_ID, STUDIO_ENV, true, "rafarc21/fleetflare",
    );

    expect(onRestoreOutcome).toHaveBeenCalledWith("restored", `daily ${KEEPER_DATE}`);
  });

  it("a restore with no r2List wired (latest-only, as before) forwards source: null", async () => {
    const fakeSnapshot = new Uint8Array(new TextEncoder().encode("fake-session-tar-bytes-not-a-real-tar"));
    const deps = restartDeps(() => undefined, true);
    const onRestoreOutcome = vi.fn();

    await runRestart(
      { ...deps, r2Get: vi.fn(async () => fakeSnapshot), onRestoreOutcome },
      status({ repoSlug: `acme-org/${REPO}` }), STUDIO_ID, STUDIO_ENV, true, "rafarc21/fleetflare",
    );

    expect(onRestoreOutcome).toHaveBeenCalledWith("restored", null);
  });
});

describe("restartWithStorage — a keeper-sourced restore measures snapshotAgeS against the KEEPER's own R2 upload time, not latest's (issue #250)", () => {
  // Mutant 1 bite-proof: KEEPER_UPLOADED_AT and LATEST_UPLOADED_AT are ~13
  // days apart on purpose — a fix that read `sessionLatestKey` for the
  // keeper case (this test's own deliberate mutant, tried and reverted while
  // authoring this fix) would report an age of a few minutes; the correct
  // fix reports an age of ~13 days.
  it("records an age computed from the keeper's own uploaded time, and stamps snapshotSource with the keeper's own label", async () => {
    const keeper = await keeperSessionArchive(KEEPER_UPLOADED_AT);
    const deps = keeperRestoreDeps(keeper);
    const storage = fakeStorageWithObserved({
      status: status({ id: KEEPER_STUDIO_ID, repoSlug: "acme-org/acme-os" }), roleEnv: STUDIO_ENV,
    });
    // No lastSnapshotAt/replacedAt seeded at all: `latest` was never
    // uploaded (this is exactly the case a keeper restore is FOR), so the
    // untouched branch has nothing to fall back on — only the keeper's own
    // fresh r2Head read can answer here.

    await restartWithStorage(deps, storage, KEEPER_STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

    const observed = await getObserved(storage);
    expect(observed.session?.restore).toBe("restored");
    expect(observed.session?.snapshotSource).toBe(`daily ${KEEPER_DATE}`);
    expect(deps.r2Head).toHaveBeenCalledWith(KEEPER_KEY);
    // ~13 days, not the few minutes a `sessionLatestKey` read would produce.
    const expectedAgeS = Math.floor((Date.parse(NOW) - Date.parse(KEEPER_UPLOADED_AT)) / 1000);
    expect(observed.session?.snapshotAgeS).toBe(expectedAgeS);
    expect(observed.session!.snapshotAgeS!).toBeGreaterThan(13 * 24 * 60 * 60);
  });
});

describe("restartWithStorage — an explicit source: \"latest\" restore is byte-for-byte unchanged (issue #250 — pins the untouched branch)", () => {
  it("a richer latest (pickRestoreSource actually runs, r2List wired) still measures age against lastSnapshotAtBefore/r2Head(sessionLatestKey), and never sets snapshotSource", async () => {
    const LATEST_LAST_SNAPSHOT_AT = "2026-09-23T17:40:00.000Z"; // 2m before NOW
    const latest = await keeperSessionArchive(LATEST_LAST_SNAPSHOT_AT);
    const deps = keeperRestoreDeps(latest);
    // Override r2Get so `latest` itself now holds the (richer) session --
    // pickRestoreSource returns fromLatest without ever reading the keeper.
    deps.r2Get = vi.fn(async (key: string) => (key === sessionLatestKey(KEEPER_STUDIO_ID) ? latest : null));
    const storage = fakeStorageWithObserved({
      status: status({ id: KEEPER_STUDIO_ID, repoSlug: "acme-org/acme-os" }), roleEnv: STUDIO_ENV,
    });
    await mergeObserved(storage, { lastSnapshotAt: LATEST_LAST_SNAPSHOT_AT });

    await restartWithStorage(deps, storage, KEEPER_STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

    const observed = await getObserved(storage);
    expect(observed.session?.restore).toBe("restored");
    expect(observed.session?.snapshotSource).toBeUndefined();
    // lastSnapshotAtBefore answers first — r2Head is never even consulted for
    // this restore's own age (the same "never re-read here" posture
    // maestro correction #8 already established for the untouched branch).
    expect(deps.r2Head).not.toHaveBeenCalledWith(sessionLatestKey(KEEPER_STUDIO_ID));
    const expectedAgeS = Math.floor((Date.parse(NOW) - Date.parse(LATEST_LAST_SNAPSHOT_AT)) / 1000);
    expect(observed.session?.snapshotAgeS).toBe(expectedAgeS);
  });
});

// ---------------------------------------------------------------------------
// Board #287 (PR #286 review, mutants M3/M4) — board #250's own fix forwards
// `restoreSource` through `onRestoreOutcome` at TWO call sites:
// `runProvision`'s own `deps.onRestoreOutcome?.(restoreOutcome, restoreSource)`
// (M3) and `provisionWithStorage`'s own `ProvisionDeps` override callback,
// `(r, s) => { restoreOutcome = r; restoreSource = s; ... }` (M4). Both
// already forward correctly, but every existing test for this forwarding
// (the two describe blocks just above) only exercises the RESTART path
// (`runRestart`/`restartWithStorage`) — a regression at either PROVISION call
// site would go completely undetected. These two describe blocks mirror
// those two, verbatim in fixture shape (`keeperSessionArchive`/
// `KEEPER_STUDIO_ID`/`KEEPER_KEY`/`KEEPER_UPLOADED_AT`/`LATEST_UPLOADED_AT`),
// swapping only `runRestart`/`restartWithStorage` for `runProvision`/
// `provisionWithStorage`.
// ---------------------------------------------------------------------------

// A working blueprint fetch is required on the provision path (unlike
// restart, which reuses the already-stored roleEnv and never calls
// resolveBringupEnv at all) — `keeperRestoreDeps`'s own fetchBlueprintFile
// throws unconditionally ("restart must not refetch the blueprint"), so this
// is a small, provision-specific fixture rather than a reuse of that one.
// role "pilot" matches KEEPER_STUDIO_ID's own role segment
// ("acme-os--pilot"), so `buildStudioId({repo: "acme-os", role:
// "pilot"})` lands on the exact id the keeper R2 fixture (KEEPER_KEY,
// r2Head's per-key answers) was already built around.
const KEEPER_PROVISION_FLEET_JSON = JSON.stringify({
  blueprint: { repo: "rafarc21/fleetflare", ref: "main" }, roles: ["pilot"], instance_type: "standard-2",
});
const KEEPER_PROVISION_ROLE_MD = `---
name: pilot
skills: []
allowedTools: Bash(git *)
may_spawn: []
reports_to: operator
gates: []
---
You are pilot. Sandbox role, low stakes.
`;
const KEEPER_PROVISION_ORG_JSON = JSON.stringify({ edges: {}, gates: {} });

/** Same R2 fixture shape as `keeperRestoreDeps` (board #250's own: `latest`
 *  missing, keeper a real mark-bearing archive, `r2Head` answering per key),
 *  wired for the PROVISION path instead: a working `fetchBlueprintFile` and
 *  no `CONTAINER_HAS_PROJECTS_CMD` override needed (the default "no" answer
 *  lets `runSessionRestore` actually attempt the restore). */
function keeperProvisionDeps(keeper: Uint8Array<ArrayBuffer>): ProvisionDeps & { cmds: string[] } {
  const deps: ProvisionDeps & { cmds: string[] } = {
    sbExec: vi.fn(async (cmd: string) => {
      deps.cmds.push(cmd);
      if (cmd === CONTAINER_HAS_PROJECTS_CMD) return { code: 0, stdout: "no\n", stderr: "" };
      if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) {
        return {
          code: 0,
          stdout: [BRINGUP_TOKEN_WRITE_SECTION, "yes", scriptedProbe(true, "/workspace/acme-os")].join("\n"),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    }),
    recordStudio: async () => {},
    now: () => NOW,
    fetchBlueprintFile: vi.fn(async (_repo: string, path: string) => {
      if (path === "fleet.json") return KEEPER_PROVISION_FLEET_JSON;
      if (path === "fleet/blueprint/roles/pilot.md") return KEEPER_PROVISION_ROLE_MD;
      if (path === "fleet/blueprint/org.json") return KEEPER_PROVISION_ORG_JSON;
      throw new Error(`fetch ${path} failed (404): Not Found`);
    }),
    r2Get: vi.fn(async (key: string) => {
      if (key === sessionLatestKey(KEEPER_STUDIO_ID)) return null;
      if (key === KEEPER_KEY) return keeper;
      return null;
    }),
    r2List: vi.fn(async (prefix: string) => [KEEPER_KEY].filter((k) => k.startsWith(prefix))),
    r2Head: vi.fn(async (key: string) => {
      if (key === KEEPER_KEY) return { uploaded: new Date(KEEPER_UPLOADED_AT) };
      if (key === sessionLatestKey(KEEPER_STUDIO_ID)) return { uploaded: new Date(LATEST_UPLOADED_AT) };
      return null;
    }),
    writeFile: vi.fn(async () => {}),
    cmds: [],
  };
  return deps;
}

describe("runProvision — onRestoreOutcome forwards runSessionRestore's own `source`, not just the outcome (board #287 mutant M3, PR #286 provision-path gap)", () => {
  // Mutant M3 bite-proof: if `runProvision`'s own call site
  // (`deps.onRestoreOutcome?.(restoreOutcome, restoreSource)`) ever regresses
  // to dropping the second argument, this assertion fails — `source` would
  // read `undefined` where "daily <date>" is expected.
  it("a keeper-sourced restore forwards source: 'daily <date>' to onRestoreOutcome, alongside the outcome", async () => {
    const keeper = await keeperSessionArchive(KEEPER_UPLOADED_AT);
    const deps = keeperProvisionDeps(keeper);
    const onRestoreOutcome = vi.fn();

    await runProvision(
      { ...deps, onRestoreOutcome }, { repo: "acme-os", role: "pilot" }, "rafarc21/fleetflare", null,
    );

    expect(onRestoreOutcome).toHaveBeenCalledWith("restored", `daily ${KEEPER_DATE}`);
  });
});

describe("provisionWithStorage — a keeper-sourced restore measures snapshotAgeS against the KEEPER's own R2 upload time, not latest's (board #287 mutant M4, PR #286 provision-path gap)", () => {
  // Mutant M4 bite-proof: if `provisionWithStorage`'s own `ProvisionDeps`
  // override (`onRestoreOutcome: (r, s) => { ...; restoreSource = s; ... }`)
  // ever regresses to dropping `s`, `recordBringupObservation` receives
  // `restoreSource: null` for a keeper restore and falls back to measuring
  // against `latest`'s own (recent) upload time — reporting an age of a few
  // minutes instead of the ~13 real days apart KEEPER_UPLOADED_AT and
  // LATEST_UPLOADED_AT are deliberately set to.
  it("records an age computed from the keeper's own uploaded time, and stamps snapshotSource with the keeper's own label", async () => {
    const keeper = await keeperSessionArchive(KEEPER_UPLOADED_AT);
    const deps = keeperProvisionDeps(keeper);
    const storage = fakeStorageWithObserved({});

    await provisionWithStorage(deps, storage, { repo: "acme-os", role: "pilot" }, "rafarc21/fleetflare", "provision", storage);

    const observed = await getObserved(storage);
    expect(observed.session?.restore).toBe("restored");
    expect(observed.session?.snapshotSource).toBe(`daily ${KEEPER_DATE}`);
    expect(deps.r2Head).toHaveBeenCalledWith(KEEPER_KEY);
    // ~13 days, not the few minutes a `sessionLatestKey` read would produce.
    const expectedAgeS = Math.floor((Date.parse(NOW) - Date.parse(KEEPER_UPLOADED_AT)) / 1000);
    expect(observed.session?.snapshotAgeS).toBe(expectedAgeS);
    expect(observed.session!.snapshotAgeS!).toBeGreaterThan(13 * 24 * 60 * 60);
  });
});

// ---------------------------------------------------------------------------
// Board #250, QA follow-up — `recordBringupObservation`'s own `keeperSource`
// guard checked `restoreSource !== null`, which is `true` for `undefined`
// too (strict equality only excludes `null`). Both real callers only ever
// pass `restoreResult.source ?? null` (never bare `undefined`), and the
// parameter's own type (`string | null`) blocks a future caller from passing
// `undefined` directly — so this is currently unreachable through the wired
// callers below, but a hypothetical future caller that bypasses the type
// system (or a later widening of the type itself) would hit
// `restoreSource.startsWith(...)` on `undefined` and throw, dropping the
// ENTIRE observation record for that bring-up (no verdict, no incarnation
// refresh, no execFailures reset) rather than degrading gracefully like
// every other unexpected-`source` shape does.
// ---------------------------------------------------------------------------
describe("recordBringupObservation — keeperSource guard excludes undefined, not just null (board #250)", () => {
  const BOARD_250_STUDIO_ID = "acme-os--pilot";

  function board250Deps(): ProvisionDeps {
    return {
      sbExec: vi.fn(async () => ({ code: 0, stdout: defaultObservationStdout(), stderr: "" })),
      recordStudio: async () => {},
      now: () => NOW,
      fetchBlueprintFile: vi.fn(async () => {
        throw new Error("this test never provisions, only records an observation");
      }),
    };
  }

  it("a bad caller's undefined restoreSource throws before the fix (RED, simulated past the type system)", async () => {
    const deps = board250Deps();
    const storage = fakeStorageWithObserved({ status: status({ id: BOARD_250_STUDIO_ID }) });
    const ctx: OpCtx = { epoch: 0, moved: async () => false };

    await expect(
      recordBringupObservation(
        deps, storage, status({ id: BOARD_250_STUDIO_ID }), null, "restored", "provision",
        null, NOW, NOW, undefined as unknown as string | null, null, ctx,
      ),
    ).resolves.not.toThrow();

    const observed = await getObserved(storage);
    // Falls through to the SAME latest-path logic every other unexpected
    // `source` value already gets — a full verdict is still recorded, and
    // no keeper-specific `snapshotSource` is stamped.
    expect(observed.session).not.toBeNull();
    expect(observed.session?.snapshotSource).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Board #287 (PR #286 review, mutant M5) — the keeper branch's OWN r2Head
// read (`deps.r2Head(keeperKey)`, provision.ts ~line 2652) is already correct
// as written: `snapshotUploadedAt = head ? head.uploaded.toISOString() :
// null` — a failed head lookup (r2Head returns null, or the keeper object
// vanished between pickRestoreSource choosing it and this later read) leaves
// the age unknown rather than falling back to `latest`'s own upload time.
// But no existing test exercises this failure path at all, so a regression
// that made the keeper branch fall through to the SAME latest-reading logic
// the `else` branch uses on failure — exactly the #250 bug this whole PR
// fixed, reopened — would go completely undetected.
// ---------------------------------------------------------------------------
describe("recordBringupObservation — the keeper's own r2Head failing never falls back to latest's upload time (board #287 mutant M5)", () => {
  it("r2Head(keeperKey) returns null: snapshotAgeS stays null, and the survival brief shows no 'from ... snap' age suffix", async () => {
    const r2Head = vi.fn(async (key: string) => {
      if (key === KEEPER_KEY) return null; // the keeper's own head lookup failed
      if (key === sessionLatestKey(KEEPER_STUDIO_ID)) return { uploaded: new Date(LATEST_UPLOADED_AT) };
      return null;
    });
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: defaultObservationStdout(), stderr: "" })),
      recordStudio: async () => {},
      now: () => NOW,
      fetchBlueprintFile: vi.fn(async () => {
        throw new Error("this test never provisions, only records an observation");
      }),
      r2Head,
    };
    const storage = fakeStorageWithObserved({ status: status({ id: KEEPER_STUDIO_ID }) });
    const ctx: OpCtx = { epoch: 0, moved: async () => false };

    await recordBringupObservation(
      deps, storage, status({ id: KEEPER_STUDIO_ID }), null, "restored", "provision",
      null, NOW, NOW, `daily ${KEEPER_DATE}`, null, ctx,
    );

    const observed = await getObserved(storage);
    expect(r2Head).toHaveBeenCalledWith(KEEPER_KEY);
    // Never consulted latest's own key to paper over the failed keeper read.
    expect(r2Head).not.toHaveBeenCalledWith(sessionLatestKey(KEEPER_STUDIO_ID));
    expect(observed.session?.snapshotAgeS).toBeNull();

    // survival-brief.ts falls through to the restore-outcome branch, never
    // fabricating a "from ... snap N old" suffix from an age that was never
    // actually computed.
    const brief = composeSurvivalBrief({
      studioId: KEEPER_STUDIO_ID,
      tasks: { ok: true, value: [] },
      openPrs: { ok: true, value: [] },
      unclaimedRescueBranches: { ok: true, value: [] },
      liveWipRefs: { ok: true, value: [] },
      session: observed.session ?? null,
      now: NOW,
    });
    const sessionLine = brief.split("\n").find((l) => l.startsWith("- Session:"));
    expect(sessionLine).not.toContain("from");
    expect(sessionLine).not.toContain("snap");
  });
});

// ---------------------------------------------------------------------------
// Board #287 (PR #286 review, mutant M6) — the "lead predates bring-up"
// branch (`untouched && priorSession === null`, provision.ts ~line 2697-2703)
// already spreads `...(keeperSource ? { snapshotSource: keeperSource } : {})`
// into the recorded session, same as the normal computeSessionVerdict branch
// just below it — but no existing test exercises THIS branch with a
// keeper-sourced restore (an untouched lead AND no prior verdict AND a
// keeper restore, all three at once) to confirm `snapshotSource` actually
// survives into it rather than being silently dropped.
// ---------------------------------------------------------------------------
describe("recordBringupObservation — the 'lead predates bring-up' branch still stamps a keeper's own snapshotSource (board #287 mutant M6)", () => {
  it("an untouched lead, no prior session at all, and a keeper-sourced restore: snapshotSource survives into the unknown/'lead predates bring-up' verdict", async () => {
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({
        code: 0,
        // A lead far older than this bring-up (leadAgeS 999_999 with
        // bringupStartedAt === now === NOW, so bringupAgeS is 0) — genuinely
        // untouched, same fixture shape as MUST-FIX 9's own test above.
        stdout: [BRINGUP_TOKEN_WRITE_SECTION, "yes", scriptedProbeWithAge(false, "/workspace/acme-os", 999_999)].join("\n"),
        stderr: "",
      })),
      recordStudio: async () => {},
      now: () => NOW,
      fetchBlueprintFile: vi.fn(async () => {
        throw new Error("this test never provisions, only records an observation");
      }),
      r2Head: vi.fn(async (key: string) => (key === KEEPER_KEY ? { uploaded: new Date(KEEPER_UPLOADED_AT) } : null)),
    };
    // Deliberately no mergeObserved(storage, { session: ... }) call —
    // observedBefore.session is null, the exact gap MUST-FIX 9 covers, now
    // combined with a keeper-sourced restore.
    const storage = fakeStorageWithObserved({ status: status({ id: KEEPER_STUDIO_ID }) });
    const ctx: OpCtx = { epoch: 0, moved: async () => false };

    await recordBringupObservation(
      deps, storage, status({ id: KEEPER_STUDIO_ID }), null, "restored", "provision",
      null, NOW, NOW, `daily ${KEEPER_DATE}`, null, ctx,
    );

    const observed = await getObserved(storage);
    expect(observed.session?.verdict).toBe("unknown");
    expect(observed.session?.reason).toBe("lead predates bring-up");
    expect(observed.session?.snapshotSource).toBe(`daily ${KEEPER_DATE}`);
  });
});

// ---------------------------------------------------------------------------
// Issue #85, maestro correction #14 — a verdict test PER bring-up path
// (provision, recycle, heal, failover), not only restart/heal: a bug in one
// path's own do.ts call site (a forgotten `observedStorage` argument, say)
// would otherwise only ever be caught by whichever ONE path happened to
// already have a test. `heal` is covered above by the RESUMED/LOST tests;
// `failover` lives in test/studio.account-failover.test.ts, the file that
// already owns every other `runAccountFailover` fixture.
// ---------------------------------------------------------------------------
describe("a session verdict is recorded on EVERY bring-up path (issue #85, maestro correction #14)", () => {
  const FAKE_FLEET_JSON = JSON.stringify({
    blueprint: { repo: "rafarc21/fleetflare", ref: "main" }, roles: ["scratch"], instance_type: "standard-2",
  });
  const FAKE_ROLE_MD = `---
name: scratch
skills: []
allowedTools: Bash(git *) Bash(fleet *) Edit Write
may_spawn: []
reports_to: operator
gates: []
---
You are scratch. Sandbox role, low stakes.
`;
  const FAKE_ORG_JSON = JSON.stringify({ edges: { cto: ["release"] }, gates: { merge: ["release"] } });

  /** Same "own deps literal, own fixture" convention as this file's
   *  restartDeps — a plain-role provision, since the studio-vs-role fork
   *  itself is test/studio.provision.test.ts's own turf, not this test's. */
  function provisionDeps(observationStdout: string): ProvisionDeps & { cmds: string[] } {
    const cmds: string[] = [];
    const sbExec = vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) return { code: 0, stdout: observationStdout, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const fetchBlueprintFile = vi.fn(async (_repo: string, path: string) => {
      if (path === "fleet.json") return FAKE_FLEET_JSON;
      if (path === "fleet/blueprint/roles/scratch.md") return FAKE_ROLE_MD;
      if (path === "fleet/blueprint/org.json") return FAKE_ORG_JSON;
      throw new Error(`fetch ${path} failed (404): Not Found`);
    });
    return { sbExec, recordStudio: async () => {}, now: () => NOW, fetchBlueprintFile, cmds };
  }

  it("provision: a fresh container with no history records fresh", async () => {
    // A lead pane genuinely found, but no --continue and no lifetime
    // history — exactly a fresh launch, never mistaken for lost.
    const deps = provisionDeps(
      [BRINGUP_TOKEN_WRITE_SECTION, "yes", scriptedProbe(false, "/workspace/nowhere")].join("\n"),
    );
    const storage = fakeStorageWithObserved({});

    await provisionWithStorage(deps, storage, { repo: "acme-os", role: "scratch" }, "rafarc21/fleetflare", "provision", storage);

    const observed = await getObserved(storage);
    expect(observed.session?.via).toBe("provision");
    expect(observed.session?.verdict).toBe("fresh");
  });

  it("recycle: via is \"recycle\", not the default \"restart\"", async () => {
    // do.ts's own wiring: `recycle()` -> `recycleWithSync(..., (c) =>
    // this.provisionCore(c, "recycle"), ...)` -> `provisionCore` ->
    // `provisionWithStorage(..., via, this.ctx.storage)`. Reproduced here at
    // the exact call-site shape (a `provision` closure that itself calls
    // `provisionWithStorage` with `via: "recycle"`), driven through the real
    // `recycleWithSync` so a forgotten `via`/`observedStorage` argument at
    // that closure would fail this test exactly as it would in production.
    const deps = provisionDeps(
      [BRINGUP_TOKEN_WRITE_SECTION, "yes", scriptedProbe(false, "/workspace/nowhere")].join("\n"),
    );
    const storage = fakeStorageWithObserved({}) as StudioStorage & ObservedStorage & SessionSyncStorage;
    const cfg: ProvisionConfig = { repo: "acme-os", role: "scratch" };
    // The container never answers the liveness probe ("printf ok"): every
    // pre-teardown step (sync/rescue-push/harvest) is skipped, and only
    // destroy -> awaitReady -> provision -> the post-provision verdict check
    // run — the minimum recycleWithSync needs to reach `provision(cfg)`,
    // which is the one call this test is actually about.
    const syncDeps: SessionSyncDeps = {
      exec: vi.fn(async (cmd: string) =>
        cmd === "printf ok" ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: PROVISIONED_OK, stderr: "" },
      ),
      r2Put: async () => {},
      r2List: async () => [],
      r2Delete: async () => {},
      now: () => new Date(NOW),
      notify: async () => {},
      burnAlertThresholdTokens: 0,
    };
    const provisionFn = (c: ProvisionConfig) =>
      provisionWithStorage(deps, storage, c, "rafarc21/fleetflare", "recycle", storage);
    const noopResolveMemoryRepo: ResolveMemoryRepo = async () => "rafarc21/fleetflare";
    const noopCommit: CommitLearningFile = async () => {};

    await recycleWithSync(
      syncDeps, storage, "acme-os--scratch",
      async () => {}, async () => {}, provisionFn, async () => {},
      cfg, noopResolveMemoryRepo, noopCommit,
      // Issue #96 landed its own unsynced-work guard on this same call after
      // this test was written; the failed liveness probe above would
      // otherwise make recycleWithSync refuse before ever reaching
      // `provisionFn`, which is the one call this test is actually about —
      // `discardUnsynced: true` opts out of that guard on purpose, same as a
      // real `fleet recycle --discard-unsynced` would.
      { discardUnsynced: true, lastSyncedAt: async () => undefined },
    );

    const observed = await getObserved(storage);
    expect(observed.session?.via).toBe("recycle");
  });

  // Review round 5, Finding 1 — recycleWithSync's own doc comment
  // (do.ts:895-901) claims OPERATION_KEY is "held across the WHOLE destroy ->
  // reprovision window", but the `provision` closure it calls is, in real
  // wiring, `(c) => this.provisionCore(c, "recycle")` -> `provisionWithStorage`,
  // which independently sets OPERATION_KEY at ITS OWN start and clears it in
  // ITS OWN finally with no awareness an outer "recycle" lock already exists.
  // The instant provisionWithStorage returns, OPERATION_KEY is null, even
  // though recycleWithSync still has recycleVerdict (a real container exec,
  // with retries), a possible second provisionCore retry pass, and the final
  // D1 writes left to run — a ship tick racing an exec failure in that window
  // is wrongly counted toward execFailures/unreachableSince. Reproduced here
  // at the exact call-site shape "recycle: via is recycle" above already
  // uses, with the provisionFn wrapper peeking at storage the instant the
  // nested provisionWithStorage call returns — before control is handed back
  // to recycleWithSync's own remaining work.
  it("recycle: OPERATION_KEY survives its own nested provisionCore call (review round 5, Finding 1)", async () => {
    const deps = provisionDeps(
      [BRINGUP_TOKEN_WRITE_SECTION, "yes", scriptedProbe(false, "/workspace/nowhere")].join("\n"),
    );
    const storage = fakeStorageWithObserved({}) as StudioStorage & ObservedStorage & SessionSyncStorage;
    const cfg: ProvisionConfig = { repo: "acme-os", role: "scratch" };
    const syncDeps: SessionSyncDeps = {
      exec: vi.fn(async (cmd: string) =>
        cmd === "printf ok" ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: PROVISIONED_OK, stderr: "" },
      ),
      r2Put: async () => {},
      r2List: async () => [],
      r2Delete: async () => {},
      now: () => new Date(NOW),
      notify: async () => {},
      burnAlertThresholdTokens: 0,
    };
    let opRightAfterNestedProvision: unknown;
    const provisionFn = async (c: ProvisionConfig) => {
      const result = await provisionWithStorage(deps, storage, c, "rafarc21/fleetflare", "recycle", storage);
      // The exact instant `provisionCore`'s real body (provisionWithStorage)
      // has returned, but BEFORE recycleWithSync's own suspended frame runs
      // recycleVerdict/the second retry pass/the final D1 writes.
      opRightAfterNestedProvision = await storage.get(OPERATION_KEY);
      return result;
    };
    const noopResolveMemoryRepo: ResolveMemoryRepo = async () => "rafarc21/fleetflare";
    const noopCommit: CommitLearningFile = async () => {};

    await recycleWithSync(
      syncDeps, storage, "acme-os--scratch",
      async () => {}, async () => {}, provisionFn, async () => {},
      cfg, noopResolveMemoryRepo, noopCommit,
      { discardUnsynced: true, lastSyncedAt: async () => undefined },
    );

    expect(opRightAfterNestedProvision).toEqual({ op: "recycle", since: expect.any(String) });
    // And the OUTER (recycle) lock is still cleared once recycleWithSync
    // itself finishes — no leak past the whole operation's own end.
    expect(await storage.get(OPERATION_KEY)).toBeNull();
  });

  // Review round 4 (issue #85, TEST 12e) — this test used to be an empty
  // body pointing at the RESUMED/LOST tests above; an empty `it()` always
  // passes, which is exactly the false-confidence shape the review flagged.
  // Asserted directly here too, driven through the real heal closure with
  // its own minimal fixture (no restore staged — this test is about `via`,
  // not the restore mechanics the RESUMED/LOST tests above already cover).
  it("heal: via is \"heal\"", async () => {
    const deps = restartDeps(() => undefined);
    const storage = fakeStorageWithObserved({
      status: status({ id: "acme-os--pilot", repoSlug: "acme-org/acme-os" }), roleEnv: STUDIO_ENV,
    });

    await healClosure(deps, storage, "acme-os--pilot", "rafarc21/fleetflare")();

    const observed = await getObserved(storage);
    expect(observed.session?.via).toBe("heal");
  });

  // Same fix as "heal" above — this used to be an empty body pointing at
  // test/studio.account-failover.test.ts's own suite; that suite's own "via
  // is failover" test is real (verified), but this test's own name claimed
  // to test it too, so it now genuinely does, driven end to end through the
  // real `runAccountFailover` with a minimal rate-limit-modal fixture built
  // from the SAME exported constants that file's own MODAL_PANE fixture is
  // built from, rather than importing that file's private fixture.
  it("failover: via is \"failover\", restore is not-attempted", async () => {
    const accounts: ClaudeAccount[] = [
      { name: "CLAUDE_CODE_OAUTH_TOKEN", token: "sk-ant-oat01-" + "a".repeat(40) },
      { name: "CLAUDE_CODE_OAUTH_TOKEN_2", token: "sk-ant-oat01-" + "b".repeat(40) },
    ];
    // Same modal frame as test/studio.account-failover.test.ts's own
    // MODAL_PANE fixture (that file's own header explains why it owns every
    // OTHER runAccountFailover fixture — this one literal is duplicated
    // rather than imported, since that file does not export its own
    // private fixtures).
    const modalScreen = [
      "⏺ Reading the release notes for the batch.",
      "",
      "⏺ Read(docs/release.md)",
      "  ⎿  Read 42 lines",
      "",
      "╭────────────────────────────────────────────────────────────────╮",
      `│ ${RATE_LIMIT_HEADLINES[0]}                      │`,
      "│                                                                │",
      `│ Run ${RATE_LIMIT_MODAL_MARKERS[1]} to see what you can do.                │`,
      "│                                                                │",
      `│ ❯ 1. ${RATE_LIMIT_MODAL_MARKERS[0]}                                         │`,
      "│   2. Not now                                                   │",
      "╰────────────────────────────────────────────────────────────────╯",
    ].join("\n");
    const pane = `${modalScreen}\n${PANE_CAPTURE_MARKER}\n${modalScreen}\n`;
    const storage = fakeStorageWithObserved({
      status: status({ id: "acme-os--pilot", repoSlug: `acme-org/${REPO}` }),
    }) as StudioStorage & ObservedStorage;
    const exec = vi.fn(async (cmd: string) => {
      if (cmd === paneCaptureCmd()) return { code: 0, stdout: pane, stderr: "" };
      if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) {
        return { code: 0, stdout: [BRINGUP_TOKEN_WRITE_SECTION, "yes", scriptedProbe(false, "")].join("\n"), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const deps: FailoverDeps = {
      autoFailover: true,
      accounts, now: () => new Date(NOW), exec,
      relaunch: async () => ({ code: 0, stdout: "", stderr: "" }), notify: async () => {},
    };

    const out = await runAccountFailover(deps, storage, "acme-os--pilot", async () => {}, storage);

    expect(out.kind).toBe("switched");
    const observed = await getObserved(storage);
    expect(observed.session?.via).toBe("failover");
    expect(observed.session?.restore).toBe("not-attempted");
  });
});

// ---------------------------------------------------------------------------
// Issue #1216 — runRestart re-resolves STUDIO_MCP from the current blueprint
// ---------------------------------------------------------------------------

describe("runRestart — re-resolves STUDIO_MCP from the current blueprint (issue #1216)", () => {
  const FLEET_JSON = JSON.stringify({
    blueprint: { repo: "rafarc21/fleetflare", ref: "main" },
    roles: [],
    instance_type: "standard-2",
  });
  const STUDIO_MD = [
    "---",
    "name: release-studio",
    "title: Release Studio",
    "lead: Release Lead",
    "skills: []",
    "secrets: []",
    "mcp: [codebase-memory]",
    "allowedTools: Bash(git *)",
    "---",
    "release studio prompt body",
  ].join("\n");

  /** A deps whose sbExec records every exec's {cmd, env} and answers 0 for all. */
  function mcpRestartDeps(opts: { throwOnFetch?: boolean } = {}) {
    const execs: { cmd: string; env?: Record<string, string> }[] = [];
    const sbExec = vi.fn(async (cmd: string, env?: Record<string, string>) => {
      execs.push({ cmd, env });
      return { code: 0, stdout: "", stderr: "" };
    });
    const fetchBlueprintFile = vi.fn(async (repo: string, path: string) => {
      if (opts.throwOnFetch) throw new Error("blueprint fetch failed");
      if (path === "fleet.json") return FLEET_JSON;
      if (path === "fleet/blueprint/studios/release-studio/studio.md") return STUDIO_MD;
      throw new Error(`unexpected path: ${path}`);
    });
    const deps: ProvisionDeps & { execs: typeof execs } = {
      sbExec,
      recordStudio: async () => {},
      now: () => NOW,
      fetchBlueprintFile,
      execs,
    };
    return deps;
  }

  it("re-resolves STUDIO_MCP from the current blueprint", async () => {
    const deps = mcpRestartDeps();
    const stored = { ...STUDIO_ENV, STUDIO_MCP: "" };
    const result = await runRestart(
      deps,
      status({ id: STUDIO_ID, repoSlug: "acme-org/acme-os" }),
      STUDIO_ID,
      stored,
      true,
      "rafarc21/fleetflare",
    );
    expect(result.status.state).toBe("running");
    const bringup = deps.execs.find((e) => e.cmd === BRINGUP_CMD);
    expect(bringup).toBeDefined();
    expect(bringup!.env?.STUDIO_MCP).toBe("codebase-memory");
    expect(result.bringupEnv).toEqual({ ...stored, STUDIO_MCP: "codebase-memory" });
  });

  it("a blueprint fetch failure replays the stored env unchanged", async () => {
    const deps = mcpRestartDeps({ throwOnFetch: true });
    const stored = { ...STUDIO_ENV, STUDIO_MCP: "" };
    const result = await runRestart(
      deps,
      status({ id: STUDIO_ID, repoSlug: "acme-org/acme-os" }),
      STUDIO_ID,
      stored,
      true,
      "rafarc21/fleetflare",
    );
    expect(result.status.state).toBe("running");
    const bringup = deps.execs.find((e) => e.cmd === BRINGUP_CMD);
    expect(bringup).toBeDefined();
    expect(bringup!.env?.STUDIO_MCP).toBe("");
    expect(result.bringupEnv).toEqual(stored);
  });

  it("re-resolves against the stored BLUEPRINT_REF pin, not main", async () => {
    const refs: string[] = [];
    const deps = {
      ...mcpRestartDeps(),
      fetchBlueprintFile: vi.fn(async (repo: string, path: string, ref: string) => {
        refs.push(ref);
        if (path === "fleet.json") return FLEET_JSON;
        if (path === "fleet/blueprint/studios/release-studio/studio.md") return STUDIO_MD;
        throw new Error(`unexpected path: ${path}`);
      }),
    } as ProvisionDeps;
    const stored = { ...STUDIO_ENV, STUDIO_MCP: "", BLUEPRINT_REF: "pinned-sha" };
    const result = await runRestart(
      deps,
      status({ id: STUDIO_ID, repoSlug: "acme-org/acme-os" }),
      STUDIO_ID,
      stored,
      true,
      "rafarc21/fleetflare",
    );
    expect(result.status.state).toBe("running");
    expect(refs).toContain("pinned-sha");
  });
});

describe("restartWithStorage — persists the re-resolved MCP to ROLE_ENV_KEY (issue #1216)", () => {
  const FLEET_JSON = JSON.stringify({
    blueprint: { repo: "rafarc21/fleetflare", ref: "main" },
    roles: [],
    instance_type: "standard-2",
  });
  const STUDIO_MD = [
    "---",
    "name: release-studio",
    "title: Release Studio",
    "lead: Release Lead",
    "skills: []",
    "secrets: []",
    "mcp: [codebase-memory]",
    "allowedTools: Bash(git *)",
    "---",
    "release studio prompt body",
  ].join("\n");

  it("a heal that re-resolves MCP writes it back to storage, so the READY check agrees with the container", async () => {
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: async () => {},
      now: () => NOW,
      fetchBlueprintFile: vi.fn(async (repo: string, path: string) => {
        if (path === "fleet.json") return FLEET_JSON;
        if (path === "fleet/blueprint/studios/release-studio/studio.md") return STUDIO_MD;
        throw new Error(`unexpected path: ${path}`);
      }),
    };
    const stored = { ...STUDIO_ENV, STUDIO_MCP: "" };
    const storage = fakeStorage({ status: status({ id: STUDIO_ID, repoSlug: "acme-org/acme-os" }), roleEnv: stored });

    await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "heal");

    const persisted = (await storage.get(ROLE_ENV_KEY)) as StudioEnv;
    expect(persisted.STUDIO_MCP).toBe("codebase-memory");
  });
});

// Issue #928 (S45-F15): this file is the SECTIONS half of the split of
// test/studio.transcript.test.ts — section assembly: incarnation (#85), pane +
// verdict (#221), hook heartbeat + wiring (PR3b), memguard + kill wiring (#311),
// and the getTranscriptTailWithStorage read. The ship half lives in
// test/studio.transcript-ship.test.ts; every it() below moved here verbatim.

import { describe, it, expect, vi } from "vitest";
import {
  shipTranscriptTick, getTranscriptTailWithStorage,
  SECTION_BOOTID, SECTION_STAT, SECTION_INCARNATION, SECTION_CHUNK, SECTION_TAIL,
  SECTION_PANE, SECTION_ACTIVITY_HOOK, SECTION_MEMGUARD,
  type ShipDeps, type TranscriptStorage,
} from "../src/studio/transcript";
import type { TranscriptManifest } from "../src/studio/archive";
import {
  SESSION_FOUND_SECTION, SESSION_CONTINUE_SECTION, SESSION_CWD_SECTION,
} from "../src/studio/observed";
import { REAL_PILOT_PANE } from "./fixtures/rate-limit-panes";
import { fixedNow, b64Utf8 } from "./helpers/datetime";
import { fakeStorage as doStorage } from "./helpers/do-storage";

// Storage-key literals — protocol, not SECTION_* scope (the ship half's own
// header holds the full container↔Worker wire-format note). Kept local, the
// same literals the ship half uses.
const TRANSCRIPT_MANIFEST_KEY = "transcriptManifest";
const TRANSCRIPT_TAIL_KEY = "transcriptTail";
const TRANSCRIPT_BOOT_ID_KEY = "transcriptBootId";

const STUDIO_ID = "websites--pilot";
const TODAY = "2026-08-16";

/**
 * Same shape as provision.ts's own StudioStorage fake in
 * test/studio.refresh.test.ts: an in-memory Map behind the keyed-overload
 * port, `get` cast once (see that file's comment for why `put` needs no cast
 * but `get` does), plus a `putKeys` log so "manifest never written"
 * (failure-isolation) is a positive assertion, not just "still whatever it
 * was seeded as".
 *
 * Fix round: `failNextPutFor` — set to a key to make the VERY NEXT `put` for
 * that exact key throw once (auto-clearing itself), then behave normally
 * again. Backs the "manifest-write failure is retry-safe" coverage below —
 * the one place this file needs to inject a storage failure that is NOT
 * `r2Put` (already covered) or an exec failure.
 *
 * Fix round 2: `put` now also handles the multi-key object form (real DO
 * storage's own `put<T>(entries: Record<string,T>)` overload —
 * TranscriptStorage mirrors it, see that interface's own doc comment).
 * Normalized to a single `entries` map either way so ONE code path checks
 * `failNextPutFor` and writes — checked against ALL keys BEFORE writing ANY
 * of them, mirroring real multi-key put's all-or-nothing semantics, so a
 * fake failure can hit the atomic form too rather than silently only
 * understanding single-key calls (which would make the atomic write a
 * no-op in this fake instead of a real, observable effect).
 */
function fakeStorage(
  seed?: { manifest?: TranscriptManifest; tail?: string; bootId?: string },
): TranscriptStorage & { putKeys: string[]; failNextPutFor: string | null } {
  const initial: Record<string, unknown> = {};
  if (seed?.manifest) initial[TRANSCRIPT_MANIFEST_KEY] = seed.manifest;
  if (seed?.tail !== undefined) initial[TRANSCRIPT_TAIL_KEY] = seed.tail;
  if (seed?.bootId !== undefined) initial[TRANSCRIPT_BOOT_ID_KEY] = seed.bootId;
  const s = doStorage(initial);
  const putKeys: string[] = [];
  const storage = {
    putKeys,
    failNextPutFor: null as string | null,
    get: s.get as unknown as TranscriptStorage["get"],
    put: (async (
      keyOrEntries: string | Record<string, TranscriptManifest | string>,
      value?: TranscriptManifest | string,
    ) => {
      const entries: Record<string, TranscriptManifest | string> =
        typeof keyOrEntries === "string" ? { [keyOrEntries]: value! } : keyOrEntries;
      for (const key of Object.keys(entries)) {
        if (storage.failNextPutFor === key) {
          storage.failNextPutFor = null;
          throw new Error(`storage.put(${key}) failed: simulated`);
        }
      }
      for (const [key, v] of Object.entries(entries)) {
        putKeys.push(key);
        s.map.set(key, v);
      }
    }) as unknown as TranscriptStorage["put"],
  };
  return storage;
}

/**
 * Builds the exact delimited stdout `shipTickCmd`'s real shell script would
 * produce, from plain option fields — the fake exec's default path for the
 * consolidated command below. Mirrors the command's OWN section-emission
 * rule exactly: CHUNK/TAIL are only emitted when `stat` parses to a finite,
 * non-negative size (the command's `if [ "$FLEET_SIZE" -ge 0 ]` guard) —
 * anything else (a negative sentinel, or unparseable) omits them entirely,
 * the same "no-file" shape the parser must treat identically to the
 * marker-missing case. Issue #85: the INCARNATION section is UNCONDITIONAL
 * (before the same `if` guard, mirroring shipTickCmd's own placement),
 * `incarnation` defaults to "" the same way every other field here defaults
 * to "absent".
 */
function synthesizeTickStdout(
  opts: { stat?: string; bootId?: string; read?: string; tail?: string; incarnation?: string },
): string {
  const stat = opts.stat ?? "-1";
  const lines = [
    SECTION_BOOTID, opts.bootId ?? "", SECTION_STAT, stat,
    SECTION_INCARNATION, opts.incarnation ?? "",
  ];
  const size = Number.parseInt(stat, 10);
  if (Number.isFinite(size) && size >= 0) {
    lines.push(SECTION_CHUNK, opts.read ?? "", SECTION_TAIL, opts.tail ?? "");
  }
  return lines.join("\n");
}

/**
 * Routes by command shape, not call order — matches this feature's own
 * command builders exactly: `shipTickCmd`'s output always starts with
 * "FLEET_FRESH_BOOT_ID=" (its very first assignment); `rotateCmd` is the
 * only other command this file ever issues, so anything else routes there.
 * Defaults (no file, no bytes) so a test only has to override what it cares
 * about. `now` is folded in here too since ShipDeps bundles all three.
 *
 * `rawTickStdout` — escape hatch for the consolidated-parser matrix tests
 * below: bypasses `synthesizeTickStdout` entirely and returns this exact
 * string, so a test can construct partial/malformed/garbage output directly
 * rather than only what a well-formed tick could ever produce.
 */
function fakeDeps(opts: {
  stat?: string; bootId?: string; read?: string; tail?: string; incarnation?: string;
  rawTickStdout?: string; tickCode?: number; tickStderr?: string;
  rotateMarker?: "ROTATED" | "SKIPPED"; rotateCode?: number; rotateStderr?: string;
  now?: string;
  r2Throws?: boolean;
} = {}): ShipDeps & { execCalls: string[]; puts: { key: string; bytes: Uint8Array }[] } {
  const execCalls: string[] = [];
  const puts: { key: string; bytes: Uint8Array }[] = [];
  return {
    execCalls,
    puts,
    exec: async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd.startsWith("FLEET_FRESH_BOOT_ID=")) {
        const stdout = opts.rawTickStdout ?? synthesizeTickStdout(opts);
        return { code: opts.tickCode ?? 0, stdout, stderr: opts.tickStderr ?? "" };
      }
      return {
        code: opts.rotateCode ?? 0,
        stdout: opts.rotateMarker ?? "ROTATED",
        stderr: opts.rotateStderr ?? "",
      };
    },
    r2Put: async (key: string, bytes: Uint8Array) => {
      if (opts.r2Throws) throw new Error("r2 put failed: bucket unavailable");
      puts.push({ key, bytes });
    },
    now: fixedNow(opts.now ?? `${TODAY}T12:00:00.000Z`),
  };
}
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Issue #85 — the incarnation section: read unconditionally, newline-safe,
// carries the folded-in adoption write.
// ---------------------------------------------------------------------------
describe("shipTranscriptTick — incarnation section (issue #85)", () => {
  // The two OLD direct shipTickCmd its (captured-then-echoed read before the
  // file-exists guard; conditional adoption write in the SAME command) moved
  // to the "command shape (wire format)" describe at the top of this file —
  // same invariants, asserted on the command the tick actually sent.

  it("shipTranscriptTick returns the container's incarnation token, present case", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [
        SECTION_BOOTID, "", SECTION_STAT, "-1",
        SECTION_INCARNATION, "abc-123e4567-e89b-12d3-a456-426614174000",
      ].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID);
    expect(result.incarnationToken).toBe("abc-123e4567-e89b-12d3-a456-426614174000");
  });

  it("shipTranscriptTick returns an empty incarnation token when the file is absent", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, ""].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID);
    expect(result.incarnationToken).toBe("");
  });

  it("shipTranscriptTick passes the adoption token through to the command it sends", async () => {
    const execCalls: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      execCalls.push(cmd);
      return {
        code: 0,
        stdout: [SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, ""].join("\n"),
        stderr: "",
      };
    });
    const storage = fakeStorage({});
    await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID, "adopt-xyz");
    // Boundary-pinned contains (never built with the builder under test):
    // the token write is conditional-in-the-same-command (maestro #6), the
    // pane-lead probe folded in only when adopting (maestro #7).
    expect(execCalls[0]).toContain("adopt-xyz");
    expect(execCalls[0]).toContain(`if [ -z "$FLEET_INC" ]`);
    expect(execCalls[0]).toContain(SESSION_FOUND_SECTION);
  });

  it("shipTranscriptTick parses adoptionProbe from the combined stdout only when adopting", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [
        SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "adopt-tok-1234",
        SESSION_FOUND_SECTION, "yes", SESSION_CONTINUE_SECTION, "yes", SESSION_CWD_SECTION, "/workspace/websites",
      ].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick(
      { exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID, "adopt-tok-1234",
    );
    expect(result.adoptionProbe).toEqual({ ok: true, found: true, hasContinue: true, cwd: "/workspace/websites", leadAgeS: null, error: null });
  });

  it("shipTranscriptTick never sets adoptionProbe on a steady-state tick (no adoptionToken)", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "existing-tok"].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID);
    expect(result.adoptionProbe).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #221, Task 3 — SECTION_PANE on the ship tick (PR3a's B1 leg: one
// pane frame folded into the EXISTING tick exec, no sleep, no second exec).
// The old direct parsePaneSection/readShipTickActivity/shipTickCmd describes
// are now ONE tick-through describe: result.paneFrame/result.paneVerdict are
// the production read path (do.ts consumes the ShipResult fields), so every
// posture below pins the same invariants at the interface.
// ---------------------------------------------------------------------------
describe("shipTranscriptTick — pane section (issue #221)", () => {
  /** One tick over raw stdout; returns its result. */
  async function tickWith(raw: string) {
    const deps = fakeDeps({ rawTickStdout: raw });
    const storage = fakeStorage();
    const result = await shipTranscriptTick(deps, storage, STUDIO_ID);
    expect(deps.execCalls).toHaveLength(1);
    return result;
  }

  it("round-trips a real fixture pane through base64 into result.paneFrame, and the SAME frame drives the verdict", async () => {
    const result = await tickWith([
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, b64Utf8(REAL_PILOT_PANE),
    ].join("\n"));
    expect(result.paneFrame).toBe(REAL_PILOT_PANE);
    expect(result.paneVerdict).toBeDefined();
  });

  it("absent SECTION_PANE (old image): both paneFrame and paneVerdict undefined, never a throw", async () => {
    const result = await tickWith([SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, ""].join("\n"));
    expect(result.paneFrame).toBeUndefined();
    expect(result.paneVerdict).toBeUndefined();
  });

  it("present-but-empty section (tmux gone): paneFrame '' is a real result, verdict unknown/'pane empty'", async () => {
    const result = await tickWith([
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, "",
    ].join("\n"));
    expect(result.paneFrame).toBe("");
    expect(result.paneVerdict).toEqual({ kind: "unknown", reason: "pane empty" });
  });

  it("a torn/malformed pane section (invalid base64) never throws — paneFrame degrades to '', verdict to the same 'pane empty' posture", async () => {
    const result = await tickWith([
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, "not valid base64!!! ***",
    ].join("\n"));
    expect(result.paneFrame).toBe("");
    expect(result.paneVerdict).toEqual({ kind: "unknown", reason: "pane empty" });
  });

  it("a real working frame reaches the verdict through the tick: {kind:'working'}", async () => {
    const workingPane = REAL_PILOT_PANE.replace("✻ Cogitated for 0s", "✻ Cogitating… (3s · esc to interrupt)");
    const result = await tickWith([
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, b64Utf8(workingPane),
    ].join("\n"));
    expect(result.paneVerdict).toEqual({ kind: "working" });
  });

  it("still parses correctly ahead of the CHUNK/TAIL sections on a file-present tick", async () => {
    const result = await tickWith([
      SECTION_BOOTID, "", SECTION_STAT, "0", SECTION_INCARNATION, "",
      SECTION_PANE, btoa("hello pane"), SECTION_CHUNK, "", SECTION_TAIL, "",
    ].join("\n"));
    expect(result.paneFrame).toBe("hello pane");
  });

  // Issue #311 — SECTION_MEMGUARD now sits between PANE and CHUNK/TAIL; the
  // pane slice must end there, never swallowing the memguard bytes.
  it("ends the pane slice at SECTION_MEMGUARD when present (issue #311 boundary)", async () => {
    const result = await tickWith([
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, b64Utf8(REAL_PILOT_PANE), SECTION_MEMGUARD, "",
    ].join("\n"));
    expect(result.paneFrame).toBe(REAL_PILOT_PANE);
  });

  it("still round-trips when SECTION_MEMGUARD is absent (old-shaped stdout, unchanged behavior)", async () => {
    const result = await tickWith([
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, b64Utf8(REAL_PILOT_PANE),
    ].join("\n"));
    expect(result.paneFrame).toBe(REAL_PILOT_PANE);
  });

  it("ends at SECTION_ACTIVITY_HOOK when CHUNK/TAIL are absent (no-file tick)", async () => {
    const result = await tickWith([
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, b64Utf8(REAL_PILOT_PANE),
      SECTION_ACTIVITY_HOOK, btoa(JSON.stringify({ state: "idle", at: "2026-09-25T12:00:00.000Z" })),
    ].join("\n"));
    expect(result.paneFrame).toBe(REAL_PILOT_PANE);
  });

  it("still ends at SECTION_CHUNK with the activity-hook trailing after TAIL (file-present tick)", async () => {
    const result = await tickWith([
      SECTION_BOOTID, "", SECTION_STAT, "0", SECTION_INCARNATION, "",
      SECTION_PANE, btoa("hello pane"), SECTION_CHUNK, "", SECTION_TAIL, "",
      SECTION_ACTIVITY_HOOK, btoa(JSON.stringify({ state: "working", at: "2026-09-25T12:00:00.000Z" })),
    ].join("\n"));
    expect(result.paneFrame).toBe("hello pane");
  });
});

describe("shipTranscriptTick — pane verdict wiring (issue #221)", () => {
  it("result.paneVerdict reflects the SECTION_PANE content of the SAME exec", async () => {
    const idlePane = ["⏺ Done.", "", "─".repeat(68), "❯ ", "─".repeat(68), "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [
        SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
        SECTION_PANE, b64Utf8(idlePane),
      ].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID);
    expect(result.paneVerdict).toEqual({ kind: "idle" });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("result.paneVerdict is undefined on an old-image tick with no SECTION_PANE at all", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, ""].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID);
    expect(result.paneVerdict).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #221 (PR3b), Task 2 — SECTION_ACTIVITY_HOOK, appended as the very
// LAST section the tick's command emits (after the existing if/fi block).
// The old direct parseActivityHookSection/readShipTickHookHeartbeat and
// shipTickCmd-placement describes are now ONE tick-through describe over
// result.hookHeartbeat — do.ts consumes that ShipResult field, so every
// posture below pins the same invariants at the interface. (Placement of the
// hook echo itself is pinned in the command-shape describe at the top.)
// ---------------------------------------------------------------------------
describe("shipTranscriptTick — hook heartbeat section (issue #221, PR3b)", () => {
  /** One tick over raw stdout; returns its result. */
  async function tickWith(raw: string) {
    const deps = fakeDeps({ rawTickStdout: raw });
    const storage = fakeStorage();
    const result = await shipTranscriptTick(deps, storage, STUDIO_ID);
    expect(deps.execCalls).toHaveLength(1);
    return result;
  }

  it("absent section (old image) -> hookHeartbeat undefined, never a throw", async () => {
    const result = await tickWith([SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, ""].join("\n"));
    expect(result.hookHeartbeat).toBeUndefined();
  });

  it("empty section (no heartbeat file yet) -> null: no evidence this tick, not a throw", async () => {
    const result = await tickWith([
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, "", SECTION_ACTIVITY_HOOK, "",
    ].join("\n"));
    expect(result.hookHeartbeat).toBeNull();
  });

  it("malformed JSON in the section -> null, never a throw", async () => {
    const result = await tickWith([
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, "", SECTION_ACTIVITY_HOOK, btoa("not json"),
    ].join("\n"));
    expect(result.hookHeartbeat).toBeNull();
  });

  it("a valid heartbeat parses through", async () => {
    const raw = JSON.stringify({ state: "idle", at: "2026-09-25T12:00:00.000Z" });
    const result = await tickWith([
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, "", SECTION_ACTIVITY_HOOK, btoa(raw),
    ].join("\n"));
    expect(result.hookHeartbeat).toEqual({ state: "idle", at: "2026-09-25T12:00:00.000Z" });
  });

  it("raw heartbeat JSON text round-trips through the base64 section — hookHeartbeat reads its own fields back", async () => {
    const raw = JSON.stringify({ state: "working", at: "2026-09-25T12:00:00.000Z" });
    const result = await tickWith([
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, "", SECTION_ACTIVITY_HOOK, btoa(raw),
    ].join("\n"));
    expect(result.hookHeartbeat?.state).toBe("working");
    expect(result.hookHeartbeat?.at).toBe("2026-09-25T12:00:00.000Z");
  });
});

describe("shipTranscriptTick — hook heartbeat wiring (issue #221, PR3b)", () => {
  it("result.hookHeartbeat reflects the SAME exec's own SECTION_ACTIVITY_HOOK, full-return path", async () => {
    const idlePane = ["⏺ Done.", "", "─".repeat(68), "❯ ", "─".repeat(68), "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
    const raw = JSON.stringify({ state: "working", at: "2026-09-25T12:00:00.500Z" });
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [
        SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
        SECTION_PANE, b64Utf8(idlePane),
        SECTION_ACTIVITY_HOOK, btoa(raw),
      ].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID);
    expect(result.hookHeartbeat).toEqual({ state: "working", at: "2026-09-25T12:00:00.500Z" });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("result.hookHeartbeat is undefined on an old-image tick with no SECTION_ACTIVITY_HOOK at all", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, ""].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID);
    expect(result.hookHeartbeat).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #311 — SECTION_MEMGUARD on the ship tick: the SAME "fold into the
// existing 30s exec, no new exec" B1 leg PR3a already used for SECTION_PANE,
// now reading container/memguard.ts's already-shipped kill log
// (`${MEMGUARD_LOG:-${FLEET_WORKSPACE:-/workspace}/.fleet/memguard.log}` —
// PR #336 round 2, item 3: honours a studio that overrides MEMGUARD_LOG
// directly, not only one that overrides FLEET_WORKSPACE). The command-side
// placement/guard/override asserts live in the "command shape (wire format)"
// describe at the top of this file; everything here pins result.memguardKills
// through the tick — the production read path (do.ts consumes that
// ShipResult field).
// ---------------------------------------------------------------------------
describe("shipTranscriptTick — memguard section (issue #311)", () => {
  /** One tick over raw stdout; returns its result. */
  async function tickWith(raw: string) {
    const deps = fakeDeps({ rawTickStdout: raw });
    const storage = fakeStorage();
    const result = await shipTranscriptTick(deps, storage, STUDIO_ID);
    expect(deps.execCalls).toHaveLength(1);
    return result;
  }

  it("absent SECTION_MEMGUARD (pre-#311 Worker build) yields undefined, never a throw", async () => {
    const result = await tickWith([SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, ""].join("\n"));
    expect(result.memguardKills).toBeUndefined();
  });

  it("an empty memguard section (log file does not exist yet — present marker, no bytes) yields an empty array, not undefined", async () => {
    const result = await tickWith([
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, b64Utf8(""), SECTION_MEMGUARD, "",
    ].join("\n"));
    expect(result.memguardKills).toEqual([]);
  });

  it("a real kill line in the section parses into a full MemguardKillLogEntry", async () => {
    const line =
      "2026-09-25T09:12:03.500Z SIGKILL pid=42 comm=vitest rss_mib=612 avail_mib=88 total_mib=11930 source=cgroup cmd=vitest run";
    const result = await tickWith([
      SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
      SECTION_PANE, b64Utf8(""), SECTION_MEMGUARD, b64Utf8(line),
    ].join("\n"));
    expect(result.memguardKills).toEqual([{
      at: "2026-09-25T09:12:03.500Z", signal: "SIGKILL", pid: 42, comm: "vitest",
      rssMib: 612, availMib: 88, totalMib: 11930, source: "cgroup", cmd: "vitest run",
    }]);
  });

  it("still parses correctly ahead of CHUNK/TAIL on a file-present tick", async () => {
    const line = "2026-09-25T09:00:00.000Z SIGTERM pid=1 comm=a rss_mib=1 avail_mib=1 total_mib=1 source=meminfo cmd=a";
    const result = await tickWith([
      SECTION_BOOTID, "", SECTION_STAT, "0", SECTION_INCARNATION, "",
      SECTION_PANE, b64Utf8(""), SECTION_MEMGUARD, b64Utf8(line), SECTION_CHUNK, "", SECTION_TAIL, "",
    ].join("\n"));
    expect(result.memguardKills).toEqual([{
      at: "2026-09-25T09:00:00.000Z", signal: "SIGTERM", pid: 1, comm: "a",
      rssMib: 1, availMib: 1, totalMib: 1, source: "meminfo", cmd: "a",
    }]);
  });
});

describe("shipTranscriptTick — memguard kill wiring (issue #311)", () => {
  it("result.memguardKills reflects the SECTION_MEMGUARD content of the SAME exec", async () => {
    const line =
      "2026-09-25T09:12:03.500Z SIGKILL pid=42 comm=vitest rss_mib=612 avail_mib=88 total_mib=11930 source=cgroup cmd=vitest run";
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [
        SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, "",
        SECTION_PANE, b64Utf8(""), SECTION_MEMGUARD, b64Utf8(line),
      ].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID);
    expect(result.memguardKills).toHaveLength(1);
    expect(result.memguardKills?.[0]).toMatchObject({ signal: "SIGKILL", pid: 42 });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("result.memguardKills is undefined on an old-Worker-shaped stdout with no SECTION_MEMGUARD at all", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: [SECTION_BOOTID, "", SECTION_STAT, "-1", SECTION_INCARNATION, ""].join("\n"),
      stderr: "",
    }));
    const storage = fakeStorage({});
    const result = await shipTranscriptTick({ exec, r2Put: vi.fn(), now: fixedNow("2026-09-24T10:00:00.000Z") }, storage, STUDIO_ID);
    expect(result.memguardKills).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The grid-facing storage read — the OTHER exported member of the
// production interface. Deliberately duplicated from test/studio.grid.test.ts
// (which keeps its own copy): this file pins the whole module interface, and
// both files exercise the same function.
// ---------------------------------------------------------------------------
describe("getTranscriptTailWithStorage", () => {
  // TranscriptStorage's `get` is an overloaded signature (one per key); a
  // plain single-purpose implementation is cast through, not naturally
  // assignable — same `as X["get"]` idiom test/studio.grid.test.ts's own
  // fakeStorage() (and this file's, above) already use.
  function fakeGet(value: string | undefined): Pick<TranscriptStorage, "get"> {
    return { get: (async () => value) as TranscriptStorage["get"] };
  }

  it("returns '' (never undefined) when nothing has been stored yet", async () => {
    expect(await getTranscriptTailWithStorage(fakeGet(undefined))).toBe("");
  });

  it("returns the stored value verbatim, unscrubbed (scrubbing is the caller's job)", async () => {
    expect(await getTranscriptTailWithStorage(fakeGet("raw tail\n— not scrubbed"))).toBe("raw tail\n— not scrubbed");
  });
});

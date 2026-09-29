import { describe, it, expect } from "vitest";
import {
  OBSERVED_KEY, emptyObserved, getObserved, mergeObserved, isIncarnationToken,
  computeSessionVerdict, computeAdoptedVerdict, parsePaneLeadProbe, paneLeadProbeCmd,
  bringupObservationCmd, parseBringupObservation, bringupLeftLeadUntouched, resolveSnapshotAge,
  SESSION_FOUND_SECTION, SESSION_CONTINUE_SECTION, SESSION_CWD_SECTION, BRINGUP_TOKEN_WRITE_SECTION,
  SESSION_LEAD_AGE_SECTION, isUnreachable, UNREACHABLE_ELAPSED_MS,
  type Observed, type ObservedStorage, type PaneProbeResult,
} from "../src/studio/observed";
import { redactSecrets } from "../src/studio/redact";

// Same Map-backed fake every narrow-port suite in this feature defines
// locally (transcript.ts's TranscriptStorage, session-sync.ts's
// SessionSyncStorage) — a real `this.ctx.storage` satisfies this
// structurally, no cast.
function fakeStorage(seed?: Observed): ObservedStorage {
  const map = new Map<string, unknown>();
  if (seed) map.set(OBSERVED_KEY, seed);
  return {
    get: (async (key: string) => map.get(key)) as ObservedStorage["get"],
    put: (async (key: string, value: unknown) => {
      map.set(key, value);
    }) as ObservedStorage["put"],
  };
}

describe("observed.ts", () => {
  it("emptyObserved: every field null/zero, session null", () => {
    expect(emptyObserved()).toEqual({
      incarnation: null, replacedAt: null, execFailures: 0, unreachableSince: null,
      lastShipOkAt: null, lastSnapshotAt: null, session: null, activity: null, memberAlerts: null,
      // Issue #249 (PR4b): the survival re-brief's dedup marker. OPTIONAL on
      // the type (absence means exactly what `null` means, so a pre-#249
      // stored record reads as "never delivered"), but `emptyObserved` still
      // names it explicitly rather than leaving a reader to infer it — which
      // is what this assertion pins.
      survivalBriefDeliveredFor: null,
      // Issue #249 round 2, item 2: the DEFERRED-brief marker, named for the
      // same reason and with the same optional-means-null reading.
      survivalBriefPending: null,
      // Issue #56: the container-restart log, named for the same reason —
      // withObserved always attaches it, so an empty record carries it too.
      restarts: null,
    });
  });

  it("getObserved: no stored record yet returns emptyObserved()", async () => {
    const storage = fakeStorage();
    expect(await getObserved(storage)).toEqual(emptyObserved());
  });

  it("getObserved: returns exactly what was stored", async () => {
    const seed: Observed = { ...emptyObserved(), incarnation: "abc-123" };
    const storage = fakeStorage(seed);
    expect(await getObserved(storage)).toEqual(seed);
  });

  it("mergeObserved: patches only the given fields, leaves the rest untouched", async () => {
    const seed: Observed = { ...emptyObserved(), incarnation: "abc-123", execFailures: 2 };
    const storage = fakeStorage(seed);
    const result = await mergeObserved(storage, { execFailures: 0 });
    expect(result).toEqual({ ...seed, execFailures: 0 });
    expect(await getObserved(storage)).toEqual(result);
  });

  it("mergeObserved: starting from nothing stored behaves as a patch over emptyObserved()", async () => {
    const storage = fakeStorage();
    const result = await mergeObserved(storage, { replacedAt: "2026-09-24T10:00:00.000Z" });
    expect(result).toEqual({ ...emptyObserved(), replacedAt: "2026-09-24T10:00:00.000Z" });
  });

  // Review round 3 (issue #85 PR1), MUST-FIX 10: an old stored record missing
  // a field entirely (as a future field addition to `Observed` would leave
  // on every pre-existing row) reads back with THAT field's emptyObserved()
  // default, never `undefined` — getObserved merges over emptyObserved()
  // rather than trusting a stored record to already be complete.
  it("getObserved: a stored record missing a field reads back with emptyObserved()'s default, not undefined", async () => {
    const partial = { incarnation: "abc-123", execFailures: 2 } as unknown as Observed;
    const storage = fakeStorage(partial);
    const result = await getObserved(storage);
    expect(result).toEqual({ ...emptyObserved(), incarnation: "abc-123", execFailures: 2 });
    expect(result.session).toBeNull();
    expect(result.unreachableSince).toBeNull();
  });
});

describe("isIncarnationToken — issue #85, maestro correction #3", () => {
  it("accepts a real crypto.randomUUID() shape", () => {
    expect(isIncarnationToken("11111111-2222-3333-4444-555555555555")).toBe(true);
  });

  it("accepts uppercase hex too (case-insensitive)", () => {
    expect(isIncarnationToken("11111111-2222-3333-4444-555555555555".toUpperCase())).toBe(true);
  });

  it("rejects the empty string", () => {
    expect(isIncarnationToken("")).toBe(false);
  });

  it("rejects a truncated/garbled read", () => {
    expect(isIncarnationToken("11111111-2222-3333-4444-5555555")).toBe(false);
  });

  it("rejects arbitrary non-UUID content some other process left at the path", () => {
    expect(isIncarnationToken("not-a-real-token")).toBe(false);
  });
});

describe("computeSessionVerdict — issue #85 spec table (maestro correction #9 rewrite)", () => {
  const AT = "2026-09-24T10:00:00.000Z";
  const CWD = "/workspace/acme-os";
  const okProbe = (hasContinue: boolean, cwd: string | null): PaneProbeResult => ({ ok: true, found: true, hasContinue, cwd, leadAgeS: null, error: null });

  it("resumed: --continue found, cwd matches", () => {
    const v = computeSessionVerdict(okProbe(true, CWD), CWD, "restored", 5, 60, AT, "restart");
    expect(v.verdict).toBe("resumed");
    expect(v.reason).toBeNull();
  });

  // T5: fresh launch, turnsBefore 412 -> LOST, had 412 turns
  it("T5: no --continue, cwd correct, turnsBefore 412 -> lost, reason no --continue", () => {
    const v = computeSessionVerdict(okProbe(false, CWD), CWD, "skip:has-projects", 412, null, AT, "restart");
    expect(v.verdict).toBe("lost");
    expect(v.turnsBefore).toBe(412);
    expect(v.reason).toBe("no --continue");
  });

  // T6: fresh launch, no history -> fresh
  it("T6: no --continue, no prior history, no restored snapshot -> fresh", () => {
    const v = computeSessionVerdict(okProbe(false, CWD), CWD, "skip:no-snapshot", 0, null, AT, "provision");
    expect(v.verdict).toBe("fresh");
    expect(v.reason).toBeNull();
  });

  // T7: lead cwd /container-server after clone refusal -> LOST, reason names the cwd
  it("T7: cwd is /container-server (clone refusal), history exists -> lost, reason names the cwd", () => {
    const v = computeSessionVerdict(okProbe(true, "/container-server"), CWD, "skip:no-snapshot", 9, null, AT, "restart");
    expect(v.verdict).toBe("lost");
    expect(v.reason).toBe("cwd /container-server");
  });

  it("unknown: the pane probe itself failed", () => {
    const failedProbe: PaneProbeResult = { ok: false, found: false, hasContinue: false, cwd: null, leadAgeS: null, error: "exec timed out" };
    const v = computeSessionVerdict(failedProbe, CWD, "not-attempted", 0, null, AT, "heal");
    expect(v.verdict).toBe("unknown");
    expect(v.reason).toBe("exec timed out");
  });

  it("unknown: the probe succeeded but found no lead pid — never folded into fresh/lost (maestro correction #9)", () => {
    const notFound: PaneProbeResult = { ok: true, found: false, hasContinue: false, cwd: null, leadAgeS: null, error: null };
    const v = computeSessionVerdict(notFound, CWD, "not-attempted", 5, null, AT, "restart");
    expect(v.verdict).toBe("unknown");
    expect(v.reason).toBe("no lead process found");
  });

  it("snapshotAgeS is passed through unchanged — the caller (provision.ts) is what gates it on restore===\"restored\", not this function", () => {
    const v = computeSessionVerdict(okProbe(false, CWD), CWD, "skip:no-snapshot", 0, null, AT, "provision");
    expect(v.snapshotAgeS).toBeNull();
  });

  // Code-reviewer finding (issue #85 PR1): `reason` must be scrubbed at
  // construction, not only at a later D1-mirror/output boundary — a raw
  // exec error or cwd can carry FLEET_SPAWN_TOKEN-shaped content echoed
  // straight from the container. Same fixture convention
  // test/studio.routes.test.ts's own redactSecrets coverage uses.
  it("reason is redacted at construction when the pane probe's own exec error carries a secret shape", () => {
    const failedProbe: PaneProbeResult = {
      ok: false, found: false, hasContinue: false, cwd: null, leadAgeS: null,
      error: "no git checkout at /workspace/websites (token fsp_deadbeef00)",
    };
    const v = computeSessionVerdict(failedProbe, CWD, "not-attempted", 0, null, AT, "heal");
    expect(v.verdict).toBe("unknown");
    expect(v.reason).not.toContain("fsp_deadbeef00");
    expect(v.reason).toBe(redactSecrets("no git checkout at /workspace/websites (token fsp_deadbeef00)"));
  });

  it("reason is redacted at construction when a mismatched cwd itself carries a secret shape", () => {
    const secretCwd = "/workspace/fsp_deadbeef00";
    const v = computeSessionVerdict(okProbe(true, secretCwd), CWD, "skip:no-snapshot", 9, null, AT, "restart");
    expect(v.verdict).toBe("lost");
    expect(v.reason).not.toContain("fsp_deadbeef00");
    expect(v.reason).toBe(redactSecrets(`cwd ${secretCwd}`));
  });

  // Review round 3 (issue #85 PR1), MUST-FIX 4 / board #120: a resumed
  // session re-enters the studio through a worktree sub-checkout under
  // `<expectedCwd>/.claude/worktrees/<name>` — that cwd is a legitimate
  // resume, not a mismatch.
  it("resumed: cwd is exactly expectedCwd (unchanged baseline)", () => {
    const v = computeSessionVerdict(okProbe(true, CWD), CWD, "restored", 5, 60, AT, "restart");
    expect(v.verdict).toBe("resumed");
  });

  it("resumed: cwd is a worktree sub-checkout under expectedCwd/.claude/worktrees/ (#120)", () => {
    const worktreeCwd = `${CWD}/.claude/worktrees/row-tells-truth-85-pr1`;
    const v = computeSessionVerdict(okProbe(true, worktreeCwd), CWD, "restored", 5, 60, AT, "restart");
    expect(v.verdict).toBe("resumed");
    expect(v.reason).toBeNull();
  });

  it("NOT a match: a cwd that merely shares expectedCwd as a string prefix, without the worktree segment (#120 negative case)", () => {
    const lookalikeCwd = `${CWD}-other`;
    const v = computeSessionVerdict(okProbe(true, lookalikeCwd), CWD, "restored", 5, 60, AT, "restart");
    expect(v.verdict).toBe("lost");
    expect(v.reason).toBe(redactSecrets(`cwd ${lookalikeCwd}`));
  });
});

describe("computeAdoptedVerdict — issue #85, maestro correction #7", () => {
  const AT = "2026-09-24T10:00:00.000Z";
  const CWD = "/workspace/acme-os";

  it("resumed: --continue found, cwd matches", () => {
    const v = computeAdoptedVerdict({ ok: true, found: true, hasContinue: true, cwd: CWD, leadAgeS: null, error: null }, CWD, 40, AT);
    expect(v).toEqual({ verdict: "resumed", at: AT, via: "adopted", restore: "not-attempted", snapshotAgeS: null, turnsBefore: 40, reason: null });
  });

  it("unknown, never lost: no --continue", () => {
    const v = computeAdoptedVerdict({ ok: true, found: true, hasContinue: false, cwd: CWD, leadAgeS: null, error: null }, CWD, 900, AT);
    expect(v.verdict).toBe("unknown");
    expect(v.reason).toBe("adopted: launch history unknown");
  });

  it("unknown, never lost: cwd mismatch", () => {
    const v = computeAdoptedVerdict({ ok: true, found: true, hasContinue: true, cwd: "/container-server", leadAgeS: null, error: null }, CWD, 900, AT);
    expect(v.verdict).toBe("unknown");
  });

  it("unknown: the probe itself failed, carries the probe's own error", () => {
    const v = computeAdoptedVerdict({ ok: false, found: false, hasContinue: false, cwd: null, leadAgeS: null, error: "exec timed out" }, CWD, 0, AT);
    expect(v.verdict).toBe("unknown");
    expect(v.reason).toBe("exec timed out");
  });

  it("code-reviewer finding (issue #85 PR1): reason is redacted at construction when the probe's error carries a secret shape", () => {
    const v = computeAdoptedVerdict(
      { ok: false, found: false, hasContinue: false, cwd: null, leadAgeS: null, error: "auth failed for sk-ant-oat01-deadbeef00 (401)" },
      CWD, 0, AT,
    );
    expect(v.verdict).toBe("unknown");
    expect(v.reason).not.toContain("sk-ant-");
    expect(v.reason).toBe(redactSecrets("auth failed for sk-ant-oat01-deadbeef00 (401)"));
  });
});

describe("parsePaneLeadProbe (issue #85, maestro correction #9)", () => {
  it("parses found/hasContinue/cwd from the three sections", () => {
    const stdout = [SESSION_FOUND_SECTION, "yes", SESSION_CONTINUE_SECTION, "yes", SESSION_CWD_SECTION, "/workspace/acme-os"].join("\n");
    expect(parsePaneLeadProbe(stdout)).toEqual({ ok: true, found: true, hasContinue: true, cwd: "/workspace/acme-os", leadAgeS: null, error: null });
  });

  it("no lead process found: found false, hasContinue false, cwd null", () => {
    const stdout = [SESSION_FOUND_SECTION, "no", SESSION_CONTINUE_SECTION, "no", SESSION_CWD_SECTION, ""].join("\n");
    expect(parsePaneLeadProbe(stdout)).toEqual({ ok: true, found: false, hasContinue: false, cwd: null, leadAgeS: null, error: null });
  });

  // Review round 3 (issue #85 PR1), MUST-FIX 3.
  it("parses the lead's own age (etimes) from the fourth section", () => {
    const stdout = [
      SESSION_FOUND_SECTION, "yes", SESSION_CONTINUE_SECTION, "yes", SESSION_CWD_SECTION, "/workspace/acme-os",
      SESSION_LEAD_AGE_SECTION, "45210",
    ].join("\n");
    expect(parsePaneLeadProbe(stdout).leadAgeS).toBe(45210);
  });

  it("no lead age section at all (older probe shape, or a ps that answered nothing parseable): leadAgeS is null", () => {
    const stdout = [SESSION_FOUND_SECTION, "yes", SESSION_CONTINUE_SECTION, "yes", SESSION_CWD_SECTION, "/workspace/acme-os"].join("\n");
    expect(parsePaneLeadProbe(stdout).leadAgeS).toBeNull();
  });

  it("a blank lead age line (no lead pid to ps) parses as null, never NaN", () => {
    const stdout = [
      SESSION_FOUND_SECTION, "no", SESSION_CONTINUE_SECTION, "no", SESSION_CWD_SECTION, "",
      SESSION_LEAD_AGE_SECTION, "",
    ].join("\n");
    expect(parsePaneLeadProbe(stdout).leadAgeS).toBeNull();
  });
});

describe("paneLeadProbeCmd (issue #85, maestro correction #9)", () => {
  it("verifies the tmux target's own session:window before trusting its pane_pid, uses pgrep -x claude, checks --continue per-argv-element, and never returns raw argv", () => {
    const cmd = paneLeadProbeCmd();
    expect(cmd).toContain("tmux display -p -t studio:claude '#{session_name}:#{window_name} #{pane_pid}'");
    expect(cmd).toContain("studio:claude \"*)"); // the exact-match case guard, not trusted from -t alone
    expect(cmd).toContain("pgrep -x claude -P");
    expect(cmd).toContain("tr '\\0' '\\n'");
    expect(cmd).toContain("grep -qxF -- --continue");
    expect(cmd).toContain("/cwd");
    expect(cmd).not.toContain("/cmdline 2>/dev/null;\n"); // never echoes raw cmdline to stdout
    expect(cmd).not.toContain("attach");
    expect(cmd).not.toContain("send-keys");
  });

  // Review round 3 (issue #85 PR1), MUST-FIX 3.
  it("also reports the lead's own age via ps -o etimes=", () => {
    const cmd = paneLeadProbeCmd();
    expect(cmd).toContain("ps -o etimes=");
    expect(cmd).toContain(SESSION_LEAD_AGE_SECTION);
  });
});

describe("bringupLeftLeadUntouched (issue #85 review round 3, MUST-FIX 3)", () => {
  const BRINGUP_STARTED = "2026-09-24T10:00:00.000Z";

  it("no lead age known at all: never counts as untouched", () => {
    expect(bringupLeftLeadUntouched(null, BRINGUP_STARTED, "2026-09-24T10:00:05.000Z")).toBe(false);
  });

  it("the lead is OLDER than the elapsed bring-up time: left untouched", () => {
    // Bring-up itself has been running for 5s; the lead has been alive 999s
    // — it plainly predates this bring-up.
    const now = "2026-09-24T10:00:05.000Z";
    expect(bringupLeftLeadUntouched(999, BRINGUP_STARTED, now)).toBe(true);
  });

  it("the lead is YOUNGER than the elapsed bring-up time: genuinely (re)launched by it", () => {
    // Bring-up has been running for 30s; the lead is only 2s old — bring-up
    // could easily have started it partway through.
    const now = "2026-09-24T10:00:30.000Z";
    expect(bringupLeftLeadUntouched(2, BRINGUP_STARTED, now)).toBe(false);
  });

  it("exactly equal ages: not (yet) untouched — the boundary favors recomputing", () => {
    const now = "2026-09-24T10:00:10.000Z"; // bring-up has run 10s
    expect(bringupLeftLeadUntouched(10, BRINGUP_STARTED, now)).toBe(false);
  });
});

describe("resolveSnapshotAge (issue #85 review round 3, MUST-FIX 8d)", () => {
  const SNAPSHOT_AT = "2026-09-24T08:00:00.000Z";
  const RESTORE_OBSERVED_AT = "2026-09-24T10:00:00.000Z"; // 2h after the snapshot

  it("replacedAt known (a genuine replacement): exact age, stop time - snapshot time, never an upper bound", () => {
    const replacedAt = "2026-09-24T08:30:00.000Z"; // 30m after the snapshot
    const result = resolveSnapshotAge(SNAPSHOT_AT, replacedAt, RESTORE_OBSERVED_AT);
    expect(result).toEqual({ snapshotAgeS: 30 * 60, snapshotAgeIsUpperBound: false });
  });

  it("replacedAt unknown: falls back to restore-observed time, marked as an upper bound", () => {
    const result = resolveSnapshotAge(SNAPSHOT_AT, null, RESTORE_OBSERVED_AT);
    expect(result).toEqual({ snapshotAgeS: 2 * 3600, snapshotAgeIsUpperBound: true });
  });

  it("clamps at 0 — a snapshot uploaded AFTER the resolved stop time never renders a negative age", () => {
    const replacedAt = "2026-09-24T07:00:00.000Z"; // BEFORE the snapshot itself
    const result = resolveSnapshotAge(SNAPSHOT_AT, replacedAt, RESTORE_OBSERVED_AT);
    expect(result.snapshotAgeS).toBe(0);
    expect(result.snapshotAgeIsUpperBound).toBe(false);
  });

  it("replacedAt exactly equal to the snapshot time: age 0, still exact (not an upper bound)", () => {
    const result = resolveSnapshotAge(SNAPSHOT_AT, SNAPSHOT_AT, RESTORE_OBSERVED_AT);
    expect(result).toEqual({ snapshotAgeS: 0, snapshotAgeIsUpperBound: false });
  });

  // Review round 6, MUST-FIX 4 — #129 landed: `LAST_STOP_KEY.at` is now the
  // FIRST-priority rung, ahead of `replacedAt`, whenever it falls inside the
  // sane window `snapshotUploadedAt <= lastStop.at <= restoreObservedAt`.
  describe("lastStopAt (issue #85 review round 6, MUST-FIX 4 — board #129 landed)", () => {
    it("the maestro's own example: stopped 8h, final sync succeeded right at stop — no lost work", () => {
      // The container's own last sync landed 5s before it stopped; the
      // restore only happened 8 HOURS later. Without lastStopAt wired in,
      // this would fall through to replacedAt (null here — an ordinary
      // intentional destroy/recreate sets none) and then to
      // restoreObservedAt, wrongly charging the whole 8h of DOWNTIME as lost
      // work. With lastStopAt wired in as the real stop time, the age is the
      // 5s gap between the final sync and the stop itself.
      const snapshotUploadedAt = "2026-09-24T02:00:00.000Z";
      const lastStopAt = "2026-09-24T02:00:05.000Z"; // 5s after the snapshot
      const restoreObservedAt = "2026-09-24T10:00:05.000Z"; // 8h after the stop
      const result = resolveSnapshotAge(snapshotUploadedAt, null, restoreObservedAt, lastStopAt);
      expect(result).toEqual({ snapshotAgeS: 5, snapshotAgeIsUpperBound: false });
    });

    it("takes priority over replacedAt when both fall inside the sane window", () => {
      const snapshotUploadedAt = "2026-09-24T02:00:00.000Z";
      const lastStopAt = "2026-09-24T02:00:10.000Z"; // 10s after the snapshot
      const replacedAt = "2026-09-24T02:05:00.000Z"; // 5m after the snapshot — would give a different answer
      const restoreObservedAt = "2026-09-24T10:00:00.000Z";
      const result = resolveSnapshotAge(snapshotUploadedAt, replacedAt, restoreObservedAt, lastStopAt);
      expect(result).toEqual({ snapshotAgeS: 10, snapshotAgeIsUpperBound: false });
    });

    it("out of range (BEFORE the snapshot itself) — falls through to replacedAt, ignored entirely", () => {
      const snapshotUploadedAt = "2026-09-24T02:00:00.000Z";
      const lastStopAt = "2026-09-24T01:00:00.000Z"; // stale/nonsensical: before the snapshot
      const replacedAt = "2026-09-24T02:30:00.000Z"; // 30m after the snapshot
      const restoreObservedAt = "2026-09-24T10:00:00.000Z";
      const result = resolveSnapshotAge(snapshotUploadedAt, replacedAt, restoreObservedAt, lastStopAt);
      expect(result).toEqual({ snapshotAgeS: 30 * 60, snapshotAgeIsUpperBound: false });
    });

    it("out of range (AFTER restoreObservedAt) — falls through to the existing chain", () => {
      const snapshotUploadedAt = "2026-09-24T02:00:00.000Z";
      const restoreObservedAt = "2026-09-24T10:00:00.000Z";
      const lastStopAt = "2026-09-24T11:00:00.000Z"; // AFTER the restore was observed — nonsensical
      const result = resolveSnapshotAge(snapshotUploadedAt, null, restoreObservedAt, lastStopAt);
      // Falls all the way through to the restoreObservedAt fallback, marked
      // as an upper bound exactly as it would with no lastStopAt at all.
      expect(result).toEqual({ snapshotAgeS: 8 * 3600, snapshotAgeIsUpperBound: true });
    });

    it("absent (null) — behaves exactly as before, no change to the existing chain", () => {
      const replacedAt = "2026-09-24T08:30:00.000Z";
      const result = resolveSnapshotAge(SNAPSHOT_AT, replacedAt, RESTORE_OBSERVED_AT, null);
      expect(result).toEqual({ snapshotAgeS: 30 * 60, snapshotAgeIsUpperBound: false });
    });
  });
});

describe("bringupObservationCmd / parseBringupObservation (issue #85, maestro correction #6 — one exec for token write + probe)", () => {
  it("writes the token, reports success, then folds the SAME pane probe into the one command", () => {
    const cmd = bringupObservationCmd("11111111-2222-3333-4444-555555555555");
    expect(cmd).toContain("11111111-2222-3333-4444-555555555555");
    expect(cmd).toContain(BRINGUP_TOKEN_WRITE_SECTION);
    expect(cmd).toContain(SESSION_FOUND_SECTION); // the probe fragment is present in the SAME string
  });

  it("parses tokenWritten + the probe from one combined stdout", () => {
    const stdout = [
      BRINGUP_TOKEN_WRITE_SECTION, "yes",
      SESSION_FOUND_SECTION, "yes", SESSION_CONTINUE_SECTION, "yes", SESSION_CWD_SECTION, "/workspace/acme-os",
    ].join("\n");
    expect(parseBringupObservation(stdout)).toEqual({
      tokenWritten: true,
      probe: { ok: true, found: true, hasContinue: true, cwd: "/workspace/acme-os", leadAgeS: null, error: null },
    });
  });

  it("a failed token write still parses the probe half", () => {
    const stdout = [BRINGUP_TOKEN_WRITE_SECTION, "no", SESSION_FOUND_SECTION, "no", SESSION_CONTINUE_SECTION, "no", SESSION_CWD_SECTION, ""].join("\n");
    expect(parseBringupObservation(stdout).tokenWritten).toBe(false);
  });
});

// Board issue #183 review round 2, MUST-FIX 2 — a studio WEDGED FROM THE VERY
// START (dead immediately at deploy, or a fresh studio whose container never
// comes up reachable even once) never records a `lastShipOkAt` at all, since
// that field only ever advances on a SUCCESSFUL tick. Anchoring elapsed time
// on `lastShipOkAt` alone therefore protects exactly the studios most in need
// of the "unreachable" signal from ever showing it — this section pins the
// fix: fall back to `unreachableSince` (stamped at the FIRST FAILURE of a
// streak, which needs only one failure, never a prior success) whenever
// `lastShipOkAt` is null.
describe("isUnreachable (board issue #183 review round 2, MUST-FIX 2 — the lastShipOkAt ?? unreachableSince anchor)", () => {
  const T0 = "2026-09-24T10:00:00.000Z";

  it("RED/GREEN: no lastShipOkAt, dead plane from the first-ever tick — unreachable once 90s have elapsed SINCE unreachableSince", () => {
    // A studio whose FIRST-EVER ship tick failed: lastShipOkAt is still null
    // (it has never once succeeded), but unreachableSince WAS stamped at that
    // first failure (do.ts stamps it at execFailures 0->1, needing only a
    // failure, never a prior success).
    const observed: Observed = {
      ...emptyObserved(), execFailures: 2, unreachableSince: T0, lastShipOkAt: null,
    };
    // Under the OLD code (lastShipOkAt alone), this can NEVER return true, no
    // matter how much time passes — exactly the gap this fix closes.
    expect(isUnreachable(observed, new Date(Date.parse(T0) + UNREACHABLE_ELAPSED_MS))).toBe(true);
    expect(isUnreachable(observed, new Date(Date.parse(T0) + 60 * 60 * 1000))).toBe(true); // an hour later — still true
  });

  it("no lastShipOkAt, only 89s elapsed since unreachableSince — not yet unreachable (still the >=90s rule, just anchored differently)", () => {
    const observed: Observed = {
      ...emptyObserved(), execFailures: 2, unreachableSince: T0, lastShipOkAt: null,
    };
    expect(isUnreachable(observed, new Date(Date.parse(T0) + UNREACHABLE_ELAPSED_MS - 1_000))).toBe(false);
  });

  it("both lastShipOkAt AND unreachableSince null — nothing to measure from, still false regardless of execFailures", () => {
    const observed: Observed = { ...emptyObserved(), execFailures: 5, unreachableSince: null, lastShipOkAt: null };
    expect(isUnreachable(observed, new Date(Date.parse(T0) + 60 * 60 * 1000))).toBe(false);
  });

  it("lastShipOkAt IS known: it still wins over unreachableSince (the normal, already-correct case is unchanged)", () => {
    // lastShipOkAt is 5 minutes before unreachableSince here — if the anchor
    // picked unreachableSince instead, elapsed would read even larger, but
    // this proves lastShipOkAt itself is the one actually used whenever it
    // is available (the `??` only ever supplies a FALLBACK).
    const lastShipOkAt = "2026-09-24T09:55:00.000Z";
    const observed: Observed = { ...emptyObserved(), execFailures: 2, unreachableSince: T0, lastShipOkAt };
    // Only 89s after lastShipOkAt (not unreachableSince) — must read false.
    expect(isUnreachable(observed, new Date(Date.parse(lastShipOkAt) + UNREACHABLE_ELAPSED_MS - 1_000))).toBe(false);
    expect(isUnreachable(observed, new Date(Date.parse(lastShipOkAt) + UNREACHABLE_ELAPSED_MS))).toBe(true);
  });

  // Board issue #183 review round 2, MUST-FIX 3(b) — the exact 90s boundary
  // uses `>=`, never `>`: elapsed EXACTLY 90_000ms with 2+ failures already
  // reads unreachable.
  it("MUST-FIX 3(b): elapsed EXACTLY 90_000ms with 2+ failures is unreachable (the boundary is >=, not >)", () => {
    const observed: Observed = { ...emptyObserved(), execFailures: 2, unreachableSince: T0, lastShipOkAt: T0 };
    expect(isUnreachable(observed, new Date(Date.parse(T0) + UNREACHABLE_ELAPSED_MS))).toBe(true);
    expect(isUnreachable(observed, new Date(Date.parse(T0) + UNREACHABLE_ELAPSED_MS - 1))).toBe(false);
  });

  // Board issue #183 review round 2, MUST-FIX 3(c) — "kills the 120s mutant":
  // 100s is strictly between the real 90s threshold and a wrong hardcoded
  // 120s one, so this test can only pass under the correct 90s rule.
  it("MUST-FIX 3(c): 2 failures at 100s elapsed is unreachable — kills a hardcoded-120s mutant", () => {
    const observed: Observed = { ...emptyObserved(), execFailures: 2, unreachableSince: T0, lastShipOkAt: T0 };
    expect(isUnreachable(observed, new Date(Date.parse(T0) + 100_000))).toBe(true);
  });
});

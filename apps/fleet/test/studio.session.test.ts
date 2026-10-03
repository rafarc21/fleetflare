import { formatRescueReport } from "../src/studio/rescue";
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  syncSessionTick, restorePlan, tarAndStatCmd, singleReadCmd, splitCmd, partReadCmd,
  sessionDailyPrefix, SESSION_SYNC_DIR, SESSION_TAR_PATH, SESSION_EXCLUDES_PATH, asideListCmd, asidePackCmd, ASIDE_SHIP_KEY,
  SESSION_DAILY_DATE_KEY, SESSION_BURN_WATERMARK_KEY, BURN_KEY, SESSION_GUARD_KEY, SESSION_FORCE_KEY,
  type SessionSyncDeps, type SessionSyncStorage,
} from "../src/studio/session-sync";
import {
  runSessionRestore, restorePartPath, CONTAINER_HAS_PROJECTS_CMD, BRINGUP_CMD, provisionedCheckCmd,
  PROVISIONED_CHECK_TRIES, PROVISIONED_OK, PROVISIONED_UNKNOWN, CAVEMAN_FLAG_TRIES, harnessExpectation,
  SESSION_RESTORE_DIR, SESSION_RESTORE_MANIFEST_PATH,
  STATUS_KEY, ROLE_ENV_KEY, type ProvisionDeps, type StudioStorage, type RoleEnv, type StudioEnv,
} from "../src/studio/provision";
import {
  restartWithSync, recycleWithSync, checkProvisionedWithRetry, CHECK_ATTEMPTS,
  rescuePush, rescuePushCmd, rescueSnapshot, rescueSnapshotCmd, RESCUE_NO_CHECKOUT, RESCUE_CLEAN, RESCUE_PUSHED_PREFIX, RESCUE_FAILED_PREFIX,
  RescuePushFailedError,
  harvestLearnings, harvestRecordCmd, HARVEST_NO_RECORD, type CommitLearningFile, type ResolveMemoryRepo,
  archiveDoneRecords, doneRecordsListCmd, type DoneRecordPorts,
  DONE_RECORD_HASHES_KEY, type DoneRecordHashStorage,
  mirrorBurnToRegistry, checkAndRecordReadiness, syncSessionCycle, clearSessionGuard, RECYCLE_REFUSED_PREFIX,
  clearForceMappedAccount,
} from "../src/studio/do";
import {
  sessionLatestKey, sessionDailyKey, SESSION_SINGLE_READ_MAX, SESSION_SPLIT_PART,
  SESSION_TOTAL_MAX, SESSION_SUBAGENT_RAW_BUDGET,
  SESSION_SUBAGENT_LIVE_WINDOW_SECONDS, SESSION_SUBAGENT_WATERMARK_LOOKBACK_SECONDS,
} from "../src/studio/archive";
import { getObserved, OBSERVED_KEY, type ObservedStorage } from "../src/studio/observed";
import { INSTALL_CACHE_SAVE_LEASE_KEY, type InstallCacheSaveStorage } from "../src/studio/install-cache";
import type { StudioStatus, ProvisionConfig } from "../src/studio/types";
import type { Burn } from "../src/studio/burn";
import {
  paneCaptureCmd, PANE_CAPTURE_MARKER, exhaustedMessage, PARKED_AUTO_STOP_HOURS, type FailoverDeps,
} from "../src/studio/failover";
import type { ClaudeAccount } from "../src/studio/accounts";
import { ORG_SPEND_LIMIT_PANE } from "./fixtures/rate-limit-panes";

// A live StudioDO cannot be constructed under vitest-pool-workers (see
// src/studio/do.ts's own header) — this file targets the exported pure
// functions do.ts's real syncSession()/restartStudio() methods are thin
// wrappers around, the same split test/studio.transcript.test.ts and
// test/studio.refresh.test.ts already use for their own P1/Task-7 surfaces.

const STUDIO_ID = "websites--pilot";
const TODAY = "2026-08-16";
/** Review round 3 (#202): the container epoch every fake tar/stat command in
 *  this file reports as the start of its tar — the value a tick may adopt as
 *  the burn watermark, but only once its own burn parse has succeeded. */
const TAR_STARTED_AT = 1_758_067_200;

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

function b64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

/** Chunked base64 encode for large (multi-MiB) byte arrays — a plain
 *  `String.fromCharCode(...bytes)` spread blows the call stack past a few
 *  hundred KiB (same reason src/studio/sandbox-api.ts's own bytesToBase64
 *  chunks). Needed here (unlike b64 above) because I1's post-concat length
 *  check now requires every syncSessionTick test's DECODED byte count to
 *  genuinely match its declared stat size — a boundary test anchored to the
 *  real SESSION_SINGLE_READ_MAX/SESSION_TOTAL_MAX constants can no longer
 *  fake a few bytes standing in for millions. */
function b64Large(byteLength: number, fillValue = 1): string {
  const bytes = new Uint8Array(byteLength).fill(fillValue);
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Same shape as transcript.ts's own fakeStorage in
 *  test/studio.transcript.test.ts: an in-memory Map behind the keyed port,
 *  `putKeys` log so "marker never written" (failure isolation) is a
 *  positive assertion. Task 4 fix round (ruled-in minor): `put` also
 *  handles the multi-key object form now (SessionSyncStorage's atomic
 *  BURN_CURSOR_KEY+BURN_KEY overload) — this file's own fixtures never
 *  reach that path (none of them decode to valid gzip, so burn parsing's
 *  own magic-byte guard throws first, well before any burn-related put),
 *  but the fake stays a genuine, correct implementer of the full port
 *  rather than one that would silently mis-write if a future test here
 *  ever did reach it. */
function fakeSessionStorage(seed?: { dailyDate?: string }): SessionSyncStorage & { putKeys: string[] } {
  const map = new Map<string, unknown>();
  if (seed?.dailyDate !== undefined) map.set(SESSION_DAILY_DATE_KEY, seed.dailyDate);
  const putKeys: string[] = [];
  const storage = {
    putKeys,
    get: (async (key: string) => map.get(key)) as SessionSyncStorage["get"],
    put: (async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
      const entries: Record<string, unknown> =
        typeof keyOrEntries === "string" ? { [keyOrEntries]: value } : keyOrEntries;
      for (const [key, v] of Object.entries(entries)) {
        putKeys.push(key);
        map.set(key, v);
      }
    }) as SessionSyncStorage["put"],
    // Issue #228 item 4: SessionSyncStorage.delete is now required — this
    // fake never arms/consumes SESSION_FORCE_KEY itself.
    delete: (async (key: string) => map.delete(key)) as NonNullable<SessionSyncStorage["delete"]>,
  };
  return storage;
}

/**
 * Routes by command shape, not call order — mirrors transcript.ts's own
 * fakeDeps. tarAndStatCmd always starts with "mkdir -p"; splitCmd always
 * starts with "rm -f" (checked BEFORE the generic ".part-" check below,
 * since splitCmd's OWN text also contains ".part-" as a substring — see
 * splitCmd's doc comment); any other command containing ".part-" is a part
 * read, tracked via a dedicated counter (NOT derived by filtering
 * execCalls, which would double-count splitCmd itself); anything else is
 * the plain singleReadCmd.
 */
function fakeSyncDeps(opts: {
  statSize?: string; statCode?: number; statStderr?: string; statWatermark?: string;
  singleRead?: string; singleCode?: number;
  splitCode?: number; partReads?: string[]; partCodes?: number[];
  now?: string;
  r2List?: string[];
  r2PutThrows?: boolean;
  checks?: ({ code: number; stdout?: string } | null)[];
  /** Task 3: rescuePushCmd's own exec response. `undefined` (the default)
   *  answers RESCUE_CLEAN — the common case (per the brief, "most studios
   *  die clean") — so every pre-existing test in this file that never heard
   *  of rescue-push keeps behaving exactly as it did before this field
   *  existed. `null` means the exec itself throws, the same convention
   *  `checks: [null, ...]` above already uses for the provisioned check. */
  rescue?: { code: number; stdout?: string; stderr?: string } | null;
  /** Task 4: harvestRecordCmd's own exec response. `undefined` (the
   *  default) answers HARVEST_NO_RECORD — the common case. Completion gate
   *  DOES ask for `learnings` (studio-bringup.sh:877-878) — field is
   *  OPTIONAL, never a refusal condition, so most `.fleet/done.json`
   *  records still omit it. Pinned by `test/bun/bringup-hooks.test.ts`. So
   *  every pre-existing recycle test in this file keeps behaving exactly as
   *  it did before this field existed. `null` means the exec itself
   *  throws, same convention as `rescue`/`checks` above. */
  harvest?: { code: number; stdout?: string; stderr?: string } | null;
} = {}): SessionSyncDeps & {
  execCalls: string[]; puts: { key: string; bytes: Uint8Array }[]; deletedKeys: string[][]; listCalls: string[];
} {
  const execCalls: string[] = [];
  const puts: { key: string; bytes: Uint8Array }[] = [];
  const deletedKeys: string[][] = [];
  // Fleet Spawn P3, Task 5 (R-P3-5 backlog: "daily-prune gating... today it
  // prunes every tick"). Verified against the current source that
  // pruneDailyKeepers's own call site is ALREADY gated behind `if
  // (priorDate !== today)` (git blame: unchanged since the original Task 3
  // commit, 0fbade43) — so there is no behavior to fix here. What WAS
  // missing is a test that could actually catch a regression: the pre-Task-5
  // "no prune" test below primed r2List with an EMPTY list by default, so
  // `result.pruned === 0` held whether pruneDailyKeepers was gated OR simply
  // ran and found nothing to delete — those two outcomes were
  // indistinguishable. `listCalls` (tracking r2List invocations directly, not
  // just their return values) closes that gap: a test can now assert r2List
  // itself is never called on a non-daily tick, even when primed with keys
  // that WOULD produce a real deletion if prune ran.
  const listCalls: string[] = [];
  let partReadCount = 0;
  let checkCount = 0;
  return {
    execCalls,
    puts,
    deletedKeys,
    listCalls,
    exec: async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd.startsWith("mkdir -p")) {
        // Review round 3 (#202): the real command prints TWO lines — the tar's
        // size, then the burn watermark (the excludes file's mtime, i.e. the
        // epoch this tar started at). Every fake here answers both, so none of
        // them is a command shape production could never produce.
        return {
          code: opts.statCode ?? 0,
          stdout: `${opts.statSize ?? "0"}\n${opts.statWatermark ?? String(TAR_STARTED_AT)}`,
          stderr: opts.statStderr ?? "",
        };
      }
      if (cmd.startsWith("rm -f")) {
        return { code: opts.splitCode ?? 0, stdout: "", stderr: "" };
      }
      if (cmd.includes(".part-")) {
        const idx = partReadCount++;
        return { code: opts.partCodes?.[idx] ?? 0, stdout: opts.partReads?.[idx] ?? "", stderr: "" };
      }
      // recycleWithSync's post-provision container check (provision.ts's
      // provisionedCheckCmd), dispatched by shape like every other command
      // above. Answers are consumed IN ORDER so a test can spell out a
      // recycle's real arc — "first check says bare, the retry's check says
      // provisioned" — rather than one fixed verdict for the whole run.
      //
      // The verdict rides STDOUT, never an exit code, because the command
      // itself must never call `exit`: it runs inside the long-lived
      // "sandbox-default" session, and an `exit` there kills the session
      // shell instead of the command (see provision.ts's PROVISIONED_OK).
      // `null` in `checks` means "this exec THROWS" — the shape that
      // deterministic bug actually took in production.
      // Default (no `checks` opt) is the OK sentinel, which keeps every
      // pre-existing recycle test reading as the success it was written to
      // be.
      if (cmd.includes("pane_current_command")) {
        const idx = checkCount++;
        if (opts.checks && idx < opts.checks.length && opts.checks[idx] === null) {
          throw new Error("Session 'sandbox-default' shell exited (exit code: 0)");
        }
        const verdict = opts.checks?.[idx];
        return { code: verdict?.code ?? 0, stdout: verdict === undefined ? PROVISIONED_OK : (verdict?.stdout ?? ""), stderr: "" };
      }
      // Task 3: rescuePushCmd — dispatched by its own distinctive substring,
      // same shape-based routing as every branch above. `git status
      // --porcelain` appears nowhere else any builder in this feature emits.
      if (cmd.includes("status --porcelain")) {
        if (opts.rescue === null) throw new Error("Session 'sandbox-default' shell exited (exit code: 0)");
        return { code: opts.rescue?.code ?? 0, stdout: opts.rescue?.stdout ?? RESCUE_CLEAN, stderr: opts.rescue?.stderr ?? "" };
      }
      // Task 4: harvestRecordCmd — dispatched by its own distinctive
      // substring, same shape-based routing as rescue-push's branch above.
      // "done.json" appears nowhere else any builder in this feature emits.
      if (cmd.includes(HARVEST_NO_RECORD)) {
        if (opts.harvest === null) throw new Error("Session 'sandbox-default' shell exited (exit code: 0)");
        return { code: opts.harvest?.code ?? 0, stdout: opts.harvest?.stdout ?? HARVEST_NO_RECORD, stderr: opts.harvest?.stderr ?? "" };
      }
      return { code: opts.singleCode ?? 0, stdout: opts.singleRead ?? "", stderr: "" };
    },
    r2Put: async (key: string, bytes: Uint8Array) => {
      if (opts.r2PutThrows) throw new Error("r2 put failed: bucket unavailable");
      puts.push({ key, bytes });
    },
    r2List: async (prefix: string) => {
      listCalls.push(prefix);
      return opts.r2List ?? [];
    },
    r2Delete: async (keys: string[]) => {
      deletedKeys.push(keys);
    },
    now: fixedNow(opts.now ?? `${TODAY}T12:00:00.000Z`),
    // Task 4 (P2 plane 4): this file's own fixtures are plain byte arrays,
    // not real gzip'd tars — syncSessionTick's burn-parsing step (its own
    // internal try/catch, see that file's header) simply fails to gunzip
    // them and logs, exactly like any other genuinely corrupt tar would;
    // none of THIS file's assertions are about burn, so a no-op notify and
    // an always-off threshold keep every existing test's behavior
    // unchanged. See test/studio.burn.test.ts for burn's own coverage,
    // including through a real gzip'd tar.
    notify: async () => {},
    burnAlertThresholdTokens: 0,
  };
}

/** Task 4: recycleWithSync's own GitHub-commit adapter. Most tests don't
 *  care — fakeSyncDeps' own default HARVEST_NO_RECORD response means
 *  harvestLearnings never calls it — so they all pass this shared no-op.
 *  Tests actually ABOUT harvesting build fakeCommit() below instead, to
 *  assert what got written. */
const noopCommit: CommitLearningFile = async () => {};

/** Fix round 1: resolveMemoryRepo's own shared no-op fake, same reason
 *  noopCommit exists — harvestLearnings only ever calls this when there is
 *  something to commit, which most tests here never reach. Resolves to an
 *  obviously-fake value so a test that DOES reach it, but forgot to fake
 *  this deliberately, fails loudly rather than silently matching a repo
 *  string that happens to look real. */
const noopResolveMemoryRepo: ResolveMemoryRepo = async () => "unused/blueprint-repo";

/** Tracks every commitFile call a test cares to inspect: repo, path,
 *  content and message, in call order — same "push into an array, assert
 *  on the array" shape execCalls above already uses for exec. */
function fakeCommit(): {
  commit: CommitLearningFile;
  calls: { repo: string; path: string; content: string; message: string }[];
} {
  const calls: { repo: string; path: string; content: string; message: string }[] = [];
  return {
    calls,
    commit: async (repo, path, content, message) => {
      calls.push({ repo, path, content, message });
    },
  };
}

/** Fix round 1: tracks every resolveMemoryRepo call and resolves each to
 *  a fixed, distinctive repo slug — distinguishable at a glance from
 *  env.AGENT_REPO or a studio's own WORK repo (cfg.repo), so a test can
 *  pin that harvest's commits land in THIS resolved repo and not either of
 *  those. `calls` is a getter over a closed-over counter, same
 *  live-tracking shape fakeCommit's own `calls` array already gives. */
function fakeResolveMemoryRepo(repo = "acme-org/fleetflare-agency"): { resolve: ResolveMemoryRepo; calls: number } {
  let calls = 0;
  return {
    resolve: async () => {
      calls++;
      return repo;
    },
    get calls() {
      return calls;
    },
  };
}

// ---------------------------------------------------------------------------
// Shell command shapes
// ---------------------------------------------------------------------------

describe("tarAndStatCmd / singleReadCmd / splitCmd / partReadCmd — exact shell shapes", () => {
  it("tarAndStatCmd selects subagent transcripts newest-first under SESSION_SUBAGENT_RAW_BUDGET, admits everything past the burn watermark, then chains tar -> gzip -t -> stat -> watermark with && (C1 fix)", () => {
    expect(tarAndStatCmd()).toBe(
      `mkdir -p ${SESSION_SYNC_DIR} && ` +
      // Issue #37: aside dirs pruned from the budget, excluded from the tar.
      `( cd /root && find .claude/projects -path '.claude/projects/fleet-aside-*' -prune -o -path '*/subagents/*' ` +
        `\\( -type l -printf '-1\\t0\\t%p\\n' ` +
        `-o -name '*.jsonl' -type f -printf '%T@\\t%s\\t%p\\n' \\) ) ` +
      `| LC_ALL=C sort -rn ` +
      `| awk -F'\\t' -v b=${SESSION_SUBAGENT_RAW_BUDGET} -v w=${SESSION_SUBAGENT_LIVE_WINDOW_SECONDS} ` +
        `-v d=${SESSION_SUBAGENT_WATERMARK_LOOKBACK_SECONDS} -v k=0 -v n="$(date +%s)" ` +
        `'BEGIN { n = k > 0 ? (k > n - d ? k : n - d) : n - w } ` +
        `{ t += $2 } $1 < 0 { print $3 } $1 >= 0 && NR > 1 && t > b && $1 < n { print $3 }' ` +
      `> ${SESSION_EXCLUDES_PATH} && ` +
      `tar -C /root --exclude='.claude/projects/fleet-aside-*' --anchored --no-wildcards -X ${SESSION_EXCLUDES_PATH} -czf ${SESSION_TAR_PATH} .claude/projects .claude.json && ` +
      `gzip -t ${SESSION_TAR_PATH} && ` +
      `stat -c %s ${SESSION_TAR_PATH} && ` +
      `stat -c %Y ${SESSION_EXCLUDES_PATH}`,
    );
    // No `;`, no `2>/dev/null` on the tar half, no `|| echo` fallback on stat
    // — every one of those was what made the OLD command's exec code always
    // 0 regardless of tar's own outcome (the exact C1 bug). The awk program
    // is written as a BEGIN block plus three pattern-action blocks precisely
    // so it needs none.
    expect(tarAndStatCmd()).not.toContain(";");
    expect(tarAndStatCmd()).not.toContain("2>/dev/null");
    expect(tarAndStatCmd()).not.toContain("|| echo");
  });

  it("issue #202: the exclude list holds ONLY subagent jsonl, lands outside the tarred tree, and `cd` is confined to a subshell", () => {
    const cmd = tarAndStatCmd();
    // The selection is scoped to `subagents/` jsonl — a root/worktree-keyed
    // transcript can never be a candidate for exclusion, which is what keeps
    // the `claude --continue` restore contract (#116/#120/#146) intact.
    // Review round 3 moved the `-path` test outside the parens so it gates the
    // symlink branch too; it still gates the jsonl candidate branch, which is
    // what this assertion is about.
    expect(cmd).toContain("-prune -o -path '*/subagents/*' \\(");
    expect(cmd).toContain("-o -name '*.jsonl' -type f -printf");
    expect(cmd).not.toMatch(/find \.claude\/projects \\\(/); // never unscoped
    // Written under SESSION_SYNC_DIR (/workspace), never under /root — so the
    // list itself is never a member of the very tar it shapes.
    expect(SESSION_EXCLUDES_PATH.startsWith(`${SESSION_SYNC_DIR}/`)).toBe(true);
    expect(SESSION_EXCLUDES_PATH.startsWith("/root")).toBe(false);
    // sbExec runs commands in ONE long-lived shell: a bare `cd /root` would
    // leak into every later command. It is confined to a subshell.
    expect(cmd).toContain("( cd /root && find ");
    expect(cmd).not.toMatch(/(^|&& )cd \/root/);
    // Literal, anchored exclusion: a pattern character in a transcript name
    // must never glob a different member out of the archive.
    expect(cmd).toContain("--anchored --no-wildcards -X ");
  });

  it("issue #202 review round 3: the admission cutoff is the burn WATERMARK, not the wall clock — `n = max(W, now - 24h)`, and `now - 600` only when there is no W yet", () => {
    // `n` arrives as this tick's wall clock (`date +%s`, never mawk-hostile
    // `systime()`) and BEGIN turns it into the admission CUTOFF before a
    // single record is read. Everything at or after the cutoff is admitted
    // whatever the budget says.
    const cmd = tarAndStatCmd();
    expect(cmd).toContain(`-v n="$(date +%s)"`);
    expect(cmd).toContain("BEGIN { n = k > 0 ? (k > n - d ? k : n - d) : n - w }");
    expect(cmd).toContain("$1 < n { print $3 }");
    // Wall-clock liveness is now only the FIRST-TICK fallback: a DO with no
    // stored watermark passes k=0 and gets `now - 600` exactly as before.
    expect(cmd).toContain("-v k=0 ");
    expect(cmd).toContain(`-v w=${SESSION_SUBAGENT_LIVE_WINDOW_SECONDS} `);
    expect(SESSION_SUBAGENT_LIVE_WINDOW_SECONDS).toBeGreaterThanOrEqual(600);
    // ... and the 24h lookback caps how far back a watermark can hold the
    // tree, so a long outage sheds old files instead of blowing the budget.
    // The literal, not the import — ties this to the real emitted command.
    expect(cmd).toContain("-v d=86400 ");
    // `NR > 1` — the newest subagent transcript is never excluded, so a single
    // transcript larger than the whole budget still ships.
    expect(cmd).toContain("NR > 1 && t > b");
    // Exact-sum guard: `t > b`, never `t >= b`.
    expect(cmd).not.toContain("t >= b");
  });

  it("issue #202 review round 3: the command prints the watermark beside the size — the excludes file's mtime, i.e. the epoch this tar STARTED at", () => {
    const cmd = tarAndStatCmd();
    // The excludes list is the last thing written before `tar` runs, so its
    // mtime is the start of THIS tar: any subagent touched at or after it
    // cannot have reached this snapshot in full.
    expect(cmd).toContain(`stat -c %s ${SESSION_TAR_PATH} && stat -c %Y ${SESSION_EXCLUDES_PATH}`);
    // Chained with `&&` like every other step — a stat that fails takes the
    // whole exec down rather than printing a watermark the tar never earned.
    expect(cmd).not.toContain(`; stat -c %Y`);
  });

  it("issue #202 review round 3: a stored watermark rides into the awk program as `k`", () => {
    expect(tarAndStatCmd(undefined, undefined, undefined, undefined, 1_758_067_200)).toContain("-v k=1758067200 ");
  });

  it("issue #202 fix round: every symlink under `subagents/` is excluded, so an excluded target can never leave a dangling link", () => {
    const cmd = tarAndStatCmd();
    // Review round 3 item 2: the `-type l` rule is SCOPED to `subagents/` —
    // the only real symlink in the fleet (`websites--web-studio`) is a
    // subagent one, and the sentinel mtime `-1` sorts it last and routes it to
    // its own unconditional print.
    expect(cmd).toContain("-prune -o -path '*/subagents/*' \\( -type l -printf '-1\\t0\\t%p\\n'");
    expect(cmd).toContain("$1 < 0 { print $3 }");
  });

  it("issue #202: a caller may override home/syncDir/budget/liveWindow/watermark (tests only — production passes the real constants plus the stored watermark)", () => {
    const cmd = tarAndStatCmd("/tmp/home", "/tmp/sync", 4_096, 900, 1_700_000_000);
    expect(cmd).toContain("( cd /tmp/home && find ");
    expect(cmd).toContain("tar -C /tmp/home ");
    expect(cmd).toContain("-v b=4096 ");
    expect(cmd).toContain("-v w=900 ");
    expect(cmd).toContain("-v k=1700000000 ");
    expect(cmd).toContain("> /tmp/sync/subagent-excludes.txt &&");
    expect(cmd).toContain("mkdir -p /tmp/sync &&");
    expect(cmd).toContain("-czf /tmp/sync/latest.tar.gz ");
    expect(cmd).toContain("stat -c %Y /tmp/sync/subagent-excludes.txt");
  });

  it("singleReadCmd is a plain whole-file base64 read", () => {
    expect(singleReadCmd()).toBe(`base64 ${SESSION_TAR_PATH}`);
  });

  it("splitCmd clears stale parts before splitting at SESSION_SPLIT_PART with numeric 4-digit suffixes", () => {
    expect(splitCmd()).toBe(
      `rm -f ${SESSION_TAR_PATH}.part-* && split -b ${SESSION_SPLIT_PART} -d -a 4 ${SESSION_TAR_PATH} ${SESSION_TAR_PATH}.part-`,
    );
  });

  it("partReadCmd zero-pads the part index to 4 digits", () => {
    expect(partReadCmd(0)).toBe(`base64 ${SESSION_TAR_PATH}.part-0000`);
    expect(partReadCmd(9)).toBe(`base64 ${SESSION_TAR_PATH}.part-0009`);
  });

  it("sessionDailyPrefix matches the prefix sessionLatestKey/sessionDailyKey share", () => {
    expect(sessionDailyPrefix(STUDIO_ID)).toBe(`sessions/${STUDIO_ID}/`);
    expect(sessionLatestKey(STUDIO_ID).startsWith(sessionDailyPrefix(STUDIO_ID))).toBe(true);
    expect(sessionDailyKey(STUDIO_ID, TODAY).startsWith(sessionDailyPrefix(STUDIO_ID))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// syncSessionTick — tar/gzip/stat integrity chain (C1 fix)
// ---------------------------------------------------------------------------

describe("syncSessionTick — tar/gzip/stat failure is now reachable and never silently ships (C1 fix)", () => {
  it("C1 reachable-failure: a non-zero exec code throws, embedding the REAL tar/gzip/stat stderr — previously unreachable via the actual shell command (the old `;`-chained, `2>/dev/null`-suppressed command could never produce a non-zero overall exit code no matter what tar did), and the stderr used to be discarded even if it somehow had been", async () => {
    const realTarError = "tar: .claude.json: Cannot stat: No such file or directory\ntar: Exiting with failure status due to previous errors";
    const deps = fakeSyncDeps({ statCode: 2, statSize: "", statStderr: realTarError });
    const storage = fakeSessionStorage();

    let thrown: unknown;
    try {
      await syncSessionTick(deps, storage, STUDIO_ID);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("session tar/stat failed (2)");
    expect(message).toContain("Cannot stat: No such file or directory"); // the real stderr, no longer discarded

    // Nothing ships and nothing is marked — same failure-isolation contract
    // as every other throw path in this function.
    expect(deps.puts).toHaveLength(0);
    expect(storage.putKeys).toHaveLength(0);
    expect(deps.execCalls.every((c) => c.startsWith("mkdir -p"))).toBe(true); // never reached the read step
  });

  it("gzip -t failing (archive present but corrupt) is indistinguishable from a tar failure at this layer — both surface as the same non-zero exec code and throw the same way", async () => {
    const deps = fakeSyncDeps({ statCode: 1, statStderr: "gzip: /workspace/.session-sync/latest.tar.gz: not in gzip format" });
    await expect(syncSessionTick(deps, fakeSessionStorage(), STUDIO_ID)).rejects.toThrow("not in gzip format");
  });

  it("defensive belt: a code-0 result whose stdout is somehow not a valid non-negative integer still THROWS (never a silent skip) — unreachable via the real &&-chained command (code 0 there guarantees stat printed a real size), kept only so a genuine surprise never gets treated as a quiet success", async () => {
    const deps = fakeSyncDeps({ statCode: 0, statSize: "not-a-number" });
    await expect(syncSessionTick(deps, fakeSessionStorage(), STUDIO_ID)).rejects.toThrow("unparseable size");
  });
});

// ---------------------------------------------------------------------------
// syncSessionTick — single vs split path selection by size
// ---------------------------------------------------------------------------

describe("syncSessionTick — single vs split path selection by size", () => {
  it("small size under the boundary reads via a single base64 exec", async () => {
    const bytes = [1, 2, 3, 4, 5];
    const deps = fakeSyncDeps({ statSize: String(bytes.length), singleRead: b64(bytes) });
    const result = await syncSessionTick(deps, fakeSessionStorage(), STUDIO_ID);
    expect(result.split).toBe(false);
    expect(result.parts).toBe(1);
    expect(deps.execCalls).toContain(singleReadCmd());
    expect(deps.execCalls.some((c) => c.startsWith("rm -f"))).toBe(false);
  });

  // I1 fix: syncSessionTick now re-verifies decoded byte count against the
  // declared stat size, so a boundary test anchored to the real constant
  // needs genuinely matching content — see b64Large's own doc comment.
  it("size AT the exact SESSION_SINGLE_READ_MAX boundary still reads via a single base64 exec (inclusive <=)", async () => {
    const deps = fakeSyncDeps({ statSize: String(SESSION_SINGLE_READ_MAX), singleRead: b64Large(SESSION_SINGLE_READ_MAX) });
    const result = await syncSessionTick(deps, fakeSessionStorage(), STUDIO_ID);
    expect(result.split).toBe(false);
    expect(result.parts).toBe(1);
    expect(result.bytes).toBe(SESSION_SINGLE_READ_MAX);
    expect(deps.execCalls).toContain(singleReadCmd());
  });

  it("size ONE BYTE over SESSION_SINGLE_READ_MAX switches to the split path (2 parts)", async () => {
    const deps = fakeSyncDeps({
      statSize: String(SESSION_SINGLE_READ_MAX + 1),
      partReads: [b64Large(SESSION_SINGLE_READ_MAX), b64Large(1)],
    });
    const result = await syncSessionTick(deps, fakeSessionStorage(), STUDIO_ID);
    expect(result.split).toBe(true);
    expect(result.parts).toBe(2);
    expect(result.bytes).toBe(SESSION_SINGLE_READ_MAX + 1);
    expect(deps.execCalls).toContain(splitCmd());
    expect(deps.execCalls).toContain(partReadCmd(0));
    expect(deps.execCalls).toContain(partReadCmd(1));
    expect(deps.execCalls).not.toContain(singleReadCmd());
  });

  it("split path concatenates part bytes in order", async () => {
    const part0Len = SESSION_SINGLE_READ_MAX;
    const part1Len = 500;
    const size = part0Len + part1Len; // ceil(size / SESSION_SINGLE_READ_MAX) === 2
    const deps = fakeSyncDeps({
      statSize: String(size),
      partReads: [b64Large(part0Len, 0xaa), b64Large(part1Len, 0xbb)],
    });
    const result = await syncSessionTick(deps, fakeSessionStorage(), STUDIO_ID);
    expect(result.bytes).toBe(size);
    const shipped = deps.puts[0].bytes;
    // Spot-check the join point rather than a full multi-MiB toEqual — proves
    // ordering (part0 THEN part1) without comparing every one of ~4M bytes.
    expect(shipped[0]).toBe(0xaa);
    expect(shipped[part0Len - 1]).toBe(0xaa);
    expect(shipped[part0Len]).toBe(0xbb);
    expect(shipped[shipped.length - 1]).toBe(0xbb);
  });
});

// ---------------------------------------------------------------------------
// syncSessionTick — the burn watermark (issue #202, review round 3)
//
// W is the container epoch at the START of the tar whose burn was last
// PARSED. It is what the next tick's awk program admits from, so the one
// invariant that matters is: a tick that did not parse a burn must never move
// it. Every "does not advance" case below is a POSITIVE assertion on the
// storage key, not an absence of a side effect somewhere else.
// ---------------------------------------------------------------------------

describe("syncSessionTick — the burn watermark advances only when burn actually parsed", () => {
  it("the stored watermark rides into this tick's tar command as awk's `k`", async () => {
    const bytes = [1, 2, 3];
    const deps = fakeSyncDeps({ statSize: String(bytes.length), singleRead: b64(bytes) });
    const storage = fakeSessionStorage();
    await storage.put(SESSION_BURN_WATERMARK_KEY, 1_700_000_042);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await syncSessionTick(deps, storage, STUDIO_ID);
    } finally {
      errSpy.mockRestore();
    }
    expect(deps.execCalls[0]).toContain("-v k=1700000042 ");
  });

  it("a DO that has never stored one asks for the first-tick rule instead (k=0 -> `now - 600`)", async () => {
    const bytes = [1, 2, 3];
    const deps = fakeSyncDeps({ statSize: String(bytes.length), singleRead: b64(bytes) });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await syncSessionTick(deps, fakeSessionStorage(), STUDIO_ID);
    } finally {
      errSpy.mockRestore();
    }
    expect(deps.execCalls[0]).toContain("-v k=0 ");
  });

  it("a tick whose burn parse FAILED never advances it — the tail that tar missed stays admissible next tick", async () => {
    // Every fixture in this file is a plain byte array, not a real gzip'd tar,
    // so burn parsing throws inside its own catch: the sync succeeds, the
    // watermark must not move. (test/studio.burn.test.ts holds the mirror
    // case, over a REAL gzip'd tar, where it does.)
    const bytes = [1, 2, 3];
    const deps = fakeSyncDeps({ statSize: String(bytes.length), singleRead: b64(bytes) });
    const storage = fakeSessionStorage();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await syncSessionTick(deps, storage, STUDIO_ID);
      expect(result.bytes).toBe(3); // the sync itself still succeeded
      expect(errSpy).toHaveBeenCalled(); // burn parsing's own failure was logged
    } finally {
      errSpy.mockRestore();
    }
    expect(storage.putKeys).not.toContain(SESSION_BURN_WATERMARK_KEY);
    expect(await storage.get(SESSION_BURN_WATERMARK_KEY)).toBeUndefined();
  });

  it("an OVERSIZE tick never advances it — it never read, let alone parsed, a single byte", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = fakeSessionStorage();
    await storage.put(SESSION_BURN_WATERMARK_KEY, 1_700_000_042);
    try {
      const deps = fakeSyncDeps({ statSize: String(SESSION_TOTAL_MAX + 1) });
      expect((await syncSessionTick(deps, storage, STUDIO_ID)).skipped).toBe("oversize");
    } finally {
      warnSpy.mockRestore();
    }
    expect(await storage.get(SESSION_BURN_WATERMARK_KEY)).toBe(1_700_000_042);
  });

  it("a FAILED tar/stat tick never advances it", async () => {
    const storage = fakeSessionStorage();
    await storage.put(SESSION_BURN_WATERMARK_KEY, 1_700_000_042);
    const deps = fakeSyncDeps({ statCode: 2, statSize: "", statStderr: "tar: short write" });
    await expect(syncSessionTick(deps, storage, STUDIO_ID)).rejects.toThrow("session tar/stat failed");
    expect(await storage.get(SESSION_BURN_WATERMARK_KEY)).toBe(1_700_000_042);
  });

  it("a command that printed no watermark throws rather than shipping a tick that silently lost it", async () => {
    const deps = fakeSyncDeps({ statSize: "3", statWatermark: "" });
    await expect(syncSessionTick(deps, fakeSessionStorage(), STUDIO_ID))
      .rejects.toThrow("unparseable tar-start watermark");
  });
});

// ---------------------------------------------------------------------------
// syncSessionTick — oversize skip
// ---------------------------------------------------------------------------

describe("syncSessionTick — oversize skip", () => {
  it("size over SESSION_TOTAL_MAX is REFUSED LOUDLY — no split/read exec, no R2 put, an error log and the row's sessionGuard (#176)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const deps = fakeSyncDeps({ statSize: String(SESSION_TOTAL_MAX + 1) });
      const storage = fakeSessionStorage();
      const result = await syncSessionTick(deps, storage, STUDIO_ID);
      expect(result).toEqual({ bytes: 0, split: false, parts: 0, dailyWritten: false, pruned: 0, skipped: "oversize" });
      expect(deps.execCalls).toHaveLength(1); // only the tar+stat exec
      expect(deps.puts).toHaveLength(0);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls[0][0]).toContain(STUDIO_ID);
      expect(errSpy.mock.calls[0][0]).toContain(String(SESSION_TOTAL_MAX + 1));
      // Mirrored onto the row (StudioStatus.sessionGuard) by do.ts, like any refusal.
      const guard = await storage.get(SESSION_GUARD_KEY);
      expect(guard?.reason).toContain("oversize");
      expect(guard?.reason).toContain(String(SESSION_TOTAL_MAX + 1));
      expect(guard).toMatchObject({ tarBytes: SESSION_TOTAL_MAX + 1, capBytes: SESSION_TOTAL_MAX });
    } finally {
      errSpy.mockRestore();
    }
  });

  it("an armed clear-session-guard override (#192) survives oversize ticks — still refused, still armed, and SAID", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const storage = fakeSessionStorage();
      await storage.put(SESSION_FORCE_KEY, true);
      const result = await syncSessionTick(fakeSyncDeps({ statSize: String(SESSION_TOTAL_MAX + 1) }), storage, STUDIO_ID);
      expect(result.skipped).toBe("oversize");
      expect(await storage.get(SESSION_FORCE_KEY)).toBe(true);
      expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("override still armed");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("clear-session-guard does not reset an oversize streak's start — the row keeps 'NOT SYNCED since <first>'", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const storage = fakeSessionStorage();
      await syncSessionTick(fakeSyncDeps({ statSize: String(SESSION_TOTAL_MAX + 1), now: "2026-09-24T10:00:00.000Z" }), storage, STUDIO_ID);
      await clearSessionGuard(storage as unknown as Parameters<typeof clearSessionGuard>[0], async () => {});
      expect(await storage.get(SESSION_FORCE_KEY)).toBe(true);
      expect((await storage.get(SESSION_GUARD_KEY))?.at).toBe("2026-09-24T10:00:00.000Z");
      await syncSessionTick(fakeSyncDeps({ statSize: String(SESSION_TOTAL_MAX + 1), now: "2026-09-24T11:00:00.000Z" }), storage, STUDIO_ID);
      expect((await storage.get(SESSION_GUARD_KEY))?.at).toBe("2026-09-24T10:00:00.000Z");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("an oversize STREAK keeps the first refusal's time — the row says since when it stopped syncing (#176 review)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const storage = fakeSessionStorage();
      await syncSessionTick(fakeSyncDeps({ statSize: String(SESSION_TOTAL_MAX + 1), now: "2026-09-24T10:00:00.000Z" }), storage, STUDIO_ID);
      await syncSessionTick(fakeSyncDeps({ statSize: String(SESSION_TOTAL_MAX + 9), now: "2026-09-24T10:05:00.000Z" }), storage, STUDIO_ID);
      const guard = await storage.get(SESSION_GUARD_KEY);
      expect(guard?.at).toBe("2026-09-24T10:00:00.000Z");
      expect(guard).toMatchObject({ tarBytes: SESSION_TOTAL_MAX + 9 });
    } finally {
      errSpy.mockRestore();
    }
  });

  // Fleet Spawn P3, Task 6 (carried flake, root-caused in Task 2's fix
  // round): this one case builds a REAL SESSION_TOTAL_MAX-sized (64 MiB)
  // base64 fixture and walks every part through the tick, which takes
  // seconds of genuine CPU — comfortably under vitest's 5s default when the
  // file runs alone, but over it roughly one run in six when the full suite
  // is competing for the same cores. Nothing about the assertion is timing
  // dependent; only the fixture is expensive. A 30s budget (test-level, this
  // case only — every other test in this file keeps the default) is ~5x the
  // observed worst case, so it fails on a real regression and not on load.
  it("size exactly AT SESSION_TOTAL_MAX is still processed (boundary is strict >, not >=)", async () => {
    const size = SESSION_TOTAL_MAX;
    const numParts = Math.ceil(size / SESSION_SINGLE_READ_MAX);
    expect(size % SESSION_SINGLE_READ_MAX).toBe(0); // SESSION_TOTAL_MAX is an exact multiple — every part is full-size
    const deps = fakeSyncDeps({
      statSize: String(size),
      partReads: Array.from({ length: numParts }, () => b64Large(SESSION_SINGLE_READ_MAX)), // I1: must sum to `size`
    });
    const result = await syncSessionTick(deps, fakeSessionStorage(), STUDIO_ID);
    expect(result.skipped).toBeUndefined();
    expect(result.parts).toBe(numParts);
    expect(result.bytes).toBe(size);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// syncSessionTick — daily-once marker
// ---------------------------------------------------------------------------

describe("syncSessionTick — daily-once marker", () => {
  it("first tick ever (no prior marker) writes latest + the daily key + the marker", async () => {
    const bytes = [1, 2, 3, 4];
    const deps = fakeSyncDeps({ statSize: String(bytes.length), singleRead: b64(bytes), now: `${TODAY}T01:00:00.000Z` });
    const storage = fakeSessionStorage(); // no prior marker
    const result = await syncSessionTick(deps, storage, STUDIO_ID);

    expect(result.dailyWritten).toBe(true);
    expect(deps.puts.map((p) => p.key)).toEqual([sessionLatestKey(STUDIO_ID), sessionDailyKey(STUDIO_ID, TODAY)]);
    expect(await storage.get(SESSION_DAILY_DATE_KEY)).toBe(TODAY);
  });

  it("a second tick on the SAME UTC date writes latest only — no second daily put, no prune", async () => {
    const bytes = [9, 9, 9];
    const deps = fakeSyncDeps({ statSize: String(bytes.length), singleRead: b64(bytes), now: `${TODAY}T23:00:00.000Z` });
    const storage = fakeSessionStorage({ dailyDate: TODAY });
    const result = await syncSessionTick(deps, storage, STUDIO_ID);

    expect(result.dailyWritten).toBe(false);
    expect(deps.puts.map((p) => p.key)).toEqual([sessionLatestKey(STUDIO_ID)]);
    expect(result.pruned).toBe(0);
    expect(storage.putKeys).toHaveLength(0); // marker untouched — no rewrite needed
  });

  // Fleet Spawn P3, Task 5 (R-P3-5 backlog: "prune list/delete calls happen
  // ONLY on ticks that wrote a daily key"). Verified against the current
  // source: pruneDailyKeepers's call site is ALREADY gated behind `if
  // (priorDate !== today)` (unchanged since Task 3's original commit) — this
  // is a REGRESSION test, not a fix. The test above could not have caught a
  // violation of this gate: it seeds r2List with an empty list, so
  // `result.pruned === 0` would hold whether prune ran-and-found-nothing OR
  // was correctly skipped. This one primes r2List with enough daily keys to
  // produce a REAL deletion if pruneDailyKeepers ran, on a tick that is
  // deliberately NOT the daily-write tick — proving the gate holds by
  // asserting r2List/r2Delete are never even called, not just that their
  // return values happened to be empty.
  it("prune gate: a non-daily tick never calls r2List/r2Delete at all, even when the (unreached) prefix holds far more than SESSION_DAILY_KEEPERS", async () => {
    const dates = ["2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16"];
    const listedKeys = [sessionLatestKey(STUDIO_ID), ...dates.map((d) => sessionDailyKey(STUDIO_ID, d))];
    const bytes = [1];
    const deps = fakeSyncDeps({
      statSize: String(bytes.length), singleRead: b64(bytes), now: `${TODAY}T23:00:00.000Z`,
      r2List: listedKeys, // 9 daily keys — WOULD prune 2 if pruneDailyKeepers ran
    });
    const storage = fakeSessionStorage({ dailyDate: TODAY }); // same UTC date — NOT a daily-write tick
    const result = await syncSessionTick(deps, storage, STUDIO_ID);

    expect(result.dailyWritten).toBe(false);
    expect(result.pruned).toBe(0);
    expect(deps.listCalls).toHaveLength(0); // r2List itself never called — the gate, not a lucky empty result
    expect(deps.deletedKeys).toHaveLength(0);
  });

  it("prune gate: a daily-write tick DOES call r2List exactly once, at this studio's own daily prefix", async () => {
    const bytes = [1];
    const deps = fakeSyncDeps({
      statSize: String(bytes.length), singleRead: b64(bytes), now: "2026-08-17T00:05:00.000Z",
      r2List: [sessionLatestKey(STUDIO_ID)],
    });
    const storage = fakeSessionStorage({ dailyDate: TODAY }); // yesterday -> today: IS the daily-write tick
    const result = await syncSessionTick(deps, storage, STUDIO_ID);

    expect(result.dailyWritten).toBe(true);
    expect(deps.listCalls).toEqual([sessionDailyPrefix(STUDIO_ID)]);
  });

  it("a tick on a NEW UTC date writes a new daily key and updates the marker", async () => {
    const bytes = [7, 7];
    const deps = fakeSyncDeps({ statSize: String(bytes.length), singleRead: b64(bytes), now: "2026-08-17T00:05:00.000Z" });
    const storage = fakeSessionStorage({ dailyDate: TODAY });
    const result = await syncSessionTick(deps, storage, STUDIO_ID);

    expect(result.dailyWritten).toBe(true);
    expect(deps.puts.map((p) => p.key)).toContain(sessionDailyKey(STUDIO_ID, "2026-08-17"));
    expect(await storage.get(SESSION_DAILY_DATE_KEY)).toBe("2026-08-17");
  });
});

// ---------------------------------------------------------------------------
// syncSessionTick — prune keeps newest 7
// ---------------------------------------------------------------------------

describe("syncSessionTick — prune keeps newest SESSION_DAILY_KEEPERS", () => {
  it("deletes the oldest excess daily keys, keeping the newest 7", async () => {
    const dates = [
      "2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11",
      "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16",
    ];
    const listedKeys = [
      sessionLatestKey(STUDIO_ID), // must be filtered out — not a dated keeper
      ...dates.map((d) => sessionDailyKey(STUDIO_ID, d)),
    ];
    const bytes = [1];
    const deps = fakeSyncDeps({
      statSize: String(bytes.length), singleRead: b64(bytes), now: "2026-08-16T00:00:00.000Z",
      r2List: listedKeys,
    });
    const storage = fakeSessionStorage({ dailyDate: "2026-08-15" }); // yesterday -> today triggers a daily write
    const result = await syncSessionTick(deps, storage, STUDIO_ID);

    expect(result.pruned).toBe(2); // 9 daily keys total -> keep 7, delete the oldest 2
    expect(deps.deletedKeys).toHaveLength(1);
    expect(deps.deletedKeys[0]).toEqual([
      sessionDailyKey(STUDIO_ID, "2026-08-08"),
      sessionDailyKey(STUDIO_ID, "2026-08-09"),
    ]);
  });

  it("does not delete anything when at or under the keeper count", async () => {
    const listedKeys = ["2026-08-14", "2026-08-15", "2026-08-16"].map((d) => sessionDailyKey(STUDIO_ID, d));
    const bytes = [1];
    const deps = fakeSyncDeps({ statSize: String(bytes.length), singleRead: b64(bytes), r2List: listedKeys });
    const result = await syncSessionTick(deps, fakeSessionStorage(), STUDIO_ID);
    expect(result.pruned).toBe(0);
    expect(deps.deletedKeys).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// syncSessionTick — failure isolation
// ---------------------------------------------------------------------------

describe("syncSessionTick — failure isolation", () => {
  it("a throwing r2Put(latest) propagates and never reaches the daily branch — marker untouched", async () => {
    const bytes = [1, 2, 3];
    const deps = fakeSyncDeps({ statSize: String(bytes.length), singleRead: b64(bytes), r2PutThrows: true });
    const storage = fakeSessionStorage();
    await expect(syncSessionTick(deps, storage, STUDIO_ID)).rejects.toThrow("r2 put failed");
    expect(storage.putKeys).toHaveLength(0);
  });

  it("a non-zero tar/stat exit throws (C1 fix: reachable in reality now — see the dedicated describe block above for the stderr-preservation detail)", async () => {
    const deps = fakeSyncDeps({ statCode: 1, statStderr: "tar: short write" });
    await expect(syncSessionTick(deps, fakeSessionStorage(), STUDIO_ID)).rejects.toThrow("session tar/stat failed");
  });

  it("I1 fix: decoded byte count mismatched against the declared stat size throws — nothing ships, no daily/marker write attempted", async () => {
    const deps = fakeSyncDeps({ statSize: "100", singleRead: b64([1, 2, 3]) }); // stat says 100, only 3 bytes decode
    const storage = fakeSessionStorage();
    await expect(syncSessionTick(deps, storage, STUDIO_ID)).rejects.toThrow("session read length mismatch");
    expect(deps.puts).toHaveLength(0); // r2Put(latest) never reached
    expect(storage.putKeys).toHaveLength(0);
  });

  it("I1 fix: mismatch on the split path (a truncated LAST part) also throws before any R2 put", async () => {
    const size = SESSION_SINGLE_READ_MAX + 500;
    const deps = fakeSyncDeps({
      statSize: String(size),
      partReads: [b64Large(SESSION_SINGLE_READ_MAX), b64Large(400)], // 400, not the declared 500 -> short by 100
    });
    await expect(syncSessionTick(deps, fakeSessionStorage(), STUDIO_ID)).rejects.toThrow("session read length mismatch");
    expect(deps.puts).toHaveLength(0);
  });

  it("a non-zero single-read exit throws", async () => {
    const deps = fakeSyncDeps({ statSize: "10", singleCode: 1, singleRead: "denied" });
    await expect(syncSessionTick(deps, fakeSessionStorage(), STUDIO_ID)).rejects.toThrow("session read failed");
  });

  it("a non-zero split exit throws before any part read", async () => {
    const deps = fakeSyncDeps({ statSize: String(SESSION_SINGLE_READ_MAX + 1), splitCode: 1 });
    await expect(syncSessionTick(deps, fakeSessionStorage(), STUDIO_ID)).rejects.toThrow("session split failed");
    expect(deps.execCalls.some((c) => c.includes(".part-0000"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// syncSessionCycle (do.ts) — board issue #24. The real StudioDO.syncSession()
// used to share ONE try/catch across all three of syncSessionTick /
// mirrorBurnToRegistry / checkAndRecordReadiness — a throwing tick (the real,
// measured failure: a fresh container tar/stat-ing before claude has ever
// written ~/.claude/projects) meant the other two never even ran, so
// StudioStatus.readiness was never stamped and fleet ls's READY column stuck
// at "?" forever. syncSessionCycle is the extracted pure function (do.ts's
// own restartWithSync-established pattern: StudioDO cannot be constructed
// under vitest-pool-workers — see do.ts's own file-header comment — so the
// method's real logic lives in an exported pure function a real
// `this.ctx.storage` satisfies structurally) that gives each step its own
// try/catch instead.
// ---------------------------------------------------------------------------

/** Combined StudioStorage & SessionSyncStorage & InstallCacheSaveStorage
 *  fake for the three(-plus)-way isolation tests below — same in-memory
 *  Map/putKeys shape as fakeSessionStorage above (this file) and
 *  fakeBurnStorage (test/studio.burn.test.ts), widened with an optional
 *  `throwOnGet` key so ONE step's own storage read can be made to fail
 *  without touching the others — same "a single dependency throws"
 *  convention fakeSyncDeps' `checks: [null, ...]`/`rescue: null` already use
 *  elsewhere in this file. Board #350: widened again to satisfy
 *  InstallCacheSaveStorage's own INSTALL_CACHE_HASH_KEY get/put — the same
 *  generic Map-backed get/put below already answers it structurally, no new
 *  seed field needed unless a test wants to pre-arm it. */
function fakeCycleStorage(seed?: {
  status?: StudioStatus; burn?: Burn; throwOnGet?: string;
}): StudioStorage & SessionSyncStorage & InstallCacheSaveStorage & { putKeys: string[] } {
  const map = new Map<string, unknown>();
  if (seed?.status) map.set(STATUS_KEY, seed.status);
  if (seed?.burn) map.set(BURN_KEY, seed.burn);
  const putKeys: string[] = [];
  return {
    putKeys,
    get: (async (key: string) => {
      if (seed?.throwOnGet === key) throw new Error(`storage.get(${key}) failed`);
      return map.get(key);
    }) as StudioStorage["get"] & SessionSyncStorage["get"] & InstallCacheSaveStorage["get"],
    put: (async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
      const entries: Record<string, unknown> =
        typeof keyOrEntries === "string" ? { [keyOrEntries]: value } : keyOrEntries;
      for (const [key, v] of Object.entries(entries)) {
        putKeys.push(key);
        map.set(key, v);
      }
    }) as StudioStorage["put"] & SessionSyncStorage["put"] & InstallCacheSaveStorage["put"],
    // Issue #228 item 4: SessionSyncStorage.delete is now required — this
    // fake never arms/consumes SESSION_FORCE_KEY itself.
    delete: (async (key: string) => map.delete(key)) as NonNullable<SessionSyncStorage["delete"]>,
  };
}

function cycleStatus(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    ...overrides,
  };
}

describe("syncSessionCycle — three-step isolation (board issue #24)", () => {
  it("core regression: a syncSessionTick failure (real tar/stat rejection) does not block checkAndRecordReadiness — readiness still gets recorded", async () => {
    // fakeSyncDeps({ statCode: 1, ... }) makes the REAL syncSessionTick
    // genuinely reject with "session tar/stat failed" — the exact
    // real-world shape from the issue (`tar: .claude/projects: Cannot
    // stat`). Pre-fix (all three awaits under one try), this failure meant
    // checkAndRecordReadiness never ran at all.
    const deps = fakeSyncDeps({ statCode: 1, statStderr: "tar: .claude/projects: Cannot stat: No such file or directory" });
    const storage = fakeCycleStorage({ status: cycleStatus() });
    const recorded: StudioStatus[] = [];

    await syncSessionCycle(deps, storage, STUDIO_ID, async (s) => {
      recorded.push(s);
    });

    // The tick itself genuinely failed (proves this test isn't vacuous).
    expect(deps.execCalls.some((c) => c.startsWith("mkdir -p"))).toBe(true);

    // checkAndRecordReadiness's own effect still happened: a stamped
    // verdict landed on the recorded status AND on storage's STATUS_KEY.
    const readinessRecorded = recorded.some((s) => s.readiness?.kind === "provisioned");
    expect(readinessRecorded).toBe(true);
    expect((await storage.get(STATUS_KEY))?.readiness).toMatchObject({ kind: "provisioned" });
  });

  it("a syncSessionTick failure also does not block mirrorBurnToRegistry — the pre-existing burn still gets mirrored", async () => {
    const burn: Burn = {
      turns: 3, inputTokens: 300, outputTokens: 90, costUsd: 0,
      window5hStart: "2026-08-16T00:00:00.000Z", window5hOutput: 90,
    };
    const deps = fakeSyncDeps({ statCode: 1, statStderr: "tar: .claude/projects: Cannot stat: No such file or directory" });
    const storage = fakeCycleStorage({ status: cycleStatus(), burn });
    const recorded: StudioStatus[] = [];

    await syncSessionCycle(deps, storage, STUDIO_ID, async (s) => {
      recorded.push(s);
    });

    const burnRecorded = recorded.some((s) => s.burn?.turns === 3 && s.burn?.inputTokens === 300);
    expect(burnRecorded).toBe(true);
    expect((await storage.get(STATUS_KEY))?.burn).toEqual(burn);
  });

  it("nothing fails: all three steps run, in order, once each", async () => {
    const burn: Burn = {
      turns: 1, inputTokens: 10, outputTokens: 5, costUsd: 0,
      window5hStart: "2026-08-16T00:00:00.000Z", window5hOutput: 5,
    };
    const bytes = [1, 2, 3];
    const deps = fakeSyncDeps({ statSize: String(bytes.length), singleRead: b64(bytes) });
    const storage = fakeCycleStorage({ status: cycleStatus(), burn });
    const recorded: StudioStatus[] = [];

    await syncSessionCycle(deps, storage, STUDIO_ID, async (s) => {
      recorded.push(s);
    });

    // syncSessionTick actually ran (tar/stat + single read exec'd).
    expect(deps.execCalls.some((c) => c.startsWith("mkdir -p"))).toBe(true);

    // mirrorBurnToRegistry then checkAndRecordReadiness, each exactly once,
    // in that order: the FIRST recordStudioFn call carries burn but not yet
    // readiness (readiness hasn't run yet); the SECOND carries readiness
    // too, on top of the burn the first call already wrote to storage.
    expect(recorded).toHaveLength(2);
    expect(recorded[0].burn).toEqual(burn);
    expect(recorded[0].readiness).toBeUndefined();
    expect(recorded[1].burn).toEqual(burn);
    expect(recorded[1].readiness).toMatchObject({ kind: "provisioned" });
  });

  it("a mirrorBurnToRegistry failure (middle step) does not block checkAndRecordReadiness (third step) — full three-way isolation, not just first-step isolation", async () => {
    const burn: Burn = {
      turns: 1, inputTokens: 10, outputTokens: 5, costUsd: 0,
      window5hStart: "2026-08-16T00:00:00.000Z", window5hOutput: 5,
    };
    const bytes = [1, 2, 3];
    const deps = fakeSyncDeps({ statSize: String(bytes.length), singleRead: b64(bytes) });
    // storage.get(BURN_KEY) throws -- forces mirrorBurnToRegistry to reject
    // (checkAndRecordReadiness never reads BURN_KEY at all, so this isolates
    // the MIDDLE step specifically, not the first).
    const storage = fakeCycleStorage({ status: cycleStatus(), burn, throwOnGet: BURN_KEY });
    const recorded: StudioStatus[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await syncSessionCycle(deps, storage, STUDIO_ID, async (s) => {
        recorded.push(s);
      });

      // mirrorBurnToRegistry's own failure was logged, distinctly.
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("burn mirror failed"), expect.anything());

      // checkAndRecordReadiness (the third step) still ran and recorded.
      expect(recorded).toHaveLength(1);
      expect(recorded[0].readiness).toMatchObject({ kind: "provisioned" });
      expect((await storage.get(STATUS_KEY))?.readiness).toMatchObject({ kind: "provisioned" });
      // The burn mirror itself never landed -- proves the failure was real,
      // not silently absorbed into a still-successful write.
      expect((await storage.get(STATUS_KEY))?.burn).toBeNull();
    } finally {
      errSpy.mockRestore();
    }
  });

  // The reschedule (`this.schedule(SYNC_SESSION_SECONDS, "syncSession")`)
  // lives only in the real StudioDO.syncSession() method, not in
  // syncSessionCycle -- StudioDO itself cannot be constructed under
  // vitest-pool-workers (do.ts's own file-header comment), so it is not
  // independently observable from this file's boundary. It stays safe by
  // construction: the fix keeps the DO method's own try/finally around one
  // call to syncSessionCycle, unconditional and unchanged (same
  // SYNC_SESSION_SECONDS cadence, same "runs regardless of the call's
  // outcome" shape it always had) -- the extraction touches only the THREE
  // STEPS inside the old shared try, never the reschedule wrapping it.
});

// ---------------------------------------------------------------------------
// Board #350 round 2, item 5 — the install-cache save must never consume the
// tick's own deadline budget. RED against the pre-fix code: the save used to
// be awaited INLINE, near the top of syncSessionCycle, before
// checkAndRecordReadiness ever ran — so an install-cache sbExec that never
// resolves (a wedged curl, worse than merely slow) hung the whole tick
// forever and this test timed out. Fixed by moving the save to fire-and-forget
// (`void`, no `await`) and LAST in the function body.
// ---------------------------------------------------------------------------

describe("syncSessionCycle — install-cache save is detached (board #350 round 2, item 5)", () => {
  it("readiness still gets recorded even while the install-cache save is permanently stuck", async () => {
    const stuckForever = new Promise<never>(() => {}); // deliberately never resolves
    const installCacheDeps: import("../src/studio/install-cache").InstallCacheSaveDeps = {
      sbExec: async (cmd: string) => {
        if (cmd.includes("sha256sum")) return { code: 0, stdout: "f".repeat(64), stderr: "" };
        await stuckForever;
        return { code: 0, stdout: "saved:1", stderr: "" }; // never reached
      },
      presignPut: async () => "https://signed.example/put",
      r2Head: async () => false,
      r2List: async () => [],
      r2Delete: async () => {},
      installCacheRepos: "example-org/websites",
      now: () => new Date("2026-09-25T00:00:00.000Z"),
    };
    const deps = fakeSyncDeps({});
    const storage = fakeCycleStorage({ status: cycleStatus({ repoSlug: "example-org/websites" }) });
    const recorded: StudioStatus[] = [];

    // Pre-fix, this await never resolves (the stuck sbExec blocks the whole
    // tick) and the test times out. Post-fix, syncSessionCycle resolves
    // immediately regardless of the save's own fate.
    await syncSessionCycle(
      deps, storage, STUDIO_ID, async (s) => { recorded.push(s); },
      null, null, null, null, installCacheDeps,
    );

    const readinessRecorded = recorded.some((s) => s.readiness?.kind === "provisioned");
    expect(readinessRecorded).toBe(true);
    expect((await storage.get(STATUS_KEY))?.readiness).toMatchObject({ kind: "provisioned" });
  });
});

// ---------------------------------------------------------------------------
// Round 3 review, item 3 — in-flight guard for the detached install-cache
// save. Two layers: an in-memory flag (per DO instance, `installCacheGuard`
// here — a plain caller-supplied `{ inFlight: boolean }`) and a storage-
// persisted lease (`INSTALL_CACHE_SAVE_LEASE_KEY`, install-cache.ts). Board
// #350 round 3 measured 5 overlapping ticks producing 3 full saves of the
// SAME dir/hash before this fix.
// ---------------------------------------------------------------------------

describe("syncSessionCycle — install-cache save in-flight guard (board #350 round 3, item 3)", () => {
  it("an in-memory guard already marked in-flight skips the detached save ENTIRELY — no sbExec call at all", async () => {
    let sbExecCalls = 0;
    const installCacheDeps: import("../src/studio/install-cache").InstallCacheSaveDeps = {
      sbExec: async () => { sbExecCalls += 1; return { code: 0, stdout: "no", stderr: "" }; },
      presignPut: async () => "https://signed.example/put",
      r2Head: async () => false,
      r2List: async () => [],
      r2Delete: async () => {},
      installCacheRepos: "example-org/websites",
      now: () => new Date("2026-09-25T00:00:00.000Z"),
    };
    const deps = fakeSyncDeps({});
    const storage = fakeCycleStorage({ status: cycleStatus({ repoSlug: "example-org/websites" }) });
    const guard = { inFlight: true }; // simulates a save from an earlier, still-running tick

    await syncSessionCycle(
      deps, storage, STUDIO_ID, async () => {},
      null, null, null, null, installCacheDeps, guard,
    );
    // The in-flight check is the FIRST synchronous statement of the detached
    // IIFE, before any await — no microtask flush needed to observe this.
    expect(sbExecCalls).toBe(0);
  });

  it("a FRESH storage-persisted lease blocks a save even with a brand-new (never-set) in-memory guard — the isolate-eviction case", async () => {
    let sbExecCalls = 0;
    const installCacheDeps: import("../src/studio/install-cache").InstallCacheSaveDeps = {
      sbExec: async () => { sbExecCalls += 1; return { code: 0, stdout: "no", stderr: "" }; },
      presignPut: async () => "https://signed.example/put",
      r2Head: async () => false,
      r2List: async () => [],
      r2Delete: async () => {},
      installCacheRepos: "example-org/websites",
      now: () => new Date("2026-09-25T00:05:00.000Z"), // 5 minutes after the lease below
    };
    const deps = fakeSyncDeps({});
    const storage = fakeCycleStorage({ status: cycleStatus({ repoSlug: "example-org/websites" }) });
    await storage.put(INSTALL_CACHE_SAVE_LEASE_KEY, "2026-09-25T00:00:00.000Z"); // a PRIOR isolate's still-fresh lease
    const guard = { inFlight: false }; // this isolate has no memory of the prior save at all

    await syncSessionCycle(
      deps, storage, STUDIO_ID, async () => {},
      null, null, null, null, installCacheDeps, guard,
    );
    // The check-and-return here crosses exactly one await (the lease read) —
    // flush a few microtask turns to let it settle, the same pattern this
    // file's own replacement tests already use for a shallow async chain.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(sbExecCalls).toBe(0);
  });

  it("no guard, no lease: the save proceeds, takes out its own lease, and clears it when done", async () => {
    const installCacheDeps: import("../src/studio/install-cache").InstallCacheSaveDeps = {
      sbExec: async (cmd: string) => {
        if (cmd.includes("find .")) return { code: 0, stdout: ".\n", stderr: "" };
        if (cmd.includes("-newermt")) return { code: 0, stdout: "no", stderr: "" };
        if (cmd.includes("sha256sum")) return { code: 0, stdout: "a".repeat(64), stderr: "" };
        return { code: 0, stdout: "saved:1", stderr: "" };
      },
      presignPut: async () => "https://signed.example/put",
      r2Head: async () => false,
      r2List: async () => [],
      r2Delete: async () => {},
      installCacheRepos: "example-org/websites",
      now: () => new Date("2026-09-25T00:00:00.000Z"),
    };
    const deps = fakeSyncDeps({});
    const baseStorage = fakeCycleStorage({ status: cycleStatus({ repoSlug: "example-org/websites" }) });
    const guard = { inFlight: false };

    // Hook the lease-CLEAR write specifically (the `finally` block's own
    // `storage.put(LEASE_KEY, "")`), rather than guessing how many microtask
    // turns the real save's own await chain (sbExec -> storage.put(hashKey)
    // -> r2List -> back up through runInstallCacheSaveTick -> the detached
    // IIFE's own finally) takes to fully drain.
    let resolveCleared!: () => void;
    const leaseCleared = new Promise<void>((r) => { resolveCleared = r; });
    const storage: typeof baseStorage = {
      ...baseStorage,
      put: (async (key: string, value: unknown) => {
        await baseStorage.put(key as never, value as never);
        if (key === INSTALL_CACHE_SAVE_LEASE_KEY && value === "") resolveCleared();
      }) as typeof baseStorage.put,
    };

    await syncSessionCycle(
      deps, storage, STUDIO_ID, async () => {},
      null, null, null, null, installCacheDeps, guard,
    );
    await leaseCleared;
    expect(await storage.get(INSTALL_CACHE_SAVE_LEASE_KEY)).toBe("");
    expect(guard.inFlight).toBe(false);
  });

  // Round 4 review, item 5(a) — the maestro's own named gap: this describe
  // block already covers (inFlight=true, lease irrelevant — the in-memory
  // check short-circuits before the lease is ever read) and (inFlight=false,
  // lease ABSENT — proceeds), but never (inFlight=false, lease PRESENT but
  // STALE) — the actual "prior isolate died, a fresh one takes over" case
  // installCacheSaveLeaseFresh's own pure-logic unit tests
  // (test/install-cache.test.ts) already pin in isolation, but this
  // describe's own INTEGRATION coverage (the real syncSessionCycle wiring)
  // never exercised. Distinct from "no lease at all": a real STALE lease
  // value must be read and correctly judged non-fresh, not merely absent.
  it("a STALE storage-persisted lease (present, but past INSTALL_CACHE_SAVE_LEASE_STALE_MS) does NOT block a save — the prior-isolate-died recovery case, distinct from no lease at all", async () => {
    const installCacheDeps: import("../src/studio/install-cache").InstallCacheSaveDeps = {
      sbExec: async (cmd: string) => {
        if (cmd.includes("find .")) return { code: 0, stdout: ".\n", stderr: "" };
        if (cmd.includes("-newermt")) return { code: 0, stdout: "no", stderr: "" };
        if (cmd.includes("sha256sum")) return { code: 0, stdout: "b".repeat(64), stderr: "" };
        return { code: 0, stdout: "saved:1", stderr: "" };
      },
      presignPut: async () => "https://signed.example/put",
      r2Head: async () => false,
      r2List: async () => [],
      r2Delete: async () => {},
      installCacheRepos: "example-org/websites",
      // Well past INSTALL_CACHE_SAVE_LEASE_STALE_MS (3h) after the seeded
      // lease below — a dead isolate's lease, not a live one.
      now: () => new Date("2026-09-25T04:00:00.000Z"),
    };
    const deps = fakeSyncDeps({});
    const baseStorage = fakeCycleStorage({ status: cycleStatus({ repoSlug: "example-org/websites" }) });
    await baseStorage.put(INSTALL_CACHE_SAVE_LEASE_KEY, "2026-09-25T00:00:00.000Z"); // stale by the time now() reads
    const guard = { inFlight: false }; // no in-memory memory of the prior save either

    let resolveSaved!: () => void;
    const hashPersisted = new Promise<void>((r) => { resolveSaved = r; });
    const storage: typeof baseStorage = {
      ...baseStorage,
      put: (async (key: string, value: unknown) => {
        await baseStorage.put(key as never, value as never);
        if (key.startsWith("installCacheHash:")) resolveSaved();
      }) as typeof baseStorage.put,
    };

    await syncSessionCycle(
      deps, storage, STUDIO_ID, async () => {},
      null, null, null, null, installCacheDeps, guard,
    );
    // A genuine save actually ran — proven by the hash marker being
    // persisted, not merely that no exception was thrown.
    await hashPersisted;
  });
});

// ---------------------------------------------------------------------------
// Review round 2 (#210), FINAL round, finding B (BLOCKER) — the failover
// step (board issue #53/#210) can call `deps.stopParkedStudio`, which
// destroys the container THIS SAME TICK (the row reads "stopped" the moment
// that step returns). But two LATER steps in this same function —
// `retrySurvivalBrief` and the detached `installCacheDeps` save — used to run
// UNCONDITIONALLY regardless of what the failover step just did, and both
// eventually exec into the container, which BOOTS it back up: billing starts
// again under a row that now reads "stopped". `isStoppedIn` (this file)
// already guards the START of a tick (`runScheduledTick`) for exactly this
// reason; it did not yet guard a destroy that happens MID-tick, which is
// this gap. Fixed: both steps now also require the studio to still be
// running right after the failover step returns.
// ---------------------------------------------------------------------------

describe("syncSessionCycle — an auto-stop mid-tick must gate retrySurvivalBrief and the install-cache save (#210 review round 2 final, finding B)", () => {
  const FAILOVER_NOW = new Date("2026-10-03T19:00:00.000Z");
  const ACCOUNT_NAME = "CLAUDE_CODE_OAUTH_TOKEN";
  const TOKEN = "sk-ant-oat01-" + "a".repeat(40);
  /** Two identical observations of the pane, as `paneCaptureCmd()`'s stdout
   *  carries them — same shape test/studio.account-failover.test.ts's own
   *  `captured` helper uses. */
  const captured = (pane: string) => `${pane}\n${PANE_CAPTURE_MARKER}\n${pane}\n`;

  /** A row already parked well past PARKED_AUTO_STOP_HOURS, with nowhere to
   *  go (a single configured account): this tick's own failover step hits
   *  the ask-3 auto-stop gate directly (the "already-degraded, same message"
   *  fast path) and calls `stopParkedStudio` — no prior tick needed. */
  function parkedPastAutoStop(): StudioStatus {
    const parkedAt = new Date(FAILOVER_NOW.getTime() - (PARKED_AUTO_STOP_HOURS * 60 * 60_000 + 60_000)).toISOString();
    return cycleStatus({
      state: "degraded",
      error: exhaustedMessage(STUDIO_ID, [ACCOUNT_NAME], null),
      parkedAt,
      exhaustionKind: "select",
      // Set so the install-cache save WOULD have a real repo to act on if it
      // wrongly ran — otherwise an `sbExecCalls === 0` assertion would pass
      // vacuously (no repo configured, never any call either way).
      repoSlug: "example-org/websites",
    });
  }

  /** `stopParkedStudio` wired the way the real `destroyStudio` behaves: it
   *  writes `state: "stopped"` onto THIS SAME storage before returning —
   *  the real "destroyed mid-tick" shape this finding is about. */
  function failoverDepsThatAutoStops(storage: StudioStorage): FailoverDeps {
    return {
      accounts: [{ name: ACCOUNT_NAME, token: TOKEN }] satisfies ClaudeAccount[],
      autoFailover: true,
      primaryIsMapped: false,
      now: () => FAILOVER_NOW,
      accountLimits: { read: async () => ({}), write: async () => {} },
      exec: vi.fn(async (cmd: string) => {
        if (cmd === paneCaptureCmd()) return { code: 0, stdout: captured(ORG_SPEND_LIMIT_PANE), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }),
      relaunch: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      notify: vi.fn(async () => {}),
      stopParkedStudio: vi.fn(async () => {
        const current = (await storage.get(STATUS_KEY)) as StudioStatus;
        const stopped = { ...current, state: "stopped" as const };
        await storage.put(STATUS_KEY, stopped);
        return { ok: true as const, status: stopped };
      }),
    };
  }

  it("the failover step auto-stops this tick; neither retrySurvivalBrief nor the install-cache save runs afterward", async () => {
    const storage = fakeCycleStorage({ status: parkedPastAutoStop() });
    const failoverDeps = failoverDepsThatAutoStops(storage);
    const syncDeps = fakeSyncDeps({});
    const retrySurvivalBrief = vi.fn(async () => {});
    let sbExecCalls = 0;
    const installCacheDeps: import("../src/studio/install-cache").InstallCacheSaveDeps = {
      sbExec: async () => { sbExecCalls += 1; return { code: 0, stdout: "no", stderr: "" }; },
      presignPut: async () => "https://signed.example/put",
      r2Head: async () => false,
      r2List: async () => [],
      r2Delete: async () => {},
      installCacheRepos: "example-org/websites",
      now: () => FAILOVER_NOW,
    };

    await syncSessionCycle(
      syncDeps, storage, STUDIO_ID, async () => {},
      failoverDeps, null, null, retrySurvivalBrief, installCacheDeps,
    );
    // Let the detached install-cache IIFE's own microtasks (if it wrongly
    // started) run before asserting on it.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // The load-bearing proof the fix actually happened: the row really did
    // auto-stop THIS tick (never a vacuous test).
    expect(failoverDeps.stopParkedStudio).toHaveBeenCalledTimes(1);
    expect((await storage.get(STATUS_KEY))?.state).toBe("stopped");

    // The two gated steps must never have fired on the now-stopped row.
    expect(retrySurvivalBrief).not.toHaveBeenCalled();
    expect(sbExecCalls).toBe(0);
  });

  it("a studio that does NOT auto-stop this tick still runs both steps as before", async () => {
    const storage = fakeCycleStorage({ status: cycleStatus({ state: "running", repoSlug: "example-org/websites" }) });
    const syncDeps = fakeSyncDeps({});
    const retrySurvivalBrief = vi.fn(async () => {});
    let sbExecCalls = 0;
    const installCacheDeps: import("../src/studio/install-cache").InstallCacheSaveDeps = {
      sbExec: async (cmd: string) => {
        sbExecCalls += 1;
        if (cmd.includes("find .")) return { code: 0, stdout: ".\n", stderr: "" };
        return { code: 0, stdout: "no", stderr: "" };
      },
      presignPut: async () => "https://signed.example/put",
      r2Head: async () => false,
      r2List: async () => [],
      r2Delete: async () => {},
      installCacheRepos: "example-org/websites",
      now: () => FAILOVER_NOW,
    };

    await syncSessionCycle(
      syncDeps, storage, STUDIO_ID, async () => {},
      null, null, null, retrySurvivalBrief, installCacheDeps,
    );
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(retrySurvivalBrief).toHaveBeenCalledTimes(1);
    expect(sbExecCalls).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// syncSessionCycle — snapshot freshness (issue #85, Task 7). `fakeCycleStorage`
// already keys its single Map generically, so it structurally satisfies
// ObservedStorage's get/put too (same "one Map, several narrow-port views"
// pattern the rest of this feature uses) — a cast at the call site is all
// that's needed, no new fake.
// ---------------------------------------------------------------------------

describe("syncSessionCycle — snapshot freshness (issue #85)", () => {
  it("a successful sync tick sets observed.lastSnapshotAt to the tick's now", async () => {
    const bytes = [1, 2, 3];
    const deps = fakeSyncDeps({
      statSize: String(bytes.length), singleRead: b64(bytes), now: "2026-08-16T12:00:00.000Z",
    });
    const storage = fakeCycleStorage({ status: cycleStatus() });
    const observedStorage = storage as unknown as ObservedStorage;

    await syncSessionCycle(deps, storage, STUDIO_ID, async () => {}, null, null, observedStorage);

    const observed = await getObserved(observedStorage);
    expect(observed.lastSnapshotAt).toBe("2026-08-16T12:00:00.000Z");
  });

  it("a failed sync tick (exec throws) leaves observed.lastSnapshotAt unchanged", async () => {
    const deps = fakeSyncDeps({ statCode: 1, statStderr: "tar: .claude/projects: Cannot stat: No such file or directory" });
    const storage = fakeCycleStorage({ status: cycleStatus() });
    const observedStorage = storage as unknown as ObservedStorage;
    await observedStorage.put(OBSERVED_KEY, {
      incarnation: null, replacedAt: null, execFailures: 0, unreachableSince: null,
      lastShipOkAt: null, lastSnapshotAt: "2026-08-15T00:00:00.000Z", session: null, activity: null,
      memberAlerts: null, lastMessageLine: null,
    });

    await syncSessionCycle(deps, storage, STUDIO_ID, async () => {}, null, null, observedStorage);

    const observed = await getObserved(observedStorage);
    expect(observed.lastSnapshotAt).toBe("2026-08-15T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// restorePlan — pure truth table
// ---------------------------------------------------------------------------

describe("restorePlan — truth table", () => {
  it("restores only when R2 latest exists AND the container is fresh (no ~/.claude/projects)", () => {
    expect(restorePlan(true, false)).toBe("restore");
    expect(restorePlan(true, true)).toBe("skip");
    expect(restorePlan(false, false)).toBe("skip");
    expect(restorePlan(false, true)).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// runSessionRestore (provision.ts) — provision restore only when fresh + exists
// ---------------------------------------------------------------------------

function fakeProvisionExec(opts: { hasProjects?: boolean } = {}): {
  sbExec: ProvisionDeps["sbExec"]; execCalls: string[];
} {
  const execCalls: string[] = [];
  return {
    execCalls,
    sbExec: (async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd === CONTAINER_HAS_PROJECTS_CMD) {
        return { code: 0, stdout: opts.hasProjects ? "yes\n" : "no\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }) as ProvisionDeps["sbExec"],
  };
}

function baseProvisionDeps(overrides: Partial<ProvisionDeps>): ProvisionDeps {
  return {
    sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    recordStudio: vi.fn(async () => {}),
    now: () => "2026-08-16T00:00:00.000Z",
    fetchBlueprintFile: vi.fn(),
    ...overrides,
  };
}

/** Same algorithm provision.ts's own (private) sha256Hex uses — computed
 *  independently here so the manifest tests assert against a value derived
 *  the SAME way a real bring-up's `sha256sum` would compute it, not a
 *  hand-copied constant that could silently drift from the implementation. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("runSessionRestore — provision restore only when fresh + R2 latest exists", () => {
  it("container already has ~/.claude/projects: skips WITHOUT ever calling r2Get or writeFile", async () => {
    const { sbExec, execCalls } = fakeProvisionExec({ hasProjects: true });
    const r2Get = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const writeFile = vi.fn(async () => {});
    const deps = baseProvisionDeps({ sbExec, r2Get, writeFile });

    const result = await runSessionRestore(deps, STUDIO_ID);

    expect(result).toEqual({ plan: "skip", parts: 0, restore: "skip:has-projects" });
    expect(r2Get).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(execCalls).toEqual([CONTAINER_HAS_PROJECTS_CMD]);
  });

  it("a killed projects check (124/137) is UNKNOWN: never a restore over what may be there (#110 review)", async () => {
    for (const code of [124, 137]) {
      const sbExec = vi.fn(async () => ({ code, stdout: "", stderr: "" })) as ProvisionDeps["sbExec"];
      const r2Get = vi.fn(async () => new Uint8Array([1, 2, 3]));
      const writeFile = vi.fn(async () => {});
      await expect(runSessionRestore(baseProvisionDeps({ sbExec, r2Get, writeFile }), STUDIO_ID)).rejects.toThrow(/unknown/);
      expect(r2Get).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
    }
  });

  it("fresh container but no R2 latest object: skips, no writeFile", async () => {
    const { sbExec } = fakeProvisionExec({ hasProjects: false });
    const r2Get = vi.fn(async () => null);
    const writeFile = vi.fn(async () => {});
    const deps = baseProvisionDeps({ sbExec, r2Get, writeFile });

    const result = await runSessionRestore(deps, STUDIO_ID);

    expect(result).toEqual({ plan: "skip", parts: 0, restore: "skip:no-snapshot" });
    expect(r2Get).toHaveBeenCalledWith(sessionLatestKey(STUDIO_ID));
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("fresh container AND R2 latest exists: chunks the tar into <=SESSION_SINGLE_READ_MAX parts, written to part-NN in order, THEN a verified manifest (C2 fix)", async () => {
    const { sbExec, execCalls } = fakeProvisionExec({ hasProjects: false });
    const bigTar = new Uint8Array(SESSION_SINGLE_READ_MAX + 100).fill(7);
    const r2Get = vi.fn(async () => bigTar);
    const writes: { path: string; bytes: Uint8Array }[] = [];
    const writeFile = vi.fn(async (path: string, bytes: Uint8Array) => {
      writes.push({ path, bytes });
    });
    const deps = baseProvisionDeps({ sbExec, r2Get, writeFile });

    const result = await runSessionRestore(deps, STUDIO_ID);

    expect(result).toEqual({ plan: "restore", parts: 2, restore: "restored" });
    expect(writes).toHaveLength(3); // 2 parts + the manifest
    expect(writes[0].path).toBe(restorePartPath(0));
    expect(writes[1].path).toBe(restorePartPath(1));
    expect(writes[2].path).toBe(SESSION_RESTORE_MANIFEST_PATH); // written LAST
    expect(writes[0].bytes.length).toBe(SESSION_SINGLE_READ_MAX);
    expect(writes[1].bytes.length).toBe(100);

    const manifest = JSON.parse(new TextDecoder().decode(writes[2].bytes));
    expect(manifest.partCount).toBe(2);
    expect(manifest.totalBytes).toBe(bigTar.length);
    expect(manifest.sha256).toBe(await sha256Hex(bigTar));

    // Closes the adjacent stale-leftover gap: every attempt starts from a
    // clean restore dir, issued before any part write.
    expect(execCalls).toContain(`rm -rf ${SESSION_RESTORE_DIR} && mkdir -p ${SESSION_RESTORE_DIR}`);
  });

  it("a single-part restore (tar <= SESSION_SINGLE_READ_MAX) still writes exactly one part-00 + a manifest with partCount:1", async () => {
    const { sbExec } = fakeProvisionExec({ hasProjects: false });
    const smallTar = new Uint8Array([1, 2, 3]);
    const r2Get = vi.fn(async () => smallTar);
    const writes: { path: string; bytes: Uint8Array }[] = [];
    const writeFile = vi.fn(async (path: string, bytes: Uint8Array) => {
      writes.push({ path, bytes });
    });
    const deps = baseProvisionDeps({ sbExec, r2Get, writeFile });

    const result = await runSessionRestore(deps, STUDIO_ID);
    expect(result).toEqual({ plan: "restore", parts: 1, restore: "restored" });
    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual({ path: restorePartPath(0), bytes: smallTar });
    const manifest = JSON.parse(new TextDecoder().decode(writes[1].bytes));
    expect(manifest).toEqual({ partCount: 1, totalBytes: 3, sha256: await sha256Hex(smallTar) });
  });

  it("C2 fix: the manifest write is strictly ORDERED after every part — never interleaved, never first", async () => {
    const { sbExec } = fakeProvisionExec({ hasProjects: false });
    const tar = new Uint8Array(SESSION_SINGLE_READ_MAX + 1).fill(3); // 2 parts
    const r2Get = vi.fn(async () => tar);
    const writeOrder: string[] = [];
    const writeFile = vi.fn(async (path: string) => {
      writeOrder.push(path);
    });
    const deps = baseProvisionDeps({ sbExec, r2Get, writeFile });

    await runSessionRestore(deps, STUDIO_ID);

    expect(writeOrder).toEqual([restorePartPath(0), restorePartPath(1), SESSION_RESTORE_MANIFEST_PATH]);
  });

  it("C2/I2 fix: a part-write failure issues rm -rf on the whole restore dir and NEVER writes a manifest — the original error still propagates to the caller", async () => {
    const { sbExec, execCalls } = fakeProvisionExec({ hasProjects: false });
    const tar = new Uint8Array(SESSION_SINGLE_READ_MAX + 1).fill(3); // 2 parts
    const r2Get = vi.fn(async () => tar);
    const writeOrder: string[] = [];
    const writeFile = vi.fn(async (path: string) => {
      writeOrder.push(path);
      if (path === restorePartPath(1)) throw new Error("writeFile failed: sandbox disconnected");
    });
    const deps = baseProvisionDeps({ sbExec, r2Get, writeFile });

    await expect(runSessionRestore(deps, STUDIO_ID)).rejects.toThrow("sandbox disconnected");

    expect(writeOrder).toEqual([restorePartPath(0), restorePartPath(1)]); // manifest never reached
    expect(writeOrder).not.toContain(SESSION_RESTORE_MANIFEST_PATH);
    expect(execCalls).toContain(`rm -rf ${SESSION_RESTORE_DIR}`); // cleanup issued before the error propagated
  });

  it("capability absent (no r2Get/writeFile wired) skips silently, before any exec at all — backward compatible", async () => {
    const { sbExec, execCalls } = fakeProvisionExec({ hasProjects: false });
    const deps = baseProvisionDeps({ sbExec }); // r2Get/writeFile both omitted

    const result = await runSessionRestore(deps, STUDIO_ID);

    expect(result).toEqual({ plan: "skip", parts: 0, restore: "not-attempted" });
    expect(execCalls).toHaveLength(0); // never even checks container freshness
  });
});

// ---------------------------------------------------------------------------
// container/studio-bringup.sh — C2 verification-gate source assertions
// ---------------------------------------------------------------------------

describe("container/studio-bringup.sh — C2 verification-gate source assertions", () => {
  // Shell, not a TS module — can't be imported and exercised directly, so
  // this asserts on its raw source text instead, injected as
  // TEST_STUDIO_BRINGUP_SRC by vitest.config.ts (the SAME technique
  // test/container.args.test.ts already uses for container/server.ts — see
  // that file's own header comment). Brittle by intent, same reasoning: the
  // actual runtime behavior of every branch below was verified by hand
  // (bash -c against scratch dirs, covering success, no-manifest,
  // part-count mismatch, hash mismatch, total-bytes mismatch, already-warm,
  // a simulated kill between the two placement mvs, and a real mv failure
  // on the last (guard-key) step — see task-3 fix report, both rounds) and
  // by the real-container
  // integration suite (`bun run test:integration`, provision + restart both
  // exercise a real bring-up run); these pin the LOAD-BEARING fragments so a
  // future edit that silently weakens the verification gate fails a test
  // here, not just a manual re-check nobody remembers to redo.
  const src = () => env.TEST_STUDIO_BRINGUP_SRC;

  it("guards on the manifest's mere presence (not parts alone) AND the container still being fresh", () => {
    expect(src()).toContain('MANIFEST="$RESTORE_DIR/manifest.json"');
    expect(src()).toContain('if [ -f "$MANIFEST" ] && [ ! -d ~/.claude/projects ]; then');
  });

  it("re-derives partCount/totalBytes/sha256 from the manifest via sed (no jq dependency) and re-verifies all three against the actual files on disk", () => {
    expect(src()).toContain(`sed -n 's/.*"partCount":\\([0-9]*\\).*/\\1/p' "$MANIFEST"`);
    expect(src()).toContain(`sed -n 's/.*"totalBytes":\\([0-9]*\\).*/\\1/p' "$MANIFEST"`);
    expect(src()).toContain(`sed -n 's/.*"sha256":"\\([a-f0-9]*\\)".*/\\1/p' "$MANIFEST"`);
    expect(src()).toContain("sha256sum");
    expect(src()).toContain('[ "$actual_part_count" != "$manifest_part_count" ]');
    expect(src()).toContain('[ "$actual_total_bytes" != "$manifest_total_bytes" ]');
    expect(src()).toContain('[ "$actual_sha256" != "$manifest_sha256" ]');
  });

  it("untars into a scratch temp dir first, only mv-ing into ~/.claude/projects on a fully successful extraction — atomic by construction, never a partial ~/.claude", () => {
    expect(src()).toContain('TMP_RESTORE="${HOME:-/root}/.claude-restore-tmp"');
    expect(src()).toContain('cat "$RESTORE_DIR"/part-* | tar -xzf - -C "$TMP_RESTORE"');
    expect(src()).toContain('mv "$TMP_RESTORE/.claude/projects" ~/.claude/projects');
    // Nothing else in this file ever writes to ~/.claude/projects directly —
    // this mv is the ONLY path a restore takes into the real location.
    expect(src().match(/~\/\.claude\/projects/g)?.length).toBeGreaterThanOrEqual(1);
  });

  it("fix round 2 (Important): moves .claude.json BEFORE projects — projects is the freshness guard's own key, so it must be the LAST placement step. A kill/failure between the two self-heals via retry (guard still reads 'fresh') instead of permanently orphaning .claude.json in $TMP_RESTORE (which the OLD ordering could do: projects landing first flips the guard to 'warm', so the block never runs again to notice .claude.json never made it)", () => {
    const claudeJsonMvIdx = src().indexOf('mv "$TMP_RESTORE/.claude.json" ~/.claude.json');
    const projectsMvIdx = src().indexOf('mv "$TMP_RESTORE/.claude/projects" ~/.claude/projects');
    expect(claudeJsonMvIdx).toBeGreaterThan(-1);
    expect(projectsMvIdx).toBeGreaterThan(-1);
    expect(claudeJsonMvIdx).toBeLessThan(projectsMvIdx);
  });

  it("fix round 2 (Minor): exit-checks every placement step (mkdir + both mvs) and gates the success message on the WHOLE chain succeeding — a failed placement falls through to the same 'continuing fresh' logging every other gate in this block uses, never a false 'verified'", () => {
    expect(src()).toContain("placement_ok=1");
    expect(src()).toContain("mkdir -p ~/.claude || placement_ok=0");
    expect(src()).toContain('mv "$TMP_RESTORE/.claude.json" ~/.claude.json || placement_ok=0');
    expect(src()).toContain('mv "$TMP_RESTORE/.claude/projects" ~/.claude/projects || placement_ok=0');

    // The success echo must be reached ONLY through a placement_ok gate —
    // never unconditionally right after the mv calls (the exact bug: an
    // unchecked mv could fail while this line still printed "verified").
    const successMsgIdx = src().indexOf("session restored from R2 snapshot (verified)");
    expect(successMsgIdx).toBeGreaterThan(-1);
    const nearestGateBeforeSuccess = src().lastIndexOf('[ "$placement_ok" = "1" ]', successMsgIdx);
    expect(nearestGateBeforeSuccess).toBeGreaterThan(-1);
    expect(nearestGateBeforeSuccess).toBeLessThan(successMsgIdx);

    expect(src()).toContain("session restore placement failed after untar, continuing fresh");
  });

  it("wraps the entire block in its own `set +e` subshell — a corrupt/torn restore can never abort the rest of bring-up under this script's outer `set -euo pipefail`", () => {
    expect(src()).toContain('RESTORE_DIR="${FLEET_WORKSPACE:-/workspace}/.session-restore"');
    const restoreBlockStart = src().indexOf('RESTORE_DIR="${FLEET_WORKSPACE:-/workspace}/.session-restore"');
    const nearby = src().slice(restoreBlockStart, restoreBlockStart + 400);
    expect(nearby).toMatch(/\(\s*\n\s*set \+e/);
  });

  it("cleans up both parts and the manifest unconditionally at the end — idempotent double-run regardless of which outcome (restored/failed-verify/failed-untar) occurred", () => {
    expect(src()).toContain('rm -f "$RESTORE_DIR"/part-* "$MANIFEST"');
  });

  it("the restore-untar step still runs after tmux-session and before the claude-launch block's own --continue check", () => {
    const tmuxSessionIdx = src().indexOf('tmux new-session -d -s studio -n claude');
    const restoreIdx = src().indexOf('RESTORE_DIR="${FLEET_WORKSPACE:-/workspace}/.session-restore"');
    const continueCheckIdx = src().indexOf("claude_args+=(--continue)");
    expect(tmuxSessionIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeGreaterThan(tmuxSessionIdx);
    expect(continueCheckIdx).toBeGreaterThan(restoreIdx);
    // Issue #146: the adopt runs between them — after the untar, before the guard.
    const adoptIdx = src().indexOf("bringup_step session-adopt");
    expect(adoptIdx).toBeGreaterThan(restoreIdx);
    expect(continueCheckIdx).toBeGreaterThan(adoptIdx);
  });
});

// ---------------------------------------------------------------------------
// container/studio-bringup.sh — tailscaleHost writer (Task 6, P2 ride-along)
// ---------------------------------------------------------------------------

describe("container/studio-bringup.sh — tailscaleHost writer (Task 6, P2 ride-along)", () => {
  const src = () => env.TEST_STUDIO_BRINGUP_SRC;

  it("guards the whole block on a non-empty `tailscale status --json` result — `|| true` keeps a missing/failed tailscale from tripping this script's own set -euo pipefail", () => {
    expect(src()).toContain('ts_status_json="$(tailscale status --json 2>/dev/null || true)"');
    expect(src()).toContain('if [ -n "$ts_status_json" ]; then');
  });

  it("scopes the DNSName extraction to Self only — truncates at the Peer marker before extracting, so a peer's own DNSName can never be picked up (no jq in this image)", () => {
    expect(src()).toContain(`PEER_MARKER='"Peer"'`);
    expect(src()).toContain('ts_self_json="${ts_status_json%%$PEER_MARKER*}"');
    expect(src()).toContain(`sed -n 's/.*"DNSName": *"\\([^"]*\\)".*/\\1/p'`);
  });

  it("strips a trailing dot (tailscale's own FQDN form) before writing", () => {
    expect(src()).toContain('ts_dns_name="${ts_dns_name%.}"');
  });

  it("only writes /workspace/.ts-host when a DNSName was actually found — absent/empty just skips, leaving the file itself absent for the reader to treat as null", () => {
    expect(src()).toContain('if [ -n "$ts_dns_name" ]; then');
    expect(src()).toContain('printf \'%s\\n\' "$ts_dns_name" > /workspace/.ts-host');
  });

  it("runs AFTER `tailscale up`, not before — DNSName is only populated once tailscale is actually logged in", () => {
    const tailscaleUpIdx = src().indexOf('tailscale up --ssh --authkey=');
    const writerIdx = src().indexOf('ts_status_json="$(tailscale status --json');
    expect(tailscaleUpIdx).toBeGreaterThan(-1);
    expect(writerIdx).toBeGreaterThan(tailscaleUpIdx);
  });
});

// ---------------------------------------------------------------------------
// container/studio-bringup.sh — claude launch: skip-permissions + effort
// (operator directive 2026-08-19)
// ---------------------------------------------------------------------------

describe("container/studio-bringup.sh — claude launch: skip-permissions + effort (operator directive 2026-08-19)", () => {
  const src = () => env.TEST_STUDIO_BRINGUP_SRC;

  it("passes --dangerously-skip-permissions unconditionally", () => {
    expect(src()).toContain("claude_args+=(--dangerously-skip-permissions)");
  });

  it("passes --effort only when ROLE_EFFORT is set (empty -> claude's own default)", () => {
    expect(src()).toContain('[ -n "${ROLE_EFFORT:-}" ] && claude_args+=(--effort "$ROLE_EFFORT")');
  });

  it("the --allowedTools line survives alongside both additions (belt and braces, not a replacement)", () => {
    expect(src()).toContain('claude_args+=(--allowedTools "${ROLE_ALLOWED_TOOLS:-}")');
  });

  // Issue #6: the prompt inlined into claude_args rode the send-keys line and
  // overflowed tmux. claude_launch_line passes it by file; its behaviour runs
  // in test/bun/bringup-launch-line.test.ts.
  it("the role prompt never joins claude_args — it goes to claude_launch_line, which passes it by file", () => {
    expect(src()).not.toContain('claude_args+=(--append-system-prompt "$role_prompt"');
    expect(src()).toContain('cmd_str="$(claude_launch_line "$role_prompt" "${repo_dir:-}" "${claude_args[@]}")"');
  });

  it("skip-permissions lands before the --continue guard, --effort lands after --allowedTools, and both are assembled into cmd_str with everything else in claude_args", () => {
    const skipIdx = src().indexOf("claude_args+=(--dangerously-skip-permissions)");
    const continueGuardIdx = src().indexOf('if claude_has_conversation "${repo_dir:-$PWD}"; then');
    const allowedToolsIdx = src().indexOf('--allowedTools "${ROLE_ALLOWED_TOOLS:-}")');
    const effortIdx = src().indexOf('claude_args+=(--effort "$ROLE_EFFORT")');
    const cmdStrIdx = src().indexOf('cmd_str="$(claude_launch_line');
    expect(skipIdx).toBeGreaterThan(-1);
    expect(continueGuardIdx).toBeGreaterThan(skipIdx);
    expect(allowedToolsIdx).toBeGreaterThan(continueGuardIdx);
    expect(effortIdx).toBeGreaterThan(allowedToolsIdx);
    expect(cmdStrIdx).toBeGreaterThan(effortIdx);
  });

  // The --continue guard must stay scoped to the project claude will actually
  // launch in. It was once `[ -d ~/.claude/projects ]` — true whenever ANY
  // session existed anywhere — which went live the moment claude started
  // launching from the checkout instead of /workspace: the guard passed, no
  // session existed for that cwd, claude exited "No conversation found to
  // continue", and the studio came up as a bare bash pane.
  it("the --continue guard is scoped to the launch cwd's own project dir, never to the projects dir as a whole", () => {
    expect(src()).not.toContain("[ -d ~/.claude/projects ] && claude_args+=(--continue)");
    expect(src()).toContain("claude_project_dir() {");
    expect(src()).toContain('printf \'%s\' ~/.claude/projects/"$(printf \'%s\' "$1" | tr -c \'a-zA-Z0-9\' \'-\')"');
    // repo_dir must be resolved BEFORE the guard reads it, or the guard tests
    // one directory while claude starts in another.
    expect(src().indexOf('repo_dir="/workspace/${STUDIO_ID%%--*}"')).toBeLessThan(
      src().indexOf('if claude_has_conversation "${repo_dir:-$PWD}"; then'),
    );
  });

  // Issue #54, measured 2026-09-23 on `acme-os--web-studio`: directory
  // EXISTENCE is not evidence of a resumable conversation.
  // `/root/.claude/projects/-workspace-acme-os/` held only `memory/`, the
  // dir-existence guard passed anyway, and claude exited "No conversation
  // found to continue". The executable proof of both branches lives in
  // test/bun/bringup-claude-launch.test.ts (real function bodies, real
  // filesystem); this pins the source shape workerd can see.
  it("the --continue guard tests for a session file, never for the project DIRECTORY", () => {
    expect(src()).not.toContain('[ -d "$claude_proj_dir" ] && claude_args+=(--continue)');
    expect(src()).toContain("claude_has_conversation() {");
    // -maxdepth 1 is what keeps `memory/` (restored independently of any
    // conversation, and full of files claude never resumes from) out of the
    // answer.
    expect(src()).toContain("-maxdepth 1 -type f -name '*.jsonl'");
  });
});

// ---------------------------------------------------------------------------
// container/studio-bringup.sh — issue #54: an immediate claude exit must not
// be reported as a successful bring-up
// ---------------------------------------------------------------------------
//
// Bring-up `send-keys` the launch line and returned without ever looking at
// the pane again, so claude printing "No conversation found to continue" and
// exiting was INVISIBLE to provision, which reported success over a container
// that was `running` with a dead lead. The behavior of claude_launch_landed
// is executed in test/bun/bringup-claude-launch.test.ts; these assertions pin
// the WIRING — that bring-up actually calls it, and that a failure actually
// reaches the Worker as a non-zero exit.

describe("container/studio-bringup.sh — claude launch liveness (issue #54)", () => {
  const src = () => env.TEST_STUDIO_BRINGUP_SRC;

  it("verifies the launch landed immediately after send-keys, and records the failure instead of aborting mid-script", () => {
    // Issue #90 moved the keystrokes into claude_launch (C-c, launch, verify,
    // one retry); its behaviour runs in test/bun/bringup-claude-relaunch.test.ts.
    const fnStart = src().indexOf("\nclaude_launch() {");
    const fn = src().slice(fnStart, src().indexOf("\n}\n", fnStart));
    const sendKeysIdx = fn.indexOf('tmux send-keys -t studio:claude -- " $1" Enter');
    expect(fnStart).toBeGreaterThan(-1);
    expect(sendKeysIdx).toBeGreaterThan(-1);
    expect(fn.indexOf("claude_launch_landed")).toBeGreaterThan(sendKeysIdx);
    expect(src()).toContain('claude_launch "$cmd_str" || claude_launch_failed=1');
  });

  // The transcript pipe-pane is the only record of WHY claude exited, and the
  // shell window is the operator's way in. A studio that failed to launch
  // needs both more than a healthy one does, so the non-zero exit waits until
  // every other bring-up step has run.
  it("exits non-zero only at the very end, after the transcript pipe-pane and the shell window", () => {
    const pipeIdx = src().indexOf("tmux pipe-pane -t studio:claude");
    // #314: -d, so the shell window is never made current.
    const shellIdx = src().indexOf("tmux new-window -d -t studio -n shell");
    const exitIdx = src().indexOf('if [ "${claude_launch_failed:-0}" = 1 ]; then');
    expect(pipeIdx).toBeGreaterThan(-1);
    expect(shellIdx).toBeGreaterThan(-1);
    expect(exitIdx).toBeGreaterThan(pipeIdx);
    expect(exitIdx).toBeGreaterThan(shellIdx);
    expect(src().trimEnd().endsWith("fi")).toBe(true);
  });

  // Issue #67 moved the tmux call one level down, into `claude_pane_field`,
  // so that every question about the pane goes through the SAME hardened
  // probe (ask for `session:window field`, discard any answer that does not
  // name studio:claude). The invariant this test exists for is unchanged and
  // is still asserted, one indirection lower: the probe names the pane in
  // `-t`, and nothing anywhere in the script selects, switches or attaches.
  it("the liveness probe reads the pane BY NAME — never selects, switches or attaches a window", () => {
    const fieldFn = src().slice(src().indexOf("claude_pane_field() {"));
    const fieldBody = fieldFn.slice(0, fieldFn.indexOf("\n}"));
    expect(fieldBody).toContain('tmux display-message -p -t studio:claude "#{session_name}:#{window_name} $1"');
    // An answer that is not about studio:claude is discarded, not believed.
    expect(fieldBody).toContain('"studio:claude "*)');

    const fn = src().slice(src().indexOf("claude_pane_command() {"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("claude_pane_field '#{pane_current_command}'");

    // #314: exactly ONE select-window, and it points at the lead
    // (studio:claude) -- the shell-window region returns a session left on
    // shell to claude. Selecting any OTHER window stays forbidden: that is
    // what made operators read a healthy studio as dead.
    expect(src().match(/tmux select-window[^\n]*/g) ?? []).toEqual(["tmux select-window -t studio:claude"]);
    expect(src()).not.toContain("tmux switch-client");
  });
});

// ---------------------------------------------------------------------------
// container/studio-bringup.sh — P4a-1 fix wave: lead gate covers Bash, fails
// closed; skills warn when absent; .mcp.json lands where claude reads it
// ---------------------------------------------------------------------------
//
// Same source-pin technique (and same brittle-by-intent tradeoff) as every
// other studio-bringup.sh block in this file — see the C2 describe block's
// own header. The BEHAVIOR of the gate is verified separately and directly:
// 30 synthetic hook payloads run against the extracted script (lead+Edit,
// lead+every Bash write form, lead+every read/coordination command,
// member+everything, unparseable payload), plus a real built container. These
// pin the load-bearing fragments so a future edit that silently re-opens the
// hole fails a test instead of a manual re-check nobody redoes.

describe("container/studio-bringup.sh — lead gate covers Bash (fix wave, Critical #1)", () => {
  // Board issue #2: this hook script moved out of studio-bringup.sh's own
  // HOOKEOF heredoc into gates/lead-gate.sh, a real file both cloud bring-up
  // (cp from the blueprint clone) and `fleet gates install` read from. Every
  // assertion below targets text that lives in that script's python program
  // — only the SOURCE binding changed, not what is asserted.
  const src = () => env.TEST_LEAD_GATE_SRC;

  // P7a Task 5: matcher widened to `.*` -- a fixed tool list only catches
  // tools named ahead of time (firstmate lost 73 min of supervision to
  // exactly that gap, docs/subagent-guard.md:15-27). The write/no-write
  // decision moved INTO the script; see the shape-test assertions below.
  it("the PreToolUse matcher is `.*`, not a fixed tool list", () => {
    // The ONE test in this block that targets studio-bringup.sh's own
    // settings.json merge python (the matcher literal), not gates/lead-gate.sh
    // — that block's own settings-registration half never moved.
    const bringupSrc = env.TEST_STUDIO_BRINGUP_SRC;
    expect(bringupSrc).toContain('"matcher": ".*",');
    expect(bringupSrc).not.toContain('"matcher": "Edit|Write|NotebookEdit|Bash"');
  });

  it("members stay exempt for EVERY tool — agent_id/agent_type presence short-circuits before any tool check", () => {
    expect(src()).toContain('if payload.get("agent_id") or payload.get("agent_type"):');
  });

  it("a non-Bash tool from the lead goes through the write-SHAPE test before Bash's own command-parsing path runs", () => {
    // Renamed from "blocked outright" (P7a Task 5): a non-Bash tool is no
    // longer blocked unconditionally -- only when it LOOKS like a write.
    //
    // Review round 1 (Finding 1, Critical): a flat OR over
    // file_path/path/edits/content collided with Read (file_path) and
    // Grep/Glob (path) -- "the lead cannot Read". Fixed: locator
    // (file_path/path/notebook_path) alone is never enough; it must pair
    // with a writeish NAME, or tool_input must carry write CONTENT
    // (content/contents/edits/new_string/new_str/patch) on its own. These
    // three fragments are the load-bearing pins; the ordering assertions
    // confirm the branch still sits ahead of Bash's cmd-parsing line.
    expect(src()).toContain(
      'name_writeish = bool(re.search(r"(?i)(edit|write|notebook|patch|apply)", tool))',
    );
    expect(src()).toContain(
      'has_locator = any(key in tool_input for key in ("file_path", "path", "notebook_path"))',
    );
    // Round 4 (the one that matters): this tuple was pinned NOWHERE as a
    // source literal before now -- only named in this very comment's prose
    // above. Deleting `new_string` from the real tuple left the whole suite
    // green. Pinned the same way `has_locator`'s is pinned above.
    expect(src()).toContain(
      'key in tool_input for key in ("content", "contents", "edits", "new_string", "new_str", "patch")',
    );
    expect(src()).toContain('write_shaped = (name_writeish and has_locator) or has_write_content');
    const nonBashIdx = src().indexOf('if tool != "Bash":');
    const shapeIdx = src().indexOf("name_writeish = bool(re.search(");
    const cmdIdx = src().indexOf('cmd = tool_input.get("command", "")');
    expect(nonBashIdx).toBeGreaterThan(-1);
    expect(shapeIdx).toBeGreaterThan(nonBashIdx);
    expect(cmdIdx).toBeGreaterThan(shapeIdx);
  });

  it("a locator alone is not a write signal — Read/Grep/Glob must pass (review Finding 1, Critical)", () => {
    expect(src()).toContain("the only required param of Read IS file_path");
  });

  it("Bash's own tool_input read does not fail OPEN on JSON null, nor on any other unreadable shape (review round 2, hardened by D1)", () => {
    // Round 2: payload.get("tool_input", {}) only substitutes {} when the
    // key is ABSENT, so a present null still returned None, and
    // None.get("command", "") raised AttributeError uncaught -- exit 1,
    // PERMITS -- skipping the entire redirect/FORMS scan. Fixed then with
    // `or {}`.
    //
    // D1 (deferred finding, taken now): `or {}` only substitutes on FALSY --
    // a PRESENT but non-dict value (a string, a list, a number) is truthy,
    // so `or {}` never fired either, and the same crash-then-permit was
    // reachable through a different door. Replaced with the isinstance(dict)
    // normalisation the non-Bash branch above already uses, plus a refusal
    // when the value IS present but unreadable -- None/absent alone stays a
    // permit (Bash has no name-based write signal the way Edit/Write do).
    //
    // Anchored past `write_shaped` (the non-Bash branch's own last line) so
    // this proves the BASH branch carries its own copy of the fix, not a
    // toContain hit on the non-Bash branch's identical-looking lines above.
    const writeShapedIdx = src().indexOf(
      "write_shaped = (name_writeish and has_locator) or has_write_content",
    );
    expect(writeShapedIdx).toBeGreaterThan(-1);
    const bashRawIdx = src().indexOf('raw_tool_input = payload.get("tool_input")', writeShapedIdx);
    const bashGuardIdx = src().indexOf(
      "if raw_tool_input is not None and not isinstance(raw_tool_input, dict):",
      writeShapedIdx,
    );
    const bashNormalizeIdx = src().indexOf(
      'tool_input = raw_tool_input if isinstance(raw_tool_input, dict) else {}',
      writeShapedIdx,
    );
    const cmdIdx = src().indexOf('cmd = tool_input.get("command", "")', writeShapedIdx);
    expect(bashRawIdx).toBeGreaterThan(writeShapedIdx);
    expect(bashGuardIdx).toBeGreaterThan(bashRawIdx);
    expect(bashNormalizeIdx).toBeGreaterThan(bashGuardIdx);
    expect(cmdIdx).toBeGreaterThan(bashNormalizeIdx);
    // Both prior broken forms are gone outright, not just superseded.
    expect(src()).not.toContain('cmd = payload.get("tool_input", {}).get("command", "")');
    expect(src()).not.toContain('cmd = (payload.get("tool_input") or {}).get("command", "")');
  });

  it("D1: a Bash call whose tool_input is present but not an object (a string, a list, a number) refuses -- cannot verify a command it cannot read", () => {
    expect(src()).toContain(
      'refuse("leads never implement -- this Bash tool_input is not a readable object, cannot verify the command is safe. Dispatch a member.")',
    );
    // None/absent is deliberately NOT this refusal -- the guard is
    // `is not None and not isinstance(..., dict)`, not `not isinstance`
    // alone, so a genuinely absent tool_input still falls through to the
    // permit path the test above already pins.
    expect(src()).toContain("if raw_tool_input is not None and not isinstance(raw_tool_input, dict):");
  });

  it("carries no single quote in its python program — `python3 -c '...'` would end at the first one (same guard the completion gate already has, extended to this script: D1's own fix landed here as a single-quote bug the first time)", () => {
    // Board issue #2: gates/lead-gate.sh is now a standalone file, not a
    // heredoc body inside studio-bringup.sh — there is no `<<'HOOKEOF'`
    // marker left to anchor on. Slices the SAME boundary directly out of the
    // file's own text instead: the program opens at `exec python3 -c '` and
    // its closing quote is the file's own last line (the file is nothing but
    // a shebang, the python3 guard, and this one `python3 -c '...'` call).
    const openMarker = src().indexOf("exec python3 -c '");
    expect(openMarker).toBeGreaterThan(-1);
    const openIdx = openMarker + "exec python3 -c '".length;
    const closeIdx = src().lastIndexOf("\n'\n");
    expect(closeIdx).toBeGreaterThan(openIdx);
    const body = src().slice(openIdx, closeIdx);
    expect(body).not.toContain("'");
  });

  it("tool_input JSON null does not fail OPEN through an uncaught exception (review Finding 2, Important)", () => {
    // payload.get("tool_input", {}) only substitutes {} when the KEY is
    // ABSENT; a key present with value null still returns None, and
    // `any(k in None ...)` used to raise, uncaught -- exit 1, which PERMITS
    // (only exit 2 blocks).
    //
    // Round 3 (Important): `or {}` alone fixed the crash but not the hole --
    // a writeish name with absent/null/non-dict input landed on the same
    // empty {} and PERMITTED either way. Replaced with an isinstance(dict)
    // check that both normalizes tool_input AND records whether it was
    // readable, so a writeish name with unreadable input can refuse instead.
    expect(src()).toContain('tool_input_unreadable = not isinstance(raw_tool_input, dict)');
    expect(src()).toContain('tool_input = raw_tool_input if isinstance(raw_tool_input, dict) else {}');
    expect(src()).not.toContain('tool_input = payload.get("tool_input", {})');
  });

  it("a writeish name with unreadable tool_input refuses instead of silently permitting (review round 3, Important)", () => {
    // The defect in round 2's own fix: an unreadable-but-writeish call must
    // BLOCK, not fall through to the shape test where no locator/content
    // means PASS. This check must fire BEFORE has_locator/has_write_content
    // are computed from the normalized (possibly fake-empty) tool_input --
    // otherwise "unreadable" and "readable-but-empty" become indistinguishable
    // and a lead's malformed Write walks straight through.
    expect(src()).toContain(
      'if name_writeish and tool_input_unreadable:\n        refuse("leads never implement -- dispatch a member")',
    );
    const unreadableIdx = src().indexOf("tool_input_unreadable = not isinstance(");
    const refuseIdx = src().indexOf('if name_writeish and tool_input_unreadable:');
    const locatorIdx = src().indexOf("has_locator = any(");
    expect(unreadableIdx).toBeGreaterThan(-1);
    expect(refuseIdx).toBeGreaterThan(unreadableIdx);
    expect(locatorIdx).toBeGreaterThan(refuseIdx);
  });

  it("blocks the observed escape (redirection into a path) and the rest of the write-form blocklist", () => {
    // The exact escape spike-lead-tools.md recorded: Write blocked -> the
    // model wrote the file via printf through Bash.
    expect(src()).toContain('for m in re.finditer(r"(?<![<>&])>{1,2}\\|?(?!&)\\s*([^\\s;|&<>]+)", bare):');
    expect(src()).toContain('if not m.group(1).startswith("/dev/"):');
    expect(src()).toContain('(r"(?<![\\w-])tee\\b", "tee writes a file"),');
    expect(src()).toContain('--in-place');
    expect(src()).toContain('(?:mv|cp)');
    expect(src()).toContain('\\bof=');
  });

  it("strips quoted spans before scanning — a markdown blockquote in a `gh issue comment --body` is not a redirection", () => {
    expect(src()).toContain('bare = re.sub(r"\\x27[^\\x27]*\\x27|\\"(?:\\\\.|[^\\"\\\\])*\\"", " ", cmd, flags=re.S)');
  });

  it("blocks the shell wrappers whose payload the quote-strip erases — bash -c, sh -c, eval, and xargs/env spawning either", () => {
    // Without these, the quote-strip that stops `--body "> md"` false-
    // positiving also erases the ENTIRE payload of `bash -c "printf x >
    // /workspace/f"`, so `bare` sees only `bash -c` and every write rule
    // above finds nothing. Measured passing before this list grew.
    expect(src()).toContain('"bash -c / sh -c hides its payload from this gate"');
    expect(src()).toContain('"xargs/env spawning a shell hides its payload from this gate"');
    expect(src()).toContain('"eval hides its payload from this gate"');
    // The shell-name alternation and the clustered-flag form (`bash -lc`).
    expect(src()).toContain("(?:ba|z|k|da)?sh[ \\t]+(?:[^\\s;&|]+[ \\t]+)*?-[a-zA-Z]*c(?![\\w-])");
    // Command-position anchor incl. $( ) and backticks, so `grep -rn eval
    // src` and `cat scripts/deploy.sh` are not false positives.
    expect(src()).toContain('(r"(?:^|[;&|(]|\\$\\(|`)\\s*eval(?![\\w-])"');
  });

  it("does NOT block xargs itself — only `xargs ... sh -c`, so read-side pipelines survive", () => {
    expect(src()).toContain("never xargs itself");
    // The xargs rule always requires a shell-with--c after it; there is no
    // bare xargs entry in the blocklist.
    expect(src()).not.toContain('(r"(?<![\\w-])xargs\\b"');
  });

  it("says out loud that the Bash half is a blocklist of observed escapes, not a sandbox, and NAMES what is still open", () => {
    expect(src()).toContain("HONEST SCOPE");
    expect(src()).toContain("BLOCKLIST of");
    expect(src()).toContain("Never describe this as an absolute");
    expect(src()).toContain("STILL OPEN, named on purpose");
    // The paragraph is worthless if it flatters the gate: every one of
    // these writes files and none is blocked.
    for (const open of ["python3", "`ed`", "curl -o", "wget -O", "git apply", "install", "truncate", "touch"]) {
      expect(src()).toContain(open);
    }
  });
});

describe("container/studio-bringup.sh — lead gate fails CLOSED (fix wave, Important #5)", () => {
  const src = () => env.TEST_STUDIO_BRINGUP_SRC;

  it("the settings.json command guards on an EXECUTABLE script and exits 2 itself when it is absent — a deleted/chmod-stripped hook can no longer fail open", () => {
    expect(src()).toContain('"[ -x \\"$S\\" ] || { echo \\"lead-gate hook absent or not executable -- refusing (decision 11)\\" >&2; exit 2; }; "');
  });

  it("resolves $HOME at claude runtime instead of baking the bring-up-time /root into the command", () => {
    expect(src()).toContain('"S=\\"$HOME/.claude/hooks/lead-gate.sh\\"; "');
    // The old baked form is gone: expanduser must not build the hook command.
    expect(src()).not.toContain('"command": os.path.expanduser("~/.claude/hooks/lead-gate.sh")');
  });

  it("an unreadable payload and a missing python3 both refuse rather than permit", () => {
    // Both lines live INSIDE gates/lead-gate.sh itself (the python3 guard and
    // the refuse() call it protects), not in bring-up's own settings-merge
    // half this describe block otherwise tests — board issue #2 moved them
    // out of the HOOKEOF heredoc along with everything else in that file.
    expect(env.TEST_LEAD_GATE_SRC).toContain('refuse("lead-gate: unreadable hook payload -- refusing")');
    expect(env.TEST_LEAD_GATE_SRC).toContain("command -v python3 >/dev/null 2>&1 || {");
  });

  it("drops any prior lead-gate entry before appending — a re-brought-up live container cannot keep the old fail-open entry beside the new one", () => {
    expect(src()).toContain('pre[:] = [e for e in pre if "lead-gate.sh" not in json.dumps(e)]');
  });
});

describe("container/studio-bringup.sh — declared-but-absent skills are loud (fix wave, Critical #2)", () => {
  const src = () => env.TEST_STUDIO_BRINGUP_SRC;

  it("warns by name when a declared skill resolves to nothing", () => {
    expect(src()).toContain('resolves to NOTHING');
    expect(src()).toContain('studio boots without it');
  });

  it("checks the baked plugin cache before warning — every Tier-0 superpowers skill legitimately has no blueprint dir and must not produce a false alarm", () => {
    expect(src()).toContain('elif ! ls -d ~/.claude/plugins/cache/*/*/*/skills/"$s" >/dev/null 2>&1; then');
  });

  it("still symlinks from the blueprint clone when the dir IS there", () => {
    expect(src()).toContain('ln -sfn "/opt/blueprint/skills/$s" ~/.claude/skills/"$s"');
  });
});

describe("container/studio-bringup.sh — the gates' `cp` blocks warn and continue, never abort, when /opt/blueprint/gates/*.sh is missing (board issue #2)", () => {
  const src = () => env.TEST_STUDIO_BRINGUP_SRC;

  // Same single-source-of-truth shape as the skills-symlink block above,
  // repeated three times (lead-gate, session-reemit, completion-gate): `cp`
  // the hook script in from the blueprint clone when it's there, warn by
  // name on stderr and fall through when it is not, rather than aborting
  // bring-up outright. Sliced per gate from its own `if [ -f ... ]; then`
  // down through its own `chmod ... || true` so an assertion about ONE gate
  // can never accidentally pass by matching another gate's text.
  const gateCpBlock = (name: string) => {
    const ifIdx = src().indexOf(`if [ -f /opt/blueprint/gates/${name}.sh ]; then`);
    expect(ifIdx).toBeGreaterThan(-1);
    const chmodLine = `chmod 0755 ~/.claude/hooks/${name}.sh`;
    const chmodIdx = src().indexOf(chmodLine, ifIdx);
    expect(chmodIdx).toBeGreaterThan(ifIdx);
    return src().slice(ifIdx, chmodIdx + chmodLine.length);
  };

  it("lead-gate: copies from the blueprint clone when present", () => {
    expect(gateCpBlock("lead-gate")).toContain(
      "cp /opt/blueprint/gates/lead-gate.sh ~/.claude/hooks/lead-gate.sh",
    );
  });

  it("lead-gate: warns by name on stderr and falls through — no bare `exit` in the block — when the blueprint clone lacks it", () => {
    const block = gateCpBlock("lead-gate");
    expect(block).toContain(
      'echo "studio-bringup: /opt/blueprint/gates/lead-gate.sh missing -- cannot install lead-gate hook" >&2',
    );
    // Under this script's own `set -euo pipefail`, a bare `exit` here would
    // abort the whole bring-up the moment a container's blueprint clone is
    // missing or failed — the warn-and-continue posture requires there be
    // none in this block.
    expect(block).not.toMatch(/\bexit\b/);
  });

  it("session-reemit: copies from the blueprint clone when present", () => {
    expect(gateCpBlock("session-reemit")).toContain(
      "cp /opt/blueprint/gates/session-reemit.sh ~/.claude/hooks/session-reemit.sh",
    );
  });

  it("session-reemit: warns by name on stderr and falls through — no bare `exit` in the block — when the blueprint clone lacks it", () => {
    const block = gateCpBlock("session-reemit");
    expect(block).toContain(
      'echo "studio-bringup: /opt/blueprint/gates/session-reemit.sh missing -- cannot install session-reemit hook" >&2',
    );
    expect(block).not.toMatch(/\bexit\b/);
  });

  it("completion-gate: copies from the blueprint clone when present", () => {
    expect(gateCpBlock("completion-gate")).toContain(
      "cp /opt/blueprint/gates/completion-gate.sh ~/.claude/hooks/completion-gate.sh",
    );
  });

  it("completion-gate: warns by name on stderr and falls through — no bare `exit` in the block — when the blueprint clone lacks it", () => {
    const block = gateCpBlock("completion-gate");
    expect(block).toContain(
      'echo "studio-bringup: /opt/blueprint/gates/completion-gate.sh missing -- cannot install completion-gate hook" >&2',
    );
    expect(block).not.toMatch(/\bexit\b/);
  });
});

describe("container/studio-bringup.sh — .mcp.json lands in claude's own cwd (fix wave, Important #3)", () => {
  const src = () => env.TEST_STUDIO_BRINGUP_SRC;

  it("asks tmux for the claude pane's real cwd instead of hardcoding /workspace", () => {
    expect(src()).toContain(`mcp_dir="$(tmux display-message -p -t studio:claude '#{pane_current_path}' 2>/dev/null || true)"`);
    expect(src()).toContain('MCP_PATH="$mcp_dir/.mcp.json" python3 -c');
    expect(src()).toContain('with open(os.environ["MCP_PATH"], "w") as f:');
  });

  it("no longer writes the dead /workspace/.mcp.json", () => {
    expect(src()).not.toContain("/workspace/.mcp.json");
  });

  it("approves the project's own MCP servers — nothing in a headless pane answers the approval prompt", () => {
    expect(src()).toContain('cfg["enableAllProjectMcpServers"] = True');
  });
});

// ---------------------------------------------------------------------------
// restartWithSync (do.ts) — restart-runs-sync-first ordering
// ---------------------------------------------------------------------------

type CombinedStorage = StudioStorage & SessionSyncStorage;

function fakeCombinedStorage(
  seed?: { status?: StudioStatus; roleEnv?: RoleEnv | StudioEnv; dailyDate?: string },
): CombinedStorage & { putKeys: string[] } {
  // `| boolean` (Task 4, R-P3-6) covers KEEP_ALIVE_KEY — restartWithStorage
  // (called via restartWithSync below) now always reads/writes it alongside
  // STATUS_KEY/ROLE_ENV_KEY.
  const map = new Map<string, StudioStatus | RoleEnv | StudioEnv | string | boolean>();
  if (seed?.status) map.set(STATUS_KEY, seed.status);
  if (seed?.roleEnv) map.set(ROLE_ENV_KEY, seed.roleEnv);
  if (seed?.dailyDate !== undefined) map.set(SESSION_DAILY_DATE_KEY, seed.dailyDate);
  const putKeys: string[] = [];
  return {
    putKeys,
    get: (async (key: string) => map.get(key)) as CombinedStorage["get"],
    put: (async (key: string, value: StudioStatus | RoleEnv | StudioEnv | string | boolean) => {
      putKeys.push(key);
      map.set(key, value);
    }) as CombinedStorage["put"],
    // Issue #228 item 4: SessionSyncStorage.delete is now required — this
    // fake never arms/consumes SESSION_FORCE_KEY itself.
    delete: (async (key: string) => map.delete(key)) as NonNullable<SessionSyncStorage["delete"]>,
  };
}

describe("restartWithSync — sync runs before bring-up, sync failure never blocks restart", () => {
  it("issues the session-sync tar exec BEFORE the bring-up exec, and the restart still succeeds", async () => {
    const execCalls: string[] = [];
    const sharedExec = async (cmd: string) => {
      execCalls.push(cmd);
      // C1 fix: a container with no session state yet makes the tar/gzip/stat
      // chain itself fail (non-zero) — syncSessionTick throws, restartWithSync
      // catches+logs it (asserted below via execCalls' own shape), and restart
      // proceeds regardless.
      if (cmd.startsWith("mkdir -p")) return { code: 1, stdout: "", stderr: "tar: .claude.json: Cannot stat: No such file or directory" };
      return { code: 0, stdout: "", stderr: "" }; // bring-up succeeds
    };
    const provisionDeps = baseProvisionDeps({ sbExec: sharedExec });
    const syncDeps: SessionSyncDeps = {
      exec: sharedExec,
      r2Put: vi.fn(async () => {}),
      r2List: vi.fn(async () => []),
      r2Delete: vi.fn(async () => {}),
      now: fixedNow(`${TODAY}T12:00:00.000Z`),
      notify: vi.fn(async () => {}),
      burnAlertThresholdTokens: 0,
    };
    const storage = fakeCombinedStorage({ roleEnv: { ROLE_PROMPT_B64: "x", ROLE_ALLOWED_TOOLS: "Edit", ROLE_EFFORT: "" } });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const status = await restartWithSync(provisionDeps, syncDeps, storage, STUDIO_ID, "rafarc21/fleetflare");

      expect(status.state).toBe("running");
      expect(execCalls[0]).toContain("tar -C /root"); // sync's own tar+stat ran first (and threw, caught above)
      // bring-up ran after it, unaffected. Issue #38 put the on-disk
      // verification AFTER bring-up on this path too (a rollout-replaced
      // container comes up through restart, and #29 had left that gap open),
      // so bring-up is no longer the LAST exec — the ordering this test is
      // about is sync-before-bring-up, and that is what it now asserts.
      expect(execCalls).toContain(BRINGUP_CMD);
      expect(execCalls.indexOf(BRINGUP_CMD)).toBeGreaterThan(0);
      expect(errSpy).toHaveBeenCalled(); // the sync failure was logged, not silently dropped
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a throwing session sync does not prevent the restart from running/succeeding", async () => {
    const provisionDeps = baseProvisionDeps({
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    });
    const syncDeps: SessionSyncDeps = {
      exec: vi.fn(async () => {
        throw new Error("exec exploded");
      }),
      r2Put: vi.fn(async () => {}),
      r2List: vi.fn(async () => []),
      r2Delete: vi.fn(async () => {}),
      now: fixedNow(`${TODAY}T12:00:00.000Z`),
      notify: vi.fn(async () => {}),
      burnAlertThresholdTokens: 0,
    };
    const storage = fakeCombinedStorage({ roleEnv: { ROLE_PROMPT_B64: "x", ROLE_ALLOWED_TOOLS: "Edit", ROLE_EFFORT: "" } });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const status = await restartWithSync(provisionDeps, syncDeps, storage, STUDIO_ID, "rafarc21/fleetflare");
      expect(status.state).toBe("running"); // restart proceeded despite sync's throw
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("no role env ever stored: restart still degrades with NO_ROLE_ENV_ERROR, sync still ran first", async () => {
    const execCalls: string[] = [];
    const sharedExec = async (cmd: string) => {
      execCalls.push(cmd);
      return { code: 1, stdout: "", stderr: "tar: nothing to archive yet" }; // C1: a fresh container's sync fails
    };
    const provisionDeps = baseProvisionDeps({ sbExec: sharedExec });
    const syncDeps: SessionSyncDeps = {
      exec: sharedExec,
      r2Put: vi.fn(async () => {}),
      r2List: vi.fn(async () => []),
      r2Delete: vi.fn(async () => {}),
      now: fixedNow(`${TODAY}T12:00:00.000Z`),
      notify: vi.fn(async () => {}),
      burnAlertThresholdTokens: 0,
    };
    const storage = fakeCombinedStorage(); // no roleEnv seeded
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const status = await restartWithSync(provisionDeps, syncDeps, storage, STUDIO_ID, "rafarc21/fleetflare");

      expect(status.state).toBe("degraded");
      expect(execCalls).toHaveLength(1); // only sync's own tar+stat — restartWithStorage never reaches bring-up
      expect(execCalls[0]).toContain("tar -C /root");
    } finally {
      errSpy.mockRestore();
    }
  });
});

// Review round 3 (issue #85 PR1), MUST-FIX 8(a): lastSnapshotAt was only ever
// recorded on syncSessionCycle's own 300s-tick R2 put — restartWithSync's,
// recycleWithSync's, and destroyWithSync's own pre-bring-up/pre-destroy
// syncSessionTick calls succeed at exactly the same R2 put and never
// recorded it, leaving `fleet ls`'s "snap <age>" column able to read stale
// by up to 300s after any of those three paths ran a fresh sync.
function fakeCombinedStorageWithObserved(
  seed?: { status?: StudioStatus; roleEnv?: RoleEnv | StudioEnv },
): CombinedStorage & ObservedStorage {
  const map = new Map<string, unknown>();
  if (seed?.status) map.set(STATUS_KEY, seed.status);
  if (seed?.roleEnv) map.set(ROLE_ENV_KEY, seed.roleEnv);
  return {
    get: (async (key: string) => map.get(key)) as never,
    put: (async (key: string, value: unknown) => { map.set(key, value); }) as never,
    // Issue #228 item 4: SessionSyncStorage.delete is now required — this
    // fake never arms/consumes SESSION_FORCE_KEY itself.
    delete: (async (key: string) => map.delete(key)) as never,
  } as CombinedStorage & ObservedStorage;
}

describe("restartWithSync — records lastSnapshotAt on every successful pre-restart sync (issue #85 review round 3, MUST-FIX 8a)", () => {
  it("a successful pre-restart sync merges lastSnapshotAt", async () => {
    const provisionDeps = baseProvisionDeps({ sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) });
    const syncDeps = fakeSyncDeps({ now: "2026-08-16T12:00:00.000Z" });
    const storage = fakeCombinedStorageWithObserved({
      roleEnv: { ROLE_PROMPT_B64: "x", ROLE_ALLOWED_TOOLS: "Edit", ROLE_EFFORT: "" },
    });

    await restartWithSync(provisionDeps, syncDeps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

    const observed = await getObserved(storage);
    expect(observed.lastSnapshotAt).toBe("2026-08-16T12:00:00.000Z");
  });

  it("a FAILED pre-restart sync never merges lastSnapshotAt", async () => {
    const provisionDeps = baseProvisionDeps({ sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) });
    const syncDeps = fakeSyncDeps({ statCode: 1, statStderr: "tar: nothing yet" });
    const storage = fakeCombinedStorageWithObserved({
      roleEnv: { ROLE_PROMPT_B64: "x", ROLE_ALLOWED_TOOLS: "Edit", ROLE_EFFORT: "" },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await restartWithSync(provisionDeps, syncDeps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);
      const observed = await getObserved(storage);
      expect(observed.lastSnapshotAt).toBeNull();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("no observedStorage passed: behaves exactly as before, no crash, nothing recorded", async () => {
    const provisionDeps = baseProvisionDeps({ sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) });
    const syncDeps = fakeSyncDeps({});
    const storage = fakeCombinedStorageWithObserved({
      roleEnv: { ROLE_PROMPT_B64: "x", ROLE_ALLOWED_TOOLS: "Edit", ROLE_EFFORT: "" },
    });

    const status = await restartWithSync(provisionDeps, syncDeps, storage, STUDIO_ID, "rafarc21/fleetflare");
    expect(status.state).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// recycleWithSync (do.ts) — sync -> destroy -> awaitReady -> reprovision.
//
// Second review pass (2026-08-20): a real `fleet recycle` run proved
// destroy() -> provision() alone races — destroy() resolves before the DO's
// own bookkeeping catches up, so provision()'s execs could run before any
// container was confirmed ready, and its work landed nowhere durable while
// the route still reported `running, error: null`. awaitReady closes that:
// provision() must never run until readiness is confirmed, and a
// destroy/readiness failure must build+record a DEGRADED status and THROW,
// never silently look like success. See do.ts's recycleWithSync doc comment
// and sandbox-api.ts's sbAwaitReady doc comment for the full mechanism (read
// from the pinned SDK's own compiled source).
//
// `destroy`/`awaitReady`/`provision` are plain callbacks here — do.ts's real
// recycle() wires them to Sandbox.destroy()/sbAwaitReady(this)/
// StudioDO.provision(), all of which need a live DO and are therefore out of
// reach for a unit test (see this file's own header) — so this suite is only
// about the ordering/failure-handling recycleWithSync itself adds around
// them, the same scope restartWithSync's own suite above keeps toward
// restartWithStorage.
// ---------------------------------------------------------------------------

describe("provisionedCheckCmd — the shell shape recycle measures success with", () => {
  it("checks the repo's OWN checkout path and claude's tmux pane, and says which one is missing", () => {
    const cmd = provisionedCheckCmd("websites");

    // The clone target guardedCloneCmd creates for this same repo — a check
    // pointed at a different path would pass over a studio with no checkout.
    expect(cmd).toContain("/workspace/websites/.git");
    // Liveness read from the same tmux field bring-up itself keys off, and
    // addressed by NAME so extra/active windows cannot mislead it.
    expect(cmd).toContain("tmux display-message -p -t studio:claude '#{pane_current_command}'");
    // Every outcome is announced on stdout — the ONLY channel this check has
    // (see the exit-builtin test below).
    expect(cmd).toContain(`echo "${PROVISIONED_OK}"`);
    expect(cmd).toContain('echo "no git checkout at /workspace/websites"');
    expect(cmd).toContain("claude is not running in tmux studio:claude");
  });

  it("never calls `exit` — that kills the sandbox session shell, not the command (the 2026-08-25 false negative)", () => {
    const cmd = provisionedCheckCmd("websites");
    // Measured on the deployed Worker: a check ending in `exit 0` terminated
    // the "sandbox-default" session and the SDK threw `Session
    // 'sandbox-default' shell exited (exit code: 0)` — so a fully healthy
    // studio (repo cloned, session restored, hook, 6 skills, claude running)
    // came back as a 500. Deterministic, not flaky: the SUCCESS branch was
    // the one that fired it.
    expect(cmd).not.toMatch(/(^|[;&|(\s])exit\b/);
  });

  it("waits for claude rather than demanding it instantly — bring-up send-keys the launch and returns", () => {
    expect(provisionedCheckCmd("websites")).toContain(`[ "$i" -lt ${PROVISIONED_CHECK_TRIES} ]`);
    expect(PROVISIONED_CHECK_TRIES).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Task 3 (P5a guardrails): rescue-push. P4 §2.14, never built until now — see
// do.ts's own doc comment on rescuePush for the full design. These two
// describe blocks cover the pure command/parse pair in isolation; the
// recycleWithSync block further below covers where it actually gets called.
// ---------------------------------------------------------------------------

describe("rescuePushCmd — the shell shape rescue-push commits and pushes with", () => {
  it("checks the repo's own checkout path, the dirty-tree status, and resolves a generated push target", () => {
    const cmd = rescuePushCmd("websites", STUDIO_ID);

    expect(cmd).toContain("/workspace/websites/.git");
    // Issue #39: called through rescue_wt, which reports the worktree.
    expect(cmd).toContain('rescue_wt "/workspace/websites" "checkout" "checkout"');
    expect(cmd).toContain("rescue_one() {");
    expect(cmd).toContain('git -C "$w" status --porcelain');
    expect(cmd).toContain('git -C "$w" add -A');
    // Issue #207: every push now uses --no-verify unconditionally — see
    // rescue_push()'s own doc comment in rescue.ts.
    // Issue #1 piece 5 + blocker 2: configurable destination; origin (the
    // default) pushes via plain `git` on PATH = the leak-gate wrapper.
    // Issue #16: the push itself lives in rescue_try_push (shallow fallback).
    expect(cmd).toContain('"${__rgit[@]}" -C "$w" push $nv "$__rdest" "$src:refs/heads/$ref"');
    expect(cmd).toContain('rescue_try_push "$w" --no-verify "$ref" "$target"');
    expect(cmd).toContain("__rgit=(git); __rdest=origin");
    expect(cmd).not.toContain("/usr/bin/git");
    expect(cmd).toContain(`echo "${RESCUE_NO_CHECKOUT}"`);
    expect(cmd).toContain(`echo "${RESCUE_CLEAN}"`);
    expect(cmd).toContain(RESCUE_PUSHED_PREFIX);
  });

  // Issue #207 (2026-10-03): a test used to live here ("resolves the repo's
  // ACTUAL default branch rather than hardcoding main") pinning the
  // branch-vs-default resolution `rescue_target()` used to do in checkout
  // mode (Fix round 2, 2026-08-27, T5 Finding 1, HIGH). There is no
  // default-branch resolution left in `rescuePushCmd` at all — checkout mode
  // always generates now, exactly like `rescueSnapshotCmd`'s own
  // `snapshot_target()` (#312) — so there is nothing left to pin here.
  it("diverts to a generated fleet/rescue/<studio>-<UTC stamp> ref unconditionally in checkout mode (fail safe, not fail open — no branch/default inspection left to get wrong)", () => {
    const cmd = rescuePushCmd("websites", STUDIO_ID);
    expect(cmd).toContain(`target="fleet/rescue/${STUDIO_ID}-$(date -u +%Y%m%d%H%M%S)"`);
    expect(cmd).not.toContain("target_generated");
    expect(cmd).not.toContain('"$default"');
    expect(cmd).not.toContain('"$branch"');
  });

  // Issue #207: a test used to live here ("treats a detached HEAD... the
  // same as the default branch") proving `branch = "HEAD"` (detached state)
  // never reached the real-branch push path (#251 review finding). Branch/
  // HEAD is never inspected by `rescue_target()` at all any more — there is
  // no special case left to prove, detached or not.

  it("commits under a fixed fleet identity by default — Dockerfile.studio configures no git user.name/user.email of its own", () => {
    // Issue #335: the real identity is env-configured now (do.ts's
    // syncDeps() reads FLEET_BOT_NAME/_EMAIL); with no override this
    // neutral default is what every existing caller/test still gets.
    const cmd = rescuePushCmd("websites", STUDIO_ID);
    expect(cmd).toContain('user.name="fleetflare[bot]"');
    expect(cmd).toContain('user.email="fleetflare[bot]@users.noreply.github.com"');
  });

  it("never calls `exit` — same reason provisionedCheckCmd never does: this runs inside the shared sandbox-default session", () => {
    expect(rescuePushCmd("websites", STUDIO_ID)).not.toMatch(/(^|[;&|(\s])exit\b/);
  });

  it("never bare `cd`s — every git subcommand is `git -C <dir>`, so it cannot leak a cwd into the next sbExec call on the same shared session", () => {
    expect(rescuePushCmd("websites", STUDIO_ID)).not.toMatch(/(^|[;&|(\s])cd\b/);
  });
});

// Issue #1 piece 5: deps.rescueTarget (do.ts wires FLEET_RESCUE_REMOTE + a
// minted token) picks the push URL; its env rides the exec, never the cmd.
describe("rescuePush/rescueSnapshot — private rescue remote wiring", () => {
  function withTarget(target: { remoteUrl?: string; env?: Record<string, string> } | undefined) {
    const base = fakeSyncDeps();
    const envs: (Record<string, string> | undefined)[] = [];
    const deps: SessionSyncDeps = {
      ...base,
      exec: async (cmd: string, env?: Record<string, string>) => { envs.push(env); return base.exec(cmd); },
      ...(target ? { rescueTarget: async () => target } : {}),
    };
    return { deps, base, envs };
  }
  const URL = "https://github.com/acme/rescue-vault.git";

  it("rescuePush: target set -- cmd pushes to that URL, token env passed to exec, token never in the cmd", async () => {
    const { deps, base, envs } = withTarget({ remoteUrl: URL, env: { FLEET_RESCUE_TOKEN: "ghs_fake" } });
    await rescuePush(deps, "websites", STUDIO_ID);
    expect(base.execCalls).toEqual([
      rescuePushCmd("websites", STUDIO_ID, undefined, undefined, undefined, undefined, undefined, undefined, { remoteUrl: URL }),
    ]);
    expect(base.execCalls[0]).toContain(`__rdest='${URL}'`);
    expect(base.execCalls[0]).not.toContain("ghs_fake");
    expect(envs).toEqual([{ FLEET_RESCUE_TOKEN: "ghs_fake" }]);
  });

  it("rescueSnapshot: target set -- same URL + env wiring", async () => {
    const { deps, base, envs } = withTarget({ remoteUrl: URL, env: { FLEET_RESCUE_TOKEN: "ghs_fake" } });
    await rescueSnapshot(deps, "websites", STUDIO_ID);
    expect(base.execCalls).toEqual([
      rescueSnapshotCmd("websites", STUDIO_ID, undefined, undefined, undefined, undefined, undefined, undefined, { remoteUrl: URL }),
    ]);
    expect(envs).toEqual([{ FLEET_RESCUE_TOKEN: "ghs_fake" }]);
  });

  it("empty target (unset / mint failed) or no rescueTarget port: origin, exec gets no env", async () => {
    for (const t of [{}, undefined]) {
      const { deps, base, envs } = withTarget(t);
      await rescuePush(deps, "websites", STUDIO_ID);
      expect(base.execCalls).toEqual([rescuePushCmd("websites", STUDIO_ID)]);
      expect(envs).toEqual([undefined]);
    }
  });
});

describe("rescuePush — commits + pushes a dirty tree before teardown, or says why it didn't", () => {
  it("no checkout at all: nothing to rescue, not an error", async () => {
    const syncDeps = fakeSyncDeps({ rescue: { code: 0, stdout: RESCUE_NO_CHECKOUT } });
    const result = await rescuePush(syncDeps, "websites", STUDIO_ID);
    expect(result).toEqual({ pushed: false, branch: null, files: 0, skipped: "no checkout" });
  });

  it("clean tree: the common case (most studios die clean) — a normal outcome, not an error", async () => {
    const syncDeps = fakeSyncDeps(); // default rescue response is RESCUE_CLEAN
    const result = await rescuePush(syncDeps, "websites", STUDIO_ID);
    expect(result).toEqual({ pushed: false, branch: null, files: 0, skipped: "clean" });
    expect(syncDeps.execCalls).toContain(rescuePushCmd("websites", STUDIO_ID));
  });

  it("on a real task branch: commits, pushes there directly, and reports that branch + file count", async () => {
    const syncDeps = fakeSyncDeps({ rescue: { code: 0, stdout: "RESCUE_PUSHED task/42-fix-thing 3 files" } });
    const result = await rescuePush(syncDeps, "websites", STUDIO_ID);
    expect(result).toEqual({ pushed: true, branch: "task/42-fix-thing", files: 3, kind: "files" });
  });

  // Issue #266: the SAME dirty-tree-push shape above, but for a rescue whose
  // count is COMMITS (a clean tree with unpushed commits) instead of files —
  // the label must follow the wire format's own third field, never a
  // hardcoded "files".
  it("clean tree with unpushed commits: reports the SAME count field, but labeled 'commits'", async () => {
    const syncDeps = fakeSyncDeps({ rescue: { code: 0, stdout: "RESCUE_PUSHED task/42-fix-thing 2 commits" } });
    const result = await rescuePush(syncDeps, "websites", STUDIO_ID);
    expect(result).toEqual({ pushed: true, branch: "task/42-fix-thing", files: 2, kind: "commits" });
  });

  // Fix round 2 (T5 Finding 1, HIGH): this level only proves rescuePush's
  // PARSING carries whatever target the shell reports through into
  // `branch` unchanged, unaltered and un-renamed — vitest's exec fake
  // cannot run the shell's OWN default-branch resolution for real. That
  // half is verified live instead: a real shallow clone, a real diverged
  // `main`, a real rejected push straight to `main` vs. a real accepted
  // push to a generated ref — see do.ts's rescuePushCmd doc comment and
  // this fix's own report for the transcript.
  it('on the default branch: rescuePush reports the generated rescue ref the shell ACTUALLY landed on, never "main"', async () => {
    const generatedRef = `fleet/rescue/${STUDIO_ID}-20260827120000`;
    const syncDeps = fakeSyncDeps({ rescue: { code: 0, stdout: `RESCUE_PUSHED ${generatedRef} 2 files` } });
    const result = await rescuePush(syncDeps, "websites", STUDIO_ID);
    expect(result).toEqual({ pushed: true, branch: generatedRef, files: 2, kind: "files" });
  });

  // Issue #251: rescuePushCmd now walks every git worktree, so one exec can
  // report more than one RESCUE_PUSHED line at once — the main checkout AND
  // a member worktree, each independently dirty/unpushed in the same run.
  it("more than one RESCUE_PUSHED line: pushed/branch/files still describe the FIRST (unchanged shape), pushes carries every one", async () => {
    const syncDeps = fakeSyncDeps({
      rescue: {
        code: 0,
        stdout:
          "RESCUE_PUSHED task/42-fix-thing 3 files\nRESCUE_PUSHED fleet/rescue/pilot/wt/agent-a1-20260925060000 1 commits",
      },
    });
    const result = await rescuePush(syncDeps, "websites", STUDIO_ID);
    expect(result).toEqual({
      pushed: true, branch: "task/42-fix-thing", files: 3, kind: "files",
      pushes: [
        { branch: "task/42-fix-thing", files: 3, kind: "files" },
        { branch: "fleet/rescue/pilot/wt/agent-a1-20260925060000", files: 1, kind: "commits" },
      ],
    });
  });

  // PR #263 round 2, C1: a RESCUE_FAILED line means a worktree's own
  // status/add/commit/push failed — never a success, even when some OTHER
  // worktree in the same run pushed cleanly (the message below still needs
  // to name both).
  it("a RESCUE_FAILED line throws, naming the failed worktree even beside a real push", async () => {
    const syncDeps = fakeSyncDeps({
      rescue: {
        code: 0,
        stdout: `RESCUE_PUSHED fleet/rescue/${STUDIO_ID}-20260925060000 1 files\n${RESCUE_FAILED_PREFIX} agent-a1 push`,
      },
    });
    await expect(rescuePush(syncDeps, "websites", STUDIO_ID)).rejects.toThrow(/agent-a1/);
  });

  // PR #263 round 2, C1 mutant: a killed exec (timeout's own 124, or a
  // SIGKILL 137) answers nothing, even when its truncated stdout happens to
  // look like a complete RESCUE_PUSHED line — isDeadlineExit must be checked
  // BEFORE any output parsing, or a partial push reads as a real success.
  it("exit 124 (killed mid-exec) throws even though stdout looks like a complete RESCUE_PUSHED line", async () => {
    const syncDeps = fakeSyncDeps({
      rescue: { code: 124, stdout: `RESCUE_PUSHED fleet/rescue/${STUDIO_ID}-20260925060000 1 files`, stderr: "" },
    });
    await expect(rescuePush(syncDeps, "websites", STUDIO_ID)).rejects.toThrow();
  });

  // Board issue #371 (#362 follow-up): rescue.ts's new budget guard emits a
  // FOUR-token failure line — `RESCUE_FAILED <id> budget <n> not attempted`
  // — rather than the two-token `<id> <step>` shape every other RESCUE_FAILED
  // line already uses. do.ts's own `failLine` regex must accept an OPTIONAL
  // trailing detail after the two required fields so this new shape parses
  // (worktree/step/detail) AND surfaces in the thrown error's own message,
  // not only on raw stdout — while an old, pre-existing two-token line
  // (`push`/`commit`/`add`/`status`/`rev-parse`/`rev-list`) must still parse
  // identically to before, with no `detail` at all.
  it("a RESCUE_FAILED <id> budget <n> not attempted line parses its trailing detail and surfaces it in the thrown message, beside an old-format 2-token line unaffected", async () => {
    const syncDeps = fakeSyncDeps({
      rescue: {
        code: 0,
        stdout: `${RESCUE_FAILED_PREFIX} agent-a1 push\n${RESCUE_FAILED_PREFIX} agent-a2 budget 12 not attempted`,
      },
    });
    let caught: unknown;
    try {
      await rescuePush(syncDeps, "websites", STUDIO_ID);
      throw new Error("expected rescuePush to throw");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RescuePushFailedError);
    const failed = caught as RescuePushFailedError;
    expect(failed.message).toContain("agent-a1 (push)");
    expect(failed.message).toContain("agent-a2 (budget: 12 not attempted)");
    expect(failed.fails).toEqual([
      { worktree: "agent-a1", step: "push" },
      { worktree: "agent-a2", step: "budget", detail: "12 not attempted" },
    ]);
  });

  it("a rejected push (or any other unrecognisable output) throws — the caller decides whether that's safe to ignore", async () => {
    const syncDeps = fakeSyncDeps({ rescue: { code: 1, stdout: "", stderr: "! [rejected] HEAD -> task/42 (fetch first)" } });
    await expect(rescuePush(syncDeps, "websites", STUDIO_ID)).rejects.toThrow(/rejected/);
  });

  // Board issue #371, maestro note (live 2026-09-26 09:01Z, main 57a4e9f4
  // rescue-all): example-app--pilot reported "FAILED rescue-snapshot failed
  // (exit 0: remote: ... RESCUE_PUSHED ... RESCUE_PUSHED ...)" -- both pushes
  // genuinely landed, exit 0, zero RESCUE_FAILED lines, yet thrown as a
  // failure. Root cause, confirmed by a live repro (a real bare git repo with
  // a post-receive hook emitting GitHub's own "Create a pull request" hint --
  // see this fix's own report for the transcript): rescue.ts's `rescue_push()`
  // helper properly captures a push's real stderr into a local `perr` and
  // discards it on success, and even the branch-walk/stash-walk call sites'
  // OWN unguarded `git push` (no redirection at all) keep that hint cleanly on
  // the exec's real stderr, never stdout, when the two streams stay separate.
  // Whatever the exact production exec-transport plumbing that let this text
  // ride along on `res.stdout` instead (outside rescue.ts's own control), the
  // text below is the REAL, live-captured "remote: ..." hint from that repro,
  // exactly as it appeared beside two genuine RESCUE_PUSHED lines. The old
  // `pushes.length === lines.length` success gate had ZERO tolerance for any
  // extra, unrecognised-but-harmless line landing on stdout — this reproduces
  // the exact false-failure maestro observed.
  it("a benign 'remote: ...' hint line beside real RESCUE_PUSHED lines must NOT flip a real success into a false failure", async () => {
    const realRemoteHint =
      "remote: \n" +
      "remote: Create a pull request for 'task/feature' on GitHub by visiting:        \n" +
      "remote:      https://github.com/example/repo/pull/new/task/feature        \n" +
      "remote: ";
    const syncDeps = fakeSyncDeps({
      rescue: {
        code: 0,
        stdout:
          `${realRemoteHint}\n` +
          "RESCUE_PUSHED task/42-fix-thing 3 files\n" +
          `RESCUE_PUSHED fleet/rescue/pilot/wt/agent-a1-20260925060000 1 commits\n`,
        stderr: "",
      },
    });
    const result = await rescuePush(syncDeps, "websites", STUDIO_ID);
    expect(result).toEqual({
      pushed: true, branch: "task/42-fix-thing", files: 3, kind: "files",
      pushes: [
        { branch: "task/42-fix-thing", files: 3, kind: "files" },
        { branch: "fleet/rescue/pilot/wt/agent-a1-20260925060000", files: 1, kind: "commits" },
      ],
    });
  });

  // Board issue #371, maestro must-fix (PR #376 review): the "remote:"-line
  // fix above over-reached by dropping `res.code === 0` from the success
  // gate entirely. A genuinely FAILED exec (a mid-script bash syntax error,
  // exit 2) that happened to print one real RESCUE_PUSHED line before
  // crashing must never read as a full success — any worktree the script
  // never reached must not be silently reported as rescued. This undoes
  // #251's whole fail-closed guarantee if left unfixed.
  it("exit code 2 (mid-script bash syntax error) with one genuine RESCUE_PUSHED line must NOT be reported as success", async () => {
    const syncDeps = fakeSyncDeps({
      rescue: {
        code: 2,
        stdout: `RESCUE_PUSHED fleet/rescue/${STUDIO_ID}-20260925060000 1 files`,
        stderr: "rescue.sh: line 42: syntax error near unexpected token `)'",
      },
    });
    const rescued = rescuePush(syncDeps, "websites", STUDIO_ID);
    await expect(rescued).rejects.toThrow(/exit 2/);
    // The unreached-worktree information must not be silently swallowed —
    // the thrown message names the real cause, not a generic empty failure.
    await expect(rescued).rejects.toThrow(/syntax error/);
  });

  // Board issue #371, maestro must-fix (PR #376 review): the same
  // over-reached fix also dropped ALL line-completeness checking, not just
  // tolerance for `remote:` lines — a malformed `RESCUE_FAILED  push` line
  // (two spaces: an empty/missing worktree id, which fails failLine's
  // `(\S+)` group) must not silently vanish and let an unrelated genuine
  // RESCUE_PUSHED line read as the whole exec's success.
  it("a malformed 'RESCUE_FAILED  push' line (empty worktree id) beside a genuine RESCUE_PUSHED line must NOT silently pass as success", async () => {
    const syncDeps = fakeSyncDeps({
      rescue: {
        code: 0,
        stdout: `RESCUE_PUSHED fleet/rescue/${STUDIO_ID}-20260925060000 1 files\n${RESCUE_FAILED_PREFIX}  push`,
      },
    });
    await expect(rescuePush(syncDeps, "websites", STUDIO_ID)).rejects.toThrow();
  });

  it("the exec itself throwing propagates — same failure contract as syncSessionTick's own", async () => {
    const syncDeps = fakeSyncDeps({ rescue: null });
    await expect(rescuePush(syncDeps, "websites", STUDIO_ID)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Task 4 (P5a guardrails): teardown learning harvest. P4 section 8 designed
// three memory layers and none were built; P5 section 9 assigns this one to
// the SAME pre-destroy seam rescue-push already proved out — see do.ts's own
// doc comment on harvestLearnings for the full design. These two describe
// blocks cover the pure command/read pair in isolation; the recycleWithSync
// block further below covers where it actually gets called, beside
// rescue-push.
// ---------------------------------------------------------------------------

describe("harvestRecordCmd — the shell shape the teardown harvest reads its done record with", () => {
  // Board issue #316 (PR #325 review): the harvest reads EXACTLY the delivered
  // task's .fleet/done/<task>.json — never the newest file, which after a
  // clone can be an old, merged task's. Behavior is executed against a real
  // git fixture in test/bun/harvest-record.test.ts; these pin the shape.
  it("reads the delivered task's record from the workspace record dir, never the product checkout (#361)", () => {
    const cmd = harvestRecordCmd("websites", 316);
    expect(cmd).toContain("/workspace/.fleet/done/316.json");
    expect(cmd).not.toContain("/workspace/websites/");
    expect(cmd).not.toContain("ls -t");
  });

  it("unknown task: says no record, never a guess", () => {
    expect(harvestRecordCmd("websites", null)).toBe(`echo "${HARVEST_NO_RECORD}"`);
  });

  it("never calls `exit` — same reason rescuePushCmd never does: this runs inside the shared sandbox-default session", () => {
    expect(harvestRecordCmd("websites", 316)).not.toMatch(/(^|[;&|(\s])exit\b/);
  });

  it("never contains `status --porcelain` — that substring is the rescue-push builder's dispatch marker", () => {
    expect(harvestRecordCmd("websites", 316)).not.toContain("status --porcelain");
  });
});

describe("harvestLearnings — reads the studio's own .fleet/done.json and commits each learning as its own file, or says why it didn't", () => {
  it("no record: nothing to harvest, not an error", async () => {
    const syncDeps = fakeSyncDeps(); // default harvest response is HARVEST_NO_RECORD
    const commit = fakeCommit();
    const result = await harvestLearnings(syncDeps, "websites", STUDIO_ID, noopResolveMemoryRepo, commit.commit, null);
    expect(result).toEqual({ harvested: false, count: 0, skipped: "no record" });
    expect(commit.calls).toHaveLength(0);
  });

  it("record exists, no learnings field: nothing to harvest — most gated studios never write one", async () => {
    const syncDeps = fakeSyncDeps({ harvest: { code: 0, stdout: JSON.stringify({ plan: "docs/x.md", verification: [] }) } });
    const commit = fakeCommit();
    const result = await harvestLearnings(syncDeps, "websites", STUDIO_ID, noopResolveMemoryRepo, commit.commit, null);
    expect(result).toEqual({ harvested: false, count: 0, skipped: "no learnings" });
    expect(commit.calls).toHaveLength(0);
  });

  it("record exists, empty learnings array: nothing to harvest", async () => {
    const syncDeps = fakeSyncDeps({ harvest: { code: 0, stdout: JSON.stringify({ learnings: [] }) } });
    const result = await harvestLearnings(syncDeps, "websites", STUDIO_ID, noopResolveMemoryRepo, noopCommit, null);
    expect(result).toEqual({ harvested: false, count: 0, skipped: "no learnings" });
  });

  // #341: no memory store configured (FLEET_OPS_REPO unset) -- the public
  // default. Learnings are read and dropped, never committed anywhere.
  it("memory store off: learnings are not committed anywhere, and it says why", async () => {
    const syncDeps = fakeSyncDeps({ harvest: { code: 0, stdout: JSON.stringify({ learnings: ["a real learning"] }) } });
    const commit = fakeCommit();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await harvestLearnings(syncDeps, "websites", STUDIO_ID, async () => null, commit.commit, null);
      expect(result).toEqual({ harvested: false, count: 0, skipped: "memory store off (FLEET_OPS_REPO unset)", lost: 1 });
      expect(commit.calls).toHaveLength(0);
      // #346 review item 2: never silent -- the loss is logged, naming the setting.
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0]!.join(" ")).toMatch(/1 learning\(s\) NOT harvested.*FLEET_OPS_REPO/);
    } finally {
      errors.mockRestore();
    }
  });

  it("memory store off with NO learnings: nothing lost, nothing logged", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await harvestLearnings(fakeSyncDeps(), "websites", STUDIO_ID, async () => null, noopCommit, null);
      expect(result).toEqual({ harvested: false, count: 0, skipped: "no record" });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("nothing to harvest never resolves the blueprint repo — a wasted fleet.json fetch on the common case", async () => {
    const syncDeps = fakeSyncDeps(); // HARVEST_NO_RECORD
    const resolve = fakeResolveMemoryRepo();
    await harvestLearnings(syncDeps, "websites", STUDIO_ID, resolve.resolve, noopCommit, null);
    expect(resolve.calls).toBe(0);
  });

  it("one real learning: commits one file under fleet/memory/<studio>/, verbatim, with name + description + metadata.type frontmatter", async () => {
    const syncDeps = fakeSyncDeps({
      harvest: { code: 0, stdout: JSON.stringify({ learnings: ["rembg beats every matte for a dark portrait rim light"] }) },
    });
    const commit = fakeCommit();
    const result = await harvestLearnings(syncDeps, "websites", STUDIO_ID, noopResolveMemoryRepo, commit.commit, null);

    expect(result).toEqual({ harvested: true, count: 1 });
    expect(commit.calls).toHaveLength(1);
    const { path, content, message } = commit.calls[0];
    expect(path).toMatch(new RegExp(`^fleet/memory/${STUDIO_ID}/.*\\.md$`));
    expect(content).toMatch(/^---\nname: /);
    expect(content).toContain("description:");
    expect(content).toContain("type: learning");
    // Verbatim — spec section 9's second compaction rule ("numbers, names,
    // commands, dates survive verbatim") applies to the ORIGINAL write too,
    // not only a later compaction pass.
    expect(content).toContain("rembg beats every matte for a dark portrait rim light");
    expect(message).toContain(STUDIO_ID);
  });

  // Fix round 1 (reviewer finding): the earlier version of this function
  // committed to env.AGENT_REPO. P4 section 8 / P5 section 7 both put fleet
  // memory in the BLUEPRINT repo specifically, and P4a's dynamic repo
  // selection can make that diverge from BOTH env.AGENT_REPO and the
  // studio's own WORK repo — this pins the fix so a future change cannot
  // quietly put it back.
  it("commits to the RESOLVED blueprint repo — never the studio's own work repo, never a hardcoded fleet repo", async () => {
    const syncDeps = fakeSyncDeps({
      harvest: { code: 0, stdout: JSON.stringify({ learnings: ["one fact"] }) },
    });
    const commit = fakeCommit();
    const resolve = fakeResolveMemoryRepo("acme-org/fleetflare-agency");

    await harvestLearnings(syncDeps, "websites", STUDIO_ID, resolve.resolve, commit.commit, null);

    expect(resolve.calls).toBe(1);
    expect(commit.calls).toHaveLength(1);
    expect(commit.calls[0].repo).toBe("acme-org/fleetflare-agency");
    // The two repos this must NOT be, named explicitly: "websites" is the
    // `repo` param above (the studio's WORK repo, rescuePush's own target).
    expect(commit.calls[0].repo).not.toBe("websites");
  });

  it("multiple learnings: one file per fact (spec section 9 — compaction merges INDEX LINES, never memory files), each committed separately, all to the SAME resolved repo", async () => {
    const syncDeps = fakeSyncDeps({
      harvest: { code: 0, stdout: JSON.stringify({ learnings: ["first fact", "second fact"] }) },
    });
    const commit = fakeCommit();
    const resolve = fakeResolveMemoryRepo("acme-org/fleetflare-agency");
    const result = await harvestLearnings(syncDeps, "websites", STUDIO_ID, resolve.resolve, commit.commit, null);

    expect(result).toEqual({ harvested: true, count: 2 });
    expect(commit.calls).toHaveLength(2);
    expect(commit.calls[0].path).not.toBe(commit.calls[1].path);
    expect(commit.calls[0].content).toContain("first fact");
    expect(commit.calls[1].content).toContain("second fact");
    // Resolved ONCE per batch, reused for every learning — not refetched
    // per file.
    expect(resolve.calls).toBe(1);
    expect(commit.calls[0].repo).toBe("acme-org/fleetflare-agency");
    expect(commit.calls[1].repo).toBe("acme-org/fleetflare-agency");
  });

  it("a commit failure on one learning does not block the others — best-effort, losing one is still better than losing the batch", async () => {
    const syncDeps = fakeSyncDeps({
      harvest: { code: 0, stdout: JSON.stringify({ learnings: ["fact one", "fact two"] }) },
    });
    let attempts = 0;
    const commit: CommitLearningFile = async () => {
      attempts++;
      if (attempts === 1) throw new Error("GitHub 500");
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await harvestLearnings(syncDeps, "websites", STUDIO_ID, noopResolveMemoryRepo, commit, null);
      expect(result).toEqual({ harvested: true, count: 1 }); // one of two saved
      expect(attempts).toBe(2); // both attempted, the first one's failure didn't stop the second
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("malformed JSON in done.json throws — the caller decides whether that's safe to ignore", async () => {
    const syncDeps = fakeSyncDeps({ harvest: { code: 0, stdout: "{not json" } });
    await expect(harvestLearnings(syncDeps, "websites", STUDIO_ID, noopResolveMemoryRepo, noopCommit, null)).rejects.toThrow();
  });

  it("a learnings field shaped wrong (non-array) throws, held to the same rule the board envelope enforces", async () => {
    const syncDeps = fakeSyncDeps({ harvest: { code: 0, stdout: JSON.stringify({ learnings: "not an array" }) } });
    await expect(harvestLearnings(syncDeps, "websites", STUDIO_ID, noopResolveMemoryRepo, noopCommit, null)).rejects.toThrow(/learnings/);
  });

  it("the exec itself throwing propagates — same failure contract as rescuePush's own", async () => {
    const syncDeps = fakeSyncDeps({ harvest: null });
    await expect(harvestLearnings(syncDeps, "websites", STUDIO_ID, noopResolveMemoryRepo, noopCommit, null)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Issue #361: completion records live outside the product checkout
// (/workspace/.fleet/done/<task>.json). At teardown the Worker -- the only
// holder of ops-repo write credentials -- copies each to the private ops repo
// at done/<owner>-<repo>/<task>.json, or, with FLEET_OPS_REPO unset, posts it
// on the task's board issue. Never into the product repo; never a throw for
// an unset ops repo.
// ---------------------------------------------------------------------------

function listing(records: Record<string, string>): string {
  return Object.entries(records)
    .map(([task, body]) => `${task}\t${btoa(unescape(encodeURIComponent(body)))}`)
    .join("\n");
}

/** #367 round 2: a minimal DoneRecordHashStorage fake -- one map, seeded or
 *  not, the same shape the real DO storage key (DONE_RECORD_HASHES_KEY)
 *  holds. Reused across two archiveDoneRecords calls (rather than a fresh one
 *  per call) is exactly what proves the SECOND call sees the FIRST call's
 *  stamped hash -- a fresh instance per call would trivially "pass" every
 *  idempotency test for the wrong reason (nothing was ever shared). */
function fakeHashStorage(seed?: Record<string, string>): DoneRecordHashStorage & { current(): Record<string, string> | undefined } {
  let hashes = seed;
  return {
    get: async () => hashes,
    put: async (_key, value) => { hashes = value; },
    current: () => hashes,
  };
}

function archiveDeps(
  records: Record<string, string>,
  opts: { put?: DoneRecordPorts["putOpsFile"]; comment?: DoneRecordPorts["commentOnTask"] } = {},
) {
  const base = fakeSyncDeps();
  const comments: { repo: string; task: number; body: string }[] = [];
  const puts: { repo: string; path: string; content: string; message: string }[] = [];
  const deps: SessionSyncDeps & { execCalls: string[] } = {
    ...base,
    exec: async (cmd: string) => {
      if (cmd === doneRecordsListCmd()) {
        base.execCalls.push(cmd);
        return { code: 0, stdout: listing(records), stderr: "" };
      }
      return base.exec(cmd);
    },
    doneRecords: {
      workRepoSlug: async () => "acme/websites",
      putOpsFile: async (repo, path, content, message) => {
        if (opts.put) await opts.put(repo, path, content, message);
        puts.push({ repo, path, content, message });
      },
      commentOnTask: async (repo, task, body) => {
        if (opts.comment) await opts.comment(repo, task, body);
        comments.push({ repo, task, body });
      },
    },
  };
  return { deps, comments, puts, storage: fakeHashStorage() };
}

describe("archiveDoneRecords — completion records go to the ops repo, never the product repo (#361)", () => {
  const R316 = JSON.stringify({ plan: "docs/p.md", verification: [] });
  const R250 = "{\"plan\": \"docs/q.md\"}\n";

  // Must catch: a record written to the work repo when the ops repo is set.
  it("ops repo set: each record lands at done/<owner>/<repo>/<task>.json in the OPS repo, byte for byte", async () => {
    const { deps, comments, puts, storage } = archiveDeps({ "316": R316, "250": R250 });
    const result = await archiveDoneRecords(deps, storage, STUDIO_ID, async () => "rafarc21/fleetflare-ops");
    expect(result).toEqual({ archived: 2, commented: 0, failed: 0 });
    expect(puts.map((c) => [c.repo, c.path, c.content])).toEqual([
      // Glob order, as the real list command emits: 250 before 316.
      ["rafarc21/fleetflare-ops", "done/acme/websites/250.json", R250],
      ["rafarc21/fleetflare-ops", "done/acme/websites/316.json", R316],
    ]);
    expect(puts.every((c) => c.repo !== "acme/websites")).toBe(true);
    expect(comments).toEqual([]);
  });

  // Issue #367: `workRepo.replace("/", "-")` flattened the repo's own "/"
  // into "-", so an owner/repo pair like "a-b/c" and one like "a/b-c" both
  // collapsed to the identical ops path "done/a-b-c/<task>.json" -- a real
  // collision between two genuinely different repos. Dropping the replace
  // lets workRepo's own "/" produce the correctly nested two-segment path
  // instead, so two DIFFERENT (owner, repo) pairs can no longer collide.
  it("#367: two different owner/repo pairs that used to collide under the flattened path now produce different paths", async () => {
    const first = archiveDeps({ "1": "{}" });
    await archiveDoneRecords(
      { ...first.deps, doneRecords: { ...first.deps.doneRecords!, workRepoSlug: async () => "a-b/c" } },
      first.storage, STUDIO_ID, async () => "o/ops",
    );
    const second = archiveDeps({ "1": "{}" });
    await archiveDoneRecords(
      { ...second.deps, doneRecords: { ...second.deps.doneRecords!, workRepoSlug: async () => "a/b-c" } },
      second.storage, STUDIO_ID, async () => "o/ops",
    );
    expect(first.puts[0]!.path).toBe("done/a-b/c/1.json");
    expect(second.puts[0]!.path).toBe("done/a/b-c/1.json");
    expect(first.puts[0]!.path).not.toBe(second.puts[0]!.path);
  });

  // Must catch: a throw (or a repo write) when FLEET_OPS_REPO is unset.
  it("ops repo unset: no repo write at all; each record goes on its board task as a comment, and nothing throws", async () => {
    const { deps, comments, puts, storage } = archiveDeps({ "316": R316 });
    const result = await archiveDoneRecords(deps, storage, STUDIO_ID, async () => null);
    expect(result).toEqual({ archived: 0, commented: 1, failed: 0 });
    expect(puts).toEqual([]);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.repo).toBe("acme/websites");
    expect(comments[0]!.task).toBe(316);
    expect(comments[0]!.body).toContain(R316);
    expect(comments[0]!.body).toContain("FLEET_OPS_REPO");
  });

  // #363 round 2: an ops write that fails must not lose the record.
  it("ops write fails: the record falls back to its board comment, logged, nothing thrown", async () => {
    const { deps, comments, storage } = archiveDeps({ "316": R316, "250": R250 }, {
      put: async (_r, path) => { if (path.endsWith("316.json")) throw new Error("409 conflict"); },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await archiveDoneRecords(deps, storage, STUDIO_ID, async () => "o/ops");
      expect(result).toEqual({ archived: 1, commented: 1, failed: 0 });
      expect(comments.map((c) => c.task)).toEqual([316]);
      expect(errors.mock.calls.flat().join(" ")).toContain("316");
    } finally {
      errors.mockRestore();
    }
  });

  it("ops write AND the fallback comment both fail: counted failed, logged, never thrown", async () => {
    const { deps, storage } = archiveDeps({ "316": R316 }, {
      put: async () => { throw new Error("500"); },
      comment: async () => { throw new Error("board down"); },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await archiveDoneRecords(deps, storage, STUDIO_ID, async () => "o/ops");
      expect(result).toEqual({ archived: 0, commented: 0, failed: 1 });
    } finally {
      errors.mockRestore();
    }
  });

  it("a failed board comment (ops unset) is counted and logged, never thrown", async () => {
    const { deps, storage } = archiveDeps({ "316": R316 }, { comment: async () => { throw new Error("board down"); } });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await archiveDoneRecords(deps, storage, STUDIO_ID, async () => null);
      expect(result).toEqual({ archived: 0, commented: 0, failed: 1 });
    } finally {
      errors.mockRestore();
    }
  });

  // #363 round 2: the board is public by default. A token pasted into a
  // verification tail must never reach it, and GitHub refuses a comment body
  // of 65536 chars or more.
  it("the board comment is redacted and capped under GitHub's 65536-char limit, saying it was truncated", async () => {
    const huge = JSON.stringify({ plan: "p", verification: [{ cmd: "x", output: `ghp_abcdef123456 ${"y".repeat(80_000)}` }] });
    const { deps, comments, storage } = archiveDeps({ "328": huge });
    await archiveDoneRecords(deps, storage, STUDIO_ID, async () => null);
    const body = comments[0]!.body;
    expect(body).not.toContain("ghp_abcdef123456");
    expect(body.length).toBeLessThan(65536);
    expect(body).toContain("truncated");
  });

  it("no records: the ops repo is never even resolved", async () => {
    const { deps, storage } = archiveDeps({});
    const resolve = fakeResolveMemoryRepo();
    const result = await archiveDoneRecords(deps, storage, STUDIO_ID, resolve.resolve);
    expect(result).toEqual({ archived: 0, commented: 0, failed: 0 });
    expect(resolve.calls).toBe(0);
  });

  it("no doneRecords ports wired: skipped without a single exec", async () => {
    const deps = fakeSyncDeps();
    const result = await archiveDoneRecords(deps, fakeHashStorage(), STUDIO_ID, noopResolveMemoryRepo);
    expect(result).toEqual({ archived: 0, commented: 0, failed: 0 });
    expect(deps.execCalls).toEqual([]);
  });
});

describe("recycleWithSync archives the completion records before destroy (#361)", () => {
  it("records reach the ops repo before the container is destroyed", async () => {
    const { deps, puts } = archiveDeps({ "316": "{}" });
    const order = deps.execCalls;
    await recycleWithSync(
      deps, fakeCombinedStorage(), STUDIO_ID,
      async () => { order.push(`destroy after ${puts.length} put(s)`); },
      async () => {}, async () => ({ id: STUDIO_ID, state: "running" }) as StudioStatus, async () => {},
      { repo: "websites", role: "pilot" }, async () => "o/ops", noopCommit,
    );
    expect(puts.map((c) => `${c.repo}:${c.path}`)).toEqual(["o/ops:done/acme/websites/316.json"]);
    expect(order).toContain("destroy after 1 put(s)");
  });
});

// Issue #367: a container that dies any way OTHER than the recycle/destroy
// teardown (eviction, OOM, wedge+hard-stop) used to lose every unarchived
// completion record for its whole lifetime -- archiveDoneRecords only ever
// ran from that one teardown call site. The fix adds a SECOND call from the
// periodic ship tick (runShipTickWithObservation, do.ts), reusing
// archiveDoneRecords/doneRecordsListCmd UNCHANGED: whichever call (tick or
// teardown) runs first for a given task archives it, and the other must find
// nothing left to do.
//
// #367 round 2 (review HOLD fix): round 1 made that idempotent by DELETING
// the local record file once it landed -- which broke two OTHER readers of
// the SAME file: harvestLearnings (called right after this, at both call
// sites) and the container's own completion gate, which polls for the
// file's PRESENCE on every Stop event. The file is never deleted now.
// Idempotence between the two call sites is a per-task content hash kept in
// DO storage (DONE_RECORD_HASHES_KEY) instead: unchanged content is skipped,
// changed content (a genuine rewrite) is archived again as a new version.
describe("archiveDoneRecords — idempotent via a per-task content hash, never by deleting the file (#367 round 2)", () => {
  it("a record archived once is not re-archived (or re-commented) when the OTHER call runs right after, with unchanged content", async () => {
    const record = JSON.stringify({ plan: "docs/p.md", verification: [] });
    const files = new Map<string, string>([["316", record]]);
    const puts: { repo: string; path: string; content: string; message: string }[] = [];
    const comments: { repo: string; task: number; body: string }[] = [];
    const deps: SessionSyncDeps = {
      ...fakeSyncDeps(),
      exec: async (cmd: string) => {
        if (cmd === doneRecordsListCmd()) return { code: 0, stdout: listing(Object.fromEntries(files)), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      doneRecords: {
        workRepoSlug: async () => "acme/websites",
        putOpsFile: async (repo, path, content, message) => { puts.push({ repo, path, content, message }); },
        commentOnTask: async (repo, task, body) => { comments.push({ repo, task, body }); },
      },
    };
    // The SAME storage instance across both calls -- exactly what a real DO
    // gives both the sync-tick and the teardown call sites (one Durable
    // Object, one storage).
    const storage = fakeHashStorage();

    // The tick's own archive call runs first and picks up the record.
    const tickResult = await archiveDoneRecords(deps, storage, STUDIO_ID, async () => "o/ops");
    expect(tickResult).toEqual({ archived: 1, commented: 0, failed: 0 });
    expect(puts).toHaveLength(1);

    // Teardown runs right after, against the SAME (never-recycled) container
    // -- the local file is STILL there (nothing deletes it any more), but
    // its content hash already matches what was stamped after the tick's
    // own archive, so this call is a no-op: no write, no comment.
    expect(files.has("316")).toBe(true);
    const teardownResult = await archiveDoneRecords(deps, storage, STUDIO_ID, async () => "o/ops");
    expect(teardownResult).toEqual({ archived: 0, commented: 0, failed: 0 });
    expect(puts).toHaveLength(1); // never archived a second time
    expect(comments).toEqual([]);
  });

  it("a record whose content CHANGES between two calls (a genuine rewrite) is archived again, as a new version", async () => {
    const files = new Map<string, string>([["316", JSON.stringify({ plan: "docs/p.md", verification: [] })]]);
    const puts: { repo: string; path: string; content: string; message: string }[] = [];
    const deps: SessionSyncDeps = {
      ...fakeSyncDeps(),
      exec: async (cmd: string) => {
        if (cmd === doneRecordsListCmd()) return { code: 0, stdout: listing(Object.fromEntries(files)), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      doneRecords: {
        workRepoSlug: async () => "acme/websites",
        putOpsFile: async (repo, path, content, message) => { puts.push({ repo, path, content, message }); },
        commentOnTask: async () => {},
      },
    };
    const storage = fakeHashStorage();

    const first = await archiveDoneRecords(deps, storage, STUDIO_ID, async () => "o/ops");
    expect(first).toEqual({ archived: 1, commented: 0, failed: 0 });
    const hashAfterFirst = storage.current();

    // A member corrects the record's `learnings` (or any other field) before
    // the OTHER call site's own listing runs -- same task number, different
    // bytes.
    files.set("316", JSON.stringify({ plan: "docs/p.md", verification: [], learnings: ["corrected"] }));

    const second = await archiveDoneRecords(deps, storage, STUDIO_ID, async () => "o/ops");
    expect(second).toEqual({ archived: 1, commented: 0, failed: 0 }); // archived AGAIN -- a new version
    expect(puts).toHaveLength(2);
    expect(puts[1]!.content).toContain("corrected");
    // The stored hash moved to match the new content -- a THIRD call with
    // this same (now current) content would again be a no-op.
    expect(storage.current()).not.toEqual(hashAfterFirst);
  });
});

// #367 round 3 (review HOLD fix, item 3): the hash-map write used to happen
// ONCE, in memory, after the WHOLE loop finished -- a crash between record 3
// and record 4 of a 5-record pass lost every one of the first three records'
// hash updates too, even though they had already landed on the ops repo or
// board, making them re-post needlessly next call. The fix moves the write
// storage.put(DONE_RECORD_HASHES_KEY, ...) inside the loop, immediately after
// EACH record's own successful land -- this proves only records that landed
// BEFORE a mid-loop failure keep their persisted hash; the ones after it
// (including the one that never got to persist at all) stay retry-eligible,
// never zero-of-N and never all-of-N regardless of where the pass died.
describe("archiveDoneRecords — the hash write happens per-record, not batched at the end (#367 round 3)", () => {
  it("a storage failure partway through a multi-record pass leaves only the records landed BEFORE it with a persisted hash", async () => {
    const bodyA = JSON.stringify({ plan: "docs/a.md", verification: [] });
    const bodyB = JSON.stringify({ plan: "docs/b.md", verification: [] });
    const bodyC = JSON.stringify({ plan: "docs/c.md", verification: [] });
    const files = { "1": bodyA, "2": bodyB, "3": bodyC };
    const puts: { repo: string; path: string }[] = [];
    let putCalls = 0;
    // A DoneRecordHashStorage that behaves normally for the FIRST write (task
    // 1's own hash lands) but then throws -- standing in for the DO's own
    // storage dying (eviction/OOM/hard-stop) the instant it tries to persist
    // the SECOND record's hash, mid-loop, exactly the scenario the review
    // describes. Not wrapped in a try/catch inside archiveDoneRecords (unlike
    // the two GitHub port calls, which are deliberately failure-isolated) --
    // a genuine storage/process death is not a per-record failure to recover
    // from, it ends the pass right there.
    let hashes: Record<string, string> | undefined;
    const storage: DoneRecordHashStorage & { current(): Record<string, string> | undefined } = {
      get: async () => hashes,
      put: async (_key, value) => {
        putCalls++;
        if (putCalls === 2) throw new Error("storage died mid-pass");
        // A SNAPSHOT, not the same reference `archiveDoneRecords` keeps
        // mutating in its own loop -- a real DO storage.put structurally
        // clones at the instant it durably lands, so a LATER in-place
        // mutation of the caller's own live object (record 3's own
        // `hashes[key] = hash`) must never leak backward into what was
        // already persisted for record 1.
        hashes = { ...value };
      },
      current: () => hashes,
    };
    const deps: SessionSyncDeps = {
      ...fakeSyncDeps(),
      exec: async (cmd: string) => {
        if (cmd === doneRecordsListCmd()) return { code: 0, stdout: listing(files), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      doneRecords: {
        workRepoSlug: async () => "acme/websites",
        putOpsFile: async (repo, path) => { puts.push({ repo, path }); },
        commentOnTask: async () => {},
      },
    };

    // The pass dies (propagates) exactly when it tries to persist the SECOND
    // record's hash -- never silently swallowed, since a real storage/process
    // death is not something this function can recover from and keep going.
    await expect(archiveDoneRecords(deps, storage, STUDIO_ID, async () => "o/ops")).rejects.toThrow("storage died mid-pass");

    // Both records 1 and 2 reached the ops repo (the GitHub side effect
    // already landed for both before the storage death) -- glob order is
    // task-number-string order, so "1" then "2" then (never reached) "3".
    expect(puts.map((p) => p.path)).toEqual([
      "done/acme/websites/1.json",
      "done/acme/websites/2.json",
    ]);
    // But only task 1's hash actually made it into storage -- task 2 landed
    // on the ops repo yet never got to persist its own hash (the write that
    // failed), and task 3 was never even attempted. With the OLD batched-at-
    // the-end write this would have been {} (zero of three) even though two
    // had already landed; it must not be all three either.
    expect(storage.current()).toEqual({ "1": expect.any(String) });
  });
});

// #367 round 2's actual regression fix: round 1's `rm -f` deleted the local
// record the instant either call site archived it, so if the SYNC TICK
// archived a record moments before teardown's own harvestLearnings tried to
// read that SAME record for its `learnings` field, the file was already
// gone -- harvest silently reported "no record" and a real learning was
// lost, the exact kind of silent data loss #367 as a whole exists to close.
// This proves harvestLearnings still finds the record after archiveDoneRecords
// has run against it, now that the file is never deleted.
describe("archiveDoneRecords no longer deletes the local completion record (#367 round 2 regression test)", () => {
  it("harvestLearnings can still read a record's `learnings` after archiveDoneRecords has already archived it", async () => {
    const TASK = 316;
    const body = JSON.stringify({ plan: "docs/p.md", verification: [], learnings: ["ship early, ship often"] });
    const files = new Map<string, string>([[String(TASK), body]]);
    const puts: { repo: string; path: string; content: string; message: string }[] = [];
    const deps: SessionSyncDeps = {
      ...fakeSyncDeps(),
      exec: async (cmd: string) => {
        if (cmd === doneRecordsListCmd()) return { code: 0, stdout: listing(Object.fromEntries(files)), stderr: "" };
        // A regression that reintroduces the round-1 `rm -f` must actually be
        // caught here: this mock genuinely deletes from `files` on that exact
        // command, the same way a real shell `rm -f` would delete the file
        // archiveDoneRecords is not supposed to touch any more.
        const removed = /^rm -f .*\/([0-9]+)\.json$/.exec(cmd.trim());
        if (removed) { files.delete(removed[1]!); return { code: 0, stdout: "", stderr: "" }; }
        const m = /\/([0-9]+)\.json/.exec(cmd);
        if (m) {
          const stored = files.get(m[1]!);
          return { code: 0, stdout: stored ?? HARVEST_NO_RECORD, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      doneRecords: {
        workRepoSlug: async () => "acme/websites",
        putOpsFile: async (repo, path, content, message) => { puts.push({ repo, path, content, message }); },
        commentOnTask: async () => {},
      },
    };

    const archived = await archiveDoneRecords(deps, fakeHashStorage(), STUDIO_ID, async () => "o/ops");
    expect(archived).toEqual({ archived: 1, commented: 0, failed: 0 });
    // The regression: this used to be false (rm -f already ran above).
    expect(files.has(String(TASK))).toBe(true);

    const commit = fakeCommit();
    const harvest = await harvestLearnings(deps, "websites", STUDIO_ID, noopResolveMemoryRepo, commit.commit, TASK);
    expect(harvest).toEqual({ harvested: true, count: 1 });
    expect(commit.calls).toHaveLength(1);
    expect(commit.calls[0]!.content).toContain("ship early, ship often");
  });
});

describe("recycleWithSync — sync before rescue-push before destroy, destroy before awaitReady, awaitReady before reprovision", () => {
  const CFG: ProvisionConfig = { repo: "websites", role: "pilot" };

  it("calls sync, then rescue-push, then learning-harvest, then destroy, then awaitReady, then provision(cfg) — in that order, and forwards provision's result", async () => {
    // This file's own top-level fakeSyncDeps() (default opts): stat size
    // "0", single-read "" — a clean, successful, empty-session sync, a
    // quiet RESCUE_CLEAN rescue-push, and a quiet HARVEST_NO_RECORD harvest,
    // so its own four execs (tar+stat, the read, rescue-push's own status
    // check, then the harvest's own done.json check) land in `execCalls`
    // before anything else does. Reusing that SAME live array for destroy/
    // awaitReady/provision too (rather than a second bespoke tracker) is
    // what proves the actual order across all six steps, not just that
    // each one ran.
    const syncDeps = fakeSyncDeps();
    const order = syncDeps.execCalls;
    const destroy = vi.fn(async () => {
      order.push("destroy");
    });
    const awaitReady = vi.fn(async () => {
      order.push("awaitReady");
    });
    const provisionFn = vi.fn(async (cfg: ProvisionConfig) => {
      order.push(`provision:${cfg.repo}--${cfg.role}`);
      return { id: STUDIO_ID, state: "running" } as StudioStatus;
    });
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();

    const result = await recycleWithSync(syncDeps, storage, STUDIO_ID, destroy, awaitReady, provisionFn, recordStudioFn, CFG, noopResolveMemoryRepo, noopCommit);

    expect(order).toEqual([
      // Board #68: the liveness probe now runs FIRST, and deliberately so —
      // everything below needs the container channel this one sentence tests,
      // so against a dead container all of it is unwinnable and attempting it
      // anyway is what blew the platform's wall-time budget. Cheap enough that
      // ordering it ahead of the real work costs nothing on the happy path.
      "printf ok",
      // ORDER IS THE POINT (Task 3 brief, extended by Task 4): rescue-push's
      // own exec lands BEFORE "destroy", and the learning-harvest's own exec
      // lands beside it — proven here as one strict sequence, not as
      // independent "both ran" assertions. Either running after destroy
      // saves nothing; this array fails the instant that ever regresses.
      // Issue #37: aside sessions (none here) are listed after the main sync.
      tarAndStatCmd(), singleReadCmd(), asideListCmd(), rescuePushCmd(CFG.repo, STUDIO_ID), harvestRecordCmd(CFG.repo, null),
      "destroy", "awaitReady", "provision:websites--pilot",
      // The check runs LAST, against the container provisioning just
      // finished with — asserted as the exact command, so this test fails
      // if the check ever stops reading the two markers it is here for.
      provisionedCheckCmd(CFG.repo),
    ]);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(awaitReady).toHaveBeenCalledTimes(1);
    expect(provisionFn).toHaveBeenCalledTimes(1); // check passed first time: no retry
    expect(provisionFn).toHaveBeenCalledWith(CFG);
    // Issue #37: the success path now stamps the verdict it just measured
    // onto the row it returns, and records it, instead of forwarding
    // provision's result untouched with a readiness up to 300s old.
    expect(result).toEqual({
      id: STUDIO_ID, state: "running",
      readiness: { kind: "provisioned", checkedAt: `${TODAY}T12:00:00.000Z` },
    });
    expect(recordStudioFn).toHaveBeenCalledTimes(1);
  });

  // Review round 3 (issue #85 PR1), MUST-FIX 8(a) — recycleWithSync's own
  // pre-destroy sync succeeds at the identical R2 put restartWithSync's does
  // and must mirror it into lastSnapshotAt the same way.
  it("records lastSnapshotAt on a successful pre-destroy sync when observedStorage is passed", async () => {
    const syncDeps = fakeSyncDeps({ now: "2026-08-16T13:00:00.000Z" });
    const destroy = vi.fn(async () => {});
    const awaitReady = vi.fn(async () => {});
    const provisionFn = vi.fn(async (cfg: ProvisionConfig) => ({ id: STUDIO_ID, state: "running" }) as StudioStatus);
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorageWithObserved();

    await recycleWithSync(
      syncDeps, storage, STUDIO_ID, destroy, awaitReady, provisionFn, recordStudioFn, CFG,
      noopResolveMemoryRepo, noopCommit, undefined, storage,
    );

    const observed = await getObserved(storage);
    expect(observed.lastSnapshotAt).toBe("2026-08-16T13:00:00.000Z");
  });

  it("no observedStorage passed: recycleWithSync behaves exactly as before", async () => {
    const syncDeps = fakeSyncDeps();
    const destroy = vi.fn(async () => {});
    const awaitReady = vi.fn(async () => {});
    const provisionFn = vi.fn(async () => ({ id: STUDIO_ID, state: "running" }) as StudioStatus);
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();

    const result = await recycleWithSync(syncDeps, storage, STUDIO_ID, destroy, awaitReady, provisionFn, recordStudioFn, CFG, noopResolveMemoryRepo, noopCommit);

    expect(result.state).toBe("running");
  });

  it("rescue-push runs BEFORE destroy — order asserted directly against a minimal fake, isolated from the six-step chain above", async () => {
    const order: string[] = [];
    const syncDeps: SessionSyncDeps = {
      exec: async (cmd: string) => {
        if (cmd.startsWith("mkdir -p")) return { code: 0, stdout: `0\n${TAR_STARTED_AT}`, stderr: "" }; // sync's own tar+stat: empty session + tar-start watermark
        if (cmd.includes("status --porcelain")) {
          order.push("rescue-push");
          return { code: 0, stdout: "RESCUE_PUSHED main 1 files", stderr: "" };
        }
        // Task 4's own harvest check — answered quiet (no record) so this
        // test, which is about rescue-push's own ordering, stays isolated
        // from harvest's.
        if (cmd.includes(HARVEST_NO_RECORD)) return { code: 0, stdout: HARVEST_NO_RECORD, stderr: "" };
        return { code: 0, stdout: "", stderr: "" }; // the read, and the eventual provisioned check
      },
      r2Put: async () => {},
      r2List: async () => [],
      r2Delete: async () => {},
      now: fixedNow(`${TODAY}T12:00:00.000Z`),
      notify: async () => {},
      burnAlertThresholdTokens: 0,
    };
    const destroy = vi.fn(async () => {
      order.push("destroy");
    });
    const awaitReady = vi.fn(async () => {});
    const provisionFn = vi.fn(async () => ({ id: STUDIO_ID, state: "running" }) as StudioStatus);
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();

    await recycleWithSync(syncDeps, storage, STUDIO_ID, destroy, awaitReady, provisionFn, recordStudioFn, CFG, noopResolveMemoryRepo, noopCommit);

    expect(order).toEqual(["rescue-push", "destroy"]);
  });

  // Issue #62: an UNCONFIRMED rescue (exec throws or is killed) is unknown
  // state: recycle refuses like a confirmed failure, container untouched.
  // `--discard-unsynced` proceeds and the row names it.
  it("#62: a throwing rescue-push REFUSES recycle — destroy/awaitReady/provision never run", async () => {
    const syncDeps = fakeSyncDeps({ rescue: null }); // rescue-push's own exec throws
    const destroy = vi.fn(async () => {});
    const awaitReady = vi.fn(async () => {});
    const provisionFn = vi.fn(async () => ({ id: STUDIO_ID, state: "running" }) as StudioStatus);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const syncedAt = new Date(new Date(`${TODAY}T12:00:00.000Z`).getTime() - 63 * 60_000);
      const message = await recycleWithSync(
        syncDeps, fakeCombinedStorage(), STUDIO_ID, destroy, awaitReady, provisionFn, vi.fn(async () => {}), CFG,
        noopResolveMemoryRepo, noopCommit, { discardUnsynced: false, lastSyncedAt: async () => syncedAt },
      ).then(() => "", (err: Error) => err.message);
      expect(message.startsWith(RECYCLE_REFUSED_PREFIX)).toBe(true);
      expect(message).toContain("could not confirm");
      // Same price the probe refusal quotes: the last synced snapshot's age.
      expect(message).toContain("(1h 3m old)");
      expect(message).toContain(`fleet recycle ${STUDIO_ID} --discard-unsynced`);
      expect(destroy).not.toHaveBeenCalled();
      expect(awaitReady).not.toHaveBeenCalled();
      expect(provisionFn).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("#62: a KILLED rescue exec (124) REFUSES recycle — the container is never touched", async () => {
    const syncDeps = fakeSyncDeps({ rescue: { code: 124, stdout: "", stderr: "" } });
    const destroy = vi.fn(async () => {});
    const provisionFn = vi.fn(async () => ({ id: STUDIO_ID, state: "running" }) as StudioStatus);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const message = await recycleWithSync(
        syncDeps, fakeCombinedStorage(), STUDIO_ID, destroy, async () => {}, provisionFn, vi.fn(async () => {}), CFG,
        noopResolveMemoryRepo, noopCommit,
      ).then(() => "", (err: Error) => err.message);
      expect(message.startsWith(RECYCLE_REFUSED_PREFIX)).toBe(true);
      expect(message).toContain("could not confirm");
      expect(destroy).not.toHaveBeenCalled();
      expect(provisionFn).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("#62: a throwing rescue-push + --discard-unsynced → recycle proceeds, row names the unconfirmed rescue", async () => {
    const syncDeps = fakeSyncDeps({ rescue: null });
    const destroy = vi.fn(async () => {});
    const provisionFn = vi.fn(async () => ({ id: STUDIO_ID, state: "running" }) as StudioStatus);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await recycleWithSync(
        syncDeps, fakeCombinedStorage(), STUDIO_ID, destroy, async () => {}, provisionFn, vi.fn(async () => {}), CFG,
        noopResolveMemoryRepo, noopCommit, { discardUnsynced: true, lastSyncedAt: async () => undefined },
      );
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(result.state).toBe("running");
      expect(result.error).toContain("unconfirmed rescue-push");
      expect(result.error).toContain("--discard-unsynced");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a throwing learning harvest does not prevent destroy/awaitReady/provision from running (same best-effort posture as rescue-push)", async () => {
    const syncDeps = fakeSyncDeps({ harvest: null }); // harvest's own exec throws
    const destroy = vi.fn(async () => {});
    const awaitReady = vi.fn(async () => {});
    const provisionFn = vi.fn(async () => ({ id: STUDIO_ID, state: "running" }) as StudioStatus);
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await recycleWithSync(syncDeps, storage, STUDIO_ID, destroy, awaitReady, provisionFn, recordStudioFn, CFG, noopResolveMemoryRepo, noopCommit);
      expect(destroy).toHaveBeenCalledTimes(1); // recycle proceeded despite harvest's throw
      expect(awaitReady).toHaveBeenCalledTimes(1);
      expect(provisionFn).toHaveBeenCalledWith(CFG);
      expect(result.state).toBe("running");
      expect(errSpy).toHaveBeenCalled(); // the harvest failure was logged, not silently dropped
    } finally {
      errSpy.mockRestore();
    }
  });

  // #346 review item 2: a recycle that drops learnings (memory off) says so on
  // the row -- never silent loss.
  it("memory store off: the recycled row carries a note naming the learnings not harvested", async () => {
    const record = JSON.stringify({ learnings: ["one", "two"] });
    const syncDeps = fakeSyncDeps({ harvest: { code: 0, stdout: record } });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await recycleWithSync(
        syncDeps, fakeCombinedStorage(), STUDIO_ID, vi.fn(async () => {}), vi.fn(async () => {}),
        vi.fn(async () => ({ id: STUDIO_ID, state: "running", error: null }) as StudioStatus), vi.fn(async () => {}), CFG,
        async () => null, noopCommit,
      );
      expect(result.state).toBe("running");
      expect(result.error).toBe("recycled with 2 learning(s) not harvested: FLEET_OPS_REPO is unset (memory off)");
    } finally {
      errors.mockRestore();
    }
  });

  it("a real learning reaches commitFile before destroy, written under fleet/memory/<studio>/", async () => {
    const record = JSON.stringify({ learnings: ["Higgsfield image-to-image beats a fresh prompt for logo edits"] });
    const syncDeps = fakeSyncDeps({ harvest: { code: 0, stdout: record } });
    const commit = fakeCommit();
    const destroy = vi.fn(async () => {});
    const awaitReady = vi.fn(async () => {});
    const provisionFn = vi.fn(async () => ({ id: STUDIO_ID, state: "running" }) as StudioStatus);
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();

    await recycleWithSync(
      syncDeps, storage, STUDIO_ID, destroy, awaitReady, provisionFn, recordStudioFn, CFG,
      noopResolveMemoryRepo, commit.commit,
    );

    // Committed BEFORE destroy — same "capture before teardown or lose it"
    // reason rescue-push's own ordering matters.
    expect(commit.calls).toHaveLength(1);
    expect(commit.calls[0].path).toMatch(new RegExp(`^fleet/memory/${STUDIO_ID}/.*\\.md$`));
    expect(commit.calls[0].content).toContain("Higgsfield image-to-image beats a fresh prompt for logo edits");
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  // --- the 2026-08-25 incident: provisioning "succeeded" over a bare
  // container. Both execs really did exit 0, the route answered `running,
  // error: null`, and the studio had no checkout and no claude. These three
  // tests are that failure and its two possible endings.

  it("check fails after the first provision: reprovisions ONCE, and a passing second check returns running with nothing degraded", async () => {
    const syncDeps = fakeSyncDeps({ checks: [{ code: 0, stdout: "no git checkout at /workspace/websites" }, { code: 0, stdout: PROVISIONED_OK }] });
    const provisionFn = vi.fn(async () => ({ id: STUDIO_ID, state: "running" }) as StudioStatus);
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await recycleWithSync(
        syncDeps, storage, STUDIO_ID, vi.fn(async () => {}), vi.fn(async () => {}), provisionFn, recordStudioFn, CFG, noopResolveMemoryRepo, noopCommit,
      );

      expect(provisionFn).toHaveBeenCalledTimes(2); // the operator's manual re-provision, encoded
      expect(syncDeps.execCalls.filter((c) => c === provisionedCheckCmd(CFG.repo))).toHaveLength(2);
      expect(result.state).toBe("running");
      // Issue #37: healed is still never DEGRADED — but it is now recorded,
      // carrying the fresh `provisioned` verdict the retry's own check
      // produced, so `fleet ls` stops showing the pre-recycle row.
      expect(recordStudioFn).toHaveBeenCalledTimes(1);
      expect((await storage.get(STATUS_KEY))?.state).toBe("running");
      expect((await storage.get(STATUS_KEY))?.readiness).toEqual({ kind: "provisioned", checkedAt: `${TODAY}T12:00:00.000Z` });
      expect(errSpy).toHaveBeenCalled(); // the half-worked recycle was logged, not silently retried
    } finally {
      errSpy.mockRestore();
    }
  });

  it("check fails BOTH times: records a degraded status carrying the container's own reason and throws — never a 200 over a bare container", async () => {
    const syncDeps = fakeSyncDeps({
      checks: [
        { code: 0, stdout: "no git checkout at /workspace/websites" },
        { code: 0, stdout: "claude is not running in tmux studio:claude (pane runs: bash)" },
      ],
    });
    const provisionFn = vi.fn(async () => ({ id: STUDIO_ID, state: "running", error: null }) as StudioStatus);
    const recorded: StudioStatus[] = [];
    const recordStudioFn = vi.fn(async (s: StudioStatus) => {
      recorded.push(s);
    });
    const storage = fakeCombinedStorage();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        recycleWithSync(
          syncDeps, storage, STUDIO_ID, vi.fn(async () => {}), vi.fn(async () => {}), provisionFn, recordStudioFn, CFG, noopResolveMemoryRepo, noopCommit,
        ),
      ).rejects.toThrow(/claude is not running/);

      expect(provisionFn).toHaveBeenCalledTimes(2);
      expect(recorded).toHaveLength(1);
      expect(recorded[0].state).toBe("degraded");
      // The reason the CONTAINER gave, not a generic "recycle failed" — an
      // operator reading `fleet ls` learns which marker was missing.
      expect(recorded[0].error).toContain("claude is not running");
      expect((await storage.get(STATUS_KEY))?.state).toBe("degraded");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("provisioning itself degrades: the container is never checked, and recycle still fails loudly instead of returning that status 200", async () => {
    const syncDeps = fakeSyncDeps();
    const provisionFn = vi.fn(async () => ({
      id: STUDIO_ID, state: "degraded", error: "clone failed (128): repository not found",
    }) as StudioStatus);
    const recorded: StudioStatus[] = [];
    const recordStudioFn = vi.fn(async (s: StudioStatus) => {
      recorded.push(s);
    });
    const storage = fakeCombinedStorage();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        recycleWithSync(
          syncDeps, storage, STUDIO_ID, vi.fn(async () => {}), vi.fn(async () => {}), provisionFn, recordStudioFn, CFG, noopResolveMemoryRepo, noopCommit,
        ),
      ).rejects.toThrow(/clone failed/);

      expect(provisionFn).toHaveBeenCalledTimes(2); // retried, same as any other unproven outcome
      // A status that already says it failed needs no container round-trip.
      expect(syncDeps.execCalls.some((c) => c.includes("pane_current_command"))).toBe(false);
      expect(recorded[0].state).toBe("degraded");
    } finally {
      errSpy.mockRestore();
    }
  });

  // --- INCONCLUSIVE: the check could not reach a verdict ---------------------
  // The 2026-08-25 false negative. The first version of this check ended in
  // `exit 0`, which killed the "sandbox-default" session shell instead of
  // the command; the SDK threw, the code read that as failure, and a
  // demonstrably healthy `websites--maestro` (repo cloned, session restored,
  // hook installed, 6 skills, claude running in studio:claude) came back as
  // a 500. Operator ruling: a check that cannot run is not evidence about
  // the studio. Retry it; if it stays inconclusive, report success WITH an
  // explicit note rather than fail a working studio.

  it("check throws every time: retries, then reports SUCCESS carrying an explicit unverified note — never a 500 on a healthy studio", async () => {
    const syncDeps = fakeSyncDeps({ checks: [null, null, null, null] });
    const provisionFn = vi.fn(async () => ({ id: STUDIO_ID, state: "running", error: null }) as StudioStatus);
    const recorded: StudioStatus[] = [];
    const recordStudioFn = vi.fn(async (st: StudioStatus) => {
      recorded.push(st);
    });
    const storage = fakeCombinedStorage();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await recycleWithSync(
        syncDeps, storage, STUDIO_ID, vi.fn(async () => {}), vi.fn(async () => {}), provisionFn, recordStudioFn, CFG, noopResolveMemoryRepo, noopCommit,
      );

      // Retried before concluding anything — CHECK_ATTEMPTS execs, one call.
      expect(syncDeps.execCalls.filter((c) => c.includes("pane_current_command"))).toHaveLength(CHECK_ATTEMPTS);
      // Inconclusive is NOT bare: it must never trigger a second
      // provisioning pass over a studio nothing is known to be wrong with.
      expect(provisionFn).toHaveBeenCalledTimes(1);

      expect(result.state).toBe("running");
      expect(result.error).toContain("NOT verified");
      expect(result.error).toContain("sandbox-default");
      // Recorded, so `fleet ls` shows the note in the same column a real
      // failure would appear in — unverified success is never silent.
      expect(recorded).toHaveLength(1);
      expect(recorded[0].error).toContain("NOT verified");
      expect((await storage.get(STATUS_KEY))?.error).toContain("NOT verified");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("check throws once then answers: the retry's verdict is the one that counts — plain running, no note", async () => {
    const syncDeps = fakeSyncDeps({ checks: [null, { code: 0, stdout: PROVISIONED_OK }] });
    const provisionFn = vi.fn(async () => ({ id: STUDIO_ID, state: "running", error: null }) as StudioStatus);
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();

    const result = await recycleWithSync(
      syncDeps, storage, STUDIO_ID, vi.fn(async () => {}), vi.fn(async () => {}), provisionFn, recordStudioFn, CFG, noopResolveMemoryRepo, noopCommit,
    );

    expect(syncDeps.execCalls.filter((c) => c.includes("pane_current_command"))).toHaveLength(2);
    expect(provisionFn).toHaveBeenCalledTimes(1);
    expect(result.state).toBe("running");
    expect(result.error).toBeNull();
    // Issue #37: recorded, carrying the retry's own fresh verdict — the
    // distinction this test is about (no unverified NOTE) is `error`, not
    // whether the healed row was written.
    expect(recordStudioFn).toHaveBeenCalledTimes(1);
    expect(result.readiness).toEqual({ kind: "provisioned", checkedAt: `${TODAY}T12:00:00.000Z` });
  });

  it("check returns nothing recognisable (no verdict on stdout): inconclusive, not bare — never reprovisions or degrades on silence", async () => {
    const syncDeps = fakeSyncDeps({ checks: [{ code: 0, stdout: "" }, { code: 0, stdout: "" }, { code: 0, stdout: "" }] });
    const provisionFn = vi.fn(async () => ({ id: STUDIO_ID, state: "running", error: null }) as StudioStatus);
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await recycleWithSync(
        syncDeps, storage, STUDIO_ID, vi.fn(async () => {}), vi.fn(async () => {}), provisionFn, recordStudioFn, CFG, noopResolveMemoryRepo, noopCommit,
      );
      expect(provisionFn).toHaveBeenCalledTimes(1);
      expect(result.state).toBe("running");
      expect(result.error).toContain("no verdict");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a throwing session sync does not prevent destroy/awaitReady/provision from running (same best-effort posture as restartWithSync's own pre-restart sync)", async () => {
    const syncDeps = fakeSyncDeps({ statCode: 1, statStderr: "tar: nothing to archive yet" });
    const destroy = vi.fn(async () => {});
    const awaitReady = vi.fn(async () => {});
    const provisionFn = vi.fn(async () => ({ id: STUDIO_ID, state: "running" }) as StudioStatus);
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await recycleWithSync(syncDeps, storage, STUDIO_ID, destroy, awaitReady, provisionFn, recordStudioFn, CFG, noopResolveMemoryRepo, noopCommit);
      expect(destroy).toHaveBeenCalledTimes(1); // recycle proceeded despite sync's throw
      expect(awaitReady).toHaveBeenCalledTimes(1);
      expect(provisionFn).toHaveBeenCalledWith(CFG);
      expect(result.state).toBe("running");
      expect(errSpy).toHaveBeenCalled(); // the sync failure was logged, not silently dropped
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a destroy failure never reaches awaitReady or provision — builds+records a SCRUBBED degraded status (prior fields preserved) and throws", async () => {
    const syncDeps = fakeSyncDeps();
    // A secret-shaped substring in the raw error — proves the same
    // redactSecrets discipline runProvision's own catch applies also holds
    // here, both in what gets recorded AND in what gets thrown/surfaced to
    // the route.
    const destroy = vi.fn(async () => {
      throw new Error("containers control plane rejected token ghs_realsecretvalue123456");
    });
    const awaitReady = vi.fn(async () => {});
    const provisionFn = vi.fn(async () => ({ id: STUDIO_ID, state: "running" }) as StudioStatus);
    const recorded: StudioStatus[] = [];
    const recordStudioFn = vi.fn(async (s: StudioStatus) => {
      recorded.push(s);
    });
    const storage = fakeCombinedStorage({
      status: {
        id: STUDIO_ID, state: "running", tailscaleHost: "s.ts.net", lastRefresh: "2026-08-19T00:00:00.000Z",
        error: null, lastRefreshError: null, burn: null, spawnedBy: "websites--cto", spawnTokenHash: "priorhash",
        repoSlug: null,
      },
    });

    let thrown: unknown;
    try {
      await recycleWithSync(syncDeps, storage, STUDIO_ID, destroy, awaitReady, provisionFn, recordStudioFn, CFG, noopResolveMemoryRepo, noopCommit);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain("ghs_");
    expect((thrown as Error).message).toContain("containers control plane rejected");
    expect(awaitReady).not.toHaveBeenCalled();
    expect(provisionFn).not.toHaveBeenCalled();

    expect(recorded).toHaveLength(1);
    expect(recorded[0].state).toBe("degraded");
    expect(recorded[0].error).not.toContain("ghs_");
    expect(recorded[0].error).toContain("containers control plane rejected");
    // Prior fields carried forward, not reset — same `existing` spread
    // discipline runProvision/runRestart already establish.
    expect(recorded[0].tailscaleHost).toBe("s.ts.net");
    expect(recorded[0].spawnedBy).toBe("websites--cto");
    expect((await storage.get(STATUS_KEY))?.state).toBe("degraded");
  });

  it("an awaitReady failure (destroy succeeded, container never confirmed ready) never reaches provision — builds+records a degraded status and throws: the exact bug this fixes", async () => {
    const syncDeps = fakeSyncDeps();
    const destroy = vi.fn(async () => {});
    const awaitReady = vi.fn(async () => {
      throw new Error("port 3000 never became ready within 90000ms");
    });
    const provisionFn = vi.fn(async () => ({ id: STUDIO_ID, state: "running" }) as StudioStatus);
    const recorded: StudioStatus[] = [];
    const recordStudioFn = vi.fn(async (s: StudioStatus) => {
      recorded.push(s);
    });
    const storage = fakeCombinedStorage();

    await expect(
      recycleWithSync(syncDeps, storage, STUDIO_ID, destroy, awaitReady, provisionFn, recordStudioFn, CFG, noopResolveMemoryRepo, noopCommit),
    ).rejects.toThrow(/never became ready/);

    expect(destroy).toHaveBeenCalledTimes(1);
    // The headline property this whole fix exists for: provision NEVER runs
    // on a container that was not confirmed ready.
    expect(provisionFn).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].state).toBe("degraded");
    expect(recorded[0].error).toContain("never became ready");
  });
});

// ---------------------------------------------------------------------------
// Review round 2 (maestro review of PR #135), finding 5a — the existing
// `--account mapped` tests (studio.account-launched.test.ts) only pin SOURCE
// ORDER: that `cfg.forceMappedAccount` is checked, and `clearForceMappedAccount`
// called, before recycle()'s first `launchAccountOrRefuse(` call. None of
// them actually drive recycleWithSync's own pre-destroy rescue/sync phase
// (containerAnswers/syncSessionTick/rescuePush/harvestLearnings) to prove it
// still genuinely runs once a forced-mapped clear has landed — a mutant that
// made `forceMappedAccount: true` silently skip that phase would sail
// through the source-order pin untouched. This composes the same two
// primitives `StudioDO.recycle()` itself composes — `clearForceMappedAccount`
// first, then the real `recycleWithSync` — and reuses the EXACT assertion
// shape the "sync before rescue-push before destroy" test above already
// uses, so a regression here fails the identical way that one would.
// ---------------------------------------------------------------------------
describe("recycleWithSync — forced-mapped clear composes without skipping rescue (#131 ask 2, review round 2 finding 5a)", () => {
  const CFG: ProvisionConfig = { repo: "websites", role: "pilot", forceMappedAccount: true };

  it("rescue-push and the rest of the pre-destroy phase still run, in the same order, after the forced-mapped clear", async () => {
    const syncDeps = fakeSyncDeps();
    const order = syncDeps.execCalls;
    const destroy = vi.fn(async () => { order.push("destroy"); });
    const awaitReady = vi.fn(async () => { order.push("awaitReady"); });
    const provisionFn = vi.fn(async (cfg: ProvisionConfig) => {
      order.push(`provision:${cfg.repo}--${cfg.role}`);
      return { id: STUDIO_ID, state: "running" } as StudioStatus;
    });
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage({
      status: {
        id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
        lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
        claudeAccount: "CLAUDE_CODE_OAUTH_TOKEN_3", claudeAccountMovedAt: "2026-09-29T00:00:00Z",
        claudeAccountMovedVia: "inline", claudeAccountMovedBlock: "rate-limit",
      },
    });

    // recycle()'s own entry-time act, gated on cfg.forceMappedAccount — run
    // here exactly as StudioDO.recycle() runs it, before recycleWithSync.
    await clearForceMappedAccount(storage, recordStudioFn);
    // The clear landed (the mechanism studio.account-launched.test.ts's own
    // primitive-composition test already pins) — the real assertion this
    // test adds is what happens NEXT.
    expect((await storage.get(STATUS_KEY))?.claudeAccount ?? null).toBeNull();

    const result = await recycleWithSync(
      syncDeps, storage, STUDIO_ID, destroy, awaitReady, provisionFn, recordStudioFn, CFG, noopResolveMemoryRepo, noopCommit,
    );

    // Byte-identical to the plain-recycle order the sibling test above pins
    // — a mutant that special-cased `forceMappedAccount` to bypass any of
    // these steps fails here, not just the source-order grep.
    expect(order).toEqual([
      "printf ok",
      tarAndStatCmd(), singleReadCmd(), asideListCmd(), rescuePushCmd(CFG.repo, STUDIO_ID), harvestRecordCmd(CFG.repo, null),
      "destroy", "awaitReady", "provision:websites--pilot",
      provisionedCheckCmd(CFG.repo),
    ]);
    expect(result.state).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// The harness check — 2026-08-26. `websites--maestro` was measured running
// with SKILLS=0 AGENTS=0 BP=0 HOOKDIR=0 and a settings.json carrying no
// `hooks` key at all (an UNGATED lead holding Edit/Write, spec decision 11
// voided) while GET /studio/:id/provisioned answered `provisioned` the whole
// time — because the check only ever measured "repo cloned + claude running".
// These tests are that false green.
// ---------------------------------------------------------------------------

const STUDIO_ENV: StudioEnv = {
  ROLE_PROMPT_B64: "", ROLE_ALLOWED_TOOLS: "Read", ROLE_EFFORT: "",
  STUDIO_NAME: "web-studio",
  STUDIO_SKILLS: "caveman,brainstorming,qa",
  STUDIO_MEMBERS_B64: btoa(JSON.stringify({ "frontend-developer.md": "eA==", "qa-engineer.md": "eQ==" })),
  STUDIO_MCP: "playwright",
  STUDIO_LEAD_DISALLOWED: "Edit Write NotebookEdit Bash(write-forms)",
  BLUEPRINT_REPO: "acme-org/websites",
};

describe("harnessExpectation — what a studio MUST have materialized", () => {
  const decode = (b64: string) => atob(b64).split("\n");

  it("names every declared skill and every declared member file", () => {
    const lines = decode(harnessExpectation(STUDIO_ENV)!);
    expect(lines).toContain("s caveman");
    expect(lines).toContain("s brainstorming");
    expect(lines).toContain("s qa");
    expect(lines).toContain("m frontend-developer.md");
    expect(lines).toContain("m qa-engineer.md");
  });

  it("ends with a sentinel — a decode that yields nothing is a broken CHECK, not an empty expectation", () => {
    expect(decode(harnessExpectation(STUDIO_ENV)!).at(-1)).toBe("end");
  });

  it("is null for a plain role — a role provisions correctly with no hooks and no skills (measured on websites--pilot)", () => {
    const role: RoleEnv = { ROLE_PROMPT_B64: "", ROLE_ALLOWED_TOOLS: "", ROLE_EFFORT: "" };
    expect(harnessExpectation(role)).toBeNull();
    expect(harnessExpectation(null)).toBeNull();
    expect(harnessExpectation(undefined)).toBeNull();
  });

  it("survives a member bundle it cannot parse, still asserting the skills — a partial check beats none", () => {
    const broken = harnessExpectation({ ...STUDIO_ENV, STUDIO_MEMBERS_B64: "not-base64!!" })!;
    expect(decode(broken)).toContain("s qa");
    expect(decode(broken).some((l) => l.startsWith("m "))).toBe(false);
  });

  it("encodes base64 only — a skill name cannot inject shell syntax into the check", () => {
    const nasty = harnessExpectation({ ...STUDIO_ENV, STUDIO_SKILLS: 'qa"; rm -rf /; echo "' })!;
    expect(nasty).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("encodes a bare 'g' line for a code-writing studio (STUDIO_COMPLETION_GATE set)", () => {
    const lines = decode(harnessExpectation({ ...STUDIO_ENV, STUDIO_COMPLETION_GATE: "1" })!);
    expect(lines).toContain("g");
  });

  it("omits the 'g' line for a studio with no completion gate — STUDIO_ENV itself (unset), and the empty string bringup also writes for a non-code roster", () => {
    // STUDIO_ENV already carries no STUDIO_COMPLETION_GATE key at all — the
    // same shape a studio provisioned before the gate existed has (see
    // StudioEnv.STUDIO_COMPLETION_GATE's own doc comment). "" is the shape
    // studioBringupEnv writes for the Maestro. Both must produce no 'g' line:
    // a check demanding one on either would report a healthy studio bare.
    expect(decode(harnessExpectation(STUDIO_ENV)!)).not.toContain("g");
    expect(decode(harnessExpectation({ ...STUDIO_ENV, STUDIO_COMPLETION_GATE: "" })!)).not.toContain("g");
  });
});

describe("provisionedCheckCmd — the harness half", () => {
  const cmd = () => provisionedCheckCmd("websites", harnessExpectation(STUDIO_ENV));

  it("asserts the lead gate is present, executable AND referenced by settings.json", () => {
    // Both halves matter: the settings.json entry's own fail-closed guard
    // keys on `[ -x ]`, and the hook file alone runs nothing without the
    // reference. Either one missing is an ungated lead.
    expect(cmd()).toContain('[ -x "$HOME/.claude/hooks/lead-gate.sh" ]');
    expect(cmd()).toContain('grep -q lead-gate.sh "$HOME/.claude/settings.json"');
    expect(cmd()).toContain("lead-gate hook missing or not executable");
    expect(cmd()).toContain("settings.json does not reference the lead-gate hook");
  });

  it("asserts caveman actually FIRED — the flag its SessionStart hook writes, not the plugin being listed", () => {
    expect(cmd()).toContain('[ -f "$HOME/.claude/.caveman-active" ]');
    expect(cmd()).toContain("the plugin hooks did not fire");
    // Bounded wait: claude's pane reads "claude" a beat before its
    // SessionStart hooks have run.
    expect(cmd()).toContain(`[ "$j" -lt ${CAVEMAN_FLAG_TRIES} ]`);
  });

  it('probes that a declared skill RESOLVES (readable SKILL.md carrying a name: frontmatter key) against the blueprint checkout OR the baked plugin cache, not merely that its directory exists — a program.md-only dir is the exact shape that answered "Unknown skill" mid-session, and this same loop runs for every Tier-0 skill STUDIO_SKILLS carries (studio-blueprint.ts TIER0_SKILLS, folded in at provisionWithStorage)', () => {
    expect(cmd()).toContain('"$HOME/.claude/skills/$n/SKILL.md"');
    expect(cmd()).toContain('"$HOME"/.claude/plugins/cache/*/*/*/skills/"$n"/SKILL.md');
    expect(cmd()).toContain("grep -q '^name:'");
    expect(cmd()).toContain('echo "skills-unresolvable: $n"');
    // Critical, same rule as the rest of this command: the success AND
    // failure branches of this new probe must never call `exit` — it kills
    // the shared sandbox-default session's shell, not the command.
    expect(cmd()).not.toMatch(/(^|[;&|(\s])exit\b/);
  });

  it("checks declared members against ~/.claude/agents", () => {
    expect(cmd()).toContain('[ -f "$HOME/.claude/agents/$n" ]');
  });

  it("reads the expectation from a shell VARIABLE, never spliced into the command text", () => {
    // Blueprint-authored names reach this command; a name carrying a quote or
    // a `;` spliced in would be an injection. base64 in, `$n` out.
    expect(cmd()).toContain("base64 -d");
    expect(cmd()).not.toContain("skills/caveman");
  });

  it("uses no `case` — its unbalanced `)` closes the surrounding $( ) early (measured)", () => {
    expect(cmd()).not.toContain("case ");
  });

  it("still never calls `exit`, harness block included", () => {
    expect(cmd()).not.toMatch(/(^|[;&|(\s])exit\b/);
  });

  it("leaves the ROLE command exactly as it was — no harness, no new assertions", () => {
    const role = provisionedCheckCmd("websites");
    expect(role).not.toContain("lead-gate");
    expect(role).not.toContain("caveman");
    expect(role).toContain(`echo "${PROVISIONED_OK}"`);
  });
});

// ---------------------------------------------------------------------------
// Tier-0 completion gate (Stop hook) — the harness check's own verification.
// P5a closed this gap for the PreToolUse lead-gate (blocks above); this is
// the same shape for the Stop gate: bring-up materializes
// ~/.claude/hooks/completion-gate.sh ONLY for a code-writing roster
// (STUDIO_COMPLETION_GATE, studio-blueprint.ts's writesCode), and nothing
// before this fix ever verified from OUTSIDE the container that the install
// landed and stayed referenced — a code studio could run with no completion
// gate and still read `{"kind":"provisioned"}`.
// ---------------------------------------------------------------------------

describe("provisionedCheckCmd — the Tier-0 completion gate (Stop hook)", () => {
  const GATED_ENV: StudioEnv = { ...STUDIO_ENV, STUDIO_COMPLETION_GATE: "1" };
  const cmd = () => provisionedCheckCmd("websites", harnessExpectation(GATED_ENV));

  it("asserts the completion gate is present, executable AND referenced by settings.json — same two-part shape as the lead gate", () => {
    expect(cmd()).toContain('[ -x "$HOME/.claude/hooks/completion-gate.sh" ]');
    expect(cmd()).toContain('grep -q completion-gate.sh "$HOME/.claude/settings.json"');
    expect(cmd()).toContain("completion-gate hook missing or not executable");
    expect(cmd()).toContain("settings.json does not reference the completion-gate hook");
  });

  it("never calls `exit` in the gate branch either — same rule the rest of this command follows", () => {
    expect(cmd()).not.toMatch(/(^|[;&|(\s])exit\b/);
  });

  it("is gated behind the decoded 'g' marker, not unconditional like the lead-gate/caveman checks — this is what keeps a Maestro from ever being checked for it", () => {
    // lead-gate and caveman sit OUTSIDE the per-line `while` loop, inside
    // the unconditional `miss="$( { ... } )"` block, because EVERY studio
    // must carry them. The completion-gate check instead lives INSIDE that
    // loop's dispatch, behind `[ "$k" = g ]`: it only runs for a decoded
    // blob that actually contains a "g" line, and harnessExpectation adds
    // that line only when THIS studio's own STUDIO_COMPLETION_GATE is set
    // (see the "harnessExpectation — the completion gate line" describe
    // block above). A Maestro's own expectation blob never carries "g" — so
    // this branch is compiled into every studio's script text (same as the
    // "s"/"m" dispatch is, regardless of how many skills/members a given
    // studio happens to declare) but is never TAKEN for one.
    expect(cmd()).toContain('elif [ "$k" = g ]; then');
  });
});

describe("checkProvisionedWithRetry — a broken check is never a bare studio", () => {
  it("maps the container's UNKNOWN token to inconclusive, not to bare", async () => {
    const syncDeps = fakeSyncDeps({
      checks: [
        { code: 0, stdout: `${PROVISIONED_UNKNOWN} harness expectation did not decode in the container` },
        { code: 0, stdout: `${PROVISIONED_UNKNOWN} harness expectation did not decode in the container` },
        { code: 0, stdout: `${PROVISIONED_UNKNOWN} harness expectation did not decode in the container` },
      ],
    });
    const verdict = await checkProvisionedWithRetry(syncDeps, "websites", "aGk=");
    expect(verdict.kind).toBe("inconclusive");
  });

  it("reports an incomplete harness as bare, carrying the container's own list of what is missing", async () => {
    const reason = "harness incomplete: lead-gate hook missing or not executable (~/.claude/hooks/lead-gate.sh); skill qa";
    const syncDeps = fakeSyncDeps({ checks: [{ code: 0, stdout: reason }] });
    const verdict = await checkProvisionedWithRetry(syncDeps, "websites", "aGk=");
    expect(verdict).toEqual({ kind: "bare", reason });
  });
});

describe("recycleWithSync — the harness expectation comes from what provisioning just stored", () => {
  it("checks a studio against its stored studio env, so an ungated lead cannot recycle to a green verdict", async () => {
    const syncDeps = fakeSyncDeps({ checks: [{ code: 0, stdout: PROVISIONED_OK }] });
    const storage = fakeCombinedStorage({ roleEnv: STUDIO_ENV });
    await recycleWithSync(
      syncDeps, storage, "websites--web-studio", vi.fn(async () => {}), vi.fn(async () => {}),
      vi.fn(async () => ({ id: "websites--web-studio", state: "running" }) as StudioStatus),
      vi.fn(async () => {}), { repo: "websites", role: "web-studio" }, noopResolveMemoryRepo, noopCommit,
    );
    const checkCmd = syncDeps.execCalls.at(-1)!;
    expect(checkCmd).toBe(provisionedCheckCmd("websites", harnessExpectation(STUDIO_ENV)));
    expect(checkCmd).toContain("lead-gate hook missing or not executable");
  });

  it("a studio with NO stored env falls back to the two universal markers rather than refusing to check", async () => {
    const syncDeps = fakeSyncDeps({ checks: [{ code: 0, stdout: PROVISIONED_OK }] });
    await recycleWithSync(
      syncDeps, fakeCombinedStorage(), "websites--pilot", vi.fn(async () => {}), vi.fn(async () => {}),
      vi.fn(async () => ({ id: "websites--pilot", state: "running" }) as StudioStatus),
      vi.fn(async () => {}), { repo: "websites", role: "pilot" }, noopResolveMemoryRepo, noopCommit,
    );
    expect(syncDeps.execCalls.at(-1)).toBe(provisionedCheckCmd("websites"));
  });
});

// ---------------------------------------------------------------------------
// Issue #37: recycle already RUNS the live check (recycleVerdict, right after
// provisioning) and then threw the answer away — it returned the status
// provisioning wrote, whose `readiness` is whatever the last syncSession tick
// stamped up to 300s earlier. So a recycle that demonstrably healed a studio
// could hand back "bare: no git checkout", and a reviewing agent read exactly
// that and reported "recycle silently succeeds, zero effect". The work was
// already done; these tests pin that it is now REPORTED.
// ---------------------------------------------------------------------------

describe("recycleWithSync — the verdict it measured is the verdict it returns", () => {
  const CFG: ProvisionConfig = { repo: "websites", role: "pilot" };
  const NOW_ISO = `${TODAY}T12:00:00.000Z`;
  const STALE: StudioStatus["readiness"] = { kind: "bare", reason: "no git checkout at /workspace/websites", checkedAt: "2026-08-16T06:00:00.000Z" };

  /** Provisioning that carries the stale readiness forward exactly as the
   *  real runProvision does (it spreads `existing`) — the vehicle the stale
   *  verdict actually rides on. */
  const provisionCarryingStale = () =>
    vi.fn(async () => ({ id: STUDIO_ID, state: "running", error: null, readiness: STALE }) as StudioStatus);

  it("healed studio: returns {kind:'provisioned'} stamped now, never the stale stored verdict", async () => {
    const syncDeps = fakeSyncDeps({ checks: [{ code: 0, stdout: PROVISIONED_OK }] });
    const storage = fakeCombinedStorage();
    const recorded: StudioStatus[] = [];

    const result = await recycleWithSync(
      syncDeps, storage, STUDIO_ID, vi.fn(async () => {}), vi.fn(async () => {}),
      provisionCarryingStale(), async (s: StudioStatus) => { recorded.push(s); },
      CFG, noopResolveMemoryRepo, noopCommit,
    );

    expect(result.readiness).toEqual({ kind: "provisioned", checkedAt: NOW_ISO });
    expect(recorded.at(-1)?.readiness).toEqual({ kind: "provisioned", checkedAt: NOW_ISO });
    expect((await storage.get(STATUS_KEY))?.readiness).toEqual({ kind: "provisioned", checkedAt: NOW_ISO });
  });

  it("healed only by the one retry: the SECOND check's verdict is what comes back", async () => {
    const syncDeps = fakeSyncDeps({
      checks: [{ code: 0, stdout: "no git checkout at /workspace/websites" }, { code: 0, stdout: PROVISIONED_OK }],
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await recycleWithSync(
        syncDeps, fakeCombinedStorage(), STUDIO_ID, vi.fn(async () => {}), vi.fn(async () => {}),
        provisionCarryingStale(), vi.fn(async () => {}), CFG, noopResolveMemoryRepo, noopCommit,
      );
      expect(result.readiness).toEqual({ kind: "provisioned", checkedAt: NOW_ISO });
    } finally {
      errSpy.mockRestore();
    }
  });

  it("still bare: the degraded status it records and throws on carries the fresh bare verdict too", async () => {
    const syncDeps = fakeSyncDeps({
      checks: [
        { code: 0, stdout: "claude is not running in tmux studio:claude (pane runs: bash)" },
        { code: 0, stdout: "claude is not running in tmux studio:claude (pane runs: bash)" },
      ],
    });
    const recorded: StudioStatus[] = [];
    const storage = fakeCombinedStorage();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        recycleWithSync(
          syncDeps, storage, STUDIO_ID, vi.fn(async () => {}), vi.fn(async () => {}),
          vi.fn(async () => ({ id: STUDIO_ID, state: "running", error: null, readiness: { kind: "provisioned", checkedAt: "2026-08-16T06:00:00.000Z" } }) as StudioStatus),
          async (s: StudioStatus) => { recorded.push(s); }, CFG, noopResolveMemoryRepo, noopCommit,
        ),
      ).rejects.toThrow(/claude is not running/);

      expect(recorded.at(-1)?.readiness).toEqual({
        kind: "bare", reason: "claude is not running in tmux studio:claude (pane runs: bash)", checkedAt: NOW_ISO,
      });
      expect((await storage.get(STATUS_KEY))?.readiness).toMatchObject({ kind: "bare", checkedAt: NOW_ISO });
    } finally {
      errSpy.mockRestore();
    }
  });

  it("unverified (check never reached a verdict): the returned row says inconclusive, not the stale yes/no", async () => {
    const syncDeps = fakeSyncDeps({ checks: [null, null, null] });
    const storage = fakeCombinedStorage();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await recycleWithSync(
        syncDeps, storage, STUDIO_ID, vi.fn(async () => {}), vi.fn(async () => {}),
        provisionCarryingStale(), vi.fn(async () => {}), CFG, noopResolveMemoryRepo, noopCommit,
      );

      expect(result.error).toContain("NOT verified"); // the pre-existing note, unchanged
      expect(result.readiness).toMatchObject({ kind: "inconclusive", checkedAt: NOW_ISO });
      expect((result.readiness as { reason: string }).reason).toContain("sandbox-default");
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// container/studio-bringup.sh — fail closed on a missing gate (2026-08-26).
// Source assertions, same technique (and same reason) as the lead-gate blocks
// above: shell is not importable, so the guard's exact shape is pinned here.
// ---------------------------------------------------------------------------

describe("container/studio-bringup.sh — a studio with no gate refuses to boot", () => {
  const src = () => env.TEST_STUDIO_BRINGUP_SRC;

  it("verifies the hook it just installed instead of assuming the write landed", () => {
    expect(src()).toContain("if [ ! -x ~/.claude/hooks/lead-gate.sh ]; then");
    expect(src()).toContain("refusing to boot an UNGATED lead (decision 11)");
  });

  it("also refuses when settings.json does not reference the hook — the file alone runs nothing", () => {
    expect(src()).toContain("if ! grep -q lead-gate.sh ~/.claude/settings.json 2>/dev/null; then");
  });

  it("exits rather than warning — an ungated lead holding Edit/Write is what decision 11 exists to prevent", () => {
    const guard = src().slice(src().indexOf("--- fail closed on the gate ---"));
    expect(guard.slice(0, guard.indexOf("printf '%s' \"$STUDIO_NAME\""))).toContain("exit 1");
  });

  it("marks the container as a studio, and refuses a later role-path bring-up on the same container", () => {
    // STUDIO_NAME lives in the per-exec env, so an env-less bring-up cannot
    // tell by itself that this container was ever a studio. The marker is the
    // only thing on disk that remembers.
    expect(src()).toContain("printf '%s' \"$STUDIO_NAME\" > ~/.claude/.fleet-studio");
    expect(src()).toContain('if [ -z "${STUDIO_NAME:-}" ] && [ -f ~/.claude/.fleet-studio ]; then');
    expect(src()).toContain("refusing rather than relaunching an UNGATED lead");
  });

  it("puts the refusal BEFORE the claude launch — a gate checked after the fact protects nothing", () => {
    expect(src().indexOf("refusing to boot an UNGATED lead")).toBeLessThan(src().indexOf("tmux send-keys -t studio:claude"));
    expect(src().indexOf("refusing rather than relaunching an UNGATED lead")).toBeLessThan(
      src().indexOf("tmux send-keys -t studio:claude"),
    );
  });
});

describe("container/studio-bringup.sh — Tier-0 completion gate (spec §4)", () => {
  // Board issue #2: this hook script moved out of studio-bringup.sh's own
  // GATEEOF heredoc into gates/completion-gate.sh — see the lead-gate
  // describe block's own comment above for the full rationale. Only the
  // SOURCE binding changed, not what is asserted.
  const src = () => env.TEST_COMPLETION_GATE_SRC;

  it("installs only for a studio whose roster writes code — never for the maestro", () => {
    // Bring-up's own gate on the whole install block, not gates/completion-gate.sh
    // itself — this half never moved.
    expect(env.TEST_STUDIO_BRINGUP_SRC).toContain('if [ -n "${STUDIO_COMPLETION_GATE:-}" ]; then');
  });

  it("registers as a Stop hook, fail-closed, dropping any prior entry", () => {
    // Bring-up's own settings.json merge python, not gates/completion-gate.sh
    // itself — same "registration half never moved" reasoning as above.
    const bringupSrc = env.TEST_STUDIO_BRINGUP_SRC;
    expect(bringupSrc).toContain('stop = cfg.setdefault("hooks", {}).setdefault("Stop", [])');
    expect(bringupSrc).toContain('completion-gate hook absent or not executable -- refusing (Tier 0)');
    expect(bringupSrc).toContain('stop[:] = [e for e in stop if "completion-gate.sh" not in json.dumps(e)]');
  });

  it("demands a COMMITTED plan doc — git log, not mere existence on disk", () => {
    expect(src()).toContain('["git", "log", "-1", "--format=%H", "--", plan]');
    expect(src()).toContain("has no commit touching it");
  });

  it("demands green build/lint/check/test, but only the ones the repo's package.json declares", () => {
    expect(src()).toContain('WANTED = ["build", "lint", "check", "test"]');
    expect(src()).toContain('scripts = json.load(open(os.path.join(root, "package.json"))).get("scripts", {})');
    expect(src()).toContain("no green ");
    // Unsatisfiable gate == dead studio: a repo with no build script is never
    // asked for a build.
    expect(src()).toContain("if want not in scripts:");
  });

  it("demands real output per command, not just a claimed exit code", () => {
    expect(src()).toContain("carries no output -- paste the real tail");
  });

  it("demands verification INTENT too (P5 spec §4) -- url, steps, expected, not just build/lint/check/test evidence", () => {
    expect(src()).toContain('vi = rec.get("verification_intent")');
    expect(src()).toContain("verification_intent.url must be a non-empty string.");
    expect(src()).toContain("verification_intent.steps must be a non-empty list of non-empty strings.");
    expect(src()).toContain("verification_intent.expected must be a non-empty string.");
  });

  it("is BOUNDED — an unbounded Stop hook wedges a studio nobody is watching", () => {
    expect(src()).toContain("MAX_REFUSALS = 5");
    expect(src()).toContain("STOOD DOWN after ");
  });

  it("carries no single quote in its python program — `python3 -c '...'` would end at the first one", () => {
    // Board issue #2: gates/completion-gate.sh is now a standalone file, not
    // a heredoc body — no `<<'GATEEOF'` marker left to anchor on. Slices the
    // SAME boundary directly out of the file's own text: the program opens
    // at `exec python3 -c '` and its closing quote is the file's own last
    // line (shebang + python3 guard + this one `python3 -c '...'` call).
    const openMarker = src().indexOf("exec python3 -c '");
    expect(openMarker).toBeGreaterThan(-1);
    const body = src().slice(openMarker + "exec python3 -c '".length, src().lastIndexOf("\n'\n"));
    expect(body).not.toContain("'");
  });
});

// ---------------------------------------------------------------------------
// container/studio-bringup.sh — C2: session-reemit wiring is pinned at BOTH
// ends (Task 6). Before this block, `grep -rn "session-reemit|SessionStart|
// working-set" test/` returned only test/bun/bringup-hooks.test.ts's
// executed-BEHAVIOR tests of the extracted REEMIT script -- nothing asserted
// that bring-up actually REGISTERS the SessionStart hook, nothing asserted
// the persist step exists, and nothing compared the path the hook reads
// against the path bring-up writes. Deleting either the registration or the
// persist line left all 76 bun + 1570 vitest tests green while the feature
// was silently gone -- the persist half also fails silently at RUNTIME (the
// hook fires on compact, `[ -r "$ws" ]` fails, exits 0, nobody learns).
// ---------------------------------------------------------------------------

describe("container/studio-bringup.sh — C2: session-reemit hook is actually wired in (Task 6)", () => {
  const src = () => env.TEST_STUDIO_BRINGUP_SRC;

  it("registers the SessionStart hook in the SAME settings.json write as the lead gate — one bring-up installs both hooks or neither", () => {
    const preToolUseIdx = src().indexOf('pre = cfg.setdefault("hooks", {}).setdefault("PreToolUse", [])');
    expect(preToolUseIdx).toBeGreaterThan(-1);
    const ssSetdefaultIdx = src().indexOf(
      'ss = cfg.setdefault("hooks", {}).setdefault("SessionStart", [])',
      preToolUseIdx,
    );
    const ssDedupIdx = src().indexOf(
      'ss[:] = [e for e in ss if "session-reemit.sh" not in json.dumps(e)]',
      preToolUseIdx,
    );
    const ssAppendIdx = src().indexOf(
      'ss.append({"hooks": [{"type": "command", "command": "$HOME/.claude/hooks/session-reemit.sh"}]})',
      preToolUseIdx,
    );
    const dumpIdx = src().indexOf("json.dump(cfg, f, indent=2)", preToolUseIdx);
    expect(ssSetdefaultIdx).toBeGreaterThan(preToolUseIdx);
    expect(ssDedupIdx).toBeGreaterThan(ssSetdefaultIdx);
    expect(ssAppendIdx).toBeGreaterThan(ssDedupIdx);
    // Both hooks land in the SAME write: the SessionStart append happens
    // BEFORE the one json.dump that commits this settings.json block to disk.
    expect(dumpIdx).toBeGreaterThan(ssAppendIdx);
  });

  it("persists the working set to disk before claude launches — mkdir then printf, both guarded so an unwritable FLEET_WORKSPACE cannot abort bring-up", () => {
    expect(src()).toContain('mkdir -p "${FLEET_WORKSPACE:-/workspace}/.fleet"');
    expect(src()).toContain(
      'printf \'%s\\n\' "$role_prompt" > "${FLEET_WORKSPACE:-/workspace}/.fleet/working-set.md"',
    );
  });

  it("the path the re-emit hook reads is EXACTLY the path bring-up persists to — a real comparison, not two independent literals that could silently drift apart", () => {
    // Extracts BOTH literals from source and compares them, rather than
    // asserting each against its own hardcoded expectation -- the failure
    // mode this guards is a typo or a changed default on ONLY ONE side
    // (e.g. the persist step moves to .fleet/workingset.md while the reader
    // keeps the hyphen), which two independent toContain checks would each
    // pass in isolation.
    // writeMatch stays on studio-bringup.sh's own text (the persist step
    // never moved); readMatch now comes from gates/session-reemit.sh (board
    // issue #2 moved the reader out of the REEMITEOF heredoc into that
    // standalone file) — same two-literal comparison as before, new source
    // for the second half only.
    const writeMatch = src().match(/printf '%s\\n' "\$role_prompt" > "([^"]+)"/);
    const readMatch = env.TEST_SESSION_REEMIT_SRC.match(/ws="([^"]+)"/);
    expect(writeMatch?.[1]).toBeTruthy();
    expect(readMatch?.[1]).toBeTruthy();
    expect(readMatch![1]).toBe(writeMatch![1]);
  });
});

// ---------------------------------------------------------------------------
// container/studio-bringup.sh — window-size staleness on client detach
// (board issue #4, item 3)
// ---------------------------------------------------------------------------

describe("container/studio-bringup.sh — window-size staleness investigation (board issue #4, item 3)", () => {
  // the operator's own measurement (board issue #4 comment): two Orca clients
  // attached to `studio`, one closed (confirmed dead PTY, confirmed exactly
  // one client left via `tmux list-clients`), and the window stayed pinned
  // to the departed client's stale ~120-column size instead of recomputing
  // to the survivor's real size. Investigated empirically (throwaway `-L`
  // socketed tmux server, tmux 3.2a — the version actually installed in
  // this environment, matching the container image): a real client-detached
  // event (both a graceful `detach-client` and an abrupt kill+fd-close,
  // simulating "orca terminal close") ALREADY makes tmux recompute
  // `window-size latest` correctly on its own, with `aggressive-resize`
  // either on or off, and with two or three simultaneous clients — no
  // `client-detached` hook needed or added. Also confirmed (board issue #6,
  // already merged and an ancestor of this branch — see
  // docs/superpowers/plans/2026-09-18-orca-terminal-idempotency.md) that the
  // actual mechanism putting a SECOND Orca client on one studio in the first
  // place — `ensure()`'s broken `title`-based idempotency check in
  // cli/orca-workspace.ts — is independently already fixed upstream, so the
  // scenario itself should now be rare going forward too. No `window-size`
  // or `client-detached` code change lands here; this block is a regression
  // guard plus a pin of the Ctrl-b-collision documentation note (item 2).
  const src = () => env.TEST_STUDIO_BRINGUP_SRC;

  // SUPERSEDED BY MEASUREMENT (issue #43, 2026-09-23). The guard that stood
  // here pinned `window-size latest` and forbade `largest` outright. Both
  // halves were wrong, and the reasoning above is kept as the record of why
  // they looked right: the comparison was never latest-vs-smallest. With
  // `latest`, ANY client that connects — a coordinator probe, an `ff` with no
  // tty, an attach in a small window — takes over the pane size for everyone,
  // including the human reading it; that is the measured failure (four
  // acme-os studios pinned at 80 columns by one tty-less client, hours after
  // the client's own process died). With `largest` the small client sees a
  // crop and the operator's view stays intact: the cost falls on whoever
  // peeks, not on whoever works.
  //
  // The VALUES are no longer asserted here at all. This lane is workerd — no
  // filesystem, no child_process — so everything it can say about a tmux
  // option is that a line of text exists, and a line of text existing is
  // exactly what misled this file before: `tmux set -g history-limit 50000`
  // sat in the script for a month while the session ran at 2000. The real
  // assertions moved to test/bun/bringup-tmux-render.test.ts, which EXECUTES
  // the shipped region against a real tmux server and reads the four values
  // back out of the session it created.
  //
  // What is left here is the one property that lane cannot see, because it
  // extracts the region rather than reading the file around it: ORDERING.

  it("writes the tmux config BEFORE creating the session — the ordering that makes the pane be born with the full history, and the exact bug the old `set -g history-limit` line had", () => {
    const confIdx = src().indexOf('cat > "$tmux_conf" <<');
    const sessionIdx = src().indexOf("tmux new-session -d -s studio -n claude");
    expect(confIdx).toBeGreaterThan(-1);
    expect(sessionIdx).toBeGreaterThan(-1);
    // tmux allocates a pane's history AT PANE CREATION and reads ~/.tmux.conf
    // at SERVER START. Reversed, the pane is born at tmux's default 2000 while
    // `show-options -g history-limit` answers 50000 — measured 2026-09-23 on
    // `acme-os--release-studio`, and the whole reason this ordering is
    // pinned rather than assumed.
    expect(confIdx).toBeLessThan(sessionIdx);
  });

  it("brackets the region with the markers the executable lane extracts, so that suite can never silently stop testing the real script", () => {
    expect(src()).toContain("# >>> tmux-render-options >>>");
    expect(src()).toContain("# <<< tmux-render-options <<<");
  });

  it("leaves no executable `mouse on` and no executable `window-size latest` behind anywhere in the file", () => {
    // `mouse on` is what put the wheel into tmux, and scrolling with the wheel
    // is what interleaved a copy-mode history repaint with the lead's live
    // output — reproduced with the operator on 2026-09-23 and fixed by
    // `mouse off`. Re-adding either line reopens a bug that took four
    // diagnoses to find.
    //
    // COMMENTS ARE EXEMPT, deliberately: the script quotes the original
    // 2026-09-16 `mouse on` note verbatim, because reversing a decision
    // without keeping the measurement that justified it is how a fleet
    // re-learns the same thing twice. Only lines tmux would actually execute
    // are searched.
    const code = src()
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"));
    for (const line of code) {
      expect(line).not.toMatch(/\bmouse\s+on\b/);
      expect(line).not.toMatch(/window-size\s+(latest|smallest)\b/);
      expect(line).not.toMatch(/aggressive-resize\s+on\b/);
    }
  });

  it("documents the tmux prefix staying `C-b` (the operator's explicit call, board issue #4) right after the rendering region — no prefix rebind anywhere in the file", () => {
    const mouseIdx = src().indexOf("set -g mouse off");
    expect(mouseIdx).toBeGreaterThan(-1);
    const prefixNoteIdx = src().indexOf("The prefix stays `C-b`");
    expect(prefixNoteIdx).toBeGreaterThan(mouseIdx);
    const nearby = src().slice(mouseIdx, prefixNoteIdx + 800);
    expect(nearby).toContain("Ctrl-b Ctrl-b");
    expect(nearby).toContain("board issue #4");
    // No rebind: tmux's prefix is set via `set -g prefix`, never present here.
    expect(src()).not.toContain("set -g prefix");
    expect(src()).not.toContain("set-option -g prefix");
  });
});

// PR #46 review: the periodic cycle ships aside dirs (#37), and a failure
// there is visible on the row, never only in a log. A throwing aside ship
// never costs the burn mirror.
describe("syncSessionCycle — aside sessions (issue #37, PR #46 review)", () => {
  const DIR = "fleet-aside-20260929T100000Z-42--workspace-websites";
  const burn: Burn = {
    turns: 1, inputTokens: 10, outputTokens: 5, costUsd: 0,
    window5hStart: "2026-08-16T00:00:00.000Z", window5hOutput: 5,
  };

  it("lists and packs the aside dir; a failed pack lands on the row as NOT shipped", async () => {
    const deps = fakeSyncDeps();
    const inner = deps.exec;
    deps.exec = async (cmd: string) => {
      if (cmd === asideListCmd()) { deps.execCalls.push(cmd); return { code: 0, stdout: `${DIR}\n`, stderr: "" }; }
      if (cmd === asidePackCmd(DIR)) { deps.execCalls.push(cmd); return { code: 2, stdout: "", stderr: "tar: disk full" }; }
      return inner(cmd);
    };
    const storage = fakeCycleStorage({ status: cycleStatus(), burn });
    const recorded: StudioStatus[] = [];
    await syncSessionCycle(deps, storage, STUDIO_ID, async (st) => { recorded.push(st); });

    expect(deps.execCalls).toContain(asideListCmd());
    expect(deps.execCalls).toContain(asidePackCmd(DIR));
    const row = recorded.at(-1)!;
    expect(row.asideShip?.failed).toEqual([{ dir: DIR, reason: expect.stringContaining("disk full") }]);
  });

  it("an aside ship that THROWS (list exec dies) never stops the burn mirror, and is on the row", async () => {
    const deps = fakeSyncDeps();
    const inner = deps.exec;
    deps.exec = async (cmd: string) => {
      if (cmd === asideListCmd()) throw new Error("Session 'sandbox-default' shell exited");
      return inner(cmd);
    };
    const storage = fakeCycleStorage({ status: cycleStatus(), burn });
    const recorded: StudioStatus[] = [];
    await syncSessionCycle(deps, storage, STUDIO_ID, async (st) => { recorded.push(st); });

    expect(recorded.some((st) => st.burn?.turns === 1)).toBe(true);
    expect(recorded.at(-1)!.asideShip?.failed[0].reason).toContain("shell exited");
  });

  it("clean aside ship clears a prior failure from the row", async () => {
    const deps = fakeSyncDeps();
    const storage = fakeCycleStorage({ status: cycleStatus(), burn });
    await storage.put(ASIDE_SHIP_KEY, { at: "2026-09-29T00:00:00.000Z", failed: [{ dir: DIR, reason: "old" }] });
    const recorded: StudioStatus[] = [];
    await syncSessionCycle(deps, storage, STUDIO_ID, async (st) => { recorded.push(st); });
    expect(recorded.at(-1)!.asideShip).toBeNull();
  });
});

// Issue #39: rescue.ts's per-worktree RESCUE_WT lines ride out on the result
// (and on the confirmed-failure error), without changing any verdict.
describe("rescuePush — per-worktree report (issue #39)", () => {
  it("pushed + nothing: worktrees carried, verdict unchanged", async () => {
    const out = "RESCUE_WT checkout nothing\nRESCUE_WT agent-a1 pushed fleet/rescue/pilot/wt/agent-a1-20260925060000\n" +
      "RESCUE_PUSHED fleet/rescue/pilot/wt/agent-a1-20260925060000 1 files";
    const r = await rescuePush(fakeSyncDeps({ rescue: { code: 0, stdout: out } }), "fleetflare", STUDIO_ID);
    expect(r.pushed).toBe(true);
    expect(r.branch).toBe("fleet/rescue/pilot/wt/agent-a1-20260925060000");
    expect(r.worktrees).toEqual([
      { worktree: "checkout", outcome: "nothing" },
      { worktree: "agent-a1", outcome: "pushed", detail: "fleet/rescue/pilot/wt/agent-a1-20260925060000" },
    ]);
  });

  it("all nothing: still RESCUE_CLEAN, worktrees carried", async () => {
    const r = await rescuePush(fakeSyncDeps({ rescue: { code: 0, stdout: `RESCUE_WT checkout nothing\n${RESCUE_CLEAN}` } }), "fleetflare", STUDIO_ID);
    expect(r).toEqual({ pushed: false, branch: null, files: 0, skipped: "clean", worktrees: [{ worktree: "checkout", outcome: "nothing" }] });
  });

  it("confirmed failure: the error carries every worktree's line", async () => {
    const out = `RESCUE_WT checkout nothing\n${RESCUE_FAILED_PREFIX} agent-a1 push\nRESCUE_WT agent-a1 failed push`;
    const err = await rescuePush(fakeSyncDeps({ rescue: { code: 0, stdout: out } }), "fleetflare", STUDIO_ID).then(() => null, (e) => e);
    expect(err.worktrees).toEqual([{ worktree: "checkout", outcome: "nothing" }, { worktree: "agent-a1", outcome: "failed", detail: "push" }]);
  });

  it("a malformed RESCUE_WT line fails closed", async () => {
    await expect(rescuePush(fakeSyncDeps({ rescue: { code: 0, stdout: `RESCUE_WT checkout exploded\n${RESCUE_CLEAN}` } }), "fleetflare", STUDIO_ID))
      .rejects.toThrow();
  });

  it("formatRescueReport: one human line per worktree", () => {
    expect(formatRescueReport([
      { worktree: "checkout", outcome: "nothing" },
      { worktree: "agent-a1", outcome: "pushed", detail: "fleet/rescue/x" },
      { worktree: "agent-a2", outcome: "failed", detail: "budget 3 not attempted" },
    ])).toEqual(["checkout: nothing to push", "agent-a1: pushed fleet/rescue/x", "agent-a2: FAILED (budget 3 not attempted)"]);
  });
});

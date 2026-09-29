import { describe, it, expect, vi } from "vitest";
import {
  tarAndStatCmd, singleReadCmd, asideListCmd, asidePackCmd, type SessionSyncDeps, type SessionSyncStorage,
} from "../src/studio/session-sync";
import {
  STATUS_KEY, DESTROY_EPOCH_KEY, readDestroyEpoch, type StudioStorage, type RoleEnv, type StudioEnv,
} from "../src/studio/provision";
import {
  rescuePushCmd, RESCUE_CLEAN, RESCUE_FAILED_PREFIX, harvestRecordCmd, HARVEST_NO_RECORD, doneRecordsListCmd,
  type CommitLearningFile, type ResolveMemoryRepo,
} from "../src/studio/do";
import { destroyWithSync, runDestroy, DESTROY_REFUSED_PREFIX, type DestroyGuard } from "../src/studio/destroy";
import { getObserved, type ObservedStorage } from "../src/studio/observed";
import type { StudioStatus } from "../src/studio/types";

// Fleet board task #124: `fleet destroy <id> [--force]`. Same test posture
// test/studio.session.test.ts's own "recycleWithSync" describe block takes —
// see that file's header for why: a live StudioDO cannot be constructed
// under vitest-pool-workers, so destroyWithSync/runDestroy (src/studio/destroy.ts)
// are the exported pure functions do.ts's real destroyStudio() method will be
// a thin wrapper around.

const STUDIO_ID = "websites--pilot";
const REPO = "websites";
const TODAY = "2026-09-08";

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

/** Trimmed copy of test/studio.session.test.ts's own fakeSyncDeps — same
 *  command-shape dispatch (mkdir -p for the tar+stat, "status --porcelain"
 *  for rescue-push, "done.json" for the harvest check, anything else the
 *  plain single read) — narrowed to what destroyWithSync's own three
 *  pre-destroy steps need, since there is no provisioned-check/awaitReady
 *  tail here to fake responses for. */
function fakeSyncDeps(opts: {
  rescue?: { code: number; stdout?: string; stderr?: string } | null;
  harvest?: { code: number; stdout?: string; stderr?: string } | null;
} = {}): SessionSyncDeps & { execCalls: string[] } {
  const execCalls: string[] = [];
  return {
    execCalls,
    exec: async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd.startsWith("mkdir -p")) return { code: 0, stdout: "0\n1758067200", stderr: "" }; // empty session, clean sync (#202: size + tar-start watermark)
      if (cmd.includes("status --porcelain")) {
        if (opts.rescue === null) throw new Error("Session 'sandbox-default' shell exited (exit code: 0)");
        return { code: opts.rescue?.code ?? 0, stdout: opts.rescue?.stdout ?? RESCUE_CLEAN, stderr: opts.rescue?.stderr ?? "" };
      }
      if (cmd.includes(HARVEST_NO_RECORD)) {
        if (opts.harvest === null) throw new Error("Session 'sandbox-default' shell exited (exit code: 0)");
        return { code: opts.harvest?.code ?? 0, stdout: opts.harvest?.stdout ?? HARVEST_NO_RECORD, stderr: opts.harvest?.stderr ?? "" };
      }
      return { code: 0, stdout: "", stderr: "" }; // the tar's single-read
    },
    r2Put: async () => {},
    r2List: async () => [],
    r2Delete: async () => {},
    now: fixedNow(`${TODAY}T12:00:00.000Z`),
    notify: async () => {},
    burnAlertThresholdTokens: 0,
  };
}

const noopCommit: CommitLearningFile = async () => {};
const noopResolveMemoryRepo: ResolveMemoryRepo = async () => "unused/blueprint-repo";

type CombinedStorage = StudioStorage & SessionSyncStorage;

/** Same one-Map-behind-every-key shape test/studio.session.test.ts's own
 *  fakeCombinedStorage uses. */
function fakeCombinedStorage(seed?: { status?: StudioStatus }): CombinedStorage {
  const map = new Map<string, StudioStatus | RoleEnv | StudioEnv | string | boolean>();
  if (seed?.status) map.set(STATUS_KEY, seed.status);
  return {
    get: (async (key: string) => map.get(key)) as CombinedStorage["get"],
    put: (async (key: string, value: StudioStatus | RoleEnv | StudioEnv | string | boolean) => {
      map.set(key, value);
    }) as CombinedStorage["put"],
    // Issue #228 item 4: SessionSyncStorage.delete is now required — this
    // fake never arms/consumes SESSION_FORCE_KEY itself.
    delete: (async (key: string) => map.delete(key)) as NonNullable<SessionSyncStorage["delete"]>,
  };
}

// ---------------------------------------------------------------------------
// destroyWithSync — sync before rescue-push before harvest before destroy,
// then STOPPED (never reprovisioned)
// ---------------------------------------------------------------------------

describe("destroyWithSync", () => {
  it("probes, then calls sync, then rescue-push, then learning-harvest, then destroy — in that order — and NOTHING after destroy", async () => {
    const syncDeps = fakeSyncDeps();
    const order = syncDeps.execCalls;
    const destroy = vi.fn(async () => {
      order.push("destroy");
    });
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();

    const result = await destroyWithSync(syncDeps, storage, STUDIO_ID, destroy, recordStudioFn, REPO, noopResolveMemoryRepo, noopCommit);

    // Issue #104: the probe comes first, exactly as recycleWithSync's does.
    expect(order).toEqual([
      // Issue #37: aside sessions (none here) are listed after the main sync.
      "printf ok", tarAndStatCmd(), singleReadCmd(), asideListCmd(), rescuePushCmd(REPO, STUDIO_ID), harvestRecordCmd(REPO, null),
      "destroy",
    ]);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(result.state).toBe("stopped");
    expect(result.error).toBeNull();
  });

  // Issue #361: the completion records reach the ops repo before destroy.
  it("archives the workspace completion records to the ops repo before destroy", async () => {
    const base = fakeSyncDeps();
    const commits: string[] = [];
    const syncDeps = {
      ...base,
      exec: async (cmd: string) =>
        cmd === doneRecordsListCmd() ? { code: 0, stdout: `316\t${btoa("{}")}`, stderr: "" } : base.exec(cmd),
      doneRecords: {
        workRepoSlug: async () => "acme/websites",
        putOpsFile: async (repo: string, path: string) => { commits.push(`${repo}:${path}`); },
        commentOnTask: async () => {},
      },
    };
    const result = await destroyWithSync(
      syncDeps, fakeCombinedStorage(), STUDIO_ID,
      async () => { commits.push("destroy"); }, vi.fn(async () => {}), REPO,
      async () => "o/ops", noopCommit,
    );
    expect(result.state).toBe("stopped");
    // #367: the collision fix -- workRepo's own "/" is no longer flattened
    // to "-", so the ops path nests as done/<owner>/<repo>/<task>.json.
    expect(commits).toEqual(["o/ops:done/acme/websites/316.json", "destroy"]);
  });

  // #346 review item 2: memory off (FLEET_OPS_REPO unset) with learnings on
  // disk -- the stopped row says they were not harvested; never silent loss.
  it("memory store off: the stopped row names the learnings not harvested", async () => {
    const syncDeps = fakeSyncDeps({ harvest: { code: 0, stdout: JSON.stringify({ learnings: ["a fact"] }) } });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await destroyWithSync(
        syncDeps, fakeCombinedStorage(), STUDIO_ID, vi.fn(async () => {}), vi.fn(async () => {}), REPO, async () => null, noopCommit,
      );
      expect(result.state).toBe("stopped");
      expect(result.error).toBe("destroyed with 1 learning(s) not harvested: FLEET_OPS_REPO is unset (memory off)");
    } finally {
      errors.mockRestore();
    }
  });

  // Review round 3 (issue #85 PR1), MUST-FIX 8(a) — destroyWithSync's own
  // pre-destroy sync succeeds at the identical R2 put restartWithSync's/
  // recycleWithSync's do, and must mirror it into lastSnapshotAt the same
  // way. A clean destroy (this fixture's sync always succeeds) is exactly
  // the "final sync ok" case the maestro's later age-measurement ruling
  // (MUST-FIX 8d) treats as ~0 work at risk.
  it("records lastSnapshotAt on a successful pre-destroy sync when observedStorage is passed", async () => {
    const syncDeps = fakeSyncDeps();
    const destroy = vi.fn(async () => {});
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();
    const observedMap = new Map<string, unknown>();
    const observedStorage: ObservedStorage = {
      get: (async (key: string) => observedMap.get(key)) as ObservedStorage["get"],
      put: (async (key: string, value: unknown) => { observedMap.set(key, value); }) as ObservedStorage["put"],
    };

    await destroyWithSync(
      syncDeps, storage, STUDIO_ID, destroy, recordStudioFn, REPO, noopResolveMemoryRepo, noopCommit,
      undefined, observedStorage,
    );

    const observed = await getObserved(observedStorage);
    expect(observed.lastSnapshotAt).toBe(`${TODAY}T12:00:00.000Z`);
  });

  it("no observedStorage passed: destroyWithSync behaves exactly as before", async () => {
    const syncDeps = fakeSyncDeps();
    const destroy = vi.fn(async () => {});
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();

    const result = await destroyWithSync(syncDeps, storage, STUDIO_ID, destroy, recordStudioFn, REPO, noopResolveMemoryRepo, noopCommit);

    expect(result.state).toBe("stopped");
  });

  // Issue #62: an UNCONFIRMED rescue (the exec throws — dead session shell,
  // transport error — or is killed by its deadline) is unknown state, not
  // "nothing lost": destroy refuses exactly like a confirmed failure, and
  // the container is untouched. Used to proceed best-effort (#263 round 1).
  for (const [label, rescue] of [
    ["the rescue exec throws (dead shell)", null],
    ["the rescue exec is killed (124)", { code: 124, stdout: "", stderr: "" }],
  ] as const) {
    it(`#62: ${label} → destroy REFUSES, names it, container and epoch untouched`, async () => {
      const syncDeps = fakeSyncDeps({ rescue });
      const destroy = vi.fn(async () => {});
      const storage = fakeCombinedStorage();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const message = await destroyWithSync(
          syncDeps, storage, STUDIO_ID, destroy, vi.fn(async () => {}), REPO, noopResolveMemoryRepo, noopCommit,
        ).then(() => "", (err: Error) => err.message);
        expect(message.startsWith(DESTROY_REFUSED_PREFIX)).toBe(true);
        expect(message).toContain("could not confirm");
        // Same price the probe refusal quotes: the last synced snapshot's age.
        expect(message).toContain("last synced snapshot (age unknown");
        expect(message).toContain(`fleet destroy ${STUDIO_ID} --discard-unsynced`);
        // #62 follow-up: never offer --force here — it ALSO skips the
        // open-board-task check. Same single override as every refusal.
        expect(message).not.toContain("--force");
        expect(destroy).not.toHaveBeenCalled();
        expect(await readDestroyEpoch(storage)).toBe(0);
      } finally {
        errSpy.mockRestore();
      }
    });
  }

  it("#62: unconfirmed rescue + --discard-unsynced (or --force) → proceeds, stopped row names the unconfirmed rescue", async () => {
    const syncDeps = fakeSyncDeps({ rescue: null });
    const destroy = vi.fn(async () => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const flag of ["--discard-unsynced", "--force"] as const) {
        const guard: DestroyGuard = { containerRunning: () => true, discardUnsynced: true, discardFlag: flag };
        const result = await destroyWithSync(
          syncDeps, fakeCombinedStorage(), STUDIO_ID, destroy, vi.fn(async () => {}), REPO, noopResolveMemoryRepo, noopCommit, guard,
        );
        expect(result.state).toBe("stopped");
        expect(result.error).toContain("unconfirmed rescue-push");
        expect(result.error).toContain(flag);
      }
      expect(destroy).toHaveBeenCalledTimes(2);
    } finally {
      errSpy.mockRestore();
    }
  });

  // PR #263 round 3 (#251 review), N3: a CONFIRMED rescue-push failure (a
  // real `RESCUE_FAILED <wt> <step>` line — rescue.ts's own script already
  // retried a fallback ref and STILL failed) must refuse destroy exactly
  // like a failed probe does, unless the caller stated the choice to discard
  // it anyway — never the ambiguous "session shell died" throw the tests
  // above use, which stays best-effort, unchanged.
  it("a CONFIRMED rescue-push failure refuses destroy (never proceeds) when no --discard-unsynced was passed", async () => {
    const syncDeps = fakeSyncDeps({ rescue: { code: 0, stdout: `${RESCUE_FAILED_PREFIX} agent-a1 push` } });
    const destroy = vi.fn(async () => {});
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();

    expect(await readDestroyEpoch(storage)).toBe(0);
    await expect(
      destroyWithSync(syncDeps, storage, STUDIO_ID, destroy, recordStudioFn, REPO, noopResolveMemoryRepo, noopCommit),
    ).rejects.toThrow(new RegExp(`^${DESTROY_REFUSED_PREFIX}`));
    expect(destroy).not.toHaveBeenCalled();
    // Same invariant the probe refusal already has: a refused destroy leaves
    // the epoch completely untouched.
    expect(await readDestroyEpoch(storage)).toBe(0);
  });

  it("--discard-unsynced (or --force) proceeds anyway past a CONFIRMED rescue-push failure, and the stopped row names it", async () => {
    const syncDeps = fakeSyncDeps({ rescue: { code: 0, stdout: `${RESCUE_FAILED_PREFIX} agent-a1 push` } });
    const destroy = vi.fn(async () => {});
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const guard: DestroyGuard = { containerRunning: () => true, discardUnsynced: true, discardFlag: "--discard-unsynced" };
    try {
      const result = await destroyWithSync(
        syncDeps, storage, STUDIO_ID, destroy, recordStudioFn, REPO, noopResolveMemoryRepo, noopCommit, guard,
      );
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(result.state).toBe("stopped");
      expect(result.error).toMatch(/agent-a1/);
      expect(result.error).toMatch(/--discard-unsynced/);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a throwing learning harvest does not prevent destroy from running", async () => {
    const syncDeps = fakeSyncDeps({ harvest: null });
    const destroy = vi.fn(async () => {});
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await destroyWithSync(syncDeps, storage, STUDIO_ID, destroy, recordStudioFn, REPO, noopResolveMemoryRepo, noopCommit);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(result.state).toBe("stopped");
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("persists and RECORDS the final status as stopped, error null, never reprovisioned — unlike recycleWithSync, nothing downstream of this writes it", async () => {
    const syncDeps = fakeSyncDeps();
    const destroy = vi.fn(async () => {});
    const recorded: StudioStatus[] = [];
    const recordStudioFn = vi.fn(async (s: StudioStatus) => { recorded.push(s); });
    const storage = fakeCombinedStorage({
      status: { id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null },
    });

    const result = await destroyWithSync(syncDeps, storage, STUDIO_ID, destroy, recordStudioFn, REPO, noopResolveMemoryRepo, noopCommit);

    expect(result.state).toBe("stopped");
    expect((await storage.get(STATUS_KEY))?.state).toBe("stopped");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].state).toBe("stopped");
  });

  it("a destroy() failure degrades the studio (never stopped) and throws — the same non-silent posture recycleWithSync's own destroy/awaitReady failure takes", async () => {
    const syncDeps = fakeSyncDeps();
    const destroy = vi.fn(async () => { throw new Error("container kill failed: no such container"); });
    const recorded: StudioStatus[] = [];
    const recordStudioFn = vi.fn(async (s: StudioStatus) => { recorded.push(s); });
    const storage = fakeCombinedStorage();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        destroyWithSync(syncDeps, storage, STUDIO_ID, destroy, recordStudioFn, REPO, noopResolveMemoryRepo, noopCommit),
      ).rejects.toThrow(/container kill failed/);
      expect(recorded).toHaveLength(1);
      expect(recorded[0].state).toBe("degraded");
      expect((await storage.get(STATUS_KEY))?.state).toBe("degraded");
    } finally {
      errSpy.mockRestore();
    }
  });

  // Issue #152: the destroy epoch is what lets a racing provision/restart/
  // recycle tell "a destroy landed since I started" apart from "nothing
  // happened yet" — see DESTROY_EPOCH_KEY's own doc comment (provision.ts).
  it("a clean destroy bumps the epoch exactly TWICE — once after the probe-refusal decision, once after the stopped-row write", async () => {
    const syncDeps = fakeSyncDeps();
    const destroy = vi.fn(async () => {});
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();

    expect(await readDestroyEpoch(storage)).toBe(0);
    await destroyWithSync(syncDeps, storage, STUDIO_ID, destroy, recordStudioFn, REPO, noopResolveMemoryRepo, noopCommit);
    expect(await readDestroyEpoch(storage)).toBe(2);
  });

  it("a destroy that dies before its own stopped-row write (destroy() throws) bumps the epoch exactly ONCE", async () => {
    const syncDeps = fakeSyncDeps();
    const destroy = vi.fn(async () => { throw new Error("container kill failed: no such container"); });
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await readDestroyEpoch(storage)).toBe(0);
      await expect(
        destroyWithSync(syncDeps, storage, STUDIO_ID, destroy, recordStudioFn, REPO, noopResolveMemoryRepo, noopCommit),
      ).rejects.toThrow(/container kill failed/);
      expect(await readDestroyEpoch(storage)).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("the epoch is never cleared: it survives a DIFFERENT studio's untouched DESTROY_EPOCH_KEY absence and only ever increases", async () => {
    const syncDeps = fakeSyncDeps();
    const destroy = vi.fn(async () => {});
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();

    await destroyWithSync(syncDeps, storage, STUDIO_ID, destroy, recordStudioFn, REPO, noopResolveMemoryRepo, noopCommit);
    expect(await storage.get(DESTROY_EPOCH_KEY)).toBe(2);
    // A second destroy call (e.g. a retried `fleet destroy`) bumps further —
    // still monotonic, never reset back to 0 or 1.
    await destroyWithSync(syncDeps, storage, STUDIO_ID, destroy, recordStudioFn, REPO, noopResolveMemoryRepo, noopCommit);
    expect(await storage.get(DESTROY_EPOCH_KEY)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// runDestroy — the refusal gate ahead of destroyWithSync's own sequence
// ---------------------------------------------------------------------------

describe("runDestroy", () => {
  it("#55: the refusal NAMES the blocking tasks when the checker reports them", async () => {
    const syncDeps = fakeSyncDeps();
    const destroy = vi.fn(async () => {});
    const checkOpenTask = vi.fn(async () => ({ ok: true as const, hasOpenTask: true, tasks: [90, 85] }));

    const result = await runDestroy(
      checkOpenTask, STUDIO_ID, "acme-org/websites", false,
      syncDeps, fakeCombinedStorage(), STUDIO_ID, destroy, vi.fn(async () => {}), REPO, noopResolveMemoryRepo, noopCommit,
    );

    expect(result).toEqual({
      ok: false, refused: true,
      reason: "studio websites--pilot has open assigned board task(s) #90, #85; cancel (fleet task state <n> canceled), "
        + "reassign (fleet task assign <n> <role>), or pass --force to destroy anyway",
    });
    expect(destroy).not.toHaveBeenCalled();
  });

  it("#124 N1: a drifted task is named as needing its labels fixed by hand", async () => {
    const destroy = vi.fn(async () => {});
    const checkOpenTask = vi.fn(async () => ({ ok: true as const, hasOpenTask: true, tasks: [90, 7], drifted: [7] }));
    const result = await runDestroy(
      checkOpenTask, STUDIO_ID, "acme-org/websites", false,
      fakeSyncDeps(), fakeCombinedStorage(), STUDIO_ID, destroy, vi.fn(async () => {}), REPO, noopResolveMemoryRepo, noopCommit,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain(
      "#7 has drifted state labels (not exactly one of submitted/working/input_required/completed/failed/canceled) — fix them by hand on GitHub",
    );
    expect(destroy).not.toHaveBeenCalled();
  });

  it("refuses when an open assigned board task exists, and NEVER attempts sync/rescue/harvest/destroy", async () => {
    const syncDeps = fakeSyncDeps();
    const destroy = vi.fn(async () => {});
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();
    const checkOpenTask = vi.fn(async () => ({ ok: true as const, hasOpenTask: true }));

    const result = await runDestroy(
      checkOpenTask, STUDIO_ID, "acme-org/websites", false,
      syncDeps, storage, STUDIO_ID, destroy, recordStudioFn, REPO, noopResolveMemoryRepo, noopCommit,
    );

    expect(result).toEqual({
      ok: false, refused: true,
      reason: "studio websites--pilot has an open assigned board task; pass --force to destroy anyway",
    });
    expect(destroy).not.toHaveBeenCalled();
    expect(syncDeps.execCalls).toEqual([]); // sync/rescue-push/harvest never even attempted
    expect(recordStudioFn).not.toHaveBeenCalled();
  });

  it("refuses (fail CLOSED, not open) when the open-task check itself fails, and NEVER attempts sync/rescue/harvest/destroy — same shape as a confirmed open task", async () => {
    const syncDeps = fakeSyncDeps();
    const destroy = vi.fn(async () => {});
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();
    const checkOpenTask = vi.fn(async () => ({ ok: false as const, message: "board API error: 503" }));

    const result = await runDestroy(
      checkOpenTask, STUDIO_ID, "acme-org/websites", false,
      syncDeps, storage, STUDIO_ID, destroy, recordStudioFn, REPO, noopResolveMemoryRepo, noopCommit,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refused).toBe(true);
      expect(result.reason).toContain("board API error: 503");
    }
    expect(destroy).not.toHaveBeenCalled();
    expect(syncDeps.execCalls).toEqual([]); // sync/rescue-push/harvest never even attempted
    expect(recordStudioFn).not.toHaveBeenCalled();
  });

  it("--force overrides the refusal: the check is never even called, and the full destroy sequence proceeds", async () => {
    const syncDeps = fakeSyncDeps();
    const destroy = vi.fn(async () => {
      syncDeps.execCalls.push("destroy");
    });
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();
    const checkOpenTask = vi.fn(async () => ({ ok: true as const, hasOpenTask: true }));

    const result = await runDestroy(
      checkOpenTask, STUDIO_ID, "acme-org/websites", true,
      syncDeps, storage, STUDIO_ID, destroy, recordStudioFn, REPO, noopResolveMemoryRepo, noopCommit,
    );

    expect(checkOpenTask).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status.state).toBe("stopped");
    expect(syncDeps.execCalls.at(-1)).toBe("destroy");
  });

  it("no open task: proceeds through the full sequence and the final state is stopped, never running/provisioned", async () => {
    const syncDeps = fakeSyncDeps();
    const destroy = vi.fn(async () => {});
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();
    const checkOpenTask = vi.fn(async () => ({ ok: true as const, hasOpenTask: false }));

    const result = await runDestroy(
      checkOpenTask, STUDIO_ID, "acme-org/websites", false,
      syncDeps, storage, STUDIO_ID, destroy, recordStudioFn, REPO, noopResolveMemoryRepo, noopCommit,
    );

    expect(checkOpenTask).toHaveBeenCalledWith(STUDIO_ID, "acme-org/websites");
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status.state).toBe("stopped");
      expect((await storage.get(STATUS_KEY))?.state).toBe("stopped");
    }
  });

  it("with no checkOpenTask supplied at all, force:false REFUSES (fail closed — an absent check can never be treated as a confirmed 'no open task')", async () => {
    const syncDeps = fakeSyncDeps();
    const destroy = vi.fn(async () => {});
    const recordStudioFn = vi.fn(async () => {});
    const storage = fakeCombinedStorage();

    const result = await runDestroy(
      undefined, STUDIO_ID, "acme-org/websites", false,
      syncDeps, storage, STUDIO_ID, destroy, recordStudioFn, REPO, noopResolveMemoryRepo, noopCommit,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refused).toBe(true);
    expect(destroy).not.toHaveBeenCalled();
  });
});

// PR #46 review: an aside dir that could not ship before destroy is named on
// the stopped row, like an unrescued worktree.
describe("destroy — unshipped aside named on the row (PR #46 review)", () => {
  it("pack fails: destroy proceeds, stopped row names the dir", async () => {
    const DIR = "fleet-aside-20260929T100000Z-42--workspace-websites";
    const base = fakeSyncDeps();
    const syncDeps = {
      ...base,
      exec: async (cmd: string) => {
        if (cmd === asideListCmd()) return { code: 0, stdout: `${DIR}\n`, stderr: "" };
        if (cmd === asidePackCmd(DIR)) return { code: 2, stdout: "", stderr: "tar: disk full" };
        return base.exec(cmd);
      },
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await destroyWithSync(
        syncDeps, fakeCombinedStorage(), STUDIO_ID, vi.fn(async () => {}), vi.fn(async () => {}), REPO,
        noopResolveMemoryRepo, noopCommit,
      );
      expect(result.state).toBe("stopped");
      expect(result.error).toContain(`aside session NOT shipped: ${DIR}`);
    } finally {
      errSpy.mockRestore();
    }
  });
});

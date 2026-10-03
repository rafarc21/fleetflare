import { describe, it, expect, vi } from "vitest";
import {
  restartWithStorage, provisionWithStorage, runRestart, runProvision, STATUS_KEY, ROLE_ENV_KEY, BRINGUP_CMD, BRINGUP_LOG_PATH,
  bringupLogTailCmd, bringupLogAppendCmd, BRINGUP_RETRY_HEALED, OPERATION_KEY, OPERATION_STALE_MS, adoptWorktreeSessionCmd,
  LAST_STOP_KEY, recordBringupObservation,
  type ProvisionDeps, type StudioStorage, type RoleEnv, type StudioEnv, type OpCtx, type LastStop,
} from "../src/studio/provision";
import { checkProvisionedWithRetry, restartWithFreshVerdict, recycleWithSync, type ResolveMemoryRepo, type CommitLearningFile } from "../src/studio/do";
import { PROVISIONED_OK } from "../src/studio/provision";
import type { SessionSyncDeps, SessionSyncStorage } from "../src/studio/session-sync";
import { sessionLatestKey, sessionDailyKey } from "../src/studio/archive";
import type { StudioStatus, ProvisionConfig } from "../src/studio/types";
import {
  INCARNATION_PATH, getObserved, mergeObserved, type ObservedStorage, type ObservedSession,
  BRINGUP_TOKEN_WRITE_SECTION, SESSION_FOUND_SECTION, SESSION_CONTINUE_SECTION, SESSION_CWD_SECTION,
  SESSION_LEAD_AGE_SECTION,
} from "../src/studio/observed";
import {
  runAccountFailover, paneCaptureCmd, RATE_LIMIT_HEADLINES, RATE_LIMIT_MODAL_MARKERS, PANE_CAPTURE_MARKER,
  type FailoverDeps,
} from "../src/studio/failover";
import type { ClaudeAccount } from "../src/studio/accounts";
import { composeSurvivalBrief } from "../src/studio/survival-brief";

// Issue #38, measured 2026-09-23. A deploy bumped the studio image digest;
// Cloudflare replaced every running container; SIX `acme-os` studios came
// back BARE — /workspace EMPTY, no clone, the claude pane running `bash`.
// Same image, same repo, same moment as the ones that came back fine.
//
// A rollout replacement is neither a provision nor a restart-in-place: it is
// a NEW container coming up under an EXISTING Durable Object. #29 added
// on-disk verification to `runProvision` and its PR said plainly that
// `runRestart` was deliberately NOT extended, reasoning that restart heals
// the same container. A replaced container lands exactly in the gap that
// reasoning left open — `runRestart` execs bring-up, reads its exit code,
// and reports `state: "running"` over a container it never looked at, while
// spreading the PRE-replacement `readiness` verdict forward as if it were
// still true.
//
// This file covers all three parts of the issue on the Worker side:
//   part 1 — the bring-up log's tail reaches a failed readiness verdict, so
//            an operator sees the failing step without a container shell;
//   part 2 — whatever path a container takes to become live, the checkout
//            and the harness are verified before it is reported as anything
//            but broken;
//   part 3 — a failed verification re-runs bring-up ONCE, and a second
//            attempt that succeeds still says the first one failed.

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

function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    ...overrides,
  };
}

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

describe("runRestart — a replaced container is verified on disk before it is called anything but broken (issue #38 part 2)", () => {
  // THE issue's own mandatory failing test: "a container that comes up with
  // no checkout must produce a recorded, readable failure and must not be
  // reported healthy."
  it("no checkout after a clean bring-up exit: degrades, names the missing checkout, and NEVER reports running", async () => {
    const deps = restartDeps((cmd) => (cmd === CLONE_CHECK ? { code: 1, stdout: "", stderr: "" } : undefined));
    const storage = fakeStorage({ status: status(), roleEnv: ROLE_ENV });

    const result = await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare");

    expect(result.state).toBe("degraded");
    expect(result.error).toContain(`/workspace/${REPO}/.git is missing`);
    expect(result.error).toContain("did not land on this container");
    // Recorded, not merely returned: `fleet ls` reads the stored row.
    expect((await storage.get(STATUS_KEY))?.state).toBe("degraded");
  });

  it("studio path: ~/.claude/agents missing after a clean bring-up exit degrades, naming studio materialization", async () => {
    const deps = restartDeps((cmd) => (cmd === AGENTS_CHECK ? { code: 1, stdout: "", stderr: "" } : undefined));
    const storage = fakeStorage({ status: status(), roleEnv: STUDIO_ENV });

    const result = await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare");

    expect(result.state).toBe("degraded");
    expect(result.error).toContain("~/.claude/agents is missing");
    expect(result.error).toContain("studio materialization did not land on this container");
  });

  it("role path: the ~/.claude/agents check is never issued — a plain role never gets that directory", async () => {
    const deps = restartDeps(() => undefined);
    const storage = fakeStorage({ status: status({ id: ROLE_ID }), roleEnv: ROLE_ENV });

    const result = await restartWithStorage(deps, storage, ROLE_ID, "rafarc21/fleetflare");

    expect(result.state).toBe("running");
    expect(deps.cmds).not.toContain(AGENTS_CHECK);
  });

  it("both checks run strictly AFTER bring-up — this is a post-bring-up re-check, not a precondition", async () => {
    const deps = restartDeps(() => undefined);
    const storage = fakeStorage({ status: status(), roleEnv: STUDIO_ENV });

    await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare");

    const bringupIdx = deps.cmds.indexOf(BRINGUP_CMD);
    expect(bringupIdx).toBeGreaterThanOrEqual(0);
    expect(deps.cmds.indexOf(CLONE_CHECK)).toBeGreaterThan(bringupIdx);
    expect(deps.cmds.indexOf(AGENTS_CHECK)).toBeGreaterThan(bringupIdx);
  });

  // `repoSlug` seeded deliberately: this suite's default status carries null,
  // and a studio that has never recorded which repo it holds is NOT
  // "genuinely healthy" any more. Issue #76 put the guarded clone on the
  // restart path, and a null slug resolves to the FLEET repo, whose name does
  // not match this studio's id segment -- so restart correctly refuses to
  // clone and now SAYS so on the row. Seeding the field is what makes this a
  // healthy studio; asserting `error: null` without it would have been
  // asserting the refusal away.
  it("regression: a genuinely healthy restart still lands running, error null, bring-up exec'd exactly once", async () => {
    const deps = restartDeps(() => undefined);
    const storage = fakeStorage({
      status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
    });

    const result = await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare");

    expect(result.state).toBe("running");
    expect(result.error).toBeNull();
    expect(deps.bringupCount()).toBe(1);
  });

  // Issue #88, and the reason the heal was DESTROYING lead history rather
  // than only failing to preserve it. Without a staged restore, bring-up's
  // own session-restore step finds nothing, claude launches WITHOUT
  // --continue and then CREATES an empty ~/.claude/projects. From then on
  // CONTAINER_HAS_PROJECTS_CMD answers "yes", restorePlan returns "skip"
  // forever, and the next sync tick r2Put's the empty session OVER the only
  // backup. One missing call, and every future heal of that studio starts
  // blank.
  it("restart stages the session restore, between the clone and bring-up", async () => {
    const deps = restartDeps(() => undefined, true);
    const storage = fakeStorage({
      status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
    });

    await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare");

    const cloneIdx = deps.cmds.findIndex((c) => c.includes("git clone"));
    const restoreIdx = deps.cmds.indexOf(CONTAINER_HAS_PROJECTS_CMD);
    const bringupIdx = deps.cmds.indexOf(BRINGUP_CMD);
    expect(cloneIdx).toBeGreaterThanOrEqual(0);
    expect(restoreIdx).toBeGreaterThan(cloneIdx);
    expect(bringupIdx).toBeGreaterThan(restoreIdx);
  });

  // The other half of #76's guard, and the finding that made it visible: a
  // studio with no recorded repo falls into the refusal on EVERY restart and
  // every self-heal, so it stays bare forever. The reason used to live only
  // in a console.warn no operator reads.
  it("a studio that never recorded its repo says WHY it stays bare, on the row", async () => {
    const deps = restartDeps(() => undefined);
    const storage = fakeStorage({ status: status(), roleEnv: STUDIO_ENV });

    const result = await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare");

    expect(result.error).toContain("restart issued NO clone");
    expect(result.error).toContain("fleet provision");
    expect(deps.cmds.some((c) => c.includes("git clone"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PART 3 — self-heal, but loudly
// ---------------------------------------------------------------------------

describe("runRestart — the retry heals at most once, and never hides that it was needed (issue #38 part 3)", () => {
  it("first attempt comes up hollow, second lands: state running, and the error SAYS the first attempt failed", async () => {
    const deps = restartDeps((cmd, attempt) =>
      cmd === CLONE_CHECK && attempt === 1 ? { code: 1, stdout: "", stderr: "" } : undefined,
    );
    const storage = fakeStorage({ status: status(), roleEnv: STUDIO_ENV });

    const result = await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare");

    expect(result.state).toBe("running");
    expect(result.error).not.toBeNull();
    expect(result.error).toContain(BRINGUP_RETRY_HEALED);
    expect(result.error).toContain(`/workspace/${REPO}/.git is missing`);
    expect(result.error).toContain(BRINGUP_LOG_PATH);
    expect(deps.bringupCount()).toBe(2);
  });

  it("at most ONE retry: both attempts hollow costs exactly two bring-ups, never a third", async () => {
    const deps = restartDeps((cmd) => (cmd === CLONE_CHECK ? { code: 1, stdout: "", stderr: "" } : undefined));
    const storage = fakeStorage({ status: status(), roleEnv: STUDIO_ENV });

    const result = await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare");

    expect(result.state).toBe("degraded");
    expect(deps.bringupCount()).toBe(2);
  });

  it("both attempts hollow: the error names BOTH, not just the last one", async () => {
    const deps = restartDeps((cmd, attempt) => {
      if (cmd === CLONE_CHECK && attempt === 1) return { code: 1, stdout: "", stderr: "" };
      if (cmd === BRINGUP_CMD && attempt === 2) return { code: 1, stdout: "", stderr: "python3 missing" };
      return undefined;
    });
    const storage = fakeStorage({ status: status(), roleEnv: STUDIO_ENV });

    const result = await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare");

    expect(result.state).toBe("degraded");
    expect(result.error).toContain(`/workspace/${REPO}/.git is missing`);
    expect(result.error).toContain("python3 missing");
  });

  it("BOTH attempts are recorded in the container's own bring-up log, not only in the status row", async () => {
    const deps = restartDeps((cmd, attempt) =>
      cmd === CLONE_CHECK && attempt === 1 ? { code: 1, stdout: "", stderr: "" } : undefined,
    );
    const storage = fakeStorage({ status: status(), roleEnv: STUDIO_ENV });

    await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare");

    const appends = deps.cmds.filter((c) => c.includes(BRINGUP_LOG_PATH) && c.startsWith("printf"));
    expect(appends.length).toBeGreaterThan(0);
    const joined = appends.join("\n");
    expect(joined).toContain(`/workspace/${REPO}/.git is missing`);
    // Two bring-up runs append their own run ids themselves; the Worker's
    // line is what ties them together as attempt 1 and attempt 2.
    expect(joined).toContain("attempt 1");
    expect(joined).toContain("attempt 2");
  });

  it("no retry when nothing failed: a healthy restart writes no retry line into the log", async () => {
    const deps = restartDeps(() => undefined);
    const storage = fakeStorage({ status: status(), roleEnv: STUDIO_ENV });

    await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare");

    // Issue #116's adopt exec names the log (it records an adoption there); it is not a retry line.
    expect(deps.cmds.filter((c) => c.includes(BRINGUP_LOG_PATH) && c !== adoptWorktreeSessionCmd(REPO))).toHaveLength(0);
  });

  it("a log append that itself fails never changes the verdict — recording is never load-bearing", async () => {
    const deps = restartDeps((cmd, attempt) => {
      if (cmd.includes(BRINGUP_LOG_PATH)) throw new Error("container gone");
      if (cmd === CLONE_CHECK && attempt === 1) return { code: 1, stdout: "", stderr: "" };
      return undefined;
    });
    const storage = fakeStorage({ status: status(), roleEnv: STUDIO_ENV });

    const result = await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare");

    expect(result.state).toBe("running");
    expect(result.error).toContain(BRINGUP_RETRY_HEALED);
  });
});

// ---------------------------------------------------------------------------
// PART 1 (Worker half) — the log's tail reaches a failed readiness verdict
// ---------------------------------------------------------------------------

function fakeSyncDeps(
  exec: (cmd: string) => Promise<ExecResult>,
): SessionSyncDeps & { execCalls: string[] } {
  const execCalls: string[] = [];
  return {
    exec: async (cmd: string) => {
      execCalls.push(cmd);
      return exec(cmd);
    },
    r2Put: async () => {},
    r2List: async () => [],
    r2Delete: async () => {},
    now: () => new Date(NOW),
    notify: async () => {},
    burnAlertThresholdTokens: 0,
    execCalls,
  };
}

const LOG_TAIL =
  "2026-09-23T17:41:02Z 20260923T174101Z-1a2b3c4d step studio-materialization\n" +
  "2026-09-23T17:41:09Z 20260923T174101Z-1a2b3c4d stderr studio-bringup: python3 missing -- refusing to boot\n" +
  "2026-09-23T17:41:09Z 20260923T174101Z-1a2b3c4d end exit=1 last-step=studio-materialization";

describe("checkProvisionedWithRetry — a bare verdict carries the bring-up log's tail (issue #38 part 1)", () => {
  it("bare: the reason names the failing step, read off the container's own log, with no shell involved", async () => {
    const deps = fakeSyncDeps(async (cmd) =>
      cmd === bringupLogTailCmd()
        ? { code: 0, stdout: LOG_TAIL, stderr: "" }
        : { code: 0, stdout: `no git checkout at /workspace/${REPO}`, stderr: "" },
    );

    const verdict = await checkProvisionedWithRetry(deps, REPO);

    expect(verdict.kind).toBe("bare");
    const reason = (verdict as { reason: string }).reason;
    expect(reason).toContain(`no git checkout at /workspace/${REPO}`);
    expect(reason).toContain("end exit=1 last-step=studio-materialization");
    expect(reason).toContain("python3 missing");
  });

  it("provisioned: the log is never read — a healthy studio pays nothing for this", async () => {
    const deps = fakeSyncDeps(async () => ({ code: 0, stdout: PROVISIONED_OK, stderr: "" }));

    const verdict = await checkProvisionedWithRetry(deps, REPO);

    expect(verdict.kind).toBe("provisioned");
    expect(deps.execCalls).toHaveLength(1);
  });

  it("an empty or absent log leaves the reason exactly as the container stated it", async () => {
    const deps = fakeSyncDeps(async (cmd) =>
      cmd === bringupLogTailCmd()
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 0, stdout: `no git checkout at /workspace/${REPO}`, stderr: "" },
    );

    const verdict = await checkProvisionedWithRetry(deps, REPO);

    expect((verdict as { reason: string }).reason).toBe(`no git checkout at /workspace/${REPO}`);
  });

  it("a tail read that throws never turns a bare verdict into something else", async () => {
    const deps = fakeSyncDeps(async (cmd) => {
      if (cmd === bringupLogTailCmd()) throw new Error("sandbox unreachable");
      return { code: 0, stdout: `no git checkout at /workspace/${REPO}`, stderr: "" };
    });

    const verdict = await checkProvisionedWithRetry(deps, REPO);

    expect(verdict.kind).toBe("bare");
    expect((verdict as { reason: string }).reason).toBe(`no git checkout at /workspace/${REPO}`);
  });

  it("the tail is bounded — a runaway log can never become an unbounded status row", async () => {
    const huge = `${"x".repeat(200_000)}\nend exit=1 last-step=tmux-session`;
    const deps = fakeSyncDeps(async (cmd) =>
      cmd === bringupLogTailCmd()
        ? { code: 0, stdout: huge, stderr: "" }
        : { code: 0, stdout: "claude is not running in tmux studio:claude (pane runs: bash)", stderr: "" },
    );

    const verdict = await checkProvisionedWithRetry(deps, REPO);

    expect((verdict as { reason: string }).reason.length).toBeLessThan(8000);
  });
});

describe("bringupLogTailCmd / bringupLogAppendCmd — read-only, invisible, injection-proof", () => {
  it("the tail read touches no tmux window at all — the hard fleet rule on any check", () => {
    const cmd = bringupLogTailCmd();
    expect(cmd).toContain(BRINGUP_LOG_PATH);
    for (const forbidden of ["select-window", "switch-client", "attach", "send-keys", "kill-"]) {
      expect(cmd).not.toContain(forbidden);
    }
  });

  it("the tail read never uses the `exit` builtin — that kills the shared sandbox session shell", () => {
    expect(bringupLogTailCmd()).not.toMatch(/\bexit\b/);
  });

  it("a missing log is not an error: the command degrades to empty output, never a failed exec", () => {
    expect(bringupLogTailCmd()).toContain("2>/dev/null");
  });

  // The exact quoting contract, asserted as a whole string rather than by
  // pattern: a `not.toMatch(/rm -rf/)` would be a LIE here, because the
  // dangerous text is supposed to survive verbatim — safely, inside single
  // quotes. Whether a shell agrees is proven by execution, not by reading:
  // test/bun/bringup-log.test.ts runs this exact command against a real
  // bash and checks both the file contents and that no side effect fired.
  it("an append single-quotes its payload, closing/escaping/reopening on every embedded quote", () => {
    expect(bringupLogAppendCmd("boom'; rm -rf /; echo '")).toBe(
      `printf '%s\\n' 'boom'\\''; rm -rf /; echo '\\''' >> ${BRINGUP_LOG_PATH} 2>/dev/null || true`,
    );
  });

  it("an append never uses the `exit` builtin either", () => {
    expect(bringupLogAppendCmd("anything")).not.toMatch(/\bexit\b/);
  });
});

// ---------------------------------------------------------------------------
// PART 2 (reporting half) — restart answers with a FRESHLY measured verdict
// ---------------------------------------------------------------------------

describe("restartWithFreshVerdict (do.ts) — a restart never echoes the pre-replacement verdict (issue #38 part 2)", () => {
  const STALE = { kind: "provisioned" as const, checkedAt: "2026-09-23T10:00:00.000Z" };

  it("a stale `provisioned` row does not survive a restart onto a hollow container", async () => {
    const storage = fakeStorage({ status: status({ readiness: STALE }) });
    const deps = fakeSyncDeps(async (cmd) =>
      cmd === bringupLogTailCmd()
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 0, stdout: `no git checkout at /workspace/${REPO}`, stderr: "" },
    );

    const fresh = await restartWithFreshVerdict(deps, storage, STUDIO_ID, status(), async () => {});

    expect(fresh.readiness).toMatchObject({ kind: "bare", checkedAt: NOW });
  });

  it("the retry note the restart wrote survives into the fresh-verdict row", async () => {
    const restarted = status({ error: `${BRINGUP_RETRY_HEALED}: clone did not land` });
    const storage = fakeStorage({ status: restarted });
    const deps = fakeSyncDeps(async () => ({ code: 0, stdout: PROVISIONED_OK, stderr: "" }));

    const fresh = await restartWithFreshVerdict(deps, storage, STUDIO_ID, restarted, async () => {});

    expect(fresh.readiness).toEqual({ kind: "provisioned", checkedAt: NOW });
    expect(fresh.error).toContain(BRINGUP_RETRY_HEALED);
  });

  it("a check that cannot be taken reports `inconclusive` stamped NOW, never the stale row", async () => {
    const storage = fakeStorage({});
    const deps = fakeSyncDeps(async () => ({ code: 0, stdout: PROVISIONED_OK, stderr: "" }));

    const fresh = await restartWithFreshVerdict(deps, storage, STUDIO_ID, status({ readiness: STALE }), async () => {});

    expect(fresh.readiness).toMatchObject({ kind: "inconclusive", checkedAt: NOW });
  });

  it("records the fresh verdict to the registry too, so `fleet ls` agrees straight away", async () => {
    const storage = fakeStorage({ status: status({ readiness: STALE }) });
    const deps = fakeSyncDeps(async () => ({ code: 0, stdout: PROVISIONED_OK, stderr: "" }));
    const recorded: StudioStatus[] = [];

    await restartWithFreshVerdict(deps, storage, STUDIO_ID, status(), async (s) => {
      recorded.push(s);
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].readiness).toEqual({ kind: "provisioned", checkedAt: NOW });
  });
});

// ---------------------------------------------------------------------------
// Incarnation token write (issue #85)
// ---------------------------------------------------------------------------

describe("runRestart — incarnation token write (issue #85)", () => {
  it("a successful restart writes a fresh incarnation token and records it", async () => {
    const deps = restartDeps(() => undefined);
    const storage = fakeStorageWithObserved({
      status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
    });

    await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

    expect(deps.cmds.some((c) => c.includes(INCARNATION_PATH) && c.includes("printf"))).toBe(true);
    const observed = await getObserved(storage);
    expect(observed.incarnation).not.toBeNull();
    expect(typeof observed.incarnation).toBe("string");
  });

  it("a failed incarnation write does not fail the restart, and leaves incarnation unset", async () => {
    const deps = restartDeps((cmd) =>
      cmd.includes(INCARNATION_PATH) ? { code: 1, stdout: "", stderr: "disk full" } : undefined,
    );
    const storage = fakeStorageWithObserved({
      status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
    });

    const result = await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

    expect(result.state).toBe("running"); // bring-up still succeeded
    const observed = await getObserved(storage);
    expect(observed.incarnation).toBeNull();
  });

  it("with no observedStorage passed, behaves exactly as before — no incarnation exec at all", async () => {
    const deps = restartDeps(() => undefined);
    const storage = fakeStorageWithObserved({
      status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
    });

    await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare");

    expect(deps.cmds.some((c) => c.includes(INCARNATION_PATH))).toBe(false);
  });

  it("a successful restart issues exactly one combined token-write + pane-probe exec after BRINGUP_CMD (maestro correction #6)", async () => {
    const deps = restartDeps(() => undefined);
    const storage = fakeStorageWithObserved({
      status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
    });

    await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

    const bringupIdx = deps.cmds.indexOf(BRINGUP_CMD);
    const observationCmds = deps.cmds.filter((c) => c.includes(BRINGUP_TOKEN_WRITE_SECTION));
    expect(observationCmds).toHaveLength(1); // exactly one exec, never two
    expect(deps.cmds.indexOf(observationCmds[0])).toBeGreaterThan(bringupIdx);
    const observed = await getObserved(storage);
    expect(observed.session?.via).toBe("restart");
  });

  // Issue #85 review round 4, NIT 16(a) — the combined token-write +
  // pane-probe exec is a short check, never the bring-up itself, so it must
  // not ride sbExec's own EXEC_CLASSES.provision (do.ts's deps() wires that
  // to a 600s budget sized for BRINGUP_CMD). When a caller supplies a
  // distinct `observationExec`, recordBringupObservation must route the
  // combined exec through IT, never through `sbExec`.
  it("NIT 16(a): the combined token-write + pane-probe exec prefers observationExec over sbExec when both are supplied", async () => {
    const deps = restartDeps(() => undefined);
    const observationCmds: string[] = [];
    const withObservationExec: typeof deps & { observationExec: typeof deps.sbExec } = {
      ...deps,
      observationExec: async (cmd: string) => {
        observationCmds.push(cmd);
        return { code: 0, stdout: defaultObservationStdout(), stderr: "" };
      },
    };
    const storage = fakeStorageWithObserved({
      status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
    });

    await restartWithStorage(withObservationExec, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

    expect(observationCmds.some((c) => c.includes(BRINGUP_TOKEN_WRITE_SECTION))).toBe(true);
    // sbExec itself never sees the combined exec — only BRINGUP_CMD and the
    // other bring-up steps do.
    expect(deps.cmds.some((c) => c.includes(BRINGUP_TOKEN_WRITE_SECTION))).toBe(false);
  });

  // Maestro correction #13 (issue #85 review round 4, TEST 12c) — a
  // successful bring-up proves the exec plane is alive: recordBringupObservation
  // resets execFailures/unreachableSince the same way a successful ship tick
  // does, regardless of what the session verdict itself lands as.
  it("correction #13: a successful bring-up resets execFailures to 0 and clears unreachableSince, even with prior counters set", async () => {
    const deps = restartDeps(() => undefined);
    const storage = fakeStorageWithObserved({
      status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
    });
    await mergeObserved(storage, { execFailures: 2, unreachableSince: "2026-09-23T00:00:00.000Z" });

    await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

    const observed = await getObserved(storage);
    expect(observed.execFailures).toBe(0);
    expect(observed.unreachableSince).toBeNull();
  });

  // Board issue #183 — a successful bring-up's observation exec is proof the
  // exec plane answered, exactly like a successful ship tick, so it must
  // ALSO re-anchor `lastShipOkAt` to the current tick's own `now` — leaving
  // it stale (an older timestamp) makes the time-based `unreachable` rule
  // measure elapsed time from the wrong instant and fire too early.
  it("board #183: a successful bring-up re-anchors a stale lastShipOkAt to NOW", async () => {
    const deps = restartDeps(() => undefined);
    const storage = fakeStorageWithObserved({
      status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
    });
    await mergeObserved(storage, { lastShipOkAt: "2026-09-20T00:00:00.000Z" });

    await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

    const observed = await getObserved(storage);
    expect(observed.lastShipOkAt).toBe(NOW);
  });

  // Board issue #183 GUARD — a THROWN observation exec is NOT proof of life
  // (unlike a resolved-but-nonzero-exit one): `lastShipOkAt` must stay
  // exactly as it was, never re-anchored to `now`, when the exec whose
  // command includes BRINGUP_TOKEN_WRITE_SECTION rejects outright.
  it("board #183 guard: a THROWN observation exec leaves a stale lastShipOkAt untouched", async () => {
    const deps = restartDeps((cmd) => {
      if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) throw new Error("sandbox unreachable");
      return undefined;
    });
    const storage = fakeStorageWithObserved({
      status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
    });
    await mergeObserved(storage, { lastShipOkAt: "2026-09-20T00:00:00.000Z" });

    await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

    const observed = await getObserved(storage);
    expect(observed.lastShipOkAt).toBe("2026-09-20T00:00:00.000Z");
  });

  // Review round 3 (issue #85 PR1), MUST-FIX 9 — recordBringupObservation
  // must run INSIDE the op-lock's own try, before the finally that releases
  // it, wrapped in its own try/catch so a failure there can never fail the
  // whole bring-up.
  it("MUST-FIX 9: OPERATION_KEY is still fresh while the bring-up observation exec runs (still inside the op lock)", async () => {
    let opDuringObservation: unknown;
    const deps = restartDeps((cmd) => {
      if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) {
        // Read storage synchronously from inside this test's own fake
        // sbExec — a snapshot of what's in OPERATION_KEY at the instant the
        // combined token-write + probe exec actually runs.
        void storage.get(OPERATION_KEY).then((v) => { opDuringObservation = v; });
      }
      return undefined;
    });
    const storage = fakeStorageWithObserved({
      status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
    });

    await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);
    // Flush the .then() microtask queued above.
    await Promise.resolve();
    await Promise.resolve();

    expect(opDuringObservation).not.toBeNull();
    expect(opDuringObservation).not.toBeUndefined();
  });

  it("MUST-FIX 9: a throwing observedStorage.put during recordBringupObservation does not fail the restart", async () => {
    const deps = restartDeps(() => undefined);
    const base = fakeStorageWithObserved({
      status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
    });
    const throwingObserved: ObservedStorage = {
      get: base.get as ObservedStorage["get"],
      put: async () => { throw new Error("storage.put exploded"); },
    };

    const result = await restartWithStorage(deps, base, STUDIO_ID, "rafarc21/fleetflare", "restart", throwingObserved);

    expect(result.state).toBe("running");
  });
});

// Review round 6 (issue #85 review round 6), Blocker 2 — the round-5 fix
// (check-before-set/check-before-clear, MUST-FIX 9's `alreadyLocked` guard
// above) read "already held" as "OPERATION_KEY is non-null, at all", with no
// check on whether that existing value is FRESH or wreckage an isolate left
// behind before reaching its own `finally`. A STALE lock made `alreadyLocked`
// read true forever, so restartWithStorage never refreshed it and never
// cleared it — permanently defeating the exact guard this key exists to
// provide, in the OPPOSITE direction from a stale lock being correctly
// ignored (decideHeal, do.ts).
describe("restartWithStorage — a STALE OPERATION_KEY is refreshed and cleared, not treated as permanently held (issue #85 review round 6, Blocker 2)", () => {
  it("a STALE lock is ignored — restartWithStorage takes its OWN fresh lock during bring-up, clears it after", async () => {
    const storage = fakeStorage({ status: status(), roleEnv: ROLE_ENV });
    const staleSince = new Date(Date.parse(NOW) - OPERATION_STALE_MS - 1000).toISOString();
    await storage.put(OPERATION_KEY, { op: "restart", since: staleSince });
    let opDuringBringup: unknown;
    const deps = restartDeps((cmd) => {
      if (cmd === BRINGUP_CMD) {
        // Same fire-and-forget peek technique as MUST-FIX 9 above — onCmd is
        // synchronous, so this schedules a microtask read of storage at the
        // exact moment BRINGUP_CMD execs, flushed after the outer await below.
        void storage.get(OPERATION_KEY).then((v) => { opDuringBringup = v; });
      }
      return undefined;
    });

    const result = await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare");
    await Promise.resolve();
    await Promise.resolve();

    expect(result.state).toBe("running");
    // This call's OWN fresh lock, not the stale one it found.
    expect(opDuringBringup).toEqual({ op: "restart", since: NOW });
    // Cleared exactly as if there had been no pre-existing lock at all.
    expect(await storage.get(OPERATION_KEY)).toBeNull();
  });
});

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

describe("recordBringupObservation — an untouched lead keeps the prior verdict (issue #85 review round 3, MUST-FIX 3)", () => {
  const PRIOR_SESSION: ObservedSession = {
    verdict: "resumed", at: "2026-09-23T00:00:00.000Z", via: "provision",
    restore: "not-attempted", snapshotAgeS: null, turnsBefore: 40, reason: null,
  };

  it("a lead OLDER than this bring-up (left untouched) keeps the prior recorded verdict rather than recomputing", async () => {
    const deps = restartDeps((cmd) => {
      if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) {
        return {
          code: 0,
          // A first-ever-launch shape (no --continue) — would read LOST if
          // this were genuinely recomputed from the live process.
          stdout: [BRINGUP_TOKEN_WRITE_SECTION, "yes", scriptedProbeWithAge(false, `/workspace/${REPO}`, 999_999)].join("\n"),
          stderr: "",
        };
      }
      return undefined;
    });
    const storage = fakeStorageWithObserved({
      status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
    });
    await mergeObserved(storage, { session: PRIOR_SESSION });

    await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

    const observed = await getObserved(storage);
    expect(observed.session).toEqual(PRIOR_SESSION); // untouched — kept exactly as it was
  });

  it("a lead YOUNGER than this bring-up (genuinely (re)launched) still recomputes normally", async () => {
    // This fixture's own `now()` is a fixed constant (never a real ticking
    // clock — see restartDeps), so `bringupStartedAt` and the observation's
    // own `now` are identical and bringupAgeS is always 0: a leadAgeS of 0
    // (the process JUST started — etimes truncates to 0 within its first
    // second) is what a genuinely-just-launched lead looks like here.
    const deps = restartDeps((cmd) => {
      if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) {
        return {
          code: 0,
          stdout: [BRINGUP_TOKEN_WRITE_SECTION, "yes", scriptedProbeWithAge(false, `/workspace/${REPO}`, 0)].join("\n"),
          stderr: "",
        };
      }
      return undefined;
    });
    const storage = fakeStorageWithObserved({
      status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
    });
    await mergeObserved(storage, { session: PRIOR_SESSION });

    await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

    const observed = await getObserved(storage);
    expect(observed.session).not.toEqual(PRIOR_SESSION); // genuinely recomputed
    expect(observed.session?.via).toBe("restart");
  });

  it("no lead age reported at all (probe failed to answer it) — behaves exactly as before, always recomputes", async () => {
    const deps = restartDeps((cmd) => {
      if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) {
        // No SESSION_LEAD_AGE_SECTION at all — an older probe response
        // shape, or a `ps` that produced nothing parseable.
        return {
          code: 0,
          stdout: [
            BRINGUP_TOKEN_WRITE_SECTION, "yes",
            SESSION_FOUND_SECTION, "yes", SESSION_CONTINUE_SECTION, "no", SESSION_CWD_SECTION, `/workspace/${REPO}`,
          ].join("\n"),
          stderr: "",
        };
      }
      return undefined;
    });
    const storage = fakeStorageWithObserved({
      status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
    });
    await mergeObserved(storage, { session: PRIOR_SESSION });

    await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

    const observed = await getObserved(storage);
    expect(observed.session).not.toEqual(PRIOR_SESSION);
  });

  // Review round 6, MUST-FIX 9: an untouched lead with NO prior verdict
  // recorded at ALL (a studio's very first bring-up ever, or a pre-#85
  // studio being observed for the first time) used to fall through to
  // computeSessionVerdict's own recompute — the exact bug MUST-FIX 3 above
  // fixed when a PRIOR verdict existed, reopened whenever one does not.
  // Recomputing here is exactly as wrong for the same reason: the live
  // process was never touched by THIS bring-up, so its argv/cwd say nothing
  // about what THIS bring-up did. Honest answer: `unknown`, "lead predates
  // bring-up" — never a guess.
  it("MUST-FIX 9: an untouched lead with NO prior verdict at all records unknown/'lead predates bring-up', never a recompute", async () => {
    const deps = restartDeps((cmd) => {
      if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) {
        return {
          code: 0,
          // A first-ever-launch shape (no --continue) — would read LOST if
          // this were genuinely recomputed from the live process, exactly
          // like MUST-FIX 3's own fixture above.
          stdout: [BRINGUP_TOKEN_WRITE_SECTION, "yes", scriptedProbeWithAge(false, `/workspace/${REPO}`, 999_999)].join("\n"),
          stderr: "",
        };
      }
      return undefined;
    });
    const storage = fakeStorageWithObserved({
      status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
    });
    // Deliberately no mergeObserved(storage, { session: ... }) call here —
    // observedBefore.session is null, the gap this fix covers.

    await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

    const observed = await getObserved(storage);
    expect(observed.session?.verdict).toBe("unknown");
    expect(observed.session?.reason).toBe("lead predates bring-up");
  });
});

// ---------------------------------------------------------------------------
// Issue #240 (VM1/VM1r, a #174 follow-up) — recordBringupObservation's own
// FINAL write (mergeObserved, its very last line) was unconditional: the
// caller's own `ctx.moved()` check (issue #152 fix 5) only guards the DECISION
// to call this function at all, taken BEFORE it execs into the container
// (bringupObservationCmd) — real I/O that can take long enough for an
// EXTERNAL destroy to land and bump the epoch WHILE this function's own exec
// is in flight. Before this fix, that write landed 1-2ms after the destroy's
// own `stopped` row, resurrecting `observed` state for a studio a destroy had
// already finished tearing down. The fix re-checks `ctx.moved()` immediately
// before the final `mergeObserved` call and skips it entirely when true.
// ---------------------------------------------------------------------------

describe("recordBringupObservation — issue #240: a destroy landing DURING the observation exec must not overwrite `observed` afterward", () => {
  const PRIOR_SESSION: ObservedSession = {
    verdict: "resumed", at: "2026-09-23T00:00:00.000Z", via: "provision",
    restore: "not-attempted", snapshotAgeS: null, turnsBefore: 40, reason: null,
  };

  it("ctx.moved() flips true while the combined token-write + pane-probe exec is in flight: the final mergeObserved write never happens", async () => {
    let moved = false;
    // This op's own ctx: epoch agrees with the live one at entry (the outer
    // `!(await ctx.moved())` check in restartWithStorage/provisionWithStorage
    // passes, exactly as it does today), but flips to `moved` partway through
    // — modeling an EXTERNAL destroy that lands and fully completes while
    // recordBringupObservation's own exec is physically in flight.
    const ctx: OpCtx = { epoch: 0, moved: async () => moved };
    const deps = restartDeps((cmd) => {
      if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) {
        moved = true;
        return { code: 0, stdout: defaultObservationStdout(), stderr: "" };
      }
      return undefined;
    });
    const storage = fakeStorageWithObserved({
      status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
    });
    await mergeObserved(storage, {
      session: PRIOR_SESSION, execFailures: 3, unreachableSince: "2026-09-23T00:00:00.000Z",
    });

    await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage, ctx);

    const observed = await getObserved(storage);
    // The prior recorded session/counters survive UNTOUCHED: no patch from
    // this bring-up's own (now-stale) observation ever reached storage.
    expect(observed.session).toEqual(PRIOR_SESSION);
    expect(observed.execFailures).toBe(3);
    expect(observed.unreachableSince).toBe("2026-09-23T00:00:00.000Z");
  });

  it("ctx never moves (the ordinary case): the final write still happens exactly as before", async () => {
    const ctx: OpCtx = { epoch: 0, moved: async () => false };
    const deps = restartDeps(() => undefined);
    const storage = fakeStorageWithObserved({
      status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
    });
    await mergeObserved(storage, { session: PRIOR_SESSION });

    await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage, ctx);

    const observed = await getObserved(storage);
    expect(observed.session).not.toEqual(PRIOR_SESSION);
  });

  // Round 2 (survivor A2): the two tests above ("VM1r") only drive
  // restartWithStorage's own call site (provision.ts ~line 2826). A mutant
  // swapping the real `ctx` argument for `NEVER_MOVED_CTX` at
  // provisionWithStorage's OWN call site (~line 2730, inside its bring-up
  // path) survives the whole suite, because nothing else exercises THIS
  // path's own ctx-threading. Same fixture shape as "a session verdict is
  // recorded on EVERY bring-up path" below (own fleet.json/role-md/org.json
  // trio), duplicated here rather than imported — this file's own convention
  // (see that describe block's "failover" test, which does the same for its
  // own fixture).
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

  function vm1Deps(onCmd: (cmd: string) => void): ProvisionDeps & { cmds: string[] } {
    const cmds: string[] = [];
    const sbExec = vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      onCmd(cmd);
      if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) return { code: 0, stdout: defaultObservationStdout(), stderr: "" };
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

  it("provisionWithStorage (VM1): ctx.moved() flips true while the observation exec is in flight: the final mergeObserved write never happens", async () => {
    let moved = false;
    const ctx: OpCtx = { epoch: 0, moved: async () => moved };
    const deps = vm1Deps((cmd) => {
      if (cmd.includes(BRINGUP_TOKEN_WRITE_SECTION)) moved = true;
    });
    const storage = fakeStorageWithObserved({});
    await mergeObserved(storage, {
      session: PRIOR_SESSION, execFailures: 3, unreachableSince: "2026-09-23T00:00:00.000Z",
    });

    await provisionWithStorage(deps, storage, { repo: "acme-os", role: "scratch" }, "rafarc21/fleetflare", "provision", storage, ctx);

    // The observation exec DID run — this is not a "never called" story.
    expect(deps.cmds.some((c) => c.includes(BRINGUP_TOKEN_WRITE_SECTION))).toBe(true);
    const observed = await getObserved(storage);
    // But the prior recorded session/counters survive UNTOUCHED: the
    // re-check right before the final write correctly skipped it.
    expect(observed.session).toEqual(PRIOR_SESSION);
    expect(observed.execFailures).toBe(3);
    expect(observed.unreachableSince).toBe("2026-09-23T00:00:00.000Z");
  });

  it("provisionWithStorage (VM1): ctx never moves (the ordinary case): the final write still happens exactly as before", async () => {
    const ctx: OpCtx = { epoch: 0, moved: async () => false };
    const deps = vm1Deps(() => {});
    const storage = fakeStorageWithObserved({});
    await mergeObserved(storage, { session: PRIOR_SESSION });

    await provisionWithStorage(deps, storage, { repo: "acme-os", role: "scratch" }, "rafarc21/fleetflare", "provision", storage, ctx);

    const observed = await getObserved(storage);
    expect(observed.session).not.toEqual(PRIOR_SESSION);
  });
});

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
 * Drives a real staged restore through the SAME heal closure `syncSession()`
 * builds: `() => this.restartStudio("heal")`, boiled down to the one call
 * that actually matters for this test (`restartWithStorage(..., "heal",
 * storage)`) — the credential refresh / spawn-token settle that closure also
 * does along the way are DO-only concerns, already covered by
 * test/studio.refresh.test.ts and test/studio.self-heal.test.ts, and are not
 * this test's job to re-prove.
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
      unclaimedRescueBranches: [],
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

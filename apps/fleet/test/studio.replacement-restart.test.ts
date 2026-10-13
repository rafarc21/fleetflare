import { describe, it, expect, vi } from "vitest";
import {
  restartWithStorage, provisionWithStorage, runRestart, STATUS_KEY, ROLE_ENV_KEY, BRINGUP_CMD, BRINGUP_LOG_PATH,
  bringupLogTailCmd, bringupLogAppendCmd, BRINGUP_RETRY_HEALED, OPERATION_KEY, OPERATION_STALE_MS, adoptWorktreeSessionCmd,
  LAST_STOP_KEY, recordBringupObservation,
  type ProvisionDeps, type StudioStorage, type RoleEnv, type StudioEnv, type OpCtx, type LastStop,
} from "../src/studio/provision";
import { checkProvisionedWithRetry, restartWithFreshVerdict } from "../src/studio/do";
import { PROVISIONED_OK } from "../src/studio/provision";
import type { SessionSyncDeps } from "../src/studio/session-sync";
import type { StudioStatus } from "../src/studio/types";
import {
  INCARNATION_PATH, getObserved, mergeObserved, type ObservedStorage, type ObservedSession,
  BRINGUP_TOKEN_WRITE_SECTION, SESSION_FOUND_SECTION, SESSION_CONTINUE_SECTION, SESSION_CWD_SECTION,
  SESSION_LEAD_AGE_SECTION,
} from "../src/studio/observed";
import { composeSurvivalBrief } from "../src/studio/survival-brief";
import { deliverSurvivalBriefOnBringup } from "../src/studio/survival-delivery";

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

  // Fix round (#208 PR #215 review item 1, maestro DESIGN decision):
  // `Observed.wipBootStamp` is captured at the EXACT SAME moment as
  // `incarnation`, gated on the identical `tokenWritten` confirmation.
  describe("runRestart — wip-sync boot stamp, captured alongside the incarnation token (#208 fix round)", () => {
    it("a successful restart also captures a fresh 14-digit UTC wipBootStamp", async () => {
      const deps = restartDeps(() => undefined);
      const storage = fakeStorageWithObserved({
        status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
      });

      await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

      const observed = await getObserved(storage);
      expect(observed.wipBootStamp).toMatch(/^[0-9]{14}$/);
    });

    it("a failed incarnation write leaves wipBootStamp unset too — same gate, same moment", async () => {
      const deps = restartDeps((cmd) =>
        cmd.includes(INCARNATION_PATH) ? { code: 1, stdout: "", stderr: "disk full" } : undefined,
      );
      const storage = fakeStorageWithObserved({
        status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
      });

      await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

      const observed = await getObserved(storage);
      expect(observed.wipBootStamp ?? null).toBeNull();
    });

    it("a SECOND successful bring-up captures a DIFFERENT wipBootStamp than the first -- a new container never reuses a prior one's own stamp", async () => {
      const deps = restartDeps(() => undefined);
      // A real container's clock always advances between two bring-ups;
      // `restartDeps`'s own `now` is a fixed constant (every other test here
      // relies on that), so this one test overrides it with a clock that
      // ticks forward one second per call.
      const base = Date.parse(NOW);
      let n = 0;
      deps.now = () => new Date(base + n++ * 1000).toISOString();
      const storage = fakeStorageWithObserved({
        status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
      });

      await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);
      const first = (await getObserved(storage)).wipBootStamp;
      expect(first).toMatch(/^[0-9]{14}$/);

      // A second bring-up, one second later in this test's own fake clock.
      await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);
      const second = (await getObserved(storage)).wipBootStamp;
      expect(second).toMatch(/^[0-9]{14}$/);
      expect(second).not.toBe(first);
    });
  });

  // Maestro review round 1 on PR #235, BLOCKER 1 — `deliverSurvivalOnBringup`
  // (do.ts) used to read the LIVE `Observed.wipBootStamp` when composing the
  // brief, but `recordBringupObservation` has, by that point, ALREADY
  // overwritten it with a BRAND-NEW stamp for THIS SAME bring-up (the
  // `tokenWritten` branch right above). The brief ended up naming the NEW
  // container's (empty) wip ref next to an age line describing the OLD
  // container's last real push — a ref/age mismatch. Fixed by freezing the
  // PRE-bring-up stamp onto the session record (`wipBootStampBefore`), the
  // same "computed once, never re-read live" discipline `replacementDetected`
  // already uses. This test runs a REAL bring-up (not a hand-assembled
  // SurvivalInput) and then composes the brief exactly the way do.ts's
  // `survivalCompose` does, to prove the ORDER — write-then-read — never
  // leaks the new stamp into the brief.
  describe("BLOCKER 1 (#231 review round 1) — survival brief names the OLD wip ref after a replacement bring-up", () => {
    it("recordBringupObservation freezes the PRE-bring-up wipBootStamp onto the session record, even though the live field is overwritten with a new one", async () => {
      const deps = restartDeps(() => undefined);
      const storage = fakeStorageWithObserved({
        status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
      });
      const OLD_STAMP = "20261004000000";
      await mergeObserved(storage, { wipBootStamp: OLD_STAMP, replacedAt: "2026-09-23T17:00:00.000Z" });

      await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

      const observed = await getObserved(storage);
      // the LIVE field really was overwritten with a brand-new stamp...
      expect(observed.wipBootStamp).toMatch(/^[0-9]{14}$/);
      expect(observed.wipBootStamp).not.toBe(OLD_STAMP);
      // ...but the session record froze the OLD one, for the brief to use.
      expect(observed.session?.wipBootStampBefore).toBe(OLD_STAMP);
    });

    it("the composed brief names the OLD stamp's ref, not the new one just written for this same bring-up", async () => {
      const deps = restartDeps(() => undefined);
      const storage = fakeStorageWithObserved({
        status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
      });
      const OLD_STAMP = "20261004000000";
      await mergeObserved(storage, {
        wipBootStamp: OLD_STAMP,
        replacedAt: "2026-09-23T17:00:00.000Z",
        wipSyncedAt: "2026-09-23T17:10:00.000Z",
        // Maestro review round 2 on PR #235 (issue #231), item 1 — persisted
        // alongside `wipSyncedAt` by `recordWipSyncOnSuccess`, same stamp:
        // the last REAL push, under this container's own OLD_STAMP.
        wipSyncedBootStamp: OLD_STAMP,
      });

      await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "restart", storage);

      const observed = await getObserved(storage);
      // do.ts's own fixed wiring: `Observed.wipSyncedBootStamp`, never
      // `session.wipBootStampBefore` (bring-up ordering) or the live
      // `Observed.wipBootStamp`.
      const brief = composeSurvivalBrief({
        studioId: STUDIO_ID,
        tasks: { ok: true, value: [] },
        openPrs: { ok: true, value: [] },
        unclaimedRescueBranches: { ok: true, value: [] },
        liveWipRefs: { ok: true, value: [] },
        session: observed.session,
        now: NOW,
        wipSyncedAt: observed.wipSyncedAt ?? null,
        wipSyncedBootStamp: observed.wipSyncedBootStamp ?? null,
      });

      expect(brief).toContain(`fleet/rescue/${STUDIO_ID}/wip/${OLD_STAMP}`);
      expect(brief).not.toContain(`fleet/rescue/${STUDIO_ID}/wip/${observed.wipBootStamp}`);
    });
  });

  // Maestro review round 2 on PR #235 (issue #231), item 1 — BLOCKER 1's own
  // fix (above) freezes the PRE-bring-up stamp onto THAT bring-up's session
  // record, which is correct for the FIRST bring-up after a replacement (no
  // sync has happened since, so "before" and "last synced" agree). It is
  // WRONG for a SECOND bring-up with no wip-sync tick ever running in
  // between: that bring-up's own `wipBootStampBefore` is the FIRST bring-up's
  // own brand-new, never-synced stamp, next to an age (`wipSyncedAt`) that
  // still describes a push from an EARLIER incarnation. The fix persists the
  // pushed ref's own stamp (`Observed.wipSyncedBootStamp`) alongside
  // `wipSyncedAt` at the moment a push actually succeeds, and the brief
  // renders THAT instead of deriving a stamp from bring-up ordering at all.
  //
  // Driven through the REAL `deliverSurvivalBriefOnBringup` delivery
  // pipeline (survival-delivery.ts) — not a hand-built `SurvivalInput` that
  // skips the actual bring-up sequencing — with both bring-ups run through
  // the REAL `restartWithStorage`, same discipline the BLOCKER 1 test above
  // uses for ITS OWN real bring-up.
  describe("(#231 review round 2, item 1) survival brief after TWO bring-ups with no sync between — names the LAST SYNCED ref, not either bring-up's own fresh stamp", () => {
    it("replace -> bring-up A -> bring-up B (no wip-sync tick between them) -> bring-up B's own brief names the ref wipSyncedAt actually belongs to", async () => {
      const deps = restartDeps(() => undefined);
      const storage = fakeStorageWithObserved({
        status: status({ repoSlug: `acme-org/${REPO}` }), roleEnv: STUDIO_ENV,
      });
      const OLD_STAMP = "20261004000000"; // the replaced container's own stamp
      const SYNCED_AT = "2026-10-03T17:10:00.000Z"; // the last REAL push, under OLD_STAMP
      await mergeObserved(storage, {
        wipBootStamp: OLD_STAMP,
        replacedAt: "2026-10-04T00:00:00.000Z", // a replacement was detected
        wipSyncedAt: SYNCED_AT,
        wipSyncedBootStamp: OLD_STAMP, // persisted alongside wipSyncedAt by the fix
      });

      // Bring-up A: heals the replacement, writes a brand-new stamp, and
      // freezes session.wipBootStampBefore = OLD_STAMP (BLOCKER 1's own,
      // already-correct behavior for THIS bring-up) -- but no wip-sync tick
      // ever runs after it.
      await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "heal", storage);
      const afterA = await getObserved(storage);
      const stampA = afterA.wipBootStamp;
      expect(stampA).toMatch(/^[0-9]{14}$/);
      expect(stampA).not.toBe(OLD_STAMP);
      // No sync tick ran: both fields are exactly as they were before A.
      expect(afterA.wipSyncedAt).toBe(SYNCED_AT);
      expect(afterA.wipSyncedBootStamp).toBe(OLD_STAMP);

      // Bring-up B: a SECOND heal, with NO wip-sync tick ever running
      // between A and B. Its own wipBootStampBefore becomes bring-up A's own
      // fresh, never-synced stamp -- the trap the OLD derivation fell into.
      await restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare", "heal", storage);
      const afterB = await getObserved(storage);
      expect(afterB.session?.wipBootStampBefore).toBe(stampA); // the trap is real
      expect(afterB.wipSyncedBootStamp).toBe(OLD_STAMP); // still the last REAL push

      // Drive bring-up B's own survival brief through the REAL delivery
      // pipeline, wired the same way do.ts's `deliverSurvivalOnBringup` is.
      let delivered: string | null = null;
      const outcome = await deliverSurvivalBriefOnBringup(
        storage as unknown as ObservedStorage,
        async () => ({
          incarnation: afterB.incarnation,
          via: afterB.session!.via,
          replacementDetected: afterB.session!.replacementDetected === true,
          session: afterB.session!,
          wipSyncedAt: afterB.wipSyncedAt ?? null,
          wipSyncedBootStamp: afterB.wipSyncedBootStamp ?? null,
        }),
        async () => ({ busy: false }),
        async () => composeSurvivalBrief({
          studioId: STUDIO_ID,
          tasks: { ok: true, value: [] },
          openPrs: { ok: true, value: [] },
          unclaimedRescueBranches: { ok: true, value: [] },
          liveWipRefs: { ok: true, value: [] },
          session: afterB.session!,
          now: NOW,
          wipSyncedAt: afterB.wipSyncedAt ?? null,
          wipSyncedBootStamp: afterB.wipSyncedBootStamp ?? null,
        }),
        async (prompt) => {
          delivered = prompt;
          return { ok: true };
        },
      );

      expect(outcome.kind).toBe("delivered");
      expect(delivered).toContain(`fleet/rescue/${STUDIO_ID}/wip/${OLD_STAMP}`);
      expect(delivered).not.toContain(`fleet/rescue/${STUDIO_ID}/wip/${stampA}`);
    });
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


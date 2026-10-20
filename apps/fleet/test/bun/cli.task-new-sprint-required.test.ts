// apps/fleet/test/bun/cli.task-new-sprint-required.test.ts
// Issue #1255 (sprint follow-ups, S2): `fleet task new` with neither `--sprint`
// nor `--backlog` refuses, and when the `/sprints` read fails (a network error)
// the refusal must print a plain line — "could not read the open sprints (the
// board may be down)" — never a stack trace. Pins cli/fleet.ts's
// openSprintTitles' try/catch: a throw collapses to `null`, and cmdTaskNew
// prints the refusal line and exits 1.
//
// bun:test lane, not vitest: cli/fleet.ts is Bun-only (Bun.spawn, Bun.file,
// process.exit) and is never imported from the vitest suite. Same harness as
// cli.spawn-no-remote.test.ts: a real `Bun.spawn` of cli/fleet.ts against a
// dead port (nothing listening at 127.0.0.1:1), a temp HOME whose
// ~/.fleet/credentials points there, and a temp cwd with NO `.git` in it — so
// detectRepo yields `{slug: null}` and the refusal is hermetic (never this
// checkout's own remote).
import { afterEach, describe, expect, test } from "bun:test";
import { writeCredentials } from "./helpers/credentials";
import { cleanupTempDirs, runFleetIn, tmpDir } from "./helpers/fleet-cli";

afterEach(cleanupTempDirs);

describe("fleet task new requires a sprint — network error prints a refusal, not a stack trace (issue #1255)", () => {
  test("dead Worker, no --sprint/--backlog: exit 1, names the sprint requirement and the read failure, no stack trace", async () => {
    const home = tmpDir("task-new-sprint-home-");
    const cwd = tmpDir("task-new-sprint-cwd-"); // no .git here, deliberately
    // Nothing is listening here — the /sprints fetch throws, exercising
    // openSprintTitles' catch (returns null), not its !res.ok branch.
    writeCredentials(home, "http://127.0.0.1:1");

    const r = await runFleetIn(
      ["task", "new", "--title", "t", "--objective", "o", "--output", "f", "--boundaries", "b"],
      home, cwd,
    );

    expect(r.code).toBe(1);
    expect(r.err).toContain("--sprint is required (or --backlog)");
    expect(r.err).toContain("could not read the open sprints");
    // The whole point of the try/catch: a network error must NOT surface as an
    // Error/stack frame.
    expect(r.err).not.toContain("Error:");
    expect(r.err).not.toContain("  at ");
  });
});
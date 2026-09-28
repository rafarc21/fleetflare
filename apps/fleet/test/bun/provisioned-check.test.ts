import { describe, expect, test } from "bun:test";
import { runSnippet } from "./exec-snippet";
import { provisionedCheckCmd } from "../../src/studio/provision";

// A repo name that cannot exist on disk sends the command down its FIRST
// branch, so this runs instantly and needs no tmux, no claude, no container.
const ABSENT = "no-such-repo-p7a";

describe("provisionedCheckCmd, executed", () => {
  test("reports a missing checkout on stdout and leaves the parent shell alive", () => {
    const r = runSnippet({ script: provisionedCheckCmd(ABSENT), sourced: true });
    expect(r.stdout).toContain(`no git checkout at /workspace/${ABSENT}`);
    expect(r.parentAlive).toBe(true);
  });

  test("same under dash, the shell a container actually uses for /bin/sh", () => {
    const r = runSnippet({ script: provisionedCheckCmd(ABSENT), shell: "dash", sourced: true });
    expect(r.stdout).toContain(`no git checkout at /workspace/${ABSENT}`);
    expect(r.parentAlive).toBe(true);
  });

  test("the harness variant also leaves the parent alive", () => {
    const r = runSnippet({ script: provisionedCheckCmd(ABSENT, "claude"), sourced: true });
    expect(r.parentAlive).toBe(true);
  });
});

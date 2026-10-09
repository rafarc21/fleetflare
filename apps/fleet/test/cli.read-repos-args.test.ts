import { describe, it, expect } from "vitest";
import { parseCliArgs, VERBS } from "../src/studio/cli-args";

// Issue #291: `--read-repos owner/a,owner/b` on `task new` and `task assign`.
// The CLI only splits the list; ownership, count and name grammar are the
// Worker's call (src/github/read-repos.ts's parseReadRepos), so one rule set
// decides no matter which client sent the request.

const NEW = ["task", "new", "--title", "T", "--objective", "O", "--output", "F", "--boundaries", "B", "--studio", "websites--web-studio"];

describe("--read-repos", () => {
  it("task new splits the comma list into brief.readRepos", () => {
    const cmd = parseCliArgs([...NEW, "--read-repos", "acme-org/a, acme-org/b"]);
    expect(cmd).toMatchObject({ cmd: "task-new", brief: { readRepos: ["acme-org/a", "acme-org/b"] } });
  });

  it("task new without it carries no readRepos key at all", () => {
    const cmd = parseCliArgs(NEW);
    expect(cmd.cmd).toBe("task-new");
    if (cmd.cmd === "task-new") expect("readRepos" in cmd.brief).toBe(false);
  });

  it("task assign takes it too", () => {
    expect(parseCliArgs(["task", "assign", "42", "web-studio", "--read-repos", "acme-org/a"]))
      .toEqual({ cmd: "task-assign", number: 42, target: "web-studio", readRepos: ["acme-org/a"] });
  });

  it("an empty list is a usage error, not a silent no-op", () => {
    expect(parseCliArgs([...NEW, "--read-repos", " , "]).cmd).toBe("usage");
    expect(parseCliArgs(["task", "assign", "42", "web-studio", "--read-repos", ""]).cmd).toBe("usage");
  });

  it("help documents it on both verbs", () => {
    expect(VERBS["task-new"].args).toContain("--read-repos");
    expect(VERBS["task-assign"].args).toContain("--read-repos");
  });
});

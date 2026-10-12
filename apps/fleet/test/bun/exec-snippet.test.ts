import { describe, expect, test } from "bun:test";
import { extractHeredoc, extractRegion, runSnippet, BRINGUP } from "./exec-snippet";

describe("extractHeredoc", () => {
  test("returns the body between the quoted delimiters", () => {
    const src = ["prefix", "cat > f <<'MARK'", "line one", "line two", "MARK", "suffix"].join("\n");
    expect(extractHeredoc(src, "MARK")).toBe("line one\nline two");
  });

  test("throws when the marker is absent", () => {
    expect(() => extractHeredoc("nothing here", "MARK")).toThrow("MARK");
  });
});

describe("runSnippet", () => {
  test("reports stdout, exit code, and a surviving parent", () => {
    const r = runSnippet({ script: 'echo hello; echo oops >&2' });
    expect(r.stdout).toContain("hello");
    expect(r.stderr).toContain("oops");
    expect(r.code).toBe(0);
    expect(r.parentAlive).toBe(true);
  });

  test("a snippet that calls exit still leaves the PARENT shell alive", () => {
    // The wrapper is what models sbExec's shared `sandbox-default` session:
    // the snippet runs as a child, so its `exit` must not take the parent.
    const r = runSnippet({ script: "echo before; exit 3" });
    expect(r.stdout).toContain("before");
    expect(r.code).toBe(3);
    expect(r.parentAlive).toBe(true);
  });

  test("passes stdin and env through", () => {
    const r = runSnippet({ script: 'read line; echo "got:$line:$WHO"', stdin: "payload\n", env: { WHO: "member" } });
    expect(r.stdout).toContain("got:payload:member");
  });

  test("sourced mode sees a snippet's exit take the parent down; child mode does not", () => {
    const script = "echo before; exit 0";
    expect(runSnippet({ script }).parentAlive).toBe(true);
    expect(runSnippet({ script, sourced: true }).parentAlive).toBe(false);
  });
});

describe("extractRegion", () => {
  const src = [
    "prefix line",
    "# >>> shell-window >>>",
    "body one",
    "body two",
    "# <<< shell-window <<<",
    "suffix line",
  ].join("\n");

  test("returns the lines between the marker pair, exclusive of both marker lines", () => {
    // The slice ends at the terminator's column-0 `#`, so the newline that
    // ends the last body line is part of the region — matching all 9
    // folded copies, whose consumers rely on `${extractRegion(...)}\n`
    // composing correctly.
    expect(extractRegion(src, "shell-window")).toBe("body one\nbody two\n");
  });

  test("throws naming the opener when the region is absent", () => {
    expect(() => extractRegion("nothing here", "shell-window")).toThrow("region opener");
  });

  test("throws naming the terminator when only the closer side exists", () => {
    expect(() => extractRegion("# >>> only >>>\nbody", "only")).toThrow("region terminator");
  });

  test("BRINGUP reads the real studio-bringup.sh source", () => {
    expect(BRINGUP.length).toBeGreaterThan(1000);
    expect(BRINGUP).toContain("# >>> shell-window >>>");
  });
});

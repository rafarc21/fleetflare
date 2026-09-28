import { describe, expect, test } from "bun:test";
import { extractHeredoc, runSnippet } from "./exec-snippet";

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

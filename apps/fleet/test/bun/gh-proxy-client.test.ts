import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { translate, UsageError, type TranslateCtx } from "../../container/gh-proxy";

// Issue #7: fleet-gh-proxy translates gh write verbs into the Worker's fixed
// /fleet/gh op RPC. Pure translate() pinned here; one main() smoke against a
// local fake Worker.

function ctx(over: Partial<TranslateCtx> = {}): TranslateCtx & { prCalls: (string | undefined)[] } {
  const prCalls: (string | undefined)[] = [];
  return {
    prCalls,
    readFile: (p) => `file:${p}`,
    stdin: () => "from-stdin",
    currentBranch: () => "feat-x",
    prNumber: (sel) => { prCalls.push(sel); return 42; },
    defaultBranch: () => "main",
    ...over,
  };
}

describe("translate", () => {
  test("pr create fills head/base defaults", () => {
    expect(translate(["pr", "create", "-t", "T", "-b", "B", "--draft"], ctx())).toEqual({
      op: "pr-create", title: "T", body: "B", head: "feat-x", base: "main", draft: true,
    });
  });

  test("pr create explicit head/base, no draft, body default empty", () => {
    expect(translate(["pr", "create", "--title", "T", "-H", "h", "-B", "b"], ctx())).toEqual({
      op: "pr-create", title: "T", body: "", head: "h", base: "b", draft: false,
    });
  });

  test("pr create without title refuses", () => {
    expect(() => translate(["pr", "create", "-b", "B"], ctx())).toThrow("pass --title and --body");
  });

  test("--body-file - reads stdin", () => {
    expect(translate(["pr", "comment", "3", "--body-file", "-"], ctx())).toEqual({ op: "comment", number: 3, body: "from-stdin" });
  });

  test("-F path reads file", () => {
    expect(translate(["pr", "comment", "3", "-F", "/tmp/b.md"], ctx())).toEqual({ op: "comment", number: 3, body: "file:/tmp/b.md" });
  });

  test("pr comment with number", () => {
    expect(translate(["pr", "comment", "12", "-b", "x"], ctx())).toEqual({ op: "comment", number: 12, body: "x" });
  });

  test("pr comment without selector uses ctx.prNumber()", () => {
    const c = ctx();
    expect(translate(["pr", "comment", "-b", "x"], c)).toEqual({ op: "comment", number: 42, body: "x" });
    expect(c.prCalls).toEqual([undefined]);
  });

  test("pr comment with branch selector resolves via ctx.prNumber(branch)", () => {
    const c = ctx();
    expect(translate(["pr", "comment", "my-branch", "-b", "x"], c)).toEqual({ op: "comment", number: 42, body: "x" });
    expect(c.prCalls).toEqual(["my-branch"]);
  });

  test("issue comment with a number", () => {
    expect(translate(["issue", "comment", "5", "-b", "x"], ctx()))
      .toEqual({ op: "comment", number: 5, body: "x" });
  });

  test("pr edit with pull URL", () => {
    expect(translate(["pr", "edit", "https://github.com/example-org/demo/pull/8", "--body", "nb"], ctx()))
      .toEqual({ op: "pr-edit", number: 8, body: "nb", repo: "example-org/demo" });
  });

  test("pr edit with nothing to change refuses", () => {
    expect(() => translate(["pr", "edit", "8"], ctx())).toThrow(UsageError);
  });

  test("issue edit title", () => {
    expect(translate(["issue", "edit", "9", "-t", "new"], ctx())).toEqual({ op: "issue-edit", number: 9, title: "new" });
  });

  test("issue comment without selector refuses", () => {
    expect(() => translate(["issue", "comment", "-b", "x"], ctx())).toThrow(UsageError);
  });

  test("issue comment with non-numeric selector refuses", () => {
    expect(() => translate(["issue", "comment", "some-branch", "-b", "x"], ctx())).toThrow(UsageError);
  });

  test("pr review approve", () => {
    expect(translate(["pr", "review", "3", "--approve", "-b", "ok"], ctx()))
      .toEqual({ op: "pr-review", number: 3, event: "APPROVE", body: "ok" });
  });

  test("pr review -r / -c events", () => {
    expect(translate(["pr", "review", "3", "-r", "-b", "no"], ctx())).toMatchObject({ event: "REQUEST_CHANGES" });
    expect(translate(["pr", "review", "3", "-c", "-b", "hm"], ctx())).toMatchObject({ event: "COMMENT" });
  });

  test("pr review without event refuses", () => {
    expect(() => translate(["pr", "review", "3", "-b", "x"], ctx())).toThrow(UsageError);
  });

  test("pr ready without selector", () => {
    expect(translate(["pr", "ready"], ctx())).toEqual({ op: "pr-ready", number: 42 });
  });

  test("issue create labels repeat + comma-split", () => {
    expect(translate(["issue", "create", "-t", "T", "-b", "B", "-l", "a,b", "-l", "c"], ctx()))
      .toEqual({ op: "issue-create", title: "T", body: "B", labels: ["a", "b", "c"] });
  });

  test("--fill refuses naming the flag", () => {
    let err: unknown;
    try { translate(["pr", "create", "--fill"], ctx()); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain("--fill");
  });

  test("--web refuses naming the flag", () => {
    expect(() => translate(["issue", "create", "-t", "T", "--web"], ctx())).toThrow("--web");
  });

  // Review finding 5: the named repo travels to the Worker, which refuses a
  // repo other than the studio's own instead of writing the work repo.
  test("-R / --repo anywhere: passed on as repo", () => {
    expect(translate(["-R", "example-org/demo", "pr", "comment", "12", "-b", "x"], ctx()))
      .toEqual({ op: "comment", number: 12, body: "x", repo: "example-org/demo" });
    expect(translate(["pr", "comment", "12", "--repo=github.com/example-org/demo", "-b", "x"], ctx()))
      .toEqual({ op: "comment", number: 12, body: "x", repo: "example-org/demo" });
  });

  test("a URL selector's repo is passed on too", () => {
    expect(translate(["issue", "comment", "https://github.com/example-org/other/issues/5", "-b", "x"], ctx()))
      .toEqual({ op: "comment", number: 5, body: "x", repo: "example-org/other" });
  });

  test("-R and a URL naming different repos refuses", () => {
    expect(() => translate(["-R", "example-org/demo", "issue", "comment", "https://github.com/example-org/other/issues/5", "-b", "x"], ctx()))
      .toThrow(UsageError);
  });

  test("--flag=value form", () => {
    expect(translate(["pr", "create", "--title=T", "--body=B", "--base=dev"], ctx()))
      .toEqual({ op: "pr-create", title: "T", body: "B", head: "feat-x", base: "dev", draft: false });
  });

  test("unsupported verb refuses", () => {
    expect(() => translate(["pr", "merge", "3"], ctx())).toThrow(UsageError);
  });
});

describe("main() smoke", () => {
  test("posts op to fake Worker and prints html_url", async () => {
    let seen: { token: string | null; ctype: string | null; path: string; body: unknown } | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen = {
          token: req.headers.get("x-fleet-spawn-token"),
          ctype: req.headers.get("content-type"),
          path: new URL(req.url).pathname,
          body: await req.json(),
        };
        return Response.json({ html_url: "https://github.com/example-org/demo/issues/7#issuecomment-1" });
      },
    });
    try {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "../../container/gh-proxy.ts"), "issue", "comment", "7", "-b", "hi"], {
        env: { ...process.env, FLEET_WORKER_URL: `http://127.0.0.1:${server.port}`, FLEET_SPAWN_TOKEN: "fake-token" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, errText, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(errText).toBe("");
      expect(code).toBe(0);
      expect(seen).toEqual({
        token: "fake-token",
        ctype: "application/json",
        path: "/fleet/gh",
        body: { op: "comment", number: 7, body: "hi" },
      });
      expect(out.trim()).toBe("https://github.com/example-org/demo/issues/7#issuecomment-1");
    } finally {
      server.stop(true);
    }
  });

  test("non-2xx prints Worker text to stderr, exit 1", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("blocked: private text", { status: 422 }) });
    try {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "../../container/gh-proxy.ts"), "pr", "comment", "7", "-b", "hi"], {
        env: { ...process.env, FLEET_WORKER_URL: `http://127.0.0.1:${server.port}`, FLEET_SPAWN_TOKEN: "fake-token" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [errText, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(1);
      expect(errText).toContain("fleet-gh-proxy: blocked: private text");
    } finally {
      server.stop(true);
    }
  });

  test("usage error exits 2", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../../container/gh-proxy.ts"), "pr", "create", "--fill"], {
      env: { ...process.env, FLEET_WORKER_URL: "http://127.0.0.1:1", FLEET_SPAWN_TOKEN: "fake-token" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [errText, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(2);
    expect(errText).toContain("--fill");
    expect(errText).toContain("write proxy supports");
  });
});

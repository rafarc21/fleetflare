import { describe, expect, test } from "bun:test";
import type { Browser as PwBrowser, BrowserContext, Page as PwPage } from "playwright-core";
import { buildMethods, type PwPageLike } from "../../container/ego-browser/handlers";
import { Registry } from "../../container/ego-browser/registry";
import { Page } from "../../container/ego-browser/api";

/**
 * Dispatcher-side counterpart to ego-browser-page-rpc.test.ts: that file
 * pins what the client SENDS, this one pins that the daemon's handlers
 * receive exactly that -- envelope stripped, page resolved, and the right
 * Playwright method called with the right args. Together the two files
 * prove wire.ts's RpcMethods map is honored on BOTH ends of the socket.
 *
 * handlers.ts is importable (daemon.ts is not: its top level starts a
 * listener and writes files), so these tests drive buildMethods with fake
 * browser/context/page objects and count every call each fake receives.
 * The fakes are cast to the real playwright types at the single
 * buildMethods boundary; handlers.ts itself type-checks against the real
 * playwright interface -- that is the point of the extraction.
 */

/** The strictly keyed table buildMethods returns; literal-key index
 * accesses stay fully typed (params and result from the wire map). */
type Methods = ReturnType<typeof buildMethods>;

/** The recording fake page plus its tape: PwPageLike's method surface with
 * the calls array the assertions read. */
type FakePage = PwPageLike & { calls: Array<[string, unknown[]]> };

/** A recording fake Page: every method pushes [name, args] and returns a
 * canned value -- a handler that calls the wrong Playwright method, leaks
 * envelope fields into the call, applies a transform twice, or drops one
 * of the method's arguments fails loudly here. */
function fakePage(): FakePage {
  const calls: Array<[string, unknown[]]> = [];
  const rec = (name: string, ret: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, args]);
      return ret;
    };
  return {
    calls,
    goto: rec("goto", null), reload: rec("reload", null),
    url: rec("url", "https://fake.test"), title: rec("title", "T"),
    viewportSize: rec("viewportSize", { width: 1, height: 1 }),
    evaluate: rec("evaluate", { x: 0, y: 0 }),
    screenshot: rec("screenshot", Buffer.from("png")),
    click: rec("click", null), dblclick: rec("dblclick", null), hover: rec("hover", null),
    fill: rec("fill", null), press: rec("press", null), focus: rec("focus", null),
    selectOption: rec("selectOption", ["x"]), setInputFiles: rec("setInputFiles", null),
    waitForSelector: rec("waitForSelector", null), waitForLoadState: rec("waitForLoadState", null),
    waitForURL: rec("waitForURL", null), waitForFunction: rec("waitForFunction", { jsonValue: async () => 5 }),
    waitForTimeout: rec("waitForTimeout", null), close: rec("close", null),
    ariaSnapshot: rec("ariaSnapshot", "snap"),
    // locator is the one SYNCHRONOUS playwright method page.snapshot uses
    // (it returns a Locator object, not a Promise) -- so the fake must hand
    // back its {ariaSnapshot} immediately, never through rec()'s async path.
    locator(selector: string) {
      calls.push(["locator", [selector]]);
      return { ariaSnapshot: async () => "snap" };
    },
  } as unknown as FakePage;
}

/** Fake BrowserContext: newPage always hands out the SAME fake page (two
 * labels in one context then share one tape) and counts how many times it
 * ran -- a handler that materializes the same label twice shows up here. */
function fakeContext() {
  const page = fakePage();
  let newPageCount = 0;
  return {
    page,
    newPageCount: () => newPageCount,
    newPage: async () => {
      newPageCount += 1;
      return page;
    },
    close: async () => {},
  };
}

/** Fake Browser: counts newContext calls -- a taskSpace reuse that built a
 * second context would be visible here, not just in the result. */
function fakeBrowser() {
  const context = fakeContext();
  const contexts: unknown[] = [];
  return {
    context,
    newContextCount: () => contexts.length,
    newContext: async () => {
      contexts.push(context);
      return context;
    },
  };
}

/** buildMethods wired to fakes -- the same registry+browser shape daemon.ts
 * passes for real, with the fakes cast to the real playwright types at
 * this one boundary. */
function makeMethods() {
  const registry = new Registry<unknown, unknown>();
  const browser = fakeBrowser();
  const methods = buildMethods({
    registry: registry as unknown as Registry<PwPage, BrowserContext>,
    getBrowser: async () => browser as unknown as PwBrowser,
  });
  return { registry, browser, methods };
}

/** Seeds space 1 whose context materializes every label onto one fresh
 * recording page. Note the await: registry.resolve only registers the
 * space once its makeContext promise settles, so an unawaited seed is a
 * space the handlers cannot see yet. */
async function seeded() {
  const m = makeMethods();
  const page = fakePage();
  await m.registry.resolve(1, async () => ({
    newPage: async () => page,
    close: async () => {},
  }));
  return { ...m, page };
}

/** The socket dispatcher's exact view of the table: a method name off the
 * wire plus whatever params came with it. One cast, mirroring the single
 * string-keyed lookup daemon.ts itself makes in handleRequest. */
function dispatch(methods: Methods, method: string, params: unknown) {
  const handler = (methods as unknown as Record<string, (p: unknown) => Promise<unknown>>)[method];
  if (!handler) throw new Error(`test bug: no handler for ${method}`);
  return handler(params);
}

/** Fires one handler and returns the single [name, args] the fake page
 * recorded -- the shape most page.* pins assert on. */
async function one(m: { methods: Methods; page: FakePage }, method: string, params: unknown) {
  await dispatch(m.methods, method, params);
  expect(m.page.calls.length).toBe(1);
  return m.page.calls[0]!;
}

describe("page.* handlers route client params to the resolved page", () => {
  test("goto passes url and opts through untouched", async () => {
    const m = await seeded();
    // opts must arrive as the SAME value the wire carried, not a rebuilt
    // copy -- an unnamed client-side opt has to survive the hop.
    const rec = await one(m, "page.goto", { spaceId: 1, label: "p1", url: "https://x.test", opts: { timeout: 1 } });
    expect(rec).toEqual(["goto", ["https://x.test", { timeout: 1 }]]);
  });

  test("fill passes selector, value, and opts in order", async () => {
    const m = await seeded();
    const rec = await one(m, "page.fill", { spaceId: 1, label: "p1", selector: "#s", value: "v", opts: { timeout: 2 } });
    expect(rec).toEqual(["fill", ["#s", "v", { timeout: 2 }]]);
  });

  test("waitForURL turns the wire matcher back into the plain string, applied once", async () => {
    const m = await seeded();
    const rec = await one(
      m,
      "page.waitForURL",
      { spaceId: 1, label: "p1", urlMatcher: { kind: "string", value: "https://x.test/done" }, opts: { timeout: 3 } },
    );
    // The forwarder stringified the matcher (client-side pin); the handler
    // must apply toUrlMatcher exactly once -- a skipped transform would
    // leave the wire object here, a doubled one a stringified string.
    expect(rec).toEqual(["waitForURL", ["https://x.test/done", { timeout: 3 }]]);
  });

  test("waitForFunction reconstructs the callable and unwraps the handle", async () => {
    const m = await seeded();
    const result = await dispatch(m.methods, "page.waitForFunction", {
      spaceId: 1, label: "p1", fn: { code: "(x) => x", isFunction: true }, arg: 1, opts: { polling: 50 },
    });
    const rec = m.page.calls[0]!;
    expect(rec[0]).toBe("waitForFunction");
    // The wire carried source text; the handler must hand Playwright a real
    // callable (not the string) and return handle.jsonValue(), not the handle.
    expect(typeof rec[1]![0]).toBe("function");
    expect(rec[1]![1]).toBe(1);
    expect(rec[1]![2]).toEqual({ polling: 50 });
    // The handler returns handle.jsonValue()'s awaited result -- the fake's
    // canned 5 -- not the handle object itself.
    expect(result).toBe(5);
  });

  test("evaluate with a string expression forwards the string itself", async () => {
    const m = await seeded();
    // Non-function code must NOT become a callable: a plain expression goes
    // through Playwright's own evaluate-as-browser-JS string path.
    const rec = await one(m, "page.evaluate", { spaceId: 1, label: "p1", fn: { code: "1+1", isFunction: false } });
    expect(rec).toEqual(["evaluate", ["1+1"]]);
  });

  test("reload forwards opts; url/title forward no args", async () => {
    const a = await seeded();
    expect(await one(a, "page.reload", { spaceId: 1, label: "p1", opts: { a: 1 } })).toEqual(["reload", [{ a: 1 }]]);
    const b = await seeded();
    expect(await one(b, "page.url", { spaceId: 1, label: "p1" })).toEqual(["url", []]);
    const c = await seeded();
    expect(await one(c, "page.title", { spaceId: 1, label: "p1" })).toEqual(["title", []]);
  });

  test("close closes the target and removes the label from the space", async () => {
    const m = await seeded();
    // Materialize p1 first: close only acts on a target that exists (a
    // still-lazy label has nothing to close -- it is simply dropped).
    await dispatch(m.methods, "page.url", { spaceId: 1, label: "p1" });
    m.page.calls.length = 0;
    expect(await one(m, "page.close", { spaceId: 1, label: "p1" })).toEqual(["close", []]);
    // The label must be unregistered too -- a later call on it would
    // otherwise re-materialize a fresh orphan page.
    expect(m.registry.get(1)!.hasLabel("p1")).toBe(false);
  });

  test("info fans out to url/title/viewportSize/evaluate and merges the results", async () => {
    const m = await seeded();
    const result = await dispatch(m.methods, "page.info", { spaceId: 1, label: "p1" });
    expect(m.page.calls.map((c) => c[0])).toEqual(["url", "title", "viewportSize", "evaluate"]);
    // The scroll expression goes as a STRING (browser JS, never compiled by
    // our own tsc) -- a callable here would be the wrong wire form.
    expect(m.page.calls[3]![1]).toEqual(["({ x: window.scrollX, y: window.scrollY })"]);
    expect(result).toEqual({
      url: "https://fake.test",
      title: "T",
      viewport: { width: 1, height: 1 },
      scroll: { x: 0, y: 0 },
    });
  });

  test("screenshot forces type png and returns base64", async () => {
    const m = await seeded();
    const result = await dispatch(m.methods, "page.screenshot", { spaceId: 1, label: "p1", opts: { fullPage: true } });
    const rec = m.page.calls[0]!;
    expect(rec[0]).toBe("screenshot");
    expect(rec[1]![0]).toMatchObject({ fullPage: true, type: "png" });
    expect(result).toEqual({ base64: Buffer.from("png").toString("base64") });
  });

  test("screenshot with opts.path writes the file and returns the path", async () => {
    const m = await seeded();
    const path = `/tmp/ego-rpc-daemon-test/${Date.now()}/a/b/shot.png`;
    const result = await dispatch(m.methods, "page.screenshot", { spaceId: 1, label: "p1", opts: { path, fullPage: false } });
    expect(result).toEqual({ path });
    // The handler mkdirs the dirname itself -- a missing parent directory
    // must not fail the write.
    expect(await Bun.file(path).text()).toBe("png");
  });

  test("snapshot with no opts walks the page's own ariaSnapshot", async () => {
    const m = await seeded();
    const result = await dispatch(m.methods, "page.snapshot", { spaceId: 1, label: "p1", opts: undefined });
    const rec = m.page.calls[0]!;
    expect(rec[0]).toBe("ariaSnapshot");
    expect(rec[1]![0]).toEqual({ mode: "ai", boxes: false });
    expect(result).toEqual({ scope: "only_within_viewport", snapshot: "snap" });
  });

  test("snapshot full_page routes through locator('body')", async () => {
    const m = await seeded();
    const result = await dispatch(m.methods, "page.snapshot", { spaceId: 1, label: "p1", opts: { scope: "full_page", includeActionMarks: true } });
    const loc = m.page.calls[0]!;
    expect(loc[0]).toBe("locator");
    expect(loc[1]).toEqual(["body"]);
    expect(result).toEqual({ scope: "full_page", snapshot: "snap" });
  });

  test("the remaining click-family and wait-family methods forward their params", async () => {
    // One pin per method: the Playwright method name plus the args the
    // handler forwarded. The client side is already deeply pinned; this
    // proves routing + envelope strip + resolvePage for the rest. opts is
    // undefined (not absent) on the wire after JSON, so it must arrive as an
    // explicit undefined argument, exactly as the forwarder sent it.
    const cases: Array<[string, unknown, [string, unknown[]]]> = [
      ["page.click", { spaceId: 1, label: "p1", selector: "#s", opts: { timeout: 9 } }, ["click", ["#s", { timeout: 9 }]]],
      ["page.dblclick", { spaceId: 1, label: "p1", selector: "#s" }, ["dblclick", ["#s", undefined]]],
      ["page.hover", { spaceId: 1, label: "p1", selector: "#s" }, ["hover", ["#s", undefined]]],
      ["page.press", { spaceId: 1, label: "p1", selector: "#s", chord: "Enter" }, ["press", ["#s", "Enter", undefined]]],
      ["page.focus", { spaceId: 1, label: "p1", selector: "#s" }, ["focus", ["#s", undefined]]],
      ["page.selectOption", { spaceId: 1, label: "p1", selector: "#s", valueOrValues: ["a"] }, ["selectOption", ["#s", ["a"], undefined]]],
      ["page.setInputFiles", { spaceId: 1, label: "p1", selector: "#s", pathOrPaths: "/tmp/f" }, ["setInputFiles", ["#s", "/tmp/f"]]],
      ["page.waitForSelector", { spaceId: 1, label: "p1", selector: "#s" }, ["waitForSelector", ["#s", undefined]]],
      ["page.waitForLoadState", { spaceId: 1, label: "p1", state: "load" }, ["waitForLoadState", ["load", undefined]]],
      ["page.waitForTimeout", { spaceId: 1, label: "p1", ms: 50 }, ["waitForTimeout", [50]]],
    ];
    for (const [method, params, expected] of cases) {
      const m = await seeded();
      expect(await one(m, method, params)).toEqual(expected);
    }
  });
});

describe("envelope handling", () => {
  test("a call on a still-lazy label materializes the page, then reuses it", async () => {
    const m = makeMethods();
    // resolve(1, ...) registers lazy label "p1" with NO target -- the
    // handler must materialize it via the context on first use.
    await m.registry.resolve(1, async () => m.browser.context);
    const first = await dispatch(m.methods, "page.url", { spaceId: 1, label: "p1" });
    expect(first).toBe("https://fake.test");
    expect(m.registry.get(1)!.getTarget("p1")).toBeDefined();
    expect(m.browser.context.newPageCount()).toBe(1);
    // Second call must reuse the SAME page -- a second newPage() here would
    // orphan the first browser page.
    const second = await dispatch(m.methods, "page.url", { spaceId: 1, label: "p1" });
    expect(second).toBe("https://fake.test");
    expect(m.browser.context.newPageCount()).toBe(1);
    expect(m.browser.context.page.calls).toEqual([["url", []], ["url", []]]);
  });
});

describe("space.* handlers", () => {
  test("space.pages materializes every lazy label, then lists them", async () => {
    const m = makeMethods();
    const space = await m.registry.resolve(1, async () => fakeContext());
    space.ensureLabel("p2");
    // Two lazy labels, no targets yet: the handler must materialize BOTH
    // (eager, per the contract) and report them, not just the first.
    const result = await dispatch(m.methods, "space.pages", { spaceId: 1 });
    expect(result).toEqual([{ label: "p1" }, { label: "p2" }]);
    expect(space.getTarget("p1")).toBeDefined();
    expect(space.getTarget("p2")).toBeDefined();
    expect(space.listLabels().map((s) => s.label)).toEqual(["p1", "p2"]);
  });

  test("space.newPage registers the next auto label with its target set eagerly", async () => {
    const m = makeMethods();
    const context = fakeContext();
    await m.registry.resolve(1, async () => context);
    const result = await dispatch(m.methods, "space.newPage", { spaceId: 1 });
    // newPage is the one handler that materializes eagerly -- the returned
    // label must already carry its real target, not stay lazy.
    expect(result).toEqual({ label: "p2" });
    expect(m.registry.get(1)!.getTarget("p2")).toBe(context.page);
  });

  test("space.finish keep:'all' retains everything and leaves the space open", async () => {
    const m = makeMethods();
    const context = fakeContext();
    await m.registry.resolve(1, async () => context);
    const result = await dispatch(m.methods, "space.finish", { spaceId: 1, keep: "all" });
    expect(result).toEqual({ retained: ["p1"], closed: [] });
    expect(context.newPageCount()).toBe(0);
    expect(context.page.calls.length).toBe(0);
    expect(m.registry.get(1)).toBeDefined();
    expect(m.registry.get(1)!.hasLabel("p1")).toBe(true);
  });

  test("space.finish keep:[] closes the page and the whole space", async () => {
    const m = makeMethods();
    let contextClosed = false;
    const context = fakeContext();
    await m.registry.resolve(1, async () => ({ ...context, close: async () => { contextClosed = true; } }));
    // Materialize p1 through the handler first, so its close() lands on the
    // fake page's tape; then clear the tape so it shows ONLY finish's work.
    await dispatch(m.methods, "page.url", { spaceId: 1, label: "p1" });
    context.page.calls.length = 0;
    const result = await dispatch(m.methods, "space.finish", { spaceId: 1, keep: [] });
    // Real finish behavior: the receipt names what closed, the materialized
    // page was closed, the context was closed once nothing survived, and
    // the registry dropped the space.
    expect(result).toEqual({ retained: [], closed: ["p1"] });
    expect(context.page.calls.map((c) => c[0])).toEqual(["close"]);
    expect(contextClosed).toBe(true);
    expect(m.registry.get(1)).toBeUndefined();
    // The name is gone too -- a later listTaskSpaces must not report it.
    expect(await dispatch(m.methods, "listTaskSpaces", undefined)).toEqual([]);
  });

  test("a stale spaceId gets the dispatcher's loud error, not an empty result", async () => {
    const m = makeMethods();
    // resolveSpace's failure text is part of the daemon's contract: a client
    // holding a finished-or-never-created id must see a real error.
    await expect(dispatch(m.methods, "space.finish", { spaceId: 1, keep: "all" })).rejects.toThrow(
      "ego-browser: no task space 1 (finished, or never created)",
    );
  });
});

describe("taskSpace/listTaskSpaces", () => {
  test("taskSpace creates a space by name, then reuses it on the second call", async () => {
    const m = makeMethods();
    // Typed-key access (not dispatch): the result carries the wire map's
    // declared result type, so the reuse assert reads fields, not unknowns.
    const first = await m.methods["taskSpace"]({ nameOrId: "demo" });
    expect(first).toEqual({ spaceId: 1, name: "demo" });
    const second = await m.methods["taskSpace"]({ nameOrId: "demo" });
    // Same name must reuse the space: one newContext for the whole lifetime
    // of that name, not one per taskSpace call.
    expect(second.spaceId).toBe(first.spaceId);
    expect(m.browser.newContextCount()).toBe(1);
  });

  test("listTaskSpaces reports every open space's id and name", async () => {
    const m = makeMethods();
    await dispatch(m.methods, "taskSpace", { nameOrId: "demo" });
    expect(await dispatch(m.methods, "listTaskSpaces", undefined)).toEqual([{ spaceId: 1, name: "demo" }]);
  });
});

describe("wire symmetry: client forwarder output drives daemon handlers", () => {
  /** The client-side recorder from ego-browser-page-rpc.test.ts -- the
   * recorded params here are consumed by the daemon's handlers, so the two
   * files meet in the middle at the wire map. */
  function recordingCall() {
    const calls: Array<{ method: string; params: unknown }> = [];
    const call = (method: string, params?: unknown) => {
      calls.push({ method, params: structuredClone(params) });
      return Promise.resolve(undefined);
    };
    return { calls, call };
  }

  // The wire map is the declared contract on BOTH ends; these pins prove
  // declared == actual end-to-end: fire the real client forwarder, take its
  // recorded {method, params} verbatim, and hand them straight to the daemon
  // handler the socket would dispatch to. Any drift -- a renamed method, a
  // re-shaped params object -- fails the client pin, the daemon pin, or both.
  test("client page.goto params drive the goto handler", async () => {
    const m = await seeded();
    const { calls, call } = recordingCall();
    const page = new Page(1, "p1", call);
    await page.goto("https://x.test", { waitUntil: "load" });
    const { method, params } = calls[0]!;
    expect(method).toBe("page.goto");
    await dispatch(m.methods, method, params);
    expect(m.page.calls).toEqual([["goto", ["https://x.test", { waitUntil: "load" }]]]);
  });

  test("client page.fill params drive the fill handler", async () => {
    const m = await seeded();
    const { calls, call } = recordingCall();
    const page = new Page(1, "p1", call);
    await page.fill("#s", "v");
    const { method, params } = calls[0]!;
    expect(method).toBe("page.fill");
    await dispatch(m.methods, method, params);
    expect(m.page.calls).toEqual([["fill", ["#s", "v", undefined]]]);
  });

  test("client page.waitForURL params drive the waitForURL handler", async () => {
    const m = await seeded();
    const { calls, call } = recordingCall();
    const page = new Page(1, "p1", call);
    await page.waitForURL("https://x.test/done");
    const { method, params } = calls[0]!;
    expect(method).toBe("page.waitForURL");
    await dispatch(m.methods, method, params);
    expect(m.page.calls).toEqual([["waitForURL", ["https://x.test/done", undefined]]]);
  });
});

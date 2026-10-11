import { describe, expect, test } from "bun:test";
import { Page, TaskSpace, buildGlobals } from "../../container/ego-browser/api";

/**
 * Characterization of the client side's RPC wire output: every page.*,
 * space.*, and entry-point call, pinned as the exact {method, params} the
 * daemon's dispatcher must see. These pin CURRENT behavior (not ideal
 * behavior) so a refactor of the forwarding code can be proven
 * byte-identical on the wire; the params the recorder captures are exactly
 * what JSON.stringify carries over the socket.
 *
 * The recorder deep-clones params at record time, so any later mutation of
 * shared objects cannot fake a pass. Canned results verify the return-value
 * path too (url()/title() actually resolve with the daemon's result).
 */

/** A recording RpcCall: captures each call's method + a deep clone of
 * params (cloned at record time so post-call mutations of the originals
 * can never retroactively change what was recorded), then resolves a
 * canned result chosen per test. */
function recordingCall(result: () => unknown = () => undefined) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const call = (method: string, params?: unknown) => {
    calls.push({ method, params: structuredClone(params) });
    return Promise.resolve(result());
  };
  return { calls, call };
}

describe("Page RPC wire shapes (refs #320)", () => {
  test("goto sends url and opts in the envelope", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    await page.goto("https://x.test", { waitUntil: "load" });
    expect(calls).toEqual([
      { method: "page.goto", params: { spaceId: 7, label: "p1", url: "https://x.test", opts: { waitUntil: "load" } } },
    ]);
  });

  test("reload sends opts; with no opts the key is still present", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    await page.reload({ a: 1 });
    // opts stays a present-but-undefined key: the wire is JSON.stringify'd,
    // which drops undefined values, so callers cannot tell the difference --
    // but the daemon-side signature pins it as an explicit optional field.
    await page.reload();
    expect(calls).toEqual([
      { method: "page.reload", params: { spaceId: 7, label: "p1", opts: { a: 1 } } },
      { method: "page.reload", params: { spaceId: 7, label: "p1", opts: undefined } },
    ]);
  });

  test("url sends only the envelope and resolves the daemon's result", async () => {
    const { calls, call } = recordingCall(() => "https://x.test");
    const page = new Page(7, "p1", call);
    await expect(page.url()).resolves.toBe("https://x.test");
    expect(calls).toEqual([{ method: "page.url", params: { spaceId: 7, label: "p1" } }]);
  });

  test("title sends only the envelope and resolves the daemon's result", async () => {
    const { calls, call } = recordingCall(() => "T");
    const page = new Page(7, "p1", call);
    await expect(page.title()).resolves.toBe("T");
    expect(calls).toEqual([{ method: "page.title", params: { spaceId: 7, label: "p1" } }]);
  });

  test("info sends only the envelope", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    await page.info();
    expect(calls).toEqual([{ method: "page.info", params: { spaceId: 7, label: "p1" } }]);
  });

  test("screenshot sends opts in the envelope", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    await page.screenshot({ fullPage: true });
    expect(calls).toEqual([
      { method: "page.screenshot", params: { spaceId: 7, label: "p1", opts: { fullPage: true } } },
    ]);
  });

  test("evaluate marshals a function to its source text, plus arg", async () => {
    const { calls, call } = recordingCall(() => 3);
    const page = new Page(7, "p1", call);
    const add = (a: unknown, b: unknown): unknown => (a as number) + (b as number);
    await page.evaluate(add, [1, 2]);
    // The daemon must reconstruct the function from its own toString(), so
    // pinning code === fn.toString() (not a hand-typed copy) is the real
    // round-trip guarantee.
    expect(calls).toEqual([
      {
        method: "page.evaluate",
        params: {
          spaceId: 7,
          label: "p1",
          fn: { code: add.toString(), isFunction: true },
          arg: [1, 2],
        },
      },
    ]);
  });

  test("evaluate marshals a plain string expression with isFunction false", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    await page.evaluate("1+1");
    expect(calls).toEqual([
      { method: "page.evaluate", params: { spaceId: 7, label: "p1", fn: { code: "1+1", isFunction: false }, arg: undefined } },
    ]);
  });

  test("click sends selector and opts", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    await page.click("#s");
    await page.click("#s", { timeout: 5 });
    expect(calls).toEqual([
      { method: "page.click", params: { spaceId: 7, label: "p1", selector: "#s", opts: undefined } },
      { method: "page.click", params: { spaceId: 7, label: "p1", selector: "#s", opts: { timeout: 5 } } },
    ]);
  });

  test("dblclick sends selector and opts", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    await page.dblclick("#s");
    expect(calls).toEqual([
      { method: "page.dblclick", params: { spaceId: 7, label: "p1", selector: "#s", opts: undefined } },
    ]);
  });

  test("hover sends selector and opts", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    await page.hover("#s");
    expect(calls).toEqual([
      { method: "page.hover", params: { spaceId: 7, label: "p1", selector: "#s", opts: undefined } },
    ]);
  });

  test("fill sends selector, value, and opts", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    await page.fill("#s", "v");
    expect(calls).toEqual([
      { method: "page.fill", params: { spaceId: 7, label: "p1", selector: "#s", value: "v", opts: undefined } },
    ]);
  });

  test("press sends selector, chord, and opts", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    await page.press("#s", "Enter");
    expect(calls).toEqual([
      { method: "page.press", params: { spaceId: 7, label: "p1", selector: "#s", chord: "Enter", opts: undefined } },
    ]);
  });

  test("focus sends selector and opts", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    await page.focus("#s");
    expect(calls).toEqual([
      { method: "page.focus", params: { spaceId: 7, label: "p1", selector: "#s", opts: undefined } },
    ]);
  });

  test("selectOption sends selector, valueOrValues, and opts", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    await page.selectOption("#s", ["a", "b"]);
    expect(calls).toEqual([
      {
        method: "page.selectOption",
        params: { spaceId: 7, label: "p1", selector: "#s", valueOrValues: ["a", "b"], opts: undefined },
      },
    ]);
  });

  test("setInputFiles sends selector and pathOrPaths", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    await page.setInputFiles("#s", "/tmp/f");
    expect(calls).toEqual([
      { method: "page.setInputFiles", params: { spaceId: 7, label: "p1", selector: "#s", pathOrPaths: "/tmp/f" } },
    ]);
  });

  test("waitForSelector sends selector and opts", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    await page.waitForSelector("#s");
    expect(calls).toEqual([
      { method: "page.waitForSelector", params: { spaceId: 7, label: "p1", selector: "#s", opts: undefined } },
    ]);
  });

  test("waitForLoadState sends state and opts", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    await page.waitForLoadState("load");
    expect(calls).toEqual([
      { method: "page.waitForLoadState", params: { spaceId: 7, label: "p1", state: "load", opts: undefined } },
    ]);
  });

  test("waitForURL marshals a string matcher", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    await page.waitForURL("https://x.test/**");
    expect(calls).toEqual([
      {
        method: "page.waitForURL",
        params: { spaceId: 7, label: "p1", urlMatcher: { kind: "string", value: "https://x.test/**" }, opts: undefined },
      },
    ]);
  });

  test("waitForURL marshals a regexp matcher as source and flags", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    const matcher = /foo\/bar/gi;
    await page.waitForURL(matcher);
    // The daemon rebuilds `new RegExp(source, flags)` from these two
    // fields, so both must be pinned, not just the source.
    expect(calls).toEqual([
      {
        method: "page.waitForURL",
        params: { spaceId: 7, label: "p1", urlMatcher: { kind: "regexp", source: "foo\\/bar", flags: "gi" }, opts: undefined },
      },
    ]);
  });

  test("waitForURL marshals a function matcher to its source text", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    const pred = (u: URL): boolean => u.host === "x.test";
    await page.waitForURL(pred);
    expect(calls).toEqual([
      {
        method: "page.waitForURL",
        params: { spaceId: 7, label: "p1", urlMatcher: { kind: "function", code: pred.toString() }, opts: undefined },
      },
    ]);
  });

  test("waitForFunction marshals fn, arg, and opts", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    const pred = (x: unknown): boolean => (x as number) > 1;
    await page.waitForFunction(pred, 5, { polling: 100 });
    expect(calls).toEqual([
      {
        method: "page.waitForFunction",
        params: { spaceId: 7, label: "p1", fn: { code: pred.toString(), isFunction: true }, arg: 5, opts: { polling: 100 } },
      },
    ]);
  });

  test("waitForFunction marshals a plain string expression with isFunction false", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    await page.waitForFunction("window.ready");
    expect(calls).toEqual([
      {
        method: "page.waitForFunction",
        params: { spaceId: 7, label: "p1", fn: { code: "window.ready", isFunction: false }, arg: undefined, opts: undefined },
      },
    ]);
  });

  test("waitForTimeout sends ms", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    await page.waitForTimeout(50);
    expect(calls).toEqual([{ method: "page.waitForTimeout", params: { spaceId: 7, label: "p1", ms: 50 } }]);
  });

  test("close sends only the envelope", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    await page.close();
    expect(calls).toEqual([{ method: "page.close", params: { spaceId: 7, label: "p1" } }]);
  });

  test("snapshot sends opts; with no opts the key is still present", async () => {
    const { calls, call } = recordingCall();
    const page = new Page(7, "p1", call);
    await page.snapshot({ scope: "full_page" });
    await page.snapshot();
    expect(calls).toEqual([
      { method: "page.snapshot", params: { spaceId: 7, label: "p1", opts: { scope: "full_page" } } },
      { method: "page.snapshot", params: { spaceId: 7, label: "p1", opts: undefined } },
    ]);
  });
});

describe("TaskSpace RPC wire shapes", () => {
  test("page() is lazy: no call is made just by getting the handle", () => {
    const { calls, call } = recordingCall();
    const task = new TaskSpace(7, "demo", call);
    task.page("p9");
    expect(calls.length).toBe(0);
  });

  test("pages() lists the space and maps results to Page handles", async () => {
    const { calls, call } = recordingCall(() => [{ label: "p1" }, { label: "p2" }]);
    const task = new TaskSpace(7, "demo", call);
    const pages = await task.pages();
    expect(pages.map((p) => p.label)).toEqual(["p1", "p2"]);
    // The returned handles must carry the space's envelope into their own
    // later calls, so a daemon-side refactor cannot lose the linkage.
    const { calls: inner, call: innerCall } = recordingCall();
    const p1 = new Page(task.spaceId, pages[0]!.label, innerCall);
    await p1.url();
    expect(inner).toEqual([{ method: "page.url", params: { spaceId: 7, label: "p1" } }]);
    expect(calls).toEqual([{ method: "space.pages", params: { spaceId: 7 } }]);
  });

  test("newPage() creates in the space and returns a Page for the result", async () => {
    const { calls, call } = recordingCall(() => ({ label: "p2" }));
    const task = new TaskSpace(7, "demo", call);
    const page = await task.newPage();
    expect(page.label).toBe("p2");
    expect(calls).toEqual([{ method: "space.newPage", params: { spaceId: 7 } }]);
  });

  test("finish() sends keep", async () => {
    const { calls, call } = recordingCall(() => ({ retained: [], closed: [] }));
    const task = new TaskSpace(7, "demo", call);
    await task.finish({ keep: "all" });
    expect(calls).toEqual([{ method: "space.finish", params: { spaceId: 7, keep: "all" } }]);
  });
});

describe("entry-point RPC wire shapes", () => {
  test("taskSpace(name) resolves a TaskSpace carrying the daemon's identity", async () => {
    const { calls, call } = recordingCall(() => ({ spaceId: 7, name: "demo" }));
    const globals = buildGlobals(call);
    const task = await globals.taskSpace("demo");
    expect(task.spaceId).toBe(7);
    expect(task.name).toBe("demo");
    expect(calls).toEqual([{ method: "taskSpace", params: { nameOrId: "demo", profileId: undefined } }]);
  });

  test("taskSpace(id, {profileId}) sends both fields", async () => {
    const { calls, call } = recordingCall(() => ({ spaceId: 7, name: "demo" }));
    const globals = buildGlobals(call);
    await globals.taskSpace(7, { profileId: "x" });
    expect(calls).toEqual([{ method: "taskSpace", params: { nameOrId: 7, profileId: "x" } }]);
  });

  test("listTaskSpaces() makes its call with no params", async () => {
    const { calls, call } = recordingCall(() => [{ spaceId: 7, name: "demo" }]);
    const globals = buildGlobals(call);
    await expect(globals.listTaskSpaces()).resolves.toEqual([{ spaceId: 7, name: "demo" }]);
    expect(calls).toEqual([{ method: "listTaskSpaces", params: undefined }]);
  });
});

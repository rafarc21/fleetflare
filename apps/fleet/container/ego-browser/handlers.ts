/**
 * The daemon's RPC method table, separated from daemon.ts (which runs
 * Bun.listen + file I/O at top level and so can never be imported by a
 * test) so tests can drive it with injected fakes -- same spirit as the
 * registry.ts / idle-shutdown.ts / process-reap.ts extractions. Every
 * handler's params/result is typed from wire.ts's RpcMethods map, the same
 * map api.ts's forwarder types its calls from, so a name/shape drift
 * between the client and the daemon is a compile error, not a silent wire
 * bug.
 */
import type { Browser as PwBrowser, BrowserContext, Page as PwPage } from "playwright-core";
import type { Registry, TaskSpaceRecord } from "./registry";
import type { FnOrStringWire, PageParams, PageRpcMethod, RpcMethods, SnapshotOpts, UrlMatcherWire } from "./wire";

export interface HandlerDeps {
  registry: Registry<PwPage, BrowserContext>;
  getBrowser: () => Promise<PwBrowser>;
}

/**
 * The socket dispatcher's view of the table: the wire carries an arbitrary
 * method name, so daemon.ts indexes by plain string and treats a miss as
 * "unknown RPC method" -- the same loose Handler shape the table had before
 * the extraction (params must be `any`, not `unknown`: a strictly-typed
 * handler is assignable to an `any`-params signature but not, under
 * strictFunctionTypes, to a `unknown`-params one). buildMethods' own return
 * type stays the strictly keyed map, so every typed call site is checked
 * against wire.ts's RpcMethods; daemon.ts types its one declaration as
 * this view and indexes it by the raw wire string.
 */
export type MethodDispatch = Record<string, ((params: any) => Promise<unknown> | unknown) | undefined>;

/**
 * Structural stand-in for playwright-core's Page: exactly the surface the
 * handlers call, with loose argument types. The real PwPage satisfies it;
 * tests build a recording fake and cast it here. handlers.ts itself always
 * type-checks against the REAL playwright types -- this type exists so a
 * test fake needs no playwright import of its own.
 */
export interface PwPageLike {
  goto(url: string, opts?: unknown): Promise<unknown>;
  reload(opts?: unknown): Promise<unknown>;
  url(): Promise<string>;
  title(): Promise<string>;
  viewportSize(): Promise<unknown>;
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
  screenshot(opts?: unknown): Promise<Buffer>;
  click(selector: string, opts?: unknown): Promise<unknown>;
  dblclick(selector: string, opts?: unknown): Promise<unknown>;
  hover(selector: string, opts?: unknown): Promise<unknown>;
  fill(selector: string, value: string, opts?: unknown): Promise<unknown>;
  press(selector: string, chord: string, opts?: unknown): Promise<unknown>;
  focus(selector: string, opts?: unknown): Promise<unknown>;
  selectOption(selector: string, valueOrValues: unknown, opts?: unknown): Promise<unknown>;
  setInputFiles(selector: string, pathOrPaths: unknown): Promise<unknown>;
  waitForSelector(selector: string, opts?: unknown): Promise<unknown>;
  waitForLoadState(state?: unknown, opts?: unknown): Promise<unknown>;
  waitForURL(urlMatcher: unknown, opts?: unknown): Promise<unknown>;
  waitForFunction(fn: unknown, arg?: unknown, opts?: unknown): Promise<{ jsonValue(): Promise<unknown> }>;
  waitForTimeout(ms: number): Promise<unknown>;
  close(): Promise<unknown>;
  ariaSnapshot(opts?: unknown): Promise<string>;
  locator(selector: string): { ariaSnapshot(opts?: unknown): Promise<string> };
}

/** Params one handler receives: page.* methods carry the envelope
 * (spaceId+label) on top of the method's own args -- exactly what api.ts's
 * forwarder puts on the wire (wire.ts's PageParams). */
type HandlerParams<K extends keyof RpcMethods> = K extends PageRpcMethod ? PageParams<K> : RpcMethods[K]["params"];

export type MethodHandler<K extends keyof RpcMethods> = (params: HandlerParams<K>) => Promise<RpcMethods[K]["result"]>;

// ---------------------------------------------------------------------------
// evaluate / waitForFunction / waitForURL marshaling. JSON-RPC only carries
// JSON, so a function argument crosses the wire as its own source text
// (`fn.toString()`, done client-side in api.ts) and is reconstructed here
// with `new Function(...)`. This is the one deliberately non-obvious wire
// hop in the whole shim -- see api.ts's marshalFnOrString for the other
// half.
// ---------------------------------------------------------------------------
function reconstructFunction(code: string): (...args: unknown[]) => unknown {
  // eslint-disable-next-line no-new-func -- documented, deliberate: this is
  // exactly how a function argument survives a JSON-RPC hop (see header
  // comment above).
  return new Function(`return (${code});`)() as (...args: unknown[]) => unknown;
}

function toEvaluateArg(wire: FnOrStringWire): ((...args: unknown[]) => unknown) | string {
  return wire.isFunction ? reconstructFunction(wire.code) : wire.code;
}

function toUrlMatcher(wire: UrlMatcherWire): string | RegExp | ((url: URL) => boolean) {
  if (wire.kind === "string") return wire.value;
  if (wire.kind === "regexp") return new RegExp(wire.source, wire.flags);
  return reconstructFunction(wire.code) as (url: URL) => boolean;
}

// ---------------------------------------------------------------------------
// page.snapshot() -- reuses playwright-core's own public page.ariaSnapshot
// ({mode:"ai"}), which produces the same ref-annotated ([ref=e2]) shape
// @playwright/mcp's own snapshot tool does (same underlying accessibility-
// tree serializer). See docs/plans/2026-09-22-ego-browser-shim.md for the
// full reasoning, including the documented viewport-vs-full_page
// limitation (ariaSnapshot has no native notion of "viewport" -- it walks
// the accessibility tree, not the rendered pixels).
// ---------------------------------------------------------------------------
async function pageSnapshot(pwPage: PwPage, opts: SnapshotOpts = {}): Promise<{ scope: string; root?: string; snapshot: string }> {
  const scope = opts.scope ?? "only_within_viewport";
  const ariaOpts = { mode: "ai" as const, boxes: !!opts.includeActionMarks };

  if (scope === "subtree") {
    if (!opts.root) throw new Error('ego-browser: page.snapshot({scope:"subtree"}) requires opts.root');
    const snapshot = await pwPage.locator(`aria-ref=${opts.root}`).ariaSnapshot(ariaOpts);
    return { scope, root: opts.root, snapshot };
  }
  if (scope === "full_page") {
    const snapshot = await pwPage.locator("body").ariaSnapshot(ariaOpts);
    return { scope, snapshot };
  }
  const snapshot = await pwPage.ariaSnapshot(ariaOpts);
  return { scope: "only_within_viewport", snapshot };
}

export function buildMethods(deps: HandlerDeps): { [K in keyof RpcMethods]: MethodHandler<K> } {
  const { registry, getBrowser } = deps;

  async function resolveSpace(spaceId: number): Promise<TaskSpaceRecord<PwPage, BrowserContext>> {
    const space = registry.get(spaceId);
    if (!space) throw new Error(`ego-browser: no task space ${spaceId} (finished, or never created)`);
    return space;
  }

  /**
   * Materializes label's real Page the first time anything actually acts on
   * it. Delegates the actual get-or-create to TaskSpaceRecord.resolveTarget,
   * which de-dupes concurrent callers racing to materialize the SAME
   * still-lazy label (see registry.ts) -- without that, two concurrent RPCs
   * against a page never touched yet (e.g. `Promise.all([p1.goto(url),
   * p1.evaluate(fn)])`) would each create their own real Page, silently
   * orphaning one.
   */
  async function resolvePage(spaceId: number, label: string): Promise<PwPage> {
    const space = await resolveSpace(spaceId);
    return space.resolveTarget(label, (context) => context.newPage());
  }

  return {
    async taskSpace(params) {
      // profileId is accepted (per the contract, "applies only when creating
      // a new space") but has no effect here -- browser profile selection is
      // a genuinely separate feature from profiles() (loud-fail, not Tier1),
      // not a silent partial implementation of it.
      const browser = await getBrowser();
      const space = await registry.resolve(params.nameOrId, () => browser.newContext());
      return { spaceId: space.spaceId, name: space.name };
    },

    async listTaskSpaces() {
      return registry.list().map((s) => ({ spaceId: s.spaceId, name: s.name }));
    },

    async "space.pages"(params) {
      const space = await resolveSpace(params.spaceId);
      // Eager, per the contract: materializes every currently-lazy label.
      // Goes through the same resolveTarget de-dupe as resolvePage, so this
      // racing against a concurrent page.* call on one of these same labels
      // (e.g. `Promise.all([t.pages(), p1.goto(url)])`) also converges on one
      // real Page, not two.
      await Promise.all(
        space
          .listLabels()
          .filter((state) => !state.target)
          .map((state) => space.resolveTarget(state.label, (context) => context.newPage())),
      );
      return space.listLabels().map((s) => ({ label: s.label }));
    },

    async "space.newPage"(params) {
      const space = await resolveSpace(params.spaceId);
      const label = space.nextAutoLabel();
      const page = await space.context.newPage();
      space.setTarget(label, page);
      return { label };
    },

    async "space.finish"(params) {
      const space = await resolveSpace(params.spaceId);
      const receipt = space.finish(params.keep);
      for (const label of receipt.closed) {
        const target = space.getTarget(label);
        if (target) await target.close().catch(() => {});
        space.removeLabel(label);
      }
      if (receipt.spaceClosed) {
        await space.context.close().catch(() => {});
        registry.remove(space.spaceId);
      }
      return { retained: receipt.retained, closed: receipt.closed };
    },

    async "page.goto"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      await page.goto(params.url, params.opts as never);
      return null;
    },

    async "page.reload"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      await page.reload(params.opts as never);
      return null;
    },

    async "page.url"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      return page.url();
    },

    async "page.title"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      return page.title();
    },

    async "page.info"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      const [url, title, viewport, scroll] = await Promise.all([
        page.url(),
        page.title(),
        page.viewportSize(),
        // Passed as a string (evaluated as browser JS, never compiled by our
        // own tsc) rather than a real function literal -- this file's own
        // tsconfig has no DOM lib, so a literal `window.scrollX` reference
        // here would not type-check even though it is perfectly valid inside
        // the page it actually runs in.
        page.evaluate("({ x: window.scrollX, y: window.scrollY })"),
      ]);
      return { url, title, viewport, scroll };
    },

    async "page.screenshot"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      const opts = params.opts ?? {};
      const buffer = await page.screenshot({
        fullPage: opts.fullPage,
        clip: opts.clip as never,
        scale: opts.scale as never,
        type: "png",
      });
      if (opts.path) {
        const { mkdir, writeFile } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        await mkdir(dirname(opts.path), { recursive: true });
        await writeFile(opts.path, buffer);
        return { path: opts.path };
      }
      return { base64: buffer.toString("base64") };
    },

    async "page.evaluate"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      const arg = toEvaluateArg(params.fn);
      return params.fn.isFunction ? page.evaluate(arg as never, params.arg) : page.evaluate(arg as unknown as string);
    },

    async "page.click"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      await page.click(params.selector, params.opts as never);
      return null;
    },

    async "page.dblclick"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      await page.dblclick(params.selector, params.opts as never);
      return null;
    },

    async "page.hover"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      await page.hover(params.selector, params.opts as never);
      return null;
    },

    async "page.fill"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      await page.fill(params.selector, params.value, params.opts as never);
      return null;
    },

    async "page.press"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      await page.press(params.selector, params.chord, params.opts as never);
      return null;
    },

    async "page.focus"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      await page.focus(params.selector, params.opts as never);
      return null;
    },

    async "page.selectOption"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      return page.selectOption(params.selector, params.valueOrValues as never, params.opts as never);
    },

    async "page.setInputFiles"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      await page.setInputFiles(params.selector, params.pathOrPaths);
      return null;
    },

    async "page.waitForSelector"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      await page.waitForSelector(params.selector, params.opts as never);
      return null;
    },

    async "page.waitForLoadState"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      await page.waitForLoadState(params.state as never, params.opts as never);
      return null;
    },

    async "page.waitForURL"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      await page.waitForURL(toUrlMatcher(params.urlMatcher) as never, params.opts as never);
      return null;
    },

    async "page.waitForFunction"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      const target = toEvaluateArg(params.fn);
      const handle = await page.waitForFunction(target as never, params.arg, params.opts as never);
      return handle.jsonValue();
    },

    async "page.waitForTimeout"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      await page.waitForTimeout(params.ms);
      return null;
    },

    async "page.close"(params) {
      const space = await resolveSpace(params.spaceId);
      const target = space.getTarget(params.label);
      if (target) await target.close();
      space.removeLabel(params.label);
      return null;
    },

    async "page.snapshot"(params) {
      const page = await resolvePage(params.spaceId, params.label);
      return pageSnapshot(page, params.opts);
    },
  };
}

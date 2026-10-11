/**
 * Wire-format types shared by api.ts (marshals) and daemon.ts
 * (unmarshals/reconstructs). Type-only module, no runtime code, no
 * Playwright import -- safe for api.ts (which must not pull in
 * playwright-core or execute daemon.ts's top-level browser-launch code)
 * to depend on.
 */

/** A function argument crosses JSON-RPC as its own source text; a plain
 * expression string crosses as-is. `isFunction` tells the daemon which. */
export interface FnOrStringWire {
  code: string;
  isFunction: boolean;
}

export type UrlMatcherWire =
  | { kind: "string"; value: string }
  | { kind: "regexp"; source: string; flags: string }
  | { kind: "function"; code: string };

export interface SnapshotOpts {
  scope?: "full_page" | "only_within_viewport" | "subtree";
  root?: string;
  includeActionMarks?: boolean;
  includeStableLocator?: boolean;
}

/** The one place an RPC method's wire name, params shape, and result shape
 * are declared. api.ts's forwarder types every page.* call from this map;
 * the daemon's dispatcher types each handler from the same map -- a name
 * or param drift on either side is a type error here, not a silent wire
 * bug. The five remaining non-page client calls (TaskSpace's pages/
 * newPage/finish and buildGlobals' taskSpace/listTaskSpaces) still
 * hand-write their name+result casts, so they are pinned by the
 * characterization tests, not this map's types. */
export interface PageEnvelope {
  spaceId: number;
  label: string;
}

/** Params for every page.* method: the envelope plus the method's own args. */
export type PageParams<K extends PageRpcMethod> = PageEnvelope & RpcMethods[K]["params"];

export type PageRpcMethod = keyof RpcMethods & `page.${string}`;

export interface RpcMethods {
  taskSpace: { params: { nameOrId: string | number; profileId?: string }; result: { spaceId: number; name: string } };
  listTaskSpaces: { params: {}; result: Array<{ spaceId: number; name: string }> };
  "space.pages": { params: { spaceId: number }; result: Array<{ label: string }> };
  "space.newPage": { params: { spaceId: number }; result: { label: string } };
  "space.finish": { params: { spaceId: number; keep: "all" | string[] }; result: { retained: string[]; closed: string[] } };
  "page.goto": { params: { url: string; opts?: Record<string, unknown> }; result: null };
  "page.reload": { params: { opts?: Record<string, unknown> }; result: null };
  "page.url": { params: {}; result: string };
  "page.title": { params: {}; result: string };
  "page.info": { params: {}; result: unknown };
  "page.screenshot": { params: { opts?: { path?: string; fullPage?: boolean; clip?: unknown; scale?: unknown; raw?: boolean } }; result: unknown };
  "page.evaluate": { params: { fn: FnOrStringWire; arg?: unknown }; result: unknown };
  "page.click": { params: { selector: string; opts?: Record<string, unknown> }; result: null };
  "page.dblclick": { params: { selector: string; opts?: Record<string, unknown> }; result: null };
  "page.hover": { params: { selector: string; opts?: Record<string, unknown> }; result: null };
  "page.fill": { params: { selector: string; value: string; opts?: Record<string, unknown> }; result: null };
  "page.press": { params: { selector: string; chord: string; opts?: Record<string, unknown> }; result: null };
  "page.focus": { params: { selector: string; opts?: Record<string, unknown> }; result: null };
  "page.selectOption": { params: { selector: string; valueOrValues: unknown; opts?: Record<string, unknown> }; result: unknown };
  "page.setInputFiles": { params: { selector: string; pathOrPaths: string | string[] }; result: null };
  "page.waitForSelector": { params: { selector: string; opts?: Record<string, unknown> }; result: null };
  "page.waitForLoadState": { params: { state?: string; opts?: Record<string, unknown> }; result: null };
  "page.waitForURL": { params: { urlMatcher: UrlMatcherWire; opts?: Record<string, unknown> }; result: null };
  "page.waitForFunction": { params: { fn: FnOrStringWire; arg?: unknown; opts?: Record<string, unknown> }; result: unknown };
  "page.waitForTimeout": { params: { ms: number }; result: null };
  "page.close": { params: {}; result: null };
  "page.snapshot": { params: { opts?: SnapshotOpts }; result: unknown };
}

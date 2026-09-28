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

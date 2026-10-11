/**
 * Builds ego lite's documented Tier-1 global surface
 * (taskSpace/listTaskSpaces/TaskSpace/Page) as thin RPC-calling proxies,
 * plus the loud-fail stubs for the methods this shim deliberately does not
 * implement. Every function/method here is JSON-serializable-args-only --
 * no real Playwright object ever crosses back into the user's script.
 */
import { call as rpcCall } from "./client";
import type { FnOrStringWire, SnapshotOpts, UrlMatcherWire } from "./wire";

export type RpcCall = (method: string, params?: unknown) => Promise<unknown>;

function marshalFnOrString(fnOrString: ((...args: unknown[]) => unknown) | string): FnOrStringWire {
  if (typeof fnOrString === "function") return { code: fnOrString.toString(), isFunction: true };
  return { code: fnOrString, isFunction: false };
}

function marshalUrlMatcher(matcher: string | RegExp | ((url: URL) => boolean)): UrlMatcherWire {
  if (matcher instanceof RegExp) return { kind: "regexp", source: matcher.source, flags: matcher.flags };
  if (typeof matcher === "function") return { kind: "function", code: matcher.toString() };
  return { kind: "string", value: matcher };
}

/** Throws synchronously, instantly, naming itself -- never a silent no-op.
 * These are real user-session concepts (claiming a space a human owns,
 * handing control back and forth) with no meaning in a headless container;
 * see docs/plans/2026-09-22-ego-browser-shim.md. */
function unimplemented(name: string): never {
  throw new Error(
    `ego-browser: ${name} is not implemented in this shim -- it is a user-session concept with no meaning in a ` +
      `headless container. See the ego-browser skill for what IS supported.`,
  );
}

export class Page {
  readonly label: string;
  private readonly spaceId: number;
  private readonly call: RpcCall;

  constructor(spaceId: number, label: string, call: RpcCall) {
    this.spaceId = spaceId;
    this.label = label;
    this.call = call;
  }

  async goto(url: string, opts?: Record<string, unknown>): Promise<void> {
    await this.call("page.goto", { spaceId: this.spaceId, label: this.label, url, opts });
  }

  async reload(opts?: Record<string, unknown>): Promise<void> {
    await this.call("page.reload", { spaceId: this.spaceId, label: this.label, opts });
  }

  async url(): Promise<string> {
    return (await this.call("page.url", { spaceId: this.spaceId, label: this.label })) as string;
  }

  async title(): Promise<string> {
    return (await this.call("page.title", { spaceId: this.spaceId, label: this.label })) as string;
  }

  async info(): Promise<unknown> {
    return this.call("page.info", { spaceId: this.spaceId, label: this.label });
  }

  async screenshot(opts?: { path?: string; fullPage?: boolean; clip?: unknown; scale?: unknown; raw?: boolean }): Promise<unknown> {
    return this.call("page.screenshot", { spaceId: this.spaceId, label: this.label, opts });
  }

  async evaluate(fnOrString: ((...args: unknown[]) => unknown) | string, arg?: unknown): Promise<unknown> {
    return this.call("page.evaluate", { spaceId: this.spaceId, label: this.label, fn: marshalFnOrString(fnOrString), arg });
  }

  async click(selector: string, opts?: Record<string, unknown>): Promise<void> {
    await this.call("page.click", { spaceId: this.spaceId, label: this.label, selector, opts });
  }

  async dblclick(selector: string, opts?: Record<string, unknown>): Promise<void> {
    await this.call("page.dblclick", { spaceId: this.spaceId, label: this.label, selector, opts });
  }

  async hover(selector: string, opts?: Record<string, unknown>): Promise<void> {
    await this.call("page.hover", { spaceId: this.spaceId, label: this.label, selector, opts });
  }

  async fill(selector: string, value: string, opts?: Record<string, unknown>): Promise<void> {
    await this.call("page.fill", { spaceId: this.spaceId, label: this.label, selector, value, opts });
  }

  async press(selector: string, chord: string, opts?: Record<string, unknown>): Promise<void> {
    await this.call("page.press", { spaceId: this.spaceId, label: this.label, selector, chord, opts });
  }

  async focus(selector: string, opts?: Record<string, unknown>): Promise<void> {
    await this.call("page.focus", { spaceId: this.spaceId, label: this.label, selector, opts });
  }

  async selectOption(selector: string, valueOrValues: unknown, opts?: Record<string, unknown>): Promise<unknown> {
    return this.call("page.selectOption", { spaceId: this.spaceId, label: this.label, selector, valueOrValues, opts });
  }

  async setInputFiles(selector: string, pathOrPaths: string | string[]): Promise<void> {
    await this.call("page.setInputFiles", { spaceId: this.spaceId, label: this.label, selector, pathOrPaths });
  }

  async waitForSelector(selector: string, opts?: Record<string, unknown>): Promise<void> {
    await this.call("page.waitForSelector", { spaceId: this.spaceId, label: this.label, selector, opts });
  }

  async waitForLoadState(state?: string, opts?: Record<string, unknown>): Promise<void> {
    await this.call("page.waitForLoadState", { spaceId: this.spaceId, label: this.label, state, opts });
  }

  async waitForURL(urlMatcher: string | RegExp | ((url: URL) => boolean), opts?: Record<string, unknown>): Promise<void> {
    await this.call("page.waitForURL", { spaceId: this.spaceId, label: this.label, urlMatcher: marshalUrlMatcher(urlMatcher), opts });
  }

  async waitForFunction(
    fnOrString: ((...args: unknown[]) => unknown) | string,
    arg?: unknown,
    opts?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.call("page.waitForFunction", {
      spaceId: this.spaceId,
      label: this.label,
      fn: marshalFnOrString(fnOrString),
      arg,
      opts,
    });
  }

  async waitForTimeout(ms: number): Promise<void> {
    await this.call("page.waitForTimeout", { spaceId: this.spaceId, label: this.label, ms });
  }

  async close(): Promise<void> {
    await this.call("page.close", { spaceId: this.spaceId, label: this.label });
  }

  async snapshot(opts?: SnapshotOpts): Promise<unknown> {
    return this.call("page.snapshot", { spaceId: this.spaceId, label: this.label, opts });
  }

  async setViewportSize(viewportSize: { width: number; height: number }): Promise<void> {
    await this.call("page.setViewportSize", { spaceId: this.spaceId, label: this.label, viewportSize });
  }

  async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.call("page.cdp", { spaceId: this.spaceId, label: this.label, method, params });
  }
}

export class TaskSpace {
  readonly spaceId: number;
  readonly name: string;
  private readonly call: RpcCall;

  constructor(spaceId: number, name: string, call: RpcCall) {
    this.spaceId = spaceId;
    this.name = name;
    this.call = call;
  }

  /** Lazy handle: no RPC call here at all. The underlying Page materializes
   * daemon-side on the first real action taken against it. */
  page(label: string): Page {
    return new Page(this.spaceId, label, this.call);
  }

  async pages(): Promise<Page[]> {
    const result = (await this.call("space.pages", { spaceId: this.spaceId })) as Array<{ label: string }>;
    return result.map((p) => new Page(this.spaceId, p.label, this.call));
  }

  async newPage(): Promise<Page> {
    const result = (await this.call("space.newPage", { spaceId: this.spaceId })) as { label: string };
    return new Page(this.spaceId, result.label, this.call);
  }

  async finish(opts: { keep: "all" | string[] }): Promise<{ retained: string[]; closed: string[] }> {
    return this.call("space.finish", { spaceId: this.spaceId, keep: opts.keep }) as Promise<{
      retained: string[];
      closed: string[];
    }>;
  }

  // --- Loud-fail stubs (must not be silent no-ops) ---
  userPage(): never {
    return unimplemented("task.userPage()");
  }
  handOff(): never {
    return unimplemented("task.handOff()");
  }
  waitForControl(): never {
    return unimplemented("task.waitForControl()");
  }
  adopt(): never {
    return unimplemented("task.adopt()");
  }
  release(): never {
    return unimplemented("task.release()");
  }
}

export interface EgoBrowserGlobals {
  taskSpace: (nameOrId: string | number, opts?: { profileId?: string }) => Promise<TaskSpace>;
  listTaskSpaces: () => Promise<Array<{ spaceId: number; name: string }>>;
  profiles: () => never;
  claimTaskSpace: () => never;
  takeOverTaskSpace: () => never;
}

/** Builds the global surface. Separated from a mutating installGlobals() so
 * tests can exercise the object directly without touching globalThis. */
export function buildGlobals(call: RpcCall = rpcCall): EgoBrowserGlobals {
  return {
    async taskSpace(nameOrId, opts) {
      const result = (await call("taskSpace", { nameOrId, profileId: opts?.profileId })) as {
        spaceId: number;
        name: string;
      };
      return new TaskSpace(result.spaceId, result.name, call);
    },
    async listTaskSpaces() {
      return call("listTaskSpaces") as Promise<Array<{ spaceId: number; name: string }>>;
    },
    profiles(): never {
      return unimplemented("profiles()");
    },
    claimTaskSpace(): never {
      return unimplemented("claimTaskSpace()");
    },
    takeOverTaskSpace(): never {
      return unimplemented("takeOverTaskSpace()");
    },
  };
}

/** Installs the API as globals on `target` (defaults to globalThis) --
 * this is what makes a user script's bare `await taskSpace(7)` work,
 * matching ego lite's own "API injected as globals" contract. */
export function installGlobals(target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
  const g = buildGlobals();
  target.taskSpace = g.taskSpace;
  target.listTaskSpaces = g.listTaskSpaces;
  target.profiles = g.profiles;
  target.claimTaskSpace = g.claimTaskSpace;
  target.takeOverTaskSpace = g.takeOverTaskSpace;
}

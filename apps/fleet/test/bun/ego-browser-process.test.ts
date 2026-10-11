import { describe, expect, test } from "bun:test";
import { createBrowserProcess, type BrowserProcessDeps } from "../../container/ego-browser/process-reap";

// Board #326 (F11, deep-modules sweep 2,
// docs/maintainability/2026-10-10-deep-modules-sweep-2.md): daemon.ts's
// launch -> record pid -> bounded close -> SIGKILL sequence was only
// verifiable by grepping daemon.log in live container tests. These
// characterize its new home, BrowserProcess -- fake launcher/kill/log, no
// real browser, no /proc.

/** Minimal structural Browser: close() is the only member the sequence uses. */
interface FakeBrowser {
  closeCalls: number;
  close(): Promise<void>;
}

function fakeBrowser(): FakeBrowser {
  return {
    closeCalls: 0,
    close() {
      this.closeCalls += 1;
      return Promise.resolve();
    },
  };
}

interface Harness {
  state: {
    launchCalls: number;
    logLines: string[];
    killed: { pid: number; signal: string }[];
    findPidCalls: number;
    findPidParent: number | undefined;
    findPidName: string | undefined;
    pidToReport: number | undefined;
  };
  deps: BrowserProcessDeps;
}

function harness(launchImpl?: () => Promise<FakeBrowser>): Harness {
  const state: Harness["state"] = {
    launchCalls: 0,
    logLines: [],
    killed: [],
    findPidCalls: 0,
    findPidParent: undefined,
    findPidName: undefined,
    pidToReport: 4242,
  };
  const deps: BrowserProcessDeps = {
    launch: () => {
      state.launchCalls += 1;
      return launchImpl ? launchImpl() : Promise.resolve(fakeBrowser());
    },
    log: (line) => {
      state.logLines.push(line);
    },
    findPid: (parentPid, opts) => {
      state.findPidCalls += 1;
      state.findPidParent = parentPid;
      state.findPidName = opts.chromiumBinaryName;
      return state.pidToReport;
    },
    killFn: (pid, signal) => {
      state.killed.push({ pid, signal });
    },
  };
  return { state, deps };
}

describe("BrowserProcess.get()", () => {
  test("a rejected launch resets the cache so the next get() launches fresh", async () => {
    let attempts = 0;
    const { state, deps } = harness(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("ENOENT: no such chromium"))
        : Promise.resolve(fakeBrowser());
    });
    const bp = createBrowserProcess("chromium", deps);

    await expect(bp.get()).rejects.toThrow("ENOENT: no such chromium");
    await bp.get();

    expect(state.launchCalls).toBe(2);
    // One log line per REAL attempt -- the only externally-observable
    // proof a retry happened (error text repeats identically otherwise).
    expect(state.logLines.filter((l) => l === "getBrowser: attempting chromium launch")).toHaveLength(2);
  });

  test("concurrent get() calls share one in-flight launch", async () => {
    let resolveLaunch!: (b: FakeBrowser) => void;
    const { state, deps } = harness(() => new Promise<FakeBrowser>((res) => { resolveLaunch = res; }));
    const bp = createBrowserProcess("chromium", deps);

    const p1 = bp.get();
    const p2 = bp.get();
    resolveLaunch(fakeBrowser());
    const [b1, b2] = await Promise.all([p1, p2]);

    expect(state.launchCalls).toBe(1);
    expect(b1).toBe(b2);
  });

  test("a successful launch discovers and logs the browser pid", async () => {
    const { state, deps } = harness();
    const bp = createBrowserProcess("chromium", deps);

    await bp.get();

    expect(state.findPidCalls).toBe(1);
    expect(state.findPidParent).toBe(process.pid);
    expect(state.findPidName).toBe("chromium");
    expect(state.logLines).toContain("browser launched, pid 4242");
  });
});

describe("BrowserProcess.close()", () => {
  test("a hung browser.close() is bounded by the budget, then the recorded pid gets SIGKILL", async () => {
    const hungBrowser: FakeBrowser = {
      closeCalls: 0,
      close: () => new Promise<void>(() => {}),
    };
    const { state, deps } = harness(() => Promise.resolve(hungBrowser));
    let fireTimeout: (() => void) | undefined;
    deps.setTimeoutFn = ((fn: () => void) => {
      fireTimeout = fn;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const bp = createBrowserProcess("chromium", deps);
    await bp.get();

    const closing = bp.close(5000);
    let settled = false;
    void closing.then(() => { settled = true; });
    await Promise.resolve();
    // Timer armed but not fired -- close() must still be pending.
    expect(settled).toBe(false);
    expect(fireTimeout).toBeDefined();

    fireTimeout!();
    await closing;
    expect(hungBrowser.closeCalls).toBe(1);
    expect(state.killed).toEqual([{ pid: 4242, signal: "SIGKILL" }]);
  });

  test("close() without a get() neither launches nor kills", async () => {
    const { state, deps } = harness();
    const bp = createBrowserProcess("chromium", deps);

    await bp.close(5000);

    expect(state.launchCalls).toBe(0);
    expect(state.killed).toEqual([]);
  });
});

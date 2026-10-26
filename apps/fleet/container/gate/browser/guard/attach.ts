// container/gate/browser/guard/attach.ts
//
// Console auto-attach wiring: one CDP session rooted at a page, listening to
// its own console/exception events AND every target it auto-attaches
// (dedicated workers, service workers, their sub-frames) through the
// non-flatten Target.setAutoAttach + sendMessageToTarget /
// receivedMessageFromTarget path. Network is NOT handled here: the fixture
// feeds badRequests/canceledRequests from context-level response/requestfailed
// events, which cover popups from their first page-load (see fixture.ts).
//
// Measured (playwright-core 1.63.0 / Chromium 1243, do not re-derive):
//   - flatten:true at a page root captures dedicated-worker console but NOT
//     worker network; flatten:false captures dedicated-worker console AND
//     service-worker console via sendMessageToTarget/receivedMessageFromTarget.
//   - window.open popups are never auto-attached; the fixture wires each via
//     context.on('page').
// Pure — no playwright-core import.

import {
  Collector,
  normalizeConsoleAPICalled,
  normalizeExceptionThrown,
  normalizeLogEntry,
} from "./capture";

export interface CdpSessionLike {
  send(method: string, params?: unknown): Promise<unknown>;
  on(event: string, handler: (params: any) => void): void;
  off(event: string, handler: (params: any) => void): void;
}

function feedConsole(collector: Collector, method: string, params: any): void {
  if (method === "Runtime.consoleAPICalled") {
    const n = normalizeConsoleAPICalled(params);
    if (n) collector.consoleEvent(n.type, n.text, n.source, n.at, n.rawKey);
  } else if (method === "Log.entryAdded") {
    const n = normalizeLogEntry(params);
    if (n) collector.consoleEvent(n.type, n.text, n.source, n.at, n.rawKey);
  } else if (method === "Runtime.exceptionThrown") {
    const n = normalizeExceptionThrown(params);
    if (n) collector.exception(n.text, n.url, n.rawKey);
  }
}

export interface AutoAttach {
  /** Sends the console enables + Target.setAutoAttach. */
  enable(): Promise<void>;
  dispose(): void;
}

/** Wires one root session (its own console + every auto-attached target's). */
export function wireAutoAttach(collector: Collector, root: CdpSessionLike): AutoAttach {
  let idCounter = 0;

  const ownConsole = (params: any) => feedConsole(collector, "Runtime.consoleAPICalled", params);
  const ownLog = (params: any) => feedConsole(collector, "Log.entryAdded", params);
  const ownException = (params: any) => feedConsole(collector, "Runtime.exceptionThrown", params);

  const onAttached = async (e: any): Promise<void> => {
    const sessionId = e.sessionId;
    if (sessionId === undefined) return;
    for (const m of ["Runtime.enable", "Log.enable"]) {
      try {
        await root.send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id: ++idCounter, method: m, params: {} }),
        });
      } catch {
        // A target that died between attach and enable has nothing to capture.
      }
    }
  };

  const onReceived = (e: any): void => {
    let msg: any;
    try { msg = JSON.parse(e.message); } catch { return; }
    if (msg === null || typeof msg !== "object" || typeof msg.method !== "string") return;
    feedConsole(collector, msg.method, msg.params ?? {});
  };

  root.on("Runtime.consoleAPICalled", ownConsole);
  root.on("Log.entryAdded", ownLog);
  root.on("Runtime.exceptionThrown", ownException);
  root.on("Target.attachedToTarget", onAttached);
  root.on("Target.receivedMessageFromTarget", onReceived);

  const enable = async (): Promise<void> => {
    await root.send("Runtime.enable");
    await root.send("Log.enable");
    // Non-flatten: child console arrives via receivedMessageFromTarget.
    await root.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
  };

  const dispose = (): void => {
    root.off("Runtime.consoleAPICalled", ownConsole);
    root.off("Log.entryAdded", ownLog);
    root.off("Runtime.exceptionThrown", ownException);
    root.off("Target.attachedToTarget", onAttached);
    root.off("Target.receivedMessageFromTarget", onReceived);
  };

  return { enable, dispose };
}
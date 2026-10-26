// container/gate/browser/guard/attach.ts
//
// Auto-attach wiring: one CDP session rooted at a page, listening to its own
// console/network events AND every target it auto-attaches (dedicated
// workers, service workers, their sub-frames) through the non-flatten
// Target.setAutoAttach + sendMessageToTarget/receivedMessageFromTarget path.
//
// Measured (playwright-core 1.63.0 / Chromium 1243, do not re-derive):
//   - flatten:true at a page root captures dedicated-worker console but NOT
//     worker network, and popups are not auto-attached at all.
//   - flatten:false at a page root captures dedicated-worker console AND
//     network, and service-worker console, via
//     Target.sendMessageToTarget/receivedMessageFromTarget.
//   - window.open popups are never auto-attached; they are attached at the
//     fixture level via context.on('page') (see fixture.ts).
// Pure — no playwright-core import.

import {
  Collector,
  normalizeConsoleAPICalled,
  normalizeExceptionThrown,
  normalizeLoadingFailed,
  normalizeLogEntry,
  normalizeRequestWillBeSent,
  normalizeResponseReceived,
  type BadRequestEntry,
  type CanceledRequestEntry,
} from "./capture";

export interface CdpSessionLike {
  send(method: string, params?: unknown): Promise<unknown>;
  on(event: string, handler: (params: any) => void): void;
  off(event: string, handler: (params: any) => void): void;
}

interface RequestCtx { method: string; url: string; type: string; }
const noRequest = { method: "", url: "", type: "" };

/** Feeds one console/exception/network event payload into the collector. */
function feed(collector: Collector, keyPrefix: string, method: string, params: any, requests: Map<string, RequestCtx>): void {
  switch (method) {
    case "Runtime.consoleAPICalled": {
      const n = normalizeConsoleAPICalled(params);
      if (n) collector.consoleEvent(n.type, n.text, n.source, n.at, n.rawKey);
      break;
    }
    case "Log.entryAdded": {
      const n = normalizeLogEntry(params);
      if (n) collector.consoleEvent(n.type, n.text, n.source, n.at, n.rawKey);
      break;
    }
    case "Runtime.exceptionThrown": {
      const n = normalizeExceptionThrown(params);
      if (n) collector.exception(n.text, n.url, n.rawKey);
      break;
    }
    case "Network.requestWillBeSent": {
      const n = normalizeRequestWillBeSent(params);
      if (n) requests.set(`${keyPrefix}${n.requestId}`, n);
      break;
    }
    case "Network.responseReceived": {
      const r = requests.get(`${keyPrefix}${params.requestId}`) ?? noRequest;
      const n = normalizeResponseReceived(params, r.method, r.url, r.type);
      if (n) collector.badRequest(n, `${keyPrefix}${params.requestId}`);
      break;
    }
    case "Network.loadingFailed": {
      const r = requests.get(`${keyPrefix}${params.requestId}`) ?? noRequest;
      const n: BadRequestEntry | CanceledRequestEntry = normalizeLoadingFailed(params, r.method, r.url, r.type);
      if ("canceled" in n) collector.canceledRequest(n);
      else collector.badRequest(n, `${keyPrefix}${params.requestId}`);
      break;
    }
  }
}

export interface AutoAttach {
  /** Sends the three enables + Target.setAutoAttach. */
  enable(): Promise<void>;
  dispose(): void;
}

/** Wires one root session (its own events + every auto-attached target). */
export function wireAutoAttach(collector: Collector, root: CdpSessionLike): AutoAttach {
  const requests = new Map<string, RequestCtx>();
  let idCounter = 0;

  const onOwn = (method: string) => (params: any) => feed(collector, "root:", method, params, requests);
  const ownConsole = onOwn("Runtime.consoleAPICalled");
  const ownLog = onOwn("Log.entryAdded");
  const ownException = onOwn("Runtime.exceptionThrown");
  const ownRequest = onOwn("Network.requestWillBeSent");
  const ownResponse = onOwn("Network.responseReceived");
  const ownLoadingFailed = onOwn("Network.loadingFailed");

  const onAttached = async (e: any): Promise<void> => {
    const sessionId = e.sessionId;
    if (sessionId === undefined) return;
    for (const m of ["Runtime.enable", "Network.enable", "Log.enable"]) {
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
    feed(collector, `${e.sessionId}:`, msg.method, msg.params ?? {}, requests);
  };

  root.on("Runtime.consoleAPICalled", ownConsole);
  root.on("Log.entryAdded", ownLog);
  root.on("Runtime.exceptionThrown", ownException);
  root.on("Network.requestWillBeSent", ownRequest);
  root.on("Network.responseReceived", ownResponse);
  root.on("Network.loadingFailed", ownLoadingFailed);
  root.on("Target.attachedToTarget", onAttached);
  root.on("Target.receivedMessageFromTarget", onReceived);

  const enable = async (): Promise<void> => {
    await root.send("Runtime.enable");
    await root.send("Log.enable");
    await root.send("Network.enable");
    // Non-flatten: child events arrive via receivedMessageFromTarget.
    await root.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
  };

  const dispose = (): void => {
    root.off("Runtime.consoleAPICalled", ownConsole);
    root.off("Log.entryAdded", ownLog);
    root.off("Runtime.exceptionThrown", ownException);
    root.off("Network.requestWillBeSent", ownRequest);
    root.off("Network.responseReceived", ownResponse);
    root.off("Network.loadingFailed", ownLoadingFailed);
    root.off("Target.attachedToTarget", onAttached);
    root.off("Target.receivedMessageFromTarget", onReceived);
  };

  return { enable, dispose };
}
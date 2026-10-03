/**
 * Issue #96: which side a failed Worker->DO call failed on.
 *
 * Every repair verb (provision, restart, recycle, destroy, check, wake) is a
 * method on the studio's one Durable Object. Measured 2026-09-24: that DO
 * received no events 11:17:20-11:33:21Z (Cloudflare delivery, not our code;
 * container and lead fine). Every verb failed identically, recycle printed a
 * bare `failed`, and the BETA coordinator retried 5 times in 10 minutes.
 *
 * Workers RPC sets `remote: true` on an error the DO's OWN code threw; an
 * error without it never came back from the DO's code at all. It may carry
 * the runtime's own `retryable` / `overloaded` / `durableObjectReset` flags,
 * passed through as-is.
 *
 * `durableObjectReset` is its own case (review M1): the DO WAS reached and
 * reset mid-call ("Application called abort() to reset Durable Object.").
 * The containers library resets the DO when its container link drops; a
 * deploy resets it too. A fresh instance answers the next call.
 */
import { redactSecrets } from "./redact";
import { LAUNCH_REFUSED_PREFIX } from "./accounts";

/** Issue #217 investigation: do.ts's `StartAndWaitForPorts`/`start` overrides
 *  throw `StartRefusedError` (do.ts, issue #123's start gate) from INSIDE the
 *  StudioDO, and `studio.destroy-race.test.ts`'s own T6 coverage confirms it
 *  can reach `provision()`/`restartStudio()` uncaught (a destroy racing the
 *  op's own first container-start attempt) — the identical leak #217 found
 *  for `LaunchRefusedError`. Same fix, same reason it lives here rather than
 *  do.ts (which pulls in "@cloudflare/sandbox"): a prefix is the only thing
 *  that survives the Worker->DO RPC boundary (see this file's own header),
 *  so routes.ts can recognise the refusal by its message alone. */
export const START_REFUSED_PREFIX = "start refused: ";

export function threwInsideDurableObject(err: unknown): boolean {
  return (err as { remote?: unknown } | null)?.remote === true;
}

/** " (retryable=true, overloaded=false)" — only the flags the runtime set. */
export function runtimeFlags(err: unknown): string {
  const e = (err ?? {}) as { retryable?: unknown; overloaded?: unknown; durableObjectReset?: unknown };
  const flags = (["durableObjectReset", "retryable", "overloaded"] as const)
    .filter((k) => typeof e[k] === "boolean")
    .map((k) => `${k}=${e[k]}`);
  return flags.length ? ` (${flags.join(", ")})` : "";
}

export function errorMessage(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

/**
 * Issue #217: `do.ts`'s `LaunchRefusedError` (a repo mapped to an unlaunchable
 * account) and `StartRefusedError` (issue #123's start gate, confirmed by
 * `studio.destroy-race.test.ts`'s own T6 coverage to also reach
 * `provision()`/`restartStudio()` uncaught) are both known, named refusals —
 * not a Worker<->DO transport failure. Recognised here by MESSAGE PREFIX, the
 * one thing that survives the RPC boundary (Workers RPC keeps an error's
 * message, never its subclass — see each prefix's own doc comment), same
 * convention `RECYCLE_REFUSED_PREFIX` already established for recycle's own
 * refusal. `null` when `err` is neither — every caller's existing
 * `threwInsideDurableObject`/`durableObjectUnreachable` fallback (or, for
 * spawn.ts's runSpawn/runResume, a bare rethrow after their own cleanup) is
 * untouched.
 *
 * Issue #217 review round 2: lives here, not routes.ts, so `spawn.ts`'s
 * runSpawn/runResume — the SAME `stub.provision(cfg)` RPC call routes.ts's
 * own provision/restart already got this fix for, just reached through
 * /fleet/spawn and /studio/spawn instead — can import the ONE shared
 * implementation rather than routes.ts's copy, or a second, independently
 * drifting one of its own. `rpc-failure.ts` is the right home: it already
 * carries `START_REFUSED_PREFIX` and the RPC-boundary doc comment above, and
 * `accounts.ts` (where `LAUNCH_REFUSED_PREFIX` lives) is a zero-import leaf
 * module, so importing it here introduces no cycle (confirmed: `accounts.ts`
 * itself imports nothing) and no `"@cloudflare/sandbox"` dependency — the
 * same constraint `routes.ts`'s own header states and `spawn.ts`'s header
 * states even more strongly ("nothing in this file imports `Env`, touches a
 * DurableObjectNamespace, or makes a network call of its own").
 */
export function launchOrStartRefusalResponse(err: unknown): Response | null {
  const message = errorMessage(err);
  for (const prefix of [LAUNCH_REFUSED_PREFIX, START_REFUSED_PREFIX]) {
    if (message.startsWith(prefix)) {
      return Response.json({ error: message.slice(prefix.length) }, { status: 409 });
    }
  }
  return null;
}

/** The message, its own trailing "." dropped so flags + "." never read "..". */
function detail(err: unknown): string {
  return errorMessage(err).replace(/\.+$/, "") + runtimeFlags(err);
}

/** 503: the side is named, and so is the fallback that fits the runtime's flags. */
export function durableObjectUnreachable(verb: string, err: unknown): Response {
  const e = (err ?? {}) as { retryable?: unknown; durableObjectReset?: unknown };
  let text: string;
  if (e.durableObjectReset === true) {
    text = `${verb} failed: the Durable Object reset mid-call — it WAS reached (the containers library ` +
      `resets it when its container link drops; a deploy resets it too): ${detail(err)}. ` +
      "One retry reaches a fresh instance. The same failure again: wait. Watch CHECKED in fleet ls.";
  } else if (e.retryable === true) {
    text = `${verb} failed: the Durable Object did not answer: ${detail(err)}. ` +
      "The runtime marks this retryable, so one retry may land. The same failure again: every repair " +
      "verb goes through this DO, so wait — on 2026-09-24 this self-healed in ~20 min. Watch CHECKED in fleet ls.";
  } else {
    text = `${verb} failed: the Durable Object did not answer: ${detail(err)}. ` +
      "Every repair verb goes through it, so retrying cannot help. " +
      "On 2026-09-24 this self-healed in ~20 min. Watch CHECKED in fleet ls; wait.";
  }
  return new Response(text, { status: 503 });
}

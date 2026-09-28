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

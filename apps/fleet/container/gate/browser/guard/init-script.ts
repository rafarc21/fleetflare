// container/gate/browser/guard/init-script.ts
//
// Init-script hook + secret redaction. The hook reads one env var holding raw
// JS to evaluate on every new document (Page.addScriptToEvaluateOnNewDocument
// at CDP level, browserContext.addInitScript at fixture level). The motivating
// use is an App Check debug token: the token is injected into the page, but its
// VALUE must never appear in any log or evidence file, so every write the guard
// makes is redacted against the raw env value before it lands on disk.

export const INIT_SCRIPT_ENV = "BROWSER_GUARD_INIT_SCRIPT";

export interface InitScriptResult {
  /** The raw JS source to evaluate on new documents. */
  source: string;
}

/** Reads the init-script env var. Blank/absent -> null (no injection). */
export function initScriptFromEnv(
  env: Record<string, string | undefined> = process.env as unknown as Record<string, string | undefined>,
): InitScriptResult | null {
  const source = env[INIT_SCRIPT_ENV];
  if (source === undefined || source.trim() === "") return null;
  return { source };
}

/** Injects the source on every new document via the CDP session. */
export function applyInitScript(
  session: { send(method: string, params?: unknown): Promise<unknown> },
  source: string,
): Promise<unknown> {
  return session.send("Page.addScriptToEvaluateOnNewDocument", { source });
}

/** Replaces every occurrence of each secret with "<redacted>". The init-script
 *  source itself is the secret: redacting the whole source hides any token
 *  embedded in it without the harness needing to know where the token is. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === "") continue;
    out = out.split(secret).join("<redacted>");
  }
  return out;
}

/** The secret list for a given init script: the raw source value, so nothing
 *  the guard writes can echo it back. */
export function secretsFromInitScript(init: InitScriptResult | null): string[] {
  return init === null ? [] : [init.source];
}
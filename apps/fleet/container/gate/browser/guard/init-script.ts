// container/gate/browser/guard/init-script.ts
//
// Init-script hook + secret redaction. The hook reads one env var holding raw
// JS to evaluate on every new document (Page.addScriptToEvaluateOnNewDocument
// at CDP level, browserContext.addInitScript at fixture level). The motivating
// use is an App Check debug token: the token is injected into the page, but its
// VALUE must never appear in any log or evidence file. The secret list is the
// set of string literals inside the init script — the token values themselves,
// not the whole script — and every guard write is redacted against them.

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

/** The string literals inside an init script — the token values to redact, not
 *  the whole script. A double- or single-quoted run, escapes kept intact. */
export function extractSecretValues(source: string): string[] {
  const values: string[] = [];
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const v = m[1] ?? m[2] ?? "";
    if (v !== "") values.push(v);
  }
  return [...new Set(values)];
}

/** The secret list for an init script: its string-literal values. */
export function secretsFromInitScript(init: InitScriptResult | null): string[] {
  return init === null ? [] : extractSecretValues(init.source);
}

/** Replaces every occurrence of each secret with "<redacted>". */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === "") continue;
    out = out.split(secret).join("<redacted>");
  }
  return out;
}
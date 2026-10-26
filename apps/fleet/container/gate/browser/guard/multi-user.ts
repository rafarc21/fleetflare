// container/gate/browser/guard/multi-user.ts
//
// Multi-user spec support. Browser legs that exercise two-account flows read
// the auth-forcing env var to know a forced account exists, and the MailHog
// env var to reach the mail catcher. Pure value selection only — no network,
// no I/O — so the auth decision is unit-testable without a browser.

export const AUTH_FORCE_ENV = "BROWSER_GUARD_AUTH_FORCE";
export const MAILHOG_ENV = "BROWSER_GUARD_MAILHOG";

export interface MultiUserEnv {
  /** Value of the auth-forcing env var; "" when unset. */
  authForce: string;
  /** Value of the MailHog env var; "" when unset. */
  mailhog: string;
}

export function multiUserEnv(
  env: Record<string, string | undefined> = process.env as unknown as Record<string, string | undefined>,
): MultiUserEnv {
  return {
    authForce: env[AUTH_FORCE_ENV] ?? "",
    mailhog: env[MAILHOG_ENV] ?? "",
  };
}

/** True when the auth-forcing env var is set to the exact literal "on".
 *  Same on/off discipline as the fleet's own flag semantics: absent or any
 *  other string means off. */
export function isAuthForced(m: MultiUserEnv): boolean {
  return m.authForce === "on";
}

/** MailHog's HTTP API base for a configured instance, trailing slash trimmed;
 *  "" when unset. A consumer spec that needs a magic-link email polls
 *  <base>/api/v2/messages. */
export function mailhogBase(m: MultiUserEnv): string {
  return m.mailhog.replace(/\/+$/, "");
}
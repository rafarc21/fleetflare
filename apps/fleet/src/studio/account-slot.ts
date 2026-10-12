/**
 * Issue #405 — the ONE home for the `CLAUDE_CODE_OAUTH_TOKEN`/`_<n>` slot-name
 * grammar, both directions of it. Until now the grammar lived hand-kept in TWO
 * places, symmetric by discipline alone: src/studio/accounts.ts's
 * `claudeAccountVarName` (position -> secret name) with its private `slotOf`
 * (name -> position), and cli/accounts-format.ts's `slotNumber` (regex
 * parse-back) + `labelVarName` (name -> `CLAUDE_ACCOUNT_<n>_LABEL`) — so a
 * rename of the token secret shape had to land twice. This module folds all
 * four functions onto one spelling of each direction; the two old homes are
 * thin re-exports / importers of it.
 *
 * Deliberately dependency-free, the same discipline as src/base64.ts and
 * src/github/mint-token-error.ts: this module is imported by BOTH the Worker's
 * src graph (accounts.ts) and the cli project (cli/accounts-format.ts), and
 * cli/tsconfig.json type-checks under `"types": ["bun"]` with no Workers
 * ambient types — an accounts.ts import would drag `Env`, do.ts and
 * "@cloudflare/sandbox" into the cli's type-check, which is exactly why
 * cli/accounts-format.ts carried its own parse-back copy until now. Importing
 * nothing at all is what lets BOTH tsconfig projects reach this file.
 *
 * Names map to names ONLY: these functions handle secret NAMES, never
 * credential VALUES — the secrets themselves are read elsewhere (accounts.ts's
 * resolveClaudeAccounts), and the same names-not-credentials rule accounts.ts's
 * own header already states for `ClaudeAccount` applies here.
 */

/** The secret name for the nth account slot, 1-based. Slot 1 keeps the
 *  unsuffixed name every existing deploy already has. */
export function slotSecretName(position: number): string {
  return position === 1 ? "CLAUDE_CODE_OAUTH_TOKEN" : `CLAUDE_CODE_OAUTH_TOKEN_${position}`;
}

/** The 1-based slot a secret name names, or null for a name outside the
 *  grammar. Parses ANY _<n> suffix (the window policy — which positions the
 *  fleet actually scans — lives in accounts.ts next to MAX_CLAUDE_ACCOUNTS,
 *  which this module must not import). */
export function slotNumberOf(secretName: string): number | null {
  if (secretName === "CLAUDE_CODE_OAUTH_TOKEN") return 1;
  const m = /^CLAUDE_CODE_OAUTH_TOKEN_(\d+)$/.exec(secretName);
  return m ? Number(m[1]) : null;
}

/** `CLAUDE_ACCOUNT_<n>_LABEL` for a grammar name; falls back to naming the
 *  secret itself for a foreign name (defensive only — every real fleet slot
 *  matches the grammar). */
export function labelVarName(secretName: string): string {
  const n = slotNumberOf(secretName);
  return n === null ? `CLAUDE_ACCOUNT_${secretName}_LABEL` : `CLAUDE_ACCOUNT_${n}_LABEL`;
}

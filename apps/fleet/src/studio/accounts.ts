/**
 * Issue #53 — the fleet's claude ACCOUNTS, as an ordered list of Worker
 * secrets.
 *
 * One account was the whole fleet's single point of failure: when it hit its
 * org monthly spend limit on 2026-09-23, every studio parked on claude's
 * `/rate-limit-options` modal at once and a human logged into each container
 * by hand — twice. The requirement that shapes this file is "adding an account
 * is a SECRET WRITE, not a code change", so the list is discovered from the
 * environment by NAME rather than declared anywhere:
 *
 *   CLAUDE_CODE_OAUTH_TOKEN      the first account, unsuffixed — every deploy
 *                                that exists today already has exactly this
 *                                and keeps working unchanged
 *   CLAUDE_CODE_OAUTH_TOKEN_2    the second, _3 the third, up to
 *                                MAX_CLAUDE_ACCOUNTS
 *
 * `wrangler secret put CLAUDE_CODE_OAUTH_TOKEN_2` is the whole procedure.
 *
 * Lives in src/studio/ and imports NOTHING — not do.ts (which pulls in
 * "@cloudflare/sandbox"), and deliberately not src/env.ts either. `Env`'s own
 * module type-imports StudioDO, so a file that names `Env` drags do.ts,
 * terminal.ts and the whole workers-types graph behind it, and the bun:test
 * lane (test/tsconfig.json, `"types": ["bun"]`) cannot compile that. The
 * structural parameter type below is what keeps this module — and failover.ts
 * through it — reachable from a test that can ask a real shell what a command
 * actually does. Same boundary reasoning as credentials.ts's own header.
 */

/** Just the part of the Worker environment this module reads. `Env`
 *  (src/env.ts) satisfies it structurally, with no cast at any call site. */
export interface ClaudeAccountEnv {
  CLAUDE_CODE_OAUTH_TOKEN: string;
  /** Issue #271: repo -> account slot, JSON (`{"demosite-life":2}`). */
  CLAUDE_ACCOUNT_BY_REPO?: string;
  /** Issue #271: auto-failover runs only when this is exactly "on". */
  FLEET_AUTO_FAILOVER?: string;
}

/** One account: the SECRET'S NAME, and the token it holds. The name is the
 *  operator-visible identity of an account — it is a variable name, never a
 *  credential, so it is safe to log, store on StudioStatus, print in
 *  `fleet ls` and put in a telegram alert. The token is the opposite: it must
 *  never reach any of those. */
export interface ClaudeAccount {
  name: string;
  token: string;
}

/**
 * How many account slots are scanned. A fixed window rather than "scan until
 * the first gap": an operator who deletes CLAUDE_CODE_OAUTH_TOKEN_2 must not
 * silently lose CLAUDE_CODE_OAUTH_TOKEN_3 as well — a gap is a hole in the
 * list, never its end. Nine is arbitrary and deliberately generous; the cost
 * of the window is nine property reads on an object the Worker already holds.
 */
export const MAX_CLAUDE_ACCOUNTS = 9;

/** The secret name for the nth account, 1-based. The first account keeps the
 *  unsuffixed name the fleet has always used — renaming it would have made
 *  this feature a redeploy-and-re-secret migration for every existing studio,
 *  which is exactly the "code change" the requirement rules out. */
export function claudeAccountVarName(position: number): string {
  return position === 1 ? "CLAUDE_CODE_OAUTH_TOKEN" : `CLAUDE_CODE_OAUTH_TOKEN_${position}`;
}

/**
 * The ordered account list for this Worker. Order IS the failover order:
 * position 1 first, then 2, then 3.
 *
 * The computed-name reads are isolated behind one `unknown` cast, the same
 * call src/github/auth.ts's `repoToken` already makes for GITHUB_TOKEN_<OWNER>
 * and for the same reason: `Env` is closed on purpose, and widening it with an
 * index signature would stop every other `env.FOO` typo from failing the
 * build. Only CLAUDE_CODE_OAUTH_TOKEN itself is declared on `Env`.
 *
 * Empty string is not an account: `wrangler secret` can hold one, and a studio
 * launched with an empty CLAUDE_CODE_OAUTH_TOKEN starts unauthenticated, which
 * is a worse failure than having one account fewer.
 */
export function resolveClaudeAccounts(env: ClaudeAccountEnv): ClaudeAccount[] {
  const bag = env as unknown as Record<string, string | undefined>;
  const accounts: ClaudeAccount[] = [];
  for (let position = 1; position <= MAX_CLAUDE_ACCOUNTS; position++) {
    const name = claudeAccountVarName(position);
    const token = bag[name];
    if (typeof token === "string" && token.length > 0) accounts.push({ name, token });
  }
  return accounts;
}

/** The account a studio is recorded on (StudioStatus.claudeAccount), or the
 *  first one. `null` is what every studio provisioned before this feature
 *  reads as, and every such studio was launched from the unsuffixed secret by
 *  construction — there was no other possibility — so null resolves to
 *  position 1 rather than to "unknown". */
function currentIndex(accounts: ClaudeAccount[], currentName: string | null | undefined): number {
  if (currentName == null) return 0;
  return accounts.findIndex((a) => a.name === currentName);
}

/**
 * The token to launch a container with. Falls back to the first account when
 * the studio is on no recorded account, or on one whose secret no longer
 * exists — a container must always come up with SOME credential, and the
 * fallback is the same one the fleet used before this feature.
 *
 * Returns "" when no account is configured at all. Empty, not omitted, for the
 * reason studioEnvVars' TS_AUTHKEY already is: `envVars` is string-valued.
 */
export function claudeAccountToken(accounts: ClaudeAccount[], currentName: string | null | undefined): string {
  if (accounts.length === 0) return "";
  const idx = currentIndex(accounts, currentName);
  return (idx >= 0 ? accounts[idx] : accounts[0]).token;
}

/**
 * The account to fail over TO, or null when there is none left.
 *
 * FORWARD ONLY, and that is the whole anti-loop mechanism (issue #53's first
 * rule: "NEVER rotate in a loop. Try each token once"). The list is ordered
 * and a studio's position in it only ever increases, so the number of switches
 * a studio can ever make is bounded by the number of accounts configured —
 * there is no state to expire, no counter to reset, and no way to arrive back
 * at an account already known to be exhausted.
 *
 * An account name that is NOT in the list (its secret was deleted or renamed
 * while the studio was running on it) returns null rather than restarting from
 * position 1: wrapping would hand the studio an account it has already burned
 * through, which is the loop this rule exists to forbid. Degrading and naming
 * the account is the honest answer.
 */
export function nextClaudeAccount(
  accounts: ClaudeAccount[], currentName: string | null | undefined,
): ClaudeAccount | null {
  const idx = currentIndex(accounts, currentName);
  if (idx < 0) return null;
  return accounts[idx + 1] ?? null;
}

/** Every account this studio has been on, in order, up to and including the
 *  one it is on now — what the degraded message and the operator alert name.
 *  An unknown current account (secret deleted) is reported as itself, so the
 *  operator sees the name that no longer resolves. */
export function accountsTried(accounts: ClaudeAccount[], currentName: string | null | undefined): string[] {
  const idx = currentIndex(accounts, currentName);
  if (idx < 0) return currentName == null ? [] : [currentName];
  return accounts.slice(0, idx + 1).map((a) => a.name);
}

/**
 * Issue #271 — a static PRIMARY account per repo. One account capped the whole
 * fleet (91% of its session limit at 08:2xZ, 2026-09-25), and adding a second
 * secret used to ARM auto-failover for every studio, which the detector is not
 * yet safe for (#239 review). A repo -> slot map needs no detector: studios of
 * repo X launch on account N, and nothing is killed or relaunched.
 *
 * `CLAUDE_ACCOUNT_BY_REPO` is a Worker VAR holding JSON keyed by the repo
 * segment of a studio id (`{"demosite-life":2}`), not a fleet.json field: the
 * launch env is built synchronously at DO construction, where fleet.json would
 * cost a GitHub read, and a map change is then a var edit, not a commit to the
 * fleet repo. It names slots, never tokens, so it is not a secret.
 *
 * Absent or empty: no map, every repo on the first SET account. Bad JSON, or an
 * entry that is not a slot 1..MAX_CLAUDE_ACCOUNTS: dropped and LOGGED
 * (console.error), the rest stand — a typo must be visible in a tail, never a
 * silent move. A KEY that can never match a studio (not a studio-id repo
 * segment: upper case, `owner/name`, spaces) is WARNED once per parse, by
 * name, and dropped (#273 review round 2).
 */
/** The repo half of a studio id — ids.ts's SEGMENT, repeated here because this
 *  module imports nothing (see its header). */
const REPO_SEGMENT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseAccountMap(raw: string | undefined): Record<string, number> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`claude account: CLAUDE_ACCOUNT_BY_REPO is not valid JSON — every repo on the first set account`, err instanceof Error ? err.message : err);
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error("claude account: CLAUDE_ACCOUNT_BY_REPO must be a JSON object of repo -> slot — every repo on the first set account");
    return {};
  }
  const map: Record<string, number> = {};
  for (const [repo, slot] of Object.entries(parsed)) {
    if (!REPO_SEGMENT_RE.test(repo)) {
      console.warn(`claude account: CLAUDE_ACCOUNT_BY_REPO key ${JSON.stringify(repo)} can never match a studio (keys are the repo part of <repo>--<role>, lower case) — ignored`);
      continue;
    }
    if (typeof slot === "number" && Number.isInteger(slot) && slot >= 1 && slot <= MAX_CLAUDE_ACCOUNTS) {
      map[repo] = slot;
    } else {
      console.error(`claude account: CLAUDE_ACCOUNT_BY_REPO entry ${JSON.stringify(repo)} is not a slot 1-${MAX_CLAUDE_ACCOUNTS} — ignored, that repo stays on the first set account`);
    }
  }
  return map;
}

/** Issue #271: auto-failover is OFF unless FLEET_AUTO_FAILOVER is exactly "on". */
export function autoFailoverOn(env: ClaudeAccountEnv): boolean {
  return env.FLEET_AUTO_FAILOVER === "on";
}

export type LaunchAccount = { ok: true; name: string; token: string } | { ok: false; error: string };

/**
 * Issue #271: the account a studio of `repo` launches on.
 *
 *   - Auto-failover ON and the studio is RECORDED on an account that still
 *     exists: that account (#53 — a studio that failed over comes back up on
 *     the account it moved to).
 *   - Otherwise the repo's mapped slot, or when unmapped the FIRST SET
 *     account in slot order (normally CLAUDE_CODE_OAUTH_TOKEN). With
 *     failover off nothing ever moves a studio, so a restart is how a map
 *     change reaches it.
 *   - A MAPPED slot whose secret is not set REFUSES, never falls back: account
 *     1 would silently carry the other repo's load, the starvation the map
 *     exists to stop.
 *   - Unmapped with no account at all: token "" — today's behaviour.
 */
export function launchAccount(env: ClaudeAccountEnv, repo: string | null, recorded: string | null | undefined): LaunchAccount {
  const accounts = resolveClaudeAccounts(env);
  if (autoFailoverOn(env) && recorded != null) {
    const on = accounts.find((a) => a.name === recorded);
    if (on) return { ok: true, name: on.name, token: on.token };
  }
  const slot = repo === null ? undefined : parseAccountMap(env.CLAUDE_ACCOUNT_BY_REPO)[repo];
  if (slot === undefined) {
    const first = accounts[0];
    return first ? { ok: true, name: first.name, token: first.token } : { ok: true, name: claudeAccountVarName(1), token: "" };
  }
  const name = claudeAccountVarName(slot);
  const mapped = accounts.find((a) => a.name === name);
  if (!mapped) {
    return {
      ok: false,
      error:
        `claude account: ${repo} is mapped to ${name} (CLAUDE_ACCOUNT_BY_REPO), and that secret is not set — ` +
        `refusing to launch rather than fall back to another account. Set it: wrangler secret put ${name}`,
    };
  }
  return { ok: true, name: mapped.name, token: mapped.token };
}

/** The slot a secret name holds, or null for a name outside the list. */
function slotOf(name: string): number | null {
  for (let position = 1; position <= MAX_CLAUDE_ACCOUNTS; position++) {
    if (claudeAccountVarName(position) === name) return position;
  }
  return null;
}

/**
 * Issue #271: the operator's optional NON-SECRET label for an account,
 * `CLAUDE_ACCOUNT_<n>_LABEL` (an email, say). Read only for display; it is
 * never a token and resolveClaudeAccounts never reads it.
 */
export function accountLabel(env: ClaudeAccountEnv, name: string): string | null {
  const slot = slotOf(name);
  if (slot === null) return null;
  const label = (env as unknown as Record<string, string | undefined>)[`CLAUDE_ACCOUNT_${slot}_LABEL`];
  return typeof label === "string" && label.trim() !== "" ? label.trim() : null;
}

/** `<label> (<secret name>)`, or the secret name alone when unlabelled. */
export function accountDisplay(env: ClaudeAccountEnv, name: string): string {
  const label = accountLabel(env, name);
  return label === null ? name : `${label} (${name})`;
}

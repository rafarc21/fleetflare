// #168 sensor 4, option (b) (design doc
// docs/superpowers/specs/2026-10-01-sensor-task-control-loop-168-design.md,
// section "4. Worker exceptions"): the Worker's own `fetch`/`scheduled`
// entry points (src/index.ts) wrap their ENTIRE body in one outer
// try/catch and call `recordWorkerException` on anything that escapes,
// before rethrowing the SAME error unchanged. No new credential — the
// Worker already holds D1 write access via `env.DB`.
import { redactSecrets } from "./studio/redact";

/**
 * A thrown non-Error value (reject with a string, a plain object, etc) has
 * no `.stack` and no real name — this is the name this module records for
 * that shape rather than crashing trying to read `.name` off something that
 * might not have one.
 */
const NON_ERROR_NAME = "<non-Error throw>";

/**
 * `stack_head` is the top of a stack trace, not the whole thing — a full
 * stack can run to dozens of frames deep into framework/runtime noise this
 * table has no use keeping forever at 1000+ rows. Picked as a line count
 * (not a char cap) because a stack's useful signal is almost always in its
 * first few call frames, and frame lines vary wildly in length.
 */
const STACK_HEAD_MAX_LINES = 10;

function stackHead(stack: string): string {
  return stack.split("\n").slice(0, STACK_HEAD_MAX_LINES).join("\n");
}

/**
 * Operator stop-change (PR #198, issue #188): these 4 shapes were FIRST
 * added to the SHARED Worker-wide `redactSecrets` (src/studio/redact.ts) —
 * reverted from there because extending that shared util forced a matching
 * edit to its shell mirror, `container/studio-bringup.sh`'s
 * `bringup_redact`, and touching ANYTHING under `container/` makes this
 * (supposed to be Worker-only) feature an IMAGE change — a container
 * rebuild + rollout, replacing every running studio. Unacceptable blast
 * radius for a feature that only needed Worker-side D1 writes. Kept here
 * instead, module-LOCAL to exceptions.ts (NOT exported, NOT the shared
 * `redactSecrets` — do not confuse the two): `describeError` below applies
 * this AFTER `redactSecrets` already ran, so `worker_exceptions` rows still
 * get the same coverage, just without ever touching the container image.
 *
 * Patterns (unchanged shapes from the reverted shared-util version):
 *  - JWT: three dot-separated base64url segments starting `eyJ` (base64 of
 *    `{"`, i.e. every JSON-header JWT starts with it) — matched by shape,
 *    not decoded.
 *  - Telegram bot token: `\d{6,}:[A-Za-z0-9_-]{35}`, Telegram's own
 *    documented shape. Real leak surface specifically for THIS feature:
 *    `telegram.token` (src/agents/registry.ts) reaches `sendCard`
 *    (src/telegram/api.ts), called from `scheduled`'s watchdog path
 *    (src/index.ts) — exactly the path this module's `recordWorkerException`
 *    wraps.
 *  - PEM private key block, multiline, non-greedy (`[\s\S]*?` since `.`
 *    never matches newlines and a PEM body always spans several lines; non-
 *    greedy so one leaked block doesn't swallow unrelated text up to a
 *    LATER unrelated footer). Fully coverable here — unlike the shell
 *    mirror that forced the revert, src/ TS has no line-oriented-sed
 *    constraint.
 *  - `?token=`/`&key=` query-string values, case-insensitive,
 *    capture-preserving (keeps the param name, redacts only the value).
 */
// Operator found bug (PR #198, issue #188): without the `(?<![A-Za-z0-9_-])`
// negative lookbehind, this regex has no anchor on where a match attempt may
// START — a long run of `eyJ`-prefixed noise with no `.` ever following
// forces the engine to retry the same failing `[A-Za-z0-9_-]+\.` match at
// EVERY character position in the run, which is quadratic in the run's
// length (measured: "eyJ".repeat(66666) took ~10s). The lookbehind forces a
// match attempt to only start at a real token boundary (not preceded by a
// word/`-`/`_` char), closing off the retry blowup — zero effect on where a
// match ends or on any real JWT, since every real specimen already sits
// after prose/whitespace/punctuation, never mid-word.
const JWT_RE = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const TELEGRAM_TOKEN_RE = /\b\d{6,}:[A-Za-z0-9_-]{35}\b/g;
// Operator fix 2nd review (PR #198, issue #188): the `(?:-----END...|$)`
// alternation matters — without it, an UNTERMINATED PEM block (no END
// marker ever found) forces the non-greedy `[\s\S]*?` to backtrack across
// the entire rest of the string looking for a terminator that doesn't
// exist — the classic non-greedy-with-no-anchor ReDoS/quadratic-blowup
// shape. Anchoring the fallback to end-of-string gives the engine a
// guaranteed match point and avoids that.
const PEM_PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const QUERY_SECRET_RE = /([?&](?:token|key|access_token|api_key)=)[^&\s]+/gi;

function scrubExceptionLocalSecrets(s: string): string {
  return s
    .replace(JWT_RE, "«redacted»")
    .replace(TELEGRAM_TOKEN_RE, "«redacted»")
    .replace(PEM_PRIVATE_KEY_RE, "«redacted»")
    .replace(QUERY_SECRET_RE, "$1«redacted»");
}

/**
 * Operator fix-first review on PR #198 (issue #188): a hard char cap on
 * BOTH `message` and `stack_head`, applied AFTER redaction (same ordering
 * rule as this module's own `describeError` doc comment already
 * establishes — redact the full value first, slice second, so a secret
 * straddling the cut point never survives half-caught). `message` had no
 * cap at all before this; `stack_head`'s existing `STACK_HEAD_MAX_LINES`
 * line-count truncation stays as the first pass (it's still the right
 * signal-preserving cut for an ordinary stack) — this is a backstop for the
 * case a single huge line (or a huge non-Error `String(err)` message) slips
 * through that unbounded.
 */
const MAX_FIELD_CHARS = 2000;

function capField(s: string): string {
  return s.length > MAX_FIELD_CHARS ? s.slice(0, MAX_FIELD_CHARS) : s;
}

/**
 * Extracts `name`/`message`/`stack` from whatever was thrown. Redaction
 * runs here, on the FULL message/stack, BEFORE any truncation — the same
 * order src/studio/activity.ts's `truncateLine`/`extractLastVisibleLine` doc
 * comments establish and src/studio/grid.ts's `scrubPreview` already
 * implements: redact the full value first, slice second, so a secret
 * straddling the truncation boundary never survives half-caught. Exact
 * order per value: shared `redactSecrets` first, then this module's OWN
 * `scrubExceptionLocalSecrets` (see its doc comment for why these 4 extra
 * shapes live here and not in the shared util), THEN (for `stack` only)
 * `stackHead`'s line-slice, THEN `capField`'s char-cap last, on each
 * already-redacted, already-line-sliced value.
 */
function describeError(err: unknown): { name: string; message: string; stackHead: string | null } {
  if (err instanceof Error) {
    const message = capField(scrubExceptionLocalSecrets(redactSecrets(err.message)));
    const stackHead_ = err.stack
      ? capField(stackHead(scrubExceptionLocalSecrets(redactSecrets(err.stack))))
      : null;
    return { name: err.name, message, stackHead: stackHead_ };
  }
  return { name: NON_ERROR_NAME, message: capField(scrubExceptionLocalSecrets(redactSecrets(String(err)))), stackHead: null };
}

/**
 * Operator fix-first review on PR #198 (issue #188): the insert this module
 * issues against D1 must never be allowed to hang past a fixed budget — a
 * slow/degraded D1 blocking the Worker's own response past this point would
 * turn the symptom (D1 trouble) into the cause (every failing request also
 * stalling on D1). Same `Promise.race` + `setTimeout` idiom as
 * src/studio/sandbox-api.ts's `sbExec`/src/studio/do.ts's exec deadlines —
 * `clearTimeout` in `finally` either way, so a fast insert never leaves a
 * dangling timer.
 */
const INSERT_TIMEOUT_MS = 2000;

/**
 * Operator fix-first review on PR #198 (issue #188): a per-isolate cap so a
 * single Worker isolate cannot hammer a struggling D1 with unbounded insert
 * attempts under sustained failure — isolates are long-lived processes, so a
 * plain module-level counter is the standard cheap Workers rate-limit
 * pattern (no KV/D1 round trip needed to rate-limit calls INTO D1 itself).
 * Rolling window, not fixed-bucket: `now` is the same epoch-millis clock
 * already threaded into `recordWorkerException` (never `Date.now()` read
 * internally), so this stays deterministic under test.
 */
const RATE_CAP_PER_WINDOW = 20;
const RATE_WINDOW_MS = 60_000;
let rateWindowStart = 0;
let rateWindowCount = 0;

/**
 * Returns true if this call should be DROPPED — no `prepare`/`run` even
 * attempted. Logs the drop exactly once per window (on the FIRST call that
 * crosses the cap), not once per dropped record after that: under sustained
 * failure this function is itself on the hot path, so repeated logging here
 * would just be a second unbounded-cost loop replacing the first one this
 * whole cap exists to kill.
 */
function rateCapped(now: number): boolean {
  if (now - rateWindowStart >= RATE_WINDOW_MS) {
    rateWindowStart = now;
    rateWindowCount = 0;
  }
  rateWindowCount++;
  if (rateWindowCount <= RATE_CAP_PER_WINDOW) return false;
  if (rateWindowCount === RATE_CAP_PER_WINDOW + 1) {
    console.error(`recordWorkerException rate cap hit (${RATE_CAP_PER_WINDOW}/${RATE_WINDOW_MS}ms) — dropping further records this window`);
  }
  return true;
}

/** Test-only — same reset pattern src/studio/org.ts's
 *  `__resetOrgCacheForTests` already establishes for process-global state:
 *  deterministic counter resets without depending on real elapsed time or
 *  test execution order. */
export function __resetExceptionRateCapForTests(): void {
  rateWindowStart = 0;
  rateWindowCount = 0;
}

/**
 * Caps `worker_exceptions` at `keep` rows, oldest-first by `ts`. No
 * existing "cap at N rows" precedent elsewhere in this repo (every other
 * table's delete is a timestamp-cutoff, not a row-count cap), so this is
 * new. NEVER throws — a prune failure must not surface any differently
 * than the insert failure it's always called right after (see
 * `recordWorkerException`'s own doc comment for why).
 *
 * Operator fix-first review on PR #198 (issue #188), nit: a boundary-
 * timestamp comparison instead of `NOT IN` over a potentially-large id set
 * — the subquery finds the `ts` of the `keep`-th newest row (`OFFSET
 * keep - 1`), then deletes everything strictly older than it. Fewer than
 * `keep` rows: the subquery returns no row, so `ts < NULL` is never true in
 * SQL — nothing gets deleted, which is correct (nothing to prune yet).
 */
export async function pruneWorkerExceptions(db: D1Database, keep: number = 1000): Promise<void> {
  try {
    await db
      .prepare(
        `DELETE FROM worker_exceptions WHERE ts < (
           SELECT ts FROM worker_exceptions ORDER BY ts DESC LIMIT 1 OFFSET ?
         )`,
      )
      .bind(keep - 1)
      .run();
  } catch (err) {
    console.error("pruneWorkerExceptions failed", err);
  }
}

/**
 * Best-effort, NEVER throws — the issue's own ruling: "insert failure must
 * never change response behavior", i.e. the original error (or the
 * original successful response) must reach the caller exactly as if this
 * feature did not exist. A D1 outage recording the symptom must never also
 * become the symptom. Called from the outer try/catch src/index.ts's
 * `fetch`/`scheduled` wrap their entire body in, right before each
 * rethrows the SAME error it caught.
 *
 * Operator fix-first review on PR #198 (issue #188), hot-path safety: three
 * changes on top of the above so a slow/degraded D1 cannot turn every
 * failing request into a second load-bearing call against the SAME
 * struggling D1 — (1) the per-isolate rate cap (`rateCapped`) above, checked
 * FIRST, before any `prepare`/`run` is even attempted; (2) the insert itself
 * is raced against `INSERT_TIMEOUT_MS`, so a hanging D1 can never hold the
 * caller's response past that; (3) the prune that used to run inline, right
 * here, now goes through `ctx.waitUntil` instead — it still runs every
 * time an insert succeeds, but strictly AFTER this function (and therefore
 * the caller's own response) has already resolved, never blocking it.
 */
export async function recordWorkerException(
  db: D1Database, route: string, err: unknown, now: number, ctx: ExecutionContext,
): Promise<void> {
  if (rateCapped(now)) return;

  // `describeError` itself must never be allowed to throw out of this
  // function: a crafted Error subclass with a throwing `.message`/`.stack`
  // getter (not just a D1 outage) would otherwise replace the ORIGINAL
  // error the outer fetch/scheduled try/catch is rethrowing. Falling back
  // to a fixed placeholder row still records SOMETHING rather than
  // silently dropping the exception entirely.
  let name: string, message: string, head: string | null;
  try {
    ({ name, message, stackHead: head } = describeError(err));
  } catch (describeErr) {
    console.error("recordWorkerException describeError failed", describeErr);
    name = "<describeError failed>";
    message = "<describeError failed>";
    head = null;
  }
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`recordWorkerException insert timed out after ${INSERT_TIMEOUT_MS}ms`)),
        INSERT_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([
        db
          .prepare(
            `INSERT INTO worker_exceptions (id, ts, route, name, message, stack_head)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(crypto.randomUUID(), now, route, name, message, head)
          .run(),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  } catch (insertErr) {
    console.error("recordWorkerException insert failed", insertErr);
    return;
  }
  // Fresh-context review on PR #198 (issue #188), blocking: `ctx.waitUntil`
  // itself must never be allowed to throw out of this function — same class
  // of bug as `describeError`'s throwing getters above. Unreachable with a
  // real ExecutionContext today, but the function's own "NEVER throws"
  // contract has to hold unconditionally, not just for the shapes currently
  // passed at the two real call sites.
  try {
    ctx.waitUntil(pruneWorkerExceptions(db));
  } catch (waitUntilErr) {
    console.error("recordWorkerException ctx.waitUntil failed", waitUntilErr);
  }
}

/**
 * Read-only — backs the future sensor 4 (and, today, `GET
 * /studio/worker-exceptions/count`, src/studio/routes.ts). Unlike
 * `recordWorkerException`, this one CAN throw/propagate normally: nothing
 * downstream depends on it being silent, since it's a plain read with no
 * response-shape contract to protect.
 *
 * Caveat (operator fix-first review, PR #198, issue #188): a count of 0
 * does NOT mean the Worker is healthy. This whole table only catches what
 * is thrown synchronously-awaited inside `fetch`'s/`scheduled`'s own body
 * (src/index.ts's outer try/catch). It misses: (a) failures inside a
 * `ctx.waitUntil`-deferred background task — this feature's own prune call
 * included; if `pruneWorkerExceptions` itself fails inside its
 * `ctx.waitUntil`, nothing records that, since there is no outer try/catch
 * left to catch it once it's handed off; (b) Durable Object internals
 * (AgentDO/DeployDO/StudioDO methods run in their own object context and
 * never touch this wrapper at all); (c) WebSocket message handlers, if any
 * exist; (d) a route that catches its own error internally and returns a
 * 500 `Response` on purpose instead of throwing — nothing escapes to be
 * caught, so nothing gets recorded.
 */
export async function countWorkerExceptions(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM worker_exceptions`).first<{ n: number }>();
  return row?.n ?? 0;
}

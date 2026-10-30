// Issue #1422: the 10-27 ~07:20-08:00Z outage. Studios across 4 repos could
// not push ("Repository not found" / 403) for ~40 minutes while credential
// refresh (do.ts's runRefreshCredential) reported no error the whole time —
// its own self-check (workCredentialVerifyCmd) only proves git SERVES the
// minted token, never that GitHub actually accepts it for a push. This probe
// asks the real question: the exact request `git push` itself sends first,
// GitHub's git smart-HTTP receive-pack advertisement. A 200 is the one
// honest "yes" a token can give for push access.
//
// Deliberately NOT `GET /repos/<repo>` (github/api.ts's repoIsWritable):
// that endpoint's `permissions.push` is measured against a fine-grained PAT
// only (see its own doc comment) — for an App installation token it reads
// false unconditionally, since GitHub never fills in collaborator
// permissions for a token that is not a user. Using it here would refuse
// every single App-token refresh, not just a broken one.

/** Review r1 (PR #1435): a hung GitHub response would otherwise hold this
 *  probe (and the refresh/rescue tick calling it) open forever — the exact
 *  class of problem this feature exists to stop one layer up. */
const PROBE_TIMEOUT_MS = 10_000;

/** A 5xx or 429 is GitHub's own side having a bad moment, not an answer
 *  about the token — and neither is a thrown fetch (network error, DNS
 *  failure, our own timeout above). Only these are retried once; a 401/403/
 *  404 is a real, final "no" and is never retried. */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * Review r1 (PR #1435): a single blip (one 503, one dropped connection)
 * must not refuse a refresh or push a rescue branch to the public origin
 * fallback — both outcomes are worse than the one extra round trip a retry
 * costs. Retried exactly once: a probe that fails twice in a row is treated
 * as a real answer, not more flakiness.
 */
export async function canPushRepo(
  token: string, repo: string, fetchImpl: typeof fetch = fetch, timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchImpl(`https://github.com/${repo}.git/info/refs?service=git-receive-pack`, {
        method: "GET",
        headers: { authorization: `Basic ${btoa(`x-access-token:${token}`)}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Drain the body: an unread stream on a reused connection can otherwise
      // keep the request "open" from the runtime's own perspective.
      await res.arrayBuffer().catch(() => undefined);
      if (res.status === 200) return true;
      if (attempt === 1 && isTransientStatus(res.status)) continue;
      return false;
    } catch {
      // A thrown fetch -- network error, DNS failure, or our own
      // AbortSignal.timeout firing on a stalled response -- reads the same
      // as a transient status: worth exactly one retry, never more.
      if (attempt === 1) continue;
      return false;
    }
  }
  return false;
}

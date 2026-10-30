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
export async function canPushRepo(
  token: string, repo: string, fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`https://github.com/${repo}.git/info/refs?service=git-receive-pack`, {
      method: "GET",
      headers: { authorization: `Basic ${btoa(`x-access-token:${token}`)}` },
    });
    // Drain the body: an unread stream on a reused connection can otherwise
    // keep the request "open" from the runtime's own perspective.
    await res.arrayBuffer().catch(() => undefined);
    return res.status === 200;
  } catch {
    return false;
  }
}

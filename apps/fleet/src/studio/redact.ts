// Worker-side credential scrubber for studio status responses.
//
// Task 4 controller ruling: reuse an existing redact util if one is
// importable Worker-side, else write a minimal one here. Searched first:
// `grep -rn "redact\|scrub" src/ container/` turns up exactly two
// implementations, `redactCreds`/`scrub` in container/server.ts and
// container/deploy-server.ts — both are module-private (not exported) and
// both run in the AGENT CONTAINER's own Bun process (a separate runtime
// target from this Worker; vitest.config.ts even reads container/server.ts
// as raw text for test/container.args.test.ts because it "can never be
// imported by a test"). src/events/log.ts, the brief's other suggested
// location, has no redact/scrub of any kind. So: nothing importable
// Worker-side exists — this is the sanctioned fallback.
//
// Masks by shape (regex), not by exact known value: unlike
// container/server.ts's scrub() (which redacts specific token strings the
// container process already holds), this Worker never separately holds the
// studio's GitHub token — StudioStatus.error can carry one anyway, echoed
// straight from container/shell output (a failed git push, a curl against
// the GitHub API). Per the ruling: GitHub App/installation tokens
// (`ghs_...`), GitHub personal access tokens (`github_pat_...`), and a
// generic `Bearer <token>` header value.
//
// Review round 2, Important 3: this feature's own bring-up script (Task 8)
// runs `tailscale up --authkey=$TS_AUTHKEY`, and StudioStatus.error can just
// as easily echo THAT key back from a failed bring-up's stderr as a GitHub
// one — the original three patterns had no coverage for it. Added
// `tskey-auth-...` (Tailscale's own auth-key shape: alnum plus internal
// hyphens after the fixed prefix) and the other three GitHub token
// prefixes that share ghs_'s general shape — `ghp_` (classic PAT), `gho_`
// (OAuth access token), `ghu_` (GitHub App user-to-server token), `ghr_`
// (GitHub App refresh token) — ghs_ itself and github_pat_ (fine-grained
// PAT) already had their own patterns above and are deliberately left
// separate rather than folded into one regex, so each shape stays
// independently readable/greppable.
// Review round 3, Minor 4: the same argument that added tskey-auth- now
// applies to Anthropic's own token shape. Task 12 put CLAUDE_CODE_OAUTH_TOKEN
// into EVERY studio container's process environment (StudioDO.envVars), so it
// is reachable by anything the container echoes — a `claude` startup failure,
// an `env` dump in a failed bring-up, a shell trace. StudioStatus.error
// carries that output verbatim. `sk-ant-` covers the whole family (api03,
// oat01, …) since everything after the prefix is the token body.
//
// Fleet Spawn P3, Task 1: same argument again, one more time, for
// FLEET_SPAWN_TOKEN (studio/do.ts's own envVars, R-P3-1's per-studio
// spawn-auth token — org.ts's mintSpawnToken). `fsp_` is this feature's own
// prefix, chosen specifically so this pattern stays independently
// greppable/redactable rather than folded into a broad hex-blob regex (see
// org.ts's mintSpawnToken doc comment for that choice).
const GHS_RE = /ghs_[A-Za-z0-9]+/g;
const GITHUB_PAT_RE = /github_pat_[A-Za-z0-9_]+/g;
const GH_OTHER_RE = /gh[pour]_[A-Za-z0-9]+/g;
const TAILSCALE_KEY_RE = /tskey-auth-[A-Za-z0-9-]+/g;
const ANTHROPIC_KEY_RE = /sk-ant-[A-Za-z0-9_-]+/g;
const FLEET_SPAWN_TOKEN_RE = /fsp_[0-9a-f]+/g;
const BEARER_RE = /Bearer\s+\S+/gi;

export function redactSecrets(s: string): string {
  return s
    .replace(GHS_RE, "«redacted»")
    .replace(GITHUB_PAT_RE, "«redacted»")
    .replace(GH_OTHER_RE, "«redacted»")
    .replace(TAILSCALE_KEY_RE, "«redacted»")
    .replace(ANTHROPIC_KEY_RE, "«redacted»")
    .replace(FLEET_SPAWN_TOKEN_RE, "«redacted»")
    .replace(BEARER_RE, "Bearer «redacted»");
}

# Park/destroy unmerged-PR warning + `fleet ls` PRS column (board issue #332)

Problem: `awaiting_merge` is not a live board state, so `destroy --park` sails
through while the studio's PRs sit unmerged; a bounced security-adjacent PR
needs the lane alive, and one lane was parked 5x in a day while bouncing.

Attribution: no branch naming convention exists and every studio pushes under
one shared git identity, so PR author/head is useless. The fleet-native chain
already exists: studio -> assigned tasks -> latest result envelope's `pr`
artifact -> `getPullRequest` live state (pr-landed.ts + verify.ts primitives).

## Design (one module, one route, thin CLI glue)

1. **`src/board/open-prs.ts`** (new, pure over BoardApi port): `studioOpenPrs(api, repo, studioId)` — every task assigned to the studio (open OR terminal-but-unclosed), find latest result envelope per task (`verify.ts`'s `findLatestResultEnvelope`), parse `pr` artifact, live-check each PR via `getPullRequest`; unmerged+open PRs reported as `{ taskNumber, prNumber, title, url }`. Degrade per-task like pr-landed.ts does (one bad task never stops the scan); a `{ok:false}` never thrown at route level. Needs ONE new BoardApi member: `getPullRequest: (repo, number) => Promise<{ number: number; merged: boolean; title: string; url: string }>` (narrowed — githubBoardApi wires it to api.ts's existing getPullRequest).
2. **Route** `GET /studio/board/open-prs?repo=<slug>` in routes.ts: batched per repo — one call, all studios that repo, never per-studio fan-out (issue #37's ls ruling). Response: `{ [studioId]: [{ taskNumber, prNumber, title, url }] }`. Best-effort: lookup failure -> `{}` for that studio, never a 5xx.
3. **`fleet ls`**: fetch the route once per distinct repo in the table (same best-effort 404-tolerant posture as cmdLs's existing `/studio/accounts` read). New `PRS` column: count, `-` when the route is unavailable (old Worker), keeping ls instant when the route 404s.
4. **`fleet destroy`**: after a successful destroy/park, fetch the route for that studio's repo and print a NON-BLOCKING warning naming each unmerged PR (number, title, url). New `--strict-unmerged` flag (bespoke parse, cli-args.ts destroy case; `strictUnmerged?: true`) REFUSES first: fetch before destroy, exit 1 naming the PRs. Old Worker (route 404) -> warning says "unknown (route unavailable)", strict still refuses? NO — strict also degrades: it warns and proceeds, because a 404 is not evidence of zero PRs, and blocking destroy on a Worker upgrade race is worse than the warning.
5. **Docs**: maestro-playbook SKILL.md line 246 area gains: security-adjacent work parks at `completed` keeping the lane alive through PR review bounces; `awaiting_merge` is OK for routine work only; check the `PRS` column before parking.

Bound: ≤400 lines total diff, one module (board/open-prs.ts), no schema, no migrations, no env changes.

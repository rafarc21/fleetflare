# Swallowed-errors sweep 13 — apps/fleet src+cli (2026-10-12)

Ref #482. Analysis only, read-only, no code changed. Thirteenth maintainability sweep: `catch {}` / `catch (e) {}` with no log or rethrow, `.catch(() => ...)`, catches returning a default that hides a real failure, promise chains with no rejection handler. Scope `apps/fleet/src/**` and `apps/fleet/cli/**` minus `container/`. Line refs = physical lines at `origin/main` fe816d0, paths relative to repo root.

Sweeps 1-12 (docs/maintainability/*.md) and the issues they filed are NOT repeated here.

**Tier rule (from #482):** GLM-OK = none of auth, secrets, credentials, rescue, failover, accounts routing, deploy, migrations, write-proxy, leak-gate. CLAUDE-ONLY = touches any of those.

## Method

~300 catch sites and 38 `.catch()` handlers read in full. The codebase is disciplined: nearly every catch is deliberate, carries a comment naming the policy (fail-open vs fail-closed, "never unwind X over a failed alert", "total function"), and either logs or returns a named reason. The findings below are the residue where a failure is indistinguishable from absence with NO log line anywhere.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | `src/junior/authz.ts:75` — malformed authz JSON reads as "revoked", silently | GLM-OK |
| 2 | `cli/orca-workspace.ts:426` — orcaJson `return {}` contradicts its own throw contract | GLM-OK |
| 3 | `src/studio/wake.ts:744` — limitSighting read failure silently weakens the limit gate | GLM-OK |
| 4 | `src/studio/wake.ts:790` — switchedBlock read failure silently re-enables a stale limit block | GLM-OK |
| 5 | `src/github/read-repos.ts:65` — config errors rebranded as "needs the App provider" policy refusals | GLM-OK |
| 6 | `src/studio/rescue.ts:111` — privacy-lookup throw refuses rescue with no log of the cause | CLAUDE-ONLY (rescue) |
| 7 | `src/github/webhook.ts:166` — verified-signature webhook payload that fails JSON.parse drops silently | GLM-OK |
| 8 | `src/studio/terminal.ts:211` — pty close rejection dropped with no distinguishing log | GLM-OK |
| 9 | `src/llm/anthropic-route.ts:567` — writer.close() rejection after a failed stream is dropped | GLM-OK |
| 10 | `src/junior/route.ts:222` + `src/llm/anthropic-route.ts:462` — usage insert `.catch(() => {})` is documented but the row loss is unobservable | GLM-OK |
| 11 | `cli/fleet.ts:2138` — fleet-rescue-all worker catches everything with an empty comment, no per-target line | GLM-OK |
| 12 | `cli/paste-mac.ts:30,32` — paste failure reads as "no image on clipboard" with no cause | GLM-OK |
| 13 | `src/studio/frames.ts:10` — `catch {}` on frame parse: deliberate (malformed frame -> ignore) but unannotated | GLM-OK |
| 14 | `cli/orca-workspace.ts:1267` — lock-release unlink failure has only a raced-steal comment, no ENOENT-vs-real-error split | GLM-OK |
| 15 | `src/board/board.ts:508` — addStateAfterRemove first-retry `catch { }` swallows the reason before the second attempt | GLM-OK |

### F1. junior/authz.ts:75 — malformed JSON reads as revoked, silently — GLM-OK

- **Site:** `isJuniorAuthorized`: `const parsed = JSON.parse(raw) as Partial<AuthzRecord>; return parsed.studioId === studioId;` inside `try { } catch { return false; }`.
- **Risk:** a corrupt D1 flag (torn write, hand edit) is indistinguishable from a real revocation. The studio silently loses junior mid-task; the only evidence is the junior route's 403. Nothing logs.
- **Proposed fix:** `catch { console.error(\`junior authz: malformed record for ${repo}#${issueNumber}, treating as revoked\`); return false; }`. Same return, one log line. Never a new dep.

### F2. cli/orca-workspace.ts:426 — orcaJson breaks its own documented contract — GLM-OK

- **Site:** orcaJson's doc comment says "Throws on every failure — timeout, non-zero exit, unparseable output", but the parse catch is `catch { return {} }`. The timeout and exit-code branches above it DO throw.
- **Risk:** an Orca upgrade that prints non-JSON beside a 0 exit makes every caller decode an empty envelope: `ensure` sees `[]` worktrees and creates a duplicate; a successful `terminal create` decodes no handle so the rename is skipped and the next ensure stacks a second attach terminal; `fullList` throws (its own array check) but only after two other call sites already mis-decoded.
- **Proposed fix:** throw `new Error(\`${what} printed unparseable JSON\`)` — matches the two sibling branches, keeps ensureStudioWorkspace's single catch as the error boundary.

### F3. src/studio/wake.ts:744 — limitSighting failure silently weakens the limit gate — GLM-OK

- **Site:** `deps.limitSighting().catch(() => null)` in runGatedWake gate 4. `detectLimitOnScreen` -> `inlineLimitBlock` -> `limitKeyIsLive` uses the sighting for issue #127's first-sighting window and #232's fleet-wide per-account sighting.
- **Risk:** a transient D1 read failure reads as "no sighting ever". An inline block whose own `resets` text is unparseable (unfamiliar tz, new wording) then falls to `parseResetUtc === null` -> `until null` -> staleness rule alone, and a live limit can read as stale->"working" -> the wake types text into a spend modal. The gate is the one place a false negative is priced in money (wake.ts's own comment).
- **Proposed fix:** log once per failure (`console.warn(\`wake gate: limit sighting unreadable, gate runs on screen text alone: ${...}\`)`), keep returning null — screen-text detection still works; the operator at least learns the gate was degraded.

### F4. src/studio/wake.ts:790 — switchedBlock failure re-enables a stale limit block — GLM-OK

- **Site:** `deps.switchedBlock().catch(() => null)` in the same gate, issue #106 fix pass B: a block the last account switch fired on is history.
- **Risk:** with the read failed, `switched === limitBlockKey(limit)` is false, so a stale pre-switch block the screen still shows refuses the wake (false refusal — safe direction) but with no evidence why; the operator sees "session-limit block on screen" for a studio they just switched. Cheaper than F3 but same silent-degradation shape.
- **Proposed fix:** one `console.warn` on failure naming that the switched-account exemption could not be confirmed. Keep null.

### F5. src/github/read-repos.ts:65 — config errors rebranded as policy — GLM-OK

- **Site:** `readReposProviderRefusal` catches `resolveRepoAuthKind` throws and folds the error message into `kind`, then returns the fixed text `read-repos needs the GitHub App provider for X — a fine-grained PAT cannot be narrowed to read-only`.
- **Risk:** `resolveRepoAuthKind` throws on CONFIG problems — malformed `GITHUB_REPO_AUTH`, a mapped provider whose secret is missing, no auth configured at all. All three are reported to the operator (board routes.ts:911, :964, at task filing time) as a policy refusal that implies the fix is "get the App provider". A config typo then masquerades as a permanent decision.
- **Proposed fix:** only the `kind === "token"` POLICY case keeps the current text; a caught throw returns a refusal that begins with the error's own message (e.g. `read-repos unavailable: <message>`) so config problems name themselves. Same 400 shape, no new branches at call sites.

### F6. src/studio/rescue.ts:111 — privacy-lookup throw refuses rescue with no cause — CLAUDE-ONLY (rescue)

- **Site:** `priv = (await rescueRepoIsPrivate(slug)) === true` inside `catch { /* unknown = not private */ }`, then `toOrigin(\`${slug} is not confirmed private\`)`.
- **Risk:** the fail-closed direction is correct and documented, but a D1/GitHub throw and a genuine "public repo" answer produce the identical operator-visible line. The leak-gate refusal looks like a repo-policy fact when it was a read failure — unresolvable from the terminal.
- **Proposed fix:** one `console.error(\`rescue: privacy lookup for ${slug} failed, treating as not private\`, err)` in the catch. CLAUDE-ONLY: rescue module, listed not filed.

### F7. src/github/webhook.ts:166 — verified webhook payload fails JSON.parse silently — GLM-OK

- **Site:** `wakeMaestro`: `try { payload = JSON.parse(body) } catch { return; }`, after verifySignature has already passed.
- **Risk:** a verified GitHub delivery whose body is not JSON (a GitHub schema change, a proxy corrupting the body) drops with zero trace — no log, no wake, no recorded event. Every OTHER drop in the file (skip keys, muted episodes) logs; this is the only silent one after the signature gate.
- **Proposed fix:** `catch (err) { console.error(\`maestro wake: ${event} payload unparseable\`, err); return; }`. Same behavior, one line.

### F8. src/studio/terminal.ts:211 — pty close rejection indistinguishable from success — GLM-OK

- **Site:** `void pending?.then((pty) => pty.close()).catch(() => {});` in forgetPty.
- **Risk:** the two sibling cleanup paths in the same file (endStream/failStream in sandbox-api.ts:467,481) distinguish "already settled" from real failure by logging the real one. Here any close failure — including a container socket that would have failed the NEXT attach loudly — is dropped with the same silence as an idempotent close.
- **Proposed fix:** `.catch((err) => console.error(\`studio terminal pty close failed: ${err instanceof Error ? err.message : String(err)}\`))`. Close is best-effort, keep the void — just not silent on real errors.

### F9. src/llm/anthropic-route.ts:567 — writer.close() after a failed stream is dropped — GLM-OK

- **Site:** `.finally(() => { writer.close().catch(() => {}); })` on the streaming pump's waitUntil chain.
- **Risk:** on the happy path the writer is already closed and `.catch(() => {})` is correct idempotence. On the FAILURE path (`pump_error`, `client_abort`) the writer may be wedged, and the close rejection — the last signal that the downstream side never saw the error frame — is swallowed identically. The pump's own error is logged; the delivery failure is not.
- **Proposed fix:** leave the happy path; on the error branches close through a helper that logs a rejection once (`writer.close().catch((err) => console.error("[glm-lead] closing stream after failure also failed", err))`). One-line change in the finally: log only when `end()` reported not-ok.

### F10. usage-insert `.catch(() => {})` — documented, but the row loss is unobservable — GLM-OK

- **Sites:** `src/junior/route.ts:222`, `src/llm/anthropic-route.ts:462` (both wrap `insertJuniorUsage(...)`), doc comments in `src/junior/usage.ts:39` and `anthropic-route.ts:424` already say WHY the swallow is correct (a logging failure must never affect the streamed response).
- **Risk:** the DESIGN is deliberate and correct; the OBSERVABILITY is not. A persistently failing D1 insert (schema drift, a broken binding) drops every usage row with no signal anywhere — junior usage stats silently read zero.
- **Proposed fix:** keep the swallow, add the log: `.catch((err) => console.error("junior usage insert failed", err))` — usage.ts's own Issue #302 comment already distinguishes per-migration fallbacks from real failures; only real failures should print.

### F11. cli/fleet.ts:2138 — rescue-all worker catch has no per-target line — GLM-OK

- **Site:** runOne's `catch { /* Defense in depth: worker below already catches everything ... */ }`.
- **Risk:** the comment is right that the runner must survive. But if `worker` ever throws PAST its own rescueWithTimeout catch (a bug in the timeout wrapper itself), the target's failure produces no output line at all — the run finishes and prints nothing about it, where every other failure path in fleet rescue prints a per-studio line.
- **Proposed fix:** add `console.error(\`rescue ${item.id}: worker threw past its own catch\`, err)`-shaped line (read the actual variable in scope), keep swallowing.

### F12. cli/paste-mac.ts:30,32 — paste failure reads as "nothing on clipboard" — GLM-OK

- **Sites:** `file.delete().catch(() => {})` (fine — best-effort cosmetic cleanup, commented) and the outer `catch { return null; }` whose comment only explains the ENOENT-for-pngpaste case.
- **Risk:** `ctrl-v` maps null to "forward nothing" (fleet.ts's paste path). A pngpaste that EXISTS but fails (a screenshot API error, a corrupt tmp file read) produces the same silent null as "no image" — the operator cannot tell "clipboard empty" from "paste broke".
- **Proposed fix:** in the outer catch, one stderr line naming the non-ENOENT cause before returning null; keep the ENOENT case silent (it is the ordinary no-pngpaste machine case, and the comment already owns it).

### F13. src/studio/frames.ts:10 — deliberate but unannotated — GLM-OK

- **Site:** `parseFrame`: `} catch {}` then `return { type: "ignore" }`.
- **Risk:** none functionally — a malformed control frame must degrade to "ignore", never throw into a WS message handler; logging raw frame bytes into a terminal stream would be noise. But it is the only bare `catch {}` in src/ (the grep's first hit), and nothing at the site SAYS it is deliberate, unlike every sibling in this codebase.
- **Proposed fix:** comment only: `catch { /* a non-JSON frame is data, not control — ignore */ }`. No behavior change.

### F14. cli/orca-workspace.ts:1267 — lock-release unlink can hide a real error — GLM-OK

- **Site:** registry-file lock: `unlinkSync(path)` in a `finally`, `catch { /* raced a stale-lock steal ... */ }`.
- **Risk:** the comment covers exactly one legitimate case. A real failure (EACCES, EPERM, a read-only fs) is swallowed identically, and the next acquirer hits EEXIST forever with no cause logged — a wedge whose only symptom is "timed out waiting for another fleet command's lock".
- **Proposed fix:** `catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(...); }` — the raced-release case ends with the file gone (ENOENT); everything else should print.

### F15. src/board/board.ts:508 — first add-retry swallows the reason — GLM-OK

- **Site:** `addStateAfterRemove`: first `api.addLabels` attempt `catch { /* one retry below */ }`.
- **Risk:** the pattern is deliberate (issue #82's double-500 heal) and the SECOND attempt's failure is fully handled (restore + rethrow + log). But a first-attempt failure that the second attempt survives is never recorded anywhere — a transient GitHub failure the operator should still see once is indistinguishable from a first attempt that never happened.
- **Proposed fix:** `catch (err) { console.warn(\`board: first addLabels for #${number} failed, retrying once\`, err); }` before the retry. Behavior identical.

## CLAUDE-ONLY (listed, nothing filed)

- F6 (rescue.ts:111) — rescue module.
- write-proxy/, leak-gate, auth.ts, creds/, deploy/, failover.ts, accounts routing: all catch sites read; all either log, return named reasons, or carry issue-cited comments. No silent swallows found in them this pass beyond F6's neighbor.

## Proposed follow-ups

One issue per batch, `fix(GLM-OK): S13-Fn <short>`, filed from this doc. Batches:
- **S13-F1** junior authz malformed-record log (finding 1)
- **S13-F2** orcaJson unparseable-output throw (finding 2)
- **S13-F3** wake gate sighting/switchedBlock log-once (findings 3+4)
- **S13-F4** provider-refusal config-vs-policy split (finding 5)
- **S13-F5** one-log-line batch: webhook parse, pty close, writer close, usage insert, rescue-all worker, paste-mac, lock unlink, board first-retry, frames comment (findings 7,8,9,10,11,12,14,15,13)

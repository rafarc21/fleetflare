# Type-safety sweep 10 — apps/fleet src+cli (2026-10-12)

Ref #429. Analysis only, read-only, no code changed. Tenth maintainability sweep; scope `apps/fleet/src/**` and `apps/fleet/cli/**` minus `container/`. Line refs = physical lines at `origin/main` `fbb61d1`, paths relative to `apps/fleet/`.

Sweeps 1-9 (docs/maintainability/*.md) and the open deepen(*) issues they filed are NOT repeated here.

**Tier rule (from #429):** GLM-OK = none of auth, secrets, credentials, rescue, failover, accounts routing, deploy, migrations, write-proxy, leak-gate. CLAUDE-ONLY = touches any of those.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | 24 `res.json() as StudioStatus` casts in cli/ → one guarded decoder | GLM-OK |
| 2 | github/api.ts unguarded wire casts (`{sha}`, `{content}`, `{token}`) → narrow reads | GLM-OK |
| 3 | telegram api.ts double cast: `as TelegramApiResponse` then `result as {message_id}` → checked result | GLM-OK |
| 4 | approvals/store.ts `r.action as GateAction` — guard exists unused (`isGateAction`) | GLM-OK |
| 5 | memory/compact.ts `byTarget.get(target)!` after membership check → checked get | GLM-OK |
| 6 | burn.ts 9 non-null asserts over cursor maps → `?? default` / checked accessors | GLM-OK |
| 7 | do.ts `withDiscardNote(...)!` double-null contract → restructure return | GLM-OK |
| 8 | provision.ts `JSON.parse(...) as Record<string, string>` on STUDIO_MEMBERS_B64 → typeof guard | GLM-OK |
| 9 | DynamicEnv env casts in accounts.ts/app.ts/auth.ts — CLAUDE-ONLY (accounts routing, tokens) | CLAUDE-ONLY |
| 10 | write-proxy/ all casts — CLAUDE-ONLY (write-proxy) | CLAUDE-ONLY |

### F1. One guarded studio-row decoder behind the CLI's 24 `as StudioStatus` casts — GLM-OK

- **Files:** `cli/status-poll.ts:45`, `cli/recycle-outcome.ts:195`, `cli/destroy-outcome.ts:151`, `cli/ff.ts:106,118,210`, `cli/fleet.ts:692,730,853,875,1130,1177,1317,1378,1431,2382,2425`, plus `src/studio/registry.ts:382,434` (`JSON.parse(row.value) as StudioStatus`, D1 rows). Every CLI read of `/studio/` routes trusts `res.json()` shape with zero runtime check.
- **Risk:** a Worker older/newer than the CLI (mixed versions during deploy windows) answers with a different row shape; `studio.state` reads `undefined` and downstream code takes the wrong branch silently — e.g. `destroyRaceOutcome` at `cli/fleet.ts:2425` reads `state === "stopped"` off an unvalidated cast to pick destroy-vs-refuse.
- **Proposed fix:** one `parseStudioStatus(raw: unknown): StudioStatus | null` (typeof-check id/state/error + state ∈ StudioState) in a new import-free module next to `status-poll.ts`; CLI readers call it and fail with a named error on null, the same tagged-result shape `readStatus` already established. registry.ts rows reuse it (null → existing "malformed" path). Never a new dep.

### F2. github/api.ts wire casts with no runtime check — GLM-OK

- **Files:** `src/github/api.ts:100` (`JSON.parse(text) as { sha: string }.sha` — merge commit sha), `:223` (`as { content?: { sha?: string } }`), `:291` (`as { total_count?, repositories? }` — this one already typeof-guards its members), `:536` (`as { permissions?: { push?: boolean } }`), `src/github/app.ts:199` (`as { token: string; ... }` — installation token body).
- **Risk:** GitHub error bodies that still parse as JSON (a 200-shaped proxy page, a schema change) become `sha: undefined`; the value flows into commit refs and URLs. Low likelihood (GitHub's shapes are stable) but the fix is 3 lines per site.
- **Proposed fix:** keep the cast shapes but read through a tiny `field<T>(obj, key, pred)` helper (or inline `typeof x.sha === "string" ? x.sha : throw` with the site's own error framing). app.ts's `token` read: check `typeof parsed.token === "string"` before returning — that one is on the mint path. GLM-OK: shape reading only, no token handling change.

### F3. telegram api.ts: cast-on-cast for `message_id` — GLM-OK

- **Files:** `src/telegram/api.ts:108` (`JSON.parse(text) as TelegramApiResponse`), `:139` (`(result as { message_id: number }).message_id`), and the sibling inline shape at `:26` (`as { ok?; description?; result: { message_id: number } }` pushed at `:37`).
- **Risk:** Telegram's `result` is `unknown` in the interface; the `as { message_id: number }` double-cast means a 200-ok body with a missing result (Telegram has done this on partial outages) becomes `NaN`-adjacent `undefined` in `ids`, later `editCard` calls target a broken message_id.
- **Proposed fix:** `call()` keeps returning `unknown`; `sendCard` narrows with `typeof (result as {message_id?: unknown})?.message_id === "number" ? ... : throw new Error("telegram sendMessage returned no message_id")`. Same for the `sendMessage` chunker's inline body. Never a new dep.

### F4. approvals/store.ts: `r.action as GateAction` — the guard already exists — GLM-OK

- **Files:** `src/approvals/store.ts:41-43` — `action: r.action as GateAction`, `state: r.state as ApprovalState`, `params: JSON.parse(r.params) as Record<string, string>`; `src/tasks/types.ts:7` exports `isGateAction` (unused by store.ts).
- **Risk:** D1 row hand-edited or written by an older Worker → an action string outside the GateAction union reaches `gates.ts:227`'s exhaustive switch and falls through its `unknown gate action` throw only at execution time; the union type promised it could not.
- **Proposed fix:** `isGateAction(r.action) ? r.action : throw` (or a tagged result) at `toApproval`; same one-line shape check for `params` (`Object.values(...).every typeof string`). `isGateAction` already exists — this wires it in. GLM-OK: D1 row validation, not the gate decision path.

### F5. memory/compact.ts: `byTarget.get(target)!` after a membership check three loops earlier — GLM-OK

- **Files:** `src/memory/compact.ts:292,310` (`const f = byTarget.get(target)!`), validated only by the `named`-list membership sweep at `:277-281`; also `:99,167` (`target.split("/").pop()!`).
- **Risk:** the invariant "every demote/promote target passed the `named` check" holds today but is 15 non-local lines away; a future edit that reorders the checks turns `undefined` derefs into a compaction crash.
- **Proposed fix:** checked get — `const f = byTarget.get(target); if (!f) return refuse(...)` at each site (the refuse shape is already the function's error channel), and `.pop() ?? ""` at the split sites. GLM-OK: pure planning module, tests exist (test/bun/compact-*.test.ts).

### F6. burn.ts cursor-map non-null asserts — GLM-OK

- **Files:** `src/studio/burn.ts:950` (`sessions[mapKey]!`), `:1201` (`lastSeenAt[pkey]!`), `:1207` (`cursor.fileOffsets[pkey]!`), `:1357` (`ids[i]!` inside a bounded loop), `:1956,1958,1981,1999` (`measured.get(...)!`, `starts.get(name)!`).
- **Risk:** each asserts an invariant the surrounding loop establishes (comment at :947 says "never null in practice"); a malformed cursor from R2 turns the burn tick into a TypeError instead of the soft-skip the module promises elsewhere (`decodeAccountBurnState`'s own "corrupt row reads as no burn" rule).
- **Proposed fix:** replace with checked access: `sessions[mapKey] ?? { hash: null, ... }` seed shape where the rule (h) comment already defines a default; `?? 0` on offsets (rule j writes it back the same tick); `continue` on missing measured/starts. Characterization: test/bun/burn-cursor tests pass unchanged; add one corrupt-cursor case. GLM-OK: read path only, no rescue/failover.

### F7. do.ts `withDiscardNote(...)!` — a double-null contract asserted away — GLM-OK

- **Files:** `src/studio/do.ts:1883` and `:2011` — `withDiscardNote(...)!` where `withDiscardNote` (defined `:1769-1775`) returns `string | null` and is called with a non-null argument, so the `!` documents that the OTHER call sites (`:1970`, `:2003`) pass nullable `error`. Also `:1444` (`atob(m[2]!)` — regex `[A-Za-z0-9+/=]*` can match empty, `atob("")` is fine but `m[2]` after `+`-less `*` can be undefined), `:6410,8543` (`comments[i]!.body` — index guard is the loop bound, safe today).
- **Risk:** the `!` asserts a property of the *call site*, not the function; a future `error: string | null` caller copying the shape gets a silently-null status error.
- **Proposed fix:** split the helper: `appendDiscardNotes(note: string): string` (non-null in, non-null out) for the two asserted sites, `withDiscardNote` stays for the nullable ones. GLM-OK: do.ts recycle path but the change is type-shape only; rescue itself untouched.

### F8. provision.ts STUDIO_MEMBERS_B64 cast — GLM-OK

- **Files:** `src/studio/provision.ts:1416` — `JSON.parse(atob(env.STUDIO_MEMBERS_B64 || "e30=")) as Record<string, string>` inside a try/catch that catches only parse throws, not shape lies; `:1893` — `JSON.parse(listingText) as {name; path; type}[]` (blueprint member listing, no guard; `entry.type` compared at :1897 so a non-object entry throws TypeError, not the isNotFoundError path).
- **Risk:** a truncated base64 bundle decodes to a JSON array of numbers; `Object.keys(bundle)` on an array yields indices — the assert gate enumerates wrong lines with no error.
- **Proposed fix:** `typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every(x => typeof x === "string")` before the loop (else skip with the existing catch posture); for :1893, `Array.isArray(parsed)` before iteration. GLM-OK: bring-up assertion path, no credential content.

### F9. DynamicEnv computed-name env casts — CLAUDE-ONLY (accounts routing, tokens)

`src/studio/accounts.ts:91` and `:1125` (`env as unknown as Record<string, string | undefined>` over the account-token namespace), `src/github/app.ts:153`, `src/github/auth.ts:174,184,229`, `src/write-proxy/mode.ts:103` (installation-token env names). The cast is deliberate — `Env` cannot declare `CLAUDE_ACCOUNT_<n>`-pattern names — and each read typeof-checks its value. But these sit on accounts routing and token selection; recorded for the Claude lane, nothing filed.

### F10. write-proxy/ casts — CLAUDE-ONLY (write-proxy)

`src/write-proxy/gh-route.ts:82` (`as unknown as GhOp` after full shape validation), `:154,157` (GitHub response casts), `git-route.ts:166` (DecompressionStream ReadableWritablePair cast — a workers-types gap), plus the same kind of "structurally identical, cast only to satisfy TS" storage casts as do.ts's in `src/studio/do.ts:1822,2221,2265,2273,2429,2440,2443,4787-4792,5060-5061,5073,5094,5229,5331,5528` and `failover.ts:2178,2194`, `burn.ts:1605,1655,1657`, `destroy.ts:311`, `creds/test-creds.ts:58`, `directus/client.ts:218`. The write-proxy and failover slices are the operator's push/credential paths; the do.ts storage-port casts are the deliberate "real DO storage supports arbitrary keys" pattern each site's comment already documents. Recorded for the Claude lane, nothing filed.

## Not filed (deferred / noted)

- `cli/fleet.ts:2589` (`JSON.parse(text) as {url; pr; ...}` after `res.ok` on the memory-compact route) and `cli/fleet.ts:552,597` (open-prs route, already narrows with `Array.isArray`) — same F1 class, fold into F1's issue when the decoder module lands.
- `cli/orca-workspace.ts:425,1296`, `cli/junior.ts:32,138,193`, `cli/accounts.ts:101,321`, `cli/backoff.ts:64`, `cli/diag.ts:54`, `cli/repair-failure.ts:30` — CLI reads of local files or this fleet's own Worker; same shape as F1 but lower blast radius; listed in F1's issue scope as optional follow-on sites.
- `@ts-expect-error` usage (src/studio/session-sync.ts:309 reference; test files) — all carry explicit reason comments; no unreasoned suppressions found. Zero `@ts-ignore` in scope.
- `src/github/webhook.ts:108,144,165` and `:245,642` — the parse sites are guarded, but the file is webhook/authz-adjacent; left out of this sweep's filed set.
- `src/studio/survival-delivery.ts:378-554,825,943` non-null asserts and `cli/columns.ts:32`, `cli/wip-format.ts:231`, `cli/accounts.ts:166`, `cli/orca-workspace.ts:392`, `src/studio/failover.ts:675` — each guarded by an adjacent conditional (match-before-read, length-check-before-index); counted, nothing to fix.

## Counts

8 GLM-OK findings (F1-F8) → one deepen issue each. 2 CLAUDE-ONLY (F9, F10) recorded here for the Claude lane, no issue filed by this sweep (maestro files those).

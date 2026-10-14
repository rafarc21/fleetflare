# CLI usage drift sweep 42 — README/docs fleet command examples vs actual fleet usage text (2026-10-14)

Ref #849. Analysis only, read-only, no code changed, no doc fixed here — this doc records findings; fixes land as separate tasks it spawns. Forty-second maintainability sweep: documentation drift for the CLI surface — fleet subcommands/flags shown in README.md, docs/**, apps/fleet/docs/** vs the usage text printed by the fleet CLI (apps/fleet/src/studio/cli-args.ts CLI_USAGE + VERBS, apps/fleet/src/studio/ff.ts, apps/fleet/container/studio-fleet HELP).

Exclusions per sweep-34 precedent (docs/maintainability/2026-10-13-cli-docs-drift-sweep-34.md): docs/superpowers/ (archived working material), docs/fleet/README.md (dated 2026-08-03 record-of-truth snapshot), docs/fleet/firstmate-analysis.md, skipperm-effort-report.md, spike-lead-tools.md (dated records), apps/fleet/docs/plans/ (119 dated plan records), docs/maintainability/*.md (the sweeps' own dated records).

**Lane rule (from the task):** GLM-OK = none of auth, secrets, tokens, credentials, rescue, failover, accounts routing, deploy, migrations, write-proxy, leak-gate, approvals. CLAUDE-ONLY = any of those.

## Method

Every `fleet <verb>` and `ff` span extracted from scope docs by grep; every documented flag cross-checked against the live parser: verb set from src/studio/cli-args.ts VERBS + the per-verb bespoke parsers (task/junior/memory/accounts/models cases), ff grammar from src/studio/ff.ts, in-container verbs from container/studio-fleet HELP. Line refs = physical lines at branch base ecca3f3.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | docs/fleet/directus.md's DIRECTUS_TOKEN setup says bare `cd apps/fleet && wrangler secret put` — the repo's own rule is `scripts/deploy.sh secret put`, never bare | CLAUDE-ONLY |

### S42-F1. docs/fleet/directus.md:139 — bare `wrangler secret put DIRECTUS_TOKEN` — CLAUDE-ONLY

- **Site:** docs/fleet/directus.md:139 — "cd apps/fleet && wrangler secret put DIRECTUS_TOKEN" (the `DIRECTUS_TOKEN` setup section's step 4).
- **CLI truth:** docs/setup.md:344 (the repo's own operator rule): "Use `scripts/deploy.sh`, never a bare `wrangler secret put`: there is no `apps/fleet/wrangler.jsonc` tracked in this repo for a bare `wrangler` invocation to find your Worker's name in, so it fails with `Required Worker name missing`." docs/setup.md:399 spells the correct form for this exact secret: `scripts/deploy.sh secret put DIRECTUS_TOKEN`. Following directus.md's step 4 as written fails on a fresh checkout for the exact reason setup.md names, and the two docs in the same repo contradict each other on the same operation.
- **Lane:** secrets (a Directus static access token) → CLAUDE-ONLY per the task's rule. Recorded here; fix filed separately from the GLM lane.
- **Proposed fix:** docs/fleet/directus.md:139 — `scripts/deploy.sh secret put DIRECTUS_TOKEN` (run from apps/fleet), matching setup.md:399 and its never-bare rule.

## Verified clean (recorded, nothing filed)

Every fleet/ff verb and flag claim in scope checked out against the live CLI — recorded so the next sweep does not re-derive it:

- README: daily-use block (:131-138) — `fleet ls`, `fleet check <id>`, `fleet task ls`, `fleet task new --title T --objective O --output F --boundaries B`, `fleet provision <id>`, `fleet recycle <id>`, `fleet destroy <id>` all match VERBS rows; `fleet ls` extra-columns parenthetical (:149-151) names all 12 extras past ID/STATE/READY/BURN (REPO, RST, WIP, PRS, SESSION, ACTIVITY, CHECKED, ROW, ACCOUNT, HOST, REFRESHED, ERROR) — matches cli/fleet.ts's header row, sweep-34 F1 fixed and holding; ff block (:121-127) — `ff web-studio`, `ff web-studio "<brief>"`, `ff web-studio 412` (adopt, `#` optional per ff.ts:88), bare `ff` refuses (board #250) all match src/studio/ff.ts parseFfArgs; `bun link` provides `fleet` and `ff` matches apps/fleet/package.json bin.
- docs/setup.md: `fleet junior enable --account <id>` / `disable` (:51-53) matches cli-args.ts:1126-1144 junior parser; `fleet accounts` block (:772-775) — bare/`--write-labels`/`sync`/`sync --watch` all match the accounts parser + VERBS.help (watch 60s, writes via /studio/accounts/sync); `fleet spawn`/`fleet provision` account-resolution stderr claims (:701-707) match formatAccountResolution; `fleet recycle <id> --account mapped` (:715-716) matches the recycle parser (literal "mapped" only); bare `fleet memory` answers "memory is off" (:443) matches cli-args.ts:1108-1116 (bare = memory-ls alias, Worker answers off when FLEET_OPS_REPO unset); `fleet attach <id>` (:29) and attach-through-Worker (:423) match the attach verb; `bun run migrate:local/migrate:remote/deploy --allow-unrescued` (:788-798) match package.json scripts + deploy.sh (flag consumed by deploy.sh, never wrangler); every `scripts/deploy.sh secret put <NAME>` row (:385-399) is the correct form.
- docs/operations.md: `fleet models` / `assign <studio> <model>` / `promote <model>` / `demote <model>` (:148-154) match cli-args.ts:1202-1215 models parser + VERBS rows (bare models = models-ls); `fleet spawn --lead glm|kimi|deepseek` (:156) matches spawn's `[--lead claude|glm|kimi|deepseek]`; `fleet creds get <name>` (:111) matches container/studio-fleet HELP (:79) with the exact in-container context (a studio fetches it, not the Mac); `fleet rescue-all` pre-deploy-gate claims (:40, :61) match VERBS.rescue-all help.
- docs/architecture.md: `fleet spawn --new` instances sentence (:52) matches VERBS.spawn (#269) — sweep-34 F2 fixed and holding; `fleet recycle`/`fleet destroy` rescue-first (:68, :92) match VERBS; `bun run deploy` rescue gate (:118) matches deploy.sh.
- docs/env-vars.md: `fleet creds get` (:90), `fleet junior enable` (:139), `fleet ls` (:41) — all exist, correct context.
- CONTRIBUTING.md, docs/threat-model.md, docs/fleet/directus.md (except finding 1), apps/fleet/docs/maintainability/2026-10-12-cli-coverage-sweep-11.md + 2026-10-13-duplicate-types-sweep-29.md: no fleet/ff command spans, or only spans that check out.
- No scope doc names a fleet/ff verb that does not exist: full token diff of `fleet [a-z-]+` / `ff [a-z-]+` mentions against the verb set found zero documented-but-gone or renamed verbs. `fleet help` (:488) exists; `ff --help`/`-h` (ff.ts:185) exists.
- Sweep-34's two CLAUDE-ONLY findings (operations.md:102 bare `wrangler d1 execute --remote`; operations.md:120 bare `wrangler secret put INFISICAL_*`) are STILL present in operations.md at this sweep's base — drift persists, but both are already filed and owned by OPEN issues #774 and #773 respectively. Not re-filed here; re-recording only that they remain open.

## Proposed follow-ups

One issue per actionable batch:

- **S42-F1** docs/fleet/directus.md: correct the DIRECTUS_TOKEN put to `scripts/deploy.sh secret put` — CLAUDE-ONLY lane, filed as `docs(CLAUDE-ONLY): S42-F1 ...`.

No GLM-OK findings this sweep: every fleet/ff verb and flag in the in-scope docs matches the live CLI.

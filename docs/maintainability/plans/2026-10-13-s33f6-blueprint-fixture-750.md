# Plan — S33-F6: shared fake-blueprint fixtures helper (#750)

Sweep 33 finding F6 (refs #733): 7 suites each define a private
FAKE_FLEET_JSON / FAKE_ORG_JSON / FAKE_ROLE_MD triple, and most also a
path-dispatching `fetchBlueprintFile` fake. Divergence between the suites
is load-bearing — role lists, refs, org edges and role-md contents encode
each suite's org shape — so this folds via a builder with options, not one
shared literal.

## New file: apps/fleet/test/helpers/blueprint-fixture.ts

One builder, options only, no defaults that would silently merge two
suites' shapes:

```ts
export interface FakeBlueprintOpts {
  repo: string;            // blueprint.repo, e.g. "acme-org/websites"
  ref?: string;            // blueprint.ref, default "main"
  roles: string[];         // roles array — REQUIRED, no default
  roleMd: { name: string; prompt: string; allowedTools?: string; reportsTo?: string; keepAliveFalse?: boolean };
  edges?: Record<string, string[]>;   // org.json edges, default { cto: ["release"] }
  gates?: Record<string, string[]>;   // org.json gates, default { merge: ["release"] }
}

export interface FakeBlueprintFiles { fleetJson: string; orgJson: string; roleMd: string; }

export function fakeBlueprintFiles(opts: FakeBlueprintOpts): FakeBlueprintFiles;

// Path dispatcher matching ProvisionDeps["fetchBlueprintFile"]: routes
// fleet.json / org.json / any .md to the built triple, throws on anything
// else (message `fakeBlueprintFetch: unexpected path ${path}`).
export function fakeBlueprintFetch(files: FakeBlueprintFiles): ProvisionDeps["fetchBlueprintFile"];
```

`roleMd` builder emits exactly the frontmatter shape every suite shares
(name/skills:[]/allowedTools/may_spawn:[]/reports_to/gates + optional
`keep_alive: false` line), with `allowedTools` defaulting to the majority
`"Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Edit Write"` (suites that
carry fewer tools pass their own string).

Two dispatch styles exist and both stay supported:
- endsWith-style (`path.endsWith("fleet.json")` … `.md` catch-all) — used
  by routes-handle, routes-accounts, refresh, spawn.
  `fakeBlueprintFetch` uses THIS style.
- exact-path style (`path === "fleet.json"`, exact role/studio paths,
  notFound throw) — used by provision, directus.provision,
  recycle-guard. Those keep their local dispatchers (they probe exact
  404 shapes and studio paths), but their triple STRINGS come from
  `fakeBlueprintFiles`.

## Per-suite fold (values preserved byte-for-byte per suite)

| suite | fleet.json | roles | role md | org |
|---|---|---|---|---|
| studio.routes-handle.test.ts | acme-org/websites, main | [pilot] | pilot, default tools, prompt "You are pilot. Work carefully. Small commits." | default |
| studio.routes-accounts.test.ts | same | [pilot] | same | default |
| studio.refresh.test.ts | same | [pilot] | pilot, default tools, prompt "You are pilot. Work carefully." (shorter — keep per-suite prompt) | default |
| studio.provision.test.ts | acme-org/websites, main | [pilot, scratch] | scratch, default tools, prompt "You are scratch. Sandbox role, low stakes." | default |
| directus.provision.test.ts | acme-org/websites, main | [pilot, scratch] | scratch, tools "Bash(git *) Read", prompt "You are scratch. Sandbox role, low stakes." | default |
| studio.recycle-guard.test.ts | rafarc21/fleetflare, main | [web-studio] | web-studio, tools "Bash(git *) Bash(fleet *) Edit Write", prompt "You are web-studio. Sandbox role, low stakes." | default |
| studio.spawn.test.ts | acme-org/websites, v1.0.0 | [pilot, release, scratch, cto] | release, tools "Bash(git *) Edit", reportsTo cto, prompt "You are release. Merge carefully." | edges {pilot:[release], operator:[cto,pilot,scratch]}, gates default |

Variant fixtures that STAY local (suite-specific org shape — do NOT fold):
- FAKE_ROLE_MD_KEEP_ALIVE_FALSE (routes-handle, routes-accounts) — after
  folding the base md, rebuild this as the local literal or an md
  interpolation over the shared prompt; keep bytes identical.
- FAKE_ROLE_MD_CTO + FAKE_FLEET_JSON_CTO (routes-handle, inside the
  ROLE_EFFORT describe) — stay local.
- FAKE_STUDIO_MD / FAKE_MEMBER_*_MD / FAKE_MEMBERS_LISTING
  (studio.provision, directus.provision) — stay local.
- routes-handle's degrade test with roles:["dev"] inline fleet.json —
  stays inline (deliberately different shape).

Dispatcher folds per suite:
- routes-handle + routes-accounts: delete local FAKE_* triple consts and
  local fakeFetchBlueprintFile(); import { fakeBlueprintFiles,
  fakeBlueprintFetch } from "./helpers/blueprint-fixture"; module-level
  `const FAKE = fakeBlueprintFiles({...})` and
  `fakeFetchBlueprintFile()` default becomes
  `fakeBlueprintFetch(FAKE)`. Keep local names FAKE_ROLE_PROMPT etc. ONLY
  where asserted (routes suites assert `appendHouseRules(FAKE_ROLE_PROMPT)`).
- refresh: same endsWith fold; note its dispatcher lacks the throw arm —
  fakeBlueprintFetch's throw is unreachable for its paths, safe.
- spawn: fakeBlueprintFetch(overrides) helper keeps its `overrides`
  seam + `calls` capture — only the triple strings route through
  fakeBlueprintFiles. Its inline ternary at the namespace deps stays,
  referencing the shared strings.
- provision / directus.provision / recycle-guard: triple strings from
  fakeBlueprintFiles; local exact-path dispatchers keep referencing the
  built strings (keep local alias consts, e.g. `const { fleetJson:
  FAKE_FLEET_JSON, orgJson: FAKE_ORG_JSON, roleMd: FAKE_ROLE_MD } =
  fakeBlueprintFiles({...})` — smallest diff, assertions untouched).

Assertions that read fixture values (must keep passing byte-identical):
- routes-handle 538: `appendHouseRules(FAKE_ROLE_PROMPT)` — keep a local
  FAKE_ROLE_PROMPT const matching the builder's prompt option.
- routes-accounts 1494/1507: same FAKE_ROLE_PROMPT pattern.
- provision 242: `ROLE_ALLOWED_TOOLS` expects the default tools string;
  provision 241: ROLE_PROMPT_B64 expects `appendHouseRules(FAKE_ROLE_PROMPT)`.
- No suite asserts the fleet.json/org.json bytes directly (grep verified).
- recycled-guard asserts nothing on the strings — dispatcher only.

## Out of scope

- helpers/fake-namespace.ts, fakeStorage(), studio-row.ts — different
  sweeps own them.
- FAKE_STUDIO_MD/member fixtures — only 2 suites, deliberately divergent
  content; sweep census does not name them.

## Verification (one heavy gate at a time)

1. `npx vitest run` on the 7 touched files — expect 589 passed (baseline
   measured 2026-10-13 on this branch: 7 files, 589 passed, 16.37s).
   Run ALONE — vitest-pool-workers is the heavy gate.
2. `bun run check` (5x tsc) — exit 0, run ALONE, nothing in parallel.
   New helper file compiles under the `test` tsconfig.
3. `bun run english-check` — exit 0.
4. `bun run test-lies-check` — exit 0 (fixtures are test data, not
   source-reading mocks — must stay clean).
5. `git diff origin/main --stat` — expect 8 files touched (1 new helper,
   7 suites), net line removal ~80+.

## Git discipline

1. First commit: THIS plan doc (already on branch) —
   `docs(fleet): S33-F6 plan — shared blueprint fixtures helper (refs #750)`.
2. Second commit: the fold, message
   `test(fleet): S33-F6 fold 7 suites' blueprint triples into helpers/blueprint-fixture.ts (refs #750)`.
   Push right after first commit and right after the fold.
3. Never more than 15 min unpushed. Never commit to main. Never write
   /workspace/.fleet/done/750.json — lead's step.

## Report back (final output, to lead)

- Commits pushed (sha + subject), verify `git log origin/main..HEAD --oneline`.
- vitest tail verbatim (pass counts + duration), check/english/test-lies
  exit codes.
- Net line delta (helper added vs folded suites) from
  `git diff origin/main --stat`.
- Any byte-diff found in a fixture string that forced a plan deviation,
  with the exact old/new bytes.

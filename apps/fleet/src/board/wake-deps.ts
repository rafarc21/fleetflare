// Issue #263: the ONE real `AssignWakeDeps` wiring, shared by board/routes.ts
// (assign wake) and github/webhook.ts (comment wake).

import type { Env } from "../env";
import type { AssignWakeDeps } from "./assign-wake";
import { repoTokenMinter } from "../github/auth";
import { resolveCanonicalRepoName } from "../github/api";
import { listStudios } from "../studio/registry";
import { getStudioStub } from "../studio/profile";

/**
 * The real ports the wake edge needs, wired to D1 and to the Durable Object
 * namespace.
 *
 * `studioState` reads the registry FIRST and the DO only after — board
 * #40/#49's lesson: `idFromName` on a name nothing else uses mints a fresh,
 * empty Durable Object and the call succeeds, so a wake aimed at a studio
 * that does not exist lands on a phantom and reports nothing. The id is never
 * composed here; it arrives as written on the task's own `studio:` label,
 * which the operator CLI folded through `repoIdSegment` (src/studio/repo.ts)
 * before it was ever an assignee. Re-deriving that fold is exactly the bug
 * #49 fixed.
 *
 * `wake` calls `wakeStudioOnAssignment`, NOT `wakeStudio`: the DO-side method
 * that runs the stopped and pane gates (src/studio/wake.ts's runGatedWake)
 * before a single keystroke reaches the container.
 *
 * `repoSlug` (issue #278) rides along from the SAME `listStudios(env)` row —
 * it is already a field on the registry, just not read here before this fix.
 * `wakeOnAssign` uses it to refuse a wake into a studio provisioned for a
 * different repo than the task's own.
 */
export function realWakeDeps(env: Env): AssignWakeDeps {
  const mint = repoTokenMinter(env);
  return {
    studioState: async (studioId) => {
      const row = (await listStudios(env)).find((s) => s.id === studioId);
      // `?? null`: a registry row written before `repoSlug` existed (or by a
      // test fixture that omits it) has NO such key in its stored JSON at
      // all, so `row.repoSlug` reads `undefined`, not `null` — and
      // `undefined !== null` is true, which would run the repo compare on
      // `undefined.toLowerCase()` instead of failing open the way a genuine
      // `null` does. Normalized at this one read boundary rather than in
      // assign-wake.ts's own check, the same posture StudioStatus.repoSlug's
      // own doc comment already documents for this exact ambiguity.
      return row ? { state: row.state, repoSlug: row.repoSlug ?? null } : null;
    },
    wake: async (studioId, prompt) => (await getStudioStub(env, studioId)).wakeStudioOnAssignment(prompt),
    // Issue #284 round 2 (issue #268's own fix, reused): GitHub's canonical
    // owner/name for a possibly-stale `repoSlug` — see assign-wake.ts's
    // `AssignWakeDeps.resolveCanonicalRepo` for why a live lookup, not a
    // lexical trick, is what a rename or ownership transfer needs.
    resolveCanonicalRepo: async (slug) => resolveCanonicalRepoName(await mint(slug), slug),
  };
}

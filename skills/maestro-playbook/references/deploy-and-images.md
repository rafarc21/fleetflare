# Deploy and image rollout

## The deploy sequence

- **Staging first, always.** Prod only on the operator's explicit GO, per
  release — never inferred, never "probably fine this time".
- **Chain the deploy script `&&`: build → migrate → deploy.** Never run a bare
  deploy command on its own. A deploy that skips this chaining has left
  migrations unapplied on prod for weeks before anyone noticed.
- **Verify the SERVED artifact equals the build**, not just that the deploy
  command exited 0. Merged is not deployed, and deployed is not necessarily
  the thing you think you just deployed — see the next section.
- **Deploy only from a clean worktree of current `origin/main`.** Never from a
  stale or dirty checkout — dirty files sitting under the image's build
  directory bake straight into the image. A deploy run from a checkout that
  was weeks old once pushed an old container image fleet-wide; every studio
  bring-up died for roughly 3.5 hours before anyone traced it back to the
  stale checkout.
- **Pre-prod checklist:** DB export, schema check, and an explicit exit-code
  assertion on every step — not just the last one.
- **A known deploy flake gets a documented manual path, written to memory the
  first time it is hit**, not re-discovered from scratch on the next
  occurrence.

## Image deploys specifically

- The deploy tool can print "no changes" while still keeping a stale image
  running. Trust the repo's own deploy script's result, then PROVE the new
  image landed by booting one throwaway studio and checking it directly —
  never trust a route's verdict or a version column for this.
- `fleet provision` reuses the studio's EXISTING container — it does not pick
  up a new image. Only `fleet recycle` does (see the fleet-cockpit skill for
  the exact mechanics and flags). Ordering mistake measured live: giving the
  order "deploy, then provision" to heal a studio onto the new image does
  nothing — provision heals the harness on the OLD container.
- **The first recycle after an image deploy can still land the old image.**
  This is a known platform race, not a one-off. If a studio still looks like
  the old image after one recycle, recycle it once more before escalating as
  broken.
- An image deploy replaces EVERY running container at once (full rollout, not
  a canary). Before one:
  - Agree a window with every coordinator whose studios are running, and hold
    image-changing PRs so they land as one batch instead of several separate
    fleet-wide replacements in a day.
  - A worker-only deploy (no image change) spares running containers — but
    confirm the image digest is actually unchanged first; "worker-only" is a
    claim about the diff, not a promise about what actually shipped.
  - Publish, on request, a short safe-list / do-not-touch list before any
    fleet-wide action that replaces containers: which studios are freely
    recyclable because their work already landed, and which hold the only
    copy of something not yet pushed anywhere else. A fleet-wide pause or
    image deploy issued without checking this first has, twice in one
    12-hour window, stopped studios in a REPO IT WAS NEVER SCOPED TO touch —
    once mid-brainstorm with the operator, once by killing every running
    agent fleet-wide because the stale image it shipped made a startup step
    fatal. Scope every fleet-wide action by repo, explicitly, before acting —
    see this skill's Role section.

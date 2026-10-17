# Gate runner Phase 1: enable

Epic #715. Off by default (`FLEET_GATE_RUNNER` unset). Phase 1 scope: one repo,
`rafarc21/fleetflare`. This doc deploys nothing. Operator runs each step.

## Preconditions

1. Phase 1 code on `main`.
2. GitHub App has `Commit statuses: write` (plan Task 0b). Without it every
   `gate/verdict` POST gets 403.
3. `Dockerfile.gate` image window open.
4. Root `fleet.json` has the `gate` block (this PR). Worker reads it from
   `AGENT_REPO`, which must be this repo.

## 1. Live `wrangler.jsonc` entries

Edit the LIVE config, not the example. Keep existing entries. Add:

Vars (merge into `vars`):

```jsonc
"vars": {
  "FLEET_GATE_RUNNER": "on",
  "GATE_RUNNER_REPOS": "rafarc21/fleetflare"
}
```

Workflow (`workflows`):

```jsonc
{ "name": "gate", "binding": "GATE_WORKFLOW", "class_name": "GateWorkflow" }
```

Durable Object binding (`durable_objects.bindings`):

```jsonc
{ "name": "GATE_RUNNER", "class_name": "GateRunnerDO" }
```

Migration (`migrations`). Live stops at tag `v3`, so this is `v4`. If live
already has a `v4`, use the next free tag. (The example file says `v5` only
because its `StudioBigDO` takes `v4`.)

```jsonc
{ "tag": "v4", "new_sqlite_classes": ["GateRunnerDO"] }
```

Container (`containers`). `durable_object` policy is fixed at class creation.
This policy takes `images`, not `image`, and rejects `instance_type` and
`max_instances`.

```jsonc
{
  "class_name": "GateRunnerDO",
  "scheduling_policy": "durable_object",
  "images": {
    "gate": { "dockerfile": "./container/Dockerfile.gate", "build_context": "./container" }
  }
}
```

Paths are relative to the config file. Adjust `build_context` if live sits elsewhere.

## 2. Boot smoke test (before real deploy)

From `apps/fleet`, with the LIVE config path:

1. Config and bundle check, no upload:
   `bunx wrangler deploy --dry-run --config <live-wrangler.jsonc>`
   Expect no error. Fix any binding, migration or container-policy error here.
2. Local Worker boot:
   `bunx wrangler dev src/index.ts --config <live-wrangler.jsonc>`
   Expect clean start. No missing-class or missing-binding error for
   `GateRunnerDO`, `GateOutbound`, `GateWorkflow`. Stop after boot.

Either step fails: do not deploy.

## 3. Deploy

Repo's normal path (`bun run deploy` in `apps/fleet`). Migration `v4` and
`GateRunnerDO` are created on this deploy.

## 4. First run

Pick one open PR in `rafarc21/fleetflare` whose head changes a gated path:
`apps/fleet/**`, `skills/**`, `fleet/blueprint/**`, `scripts/**`, or root
`package.json`. A PR touching none of them gets a green `gate/verdict` with no legs run.

From a clone (`origin` = `rafarc21/fleetflare`):

```sh
fleet gate start <pr>            # prints: gate-start: run <runId> started for PR #<pr>
fleet gate watch <pr> <runId>    # polls to a verdict; exit 0 green, 1 red, 2 error
```

Or one command, exit 0 green, 1 red, 2 error or gate off:

```sh
fleet gate run <pr>
```

`fleet gate run` is `gate start` then `gate watch` on the run id it prints. It
reads the repo from the folder's own `origin`, so it runs from any clone of a
gated repo. `apps/fleet/scripts/gate/maestro-gate.sh <pr>` wraps it and keeps
the same exit codes.

Expect a `gate/verdict` status on the PR head. This repo's gate fans out 13
containers per PR: merge-tree, 4 lane legs, 8 vitest shards. Check each leg
finished and the verdict matches local lanes.

## 5. Enable another repo

Config for a repo lives in that repo, not in the fleet. Three steps:

1. In the target repo's root `fleet.json`, on its default branch, add a `gate`
   block. The gate reads it at the PR's base sha, so a PR cannot edit its own
   gate. Example for `acme/example`:

   ```json
   "gate": {
     "install": "bun install --frozen-lockfile",
     "legs": ["lint", { "name": "e2e", "cmd": "cd apps/web && bun run e2e" }],
     "vitestCmd": "bun run test --shard={i}/{n}",
     "vitestShards": 4,
     "pathRules": ["apps/web/**", "package.json"]
   }
   ```

   A string leg `"lint"` runs `bun run lint`. An object leg runs its own `cmd`
   from the repo root. Leg names match `^[a-z0-9][a-z0-9-]{0,39}$`, are unique,
   and cannot be `merge-tree`, `bun-N` or `vitest-N`. `vitestCmd` is optional:
   without it the repo gets no vitest legs. The total legs per PR, merge-tree
   included, cap at 24.

2. Operator config: add the slug to `GATE_RUNNER_REPOS` in live `vars`
   (comma-separated, next to `rafarc21/fleetflare`), then redeploy. Only the
   fleet operator sets this. A repo cannot add itself.

3. From a clone of that repo, on an open PR whose head changes a `pathRules`
   path:

   ```sh
   fleet gate run <pr>
   ```

A repo with no `gate` block at the PR's base, or one that is malformed, is
failed: the gate posts a red status naming the base (no valid gate config).
Only removing the repo from `GATE_RUNNER_REPOS`, or setting `FLEET_GATE_RUNNER`
to `"off"`, switches a repo off. A PR that changes `fleet.json` gates on the
block its head introduces instead.

### Pick the gate image (`image` key)

A `gate` block may name the image its legs run in:

```json
"gate": { "image": "desktop", "install": "...", "legs": ["..."] }
```

- The value is a key of the operator's `images` map, never an image ref. Only
  `gate` (the default, used when the key is absent) and `desktop` are accepted.
  Any other value, including a registry ref, makes the block malformed: the
  repo is failed red (no valid gate config), as above.
- The operator binds each key in `GateRunnerDO`'s `images` map (`wrangler.jsonc`
  `containers[]`). `desktop` builds `container/Dockerfile.gate-desktop`, with
  `build_context` `./container`. The example file binds `gate` only; add
  `desktop` to the live file to use it.
- A key that the map does not bind fails every leg as an infra error (`gate
  image not bound (images.<key>)`). The gate never falls back to the shared
  image for it.
- `desktop` carries a Windows SDK and CRT. That licence keeps the built image in
  the operator's private registry only. Never push it to a public one.

## 6. Rollback

Set `FLEET_GATE_RUNNER` to `"off"` in live `vars`, redeploy. New starts refuse
(404); `fleet gate run` and `maestro-gate.sh` exit 2. Keep the `GateRunnerDO` class and migration.
Deleting the class destroys its Durable Object storage, so never remove it to roll back.

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
    "gate": { "dockerfile": "./container/Dockerfile.gate", "build_context": "." }
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
apps/fleet/scripts/gate/maestro-gate.sh <pr>
```

Expect a `gate/verdict` status on the PR head. This repo's gate fans out 13
containers per PR: merge-tree, 4 lane legs, 8 vitest shards. Check each leg
finished and the verdict matches local lanes.

## 5. Rollback

Set `FLEET_GATE_RUNNER` to `"off"` in live `vars`, redeploy. New starts refuse
(404); `maestro-gate.sh` exits 2. Keep the `GateRunnerDO` class and migration.
Deleting the class destroys its Durable Object storage, so never remove it to roll back.

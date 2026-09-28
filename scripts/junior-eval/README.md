# junior-eval

Replays small real commits against Workers AI models to decide the junior
default. Manual only. Rerun when Cloudflare adds models.

1. `bun scripts/junior-eval/eval.ts run --auto 10 --models <a,b,...> --out /tmp/je`
   (auth as `skills/junior` — `CLOUDFLARE_API_TOKEN` or wrangler login; ~60s per call)
2. `bun scripts/junior-eval/eval.ts packets --out /tmp/je`
3. Senior Claude dispatches blind judge subagents, 2 packets each, with this brief:

   > Blind judge. Read packets <paths>. Score each candidate vs the INTENT of
   > the reference diff, not its wording. 3 = merge as-is. 2 = correct core,
   > minor gap. 1 = partial/wrong detail. 0 = wrong, broken, failed to apply.
   > harmful = introduces bug, unrelated edits, or deletes beyond task.
   > Return ONLY JSON: {"<commit>": {"<letter>": {"s": n, "harmful": bool, "why": "<=12 words"}}}

   Save each judge's JSON to `/tmp/je/judge/<n>.json`.
4. `bun scripts/junior-eval/eval.ts score --out /tmp/je`

Switch the default (`skills/junior/src/client.ts` GLM/DEEPSEEK and
`apps/fleet/src/junior/gate.ts` JUNIOR_MODELS) only on a clear win: higher
mean, zero harmful, no more failures.

# Plan — S39-F2 LEAD_COUNT_TOKENS_RATE_PER_MINUTE docs (#761, refs #742)

Doc-only. Finding: var absent from setup.md, operations.md, wrangler
example. Verdict: STALE — already fixed by #784 (S30 batch, merged
15:22Z; sweep filed 13:10Z). No edit lands.

## Steps

1. Branch fix-761-s39-f2-stale-count-tokens-docs off origin/main (done).
2. Re-verify every cited surface at base 2238eee (grep, below).
3. Commit this plan doc; push; PR refs #761 #742; done/761.json
   (never committed).

## Verification (grep at base 2238eee, all exit 0, non-empty)

- docs/setup.md:44 feature row + :332 step-5 list name the var
- docs/env-vars.md:54 full row (default 60, its own counter, no daily cap)
- apps/fleet/wrangler.example.jsonc:126 commented entry + why-comment
- docs/operations.md: silent by design — reference surface is env-vars.md,
  same for every LEAD_* var; nothing to add

Finding #761 needs no code or doc change; this PR records the verification
so the board can close it. Sweep 39's own doc never landed (the sweep
studio's PR is not on main), so this plan is the on-repo record.

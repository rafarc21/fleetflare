# Accounts and capacity

- **Usage limits are the real bottleneck.** Never let work sit idle on one
  account's limit while another account on the same fleet has headroom. A
  whole night was once lost waiting while one account sat at 0% and a second,
  unused account had room the whole time.
- **Local:** an auto-switch daemon can move a session to whichever account has
  headroom, at a threshold of roughly 85% usage.
- **Fleet slots:** map a repo to the Claude account slot with headroom in the
  ops config; a worker-only redeploy applies the new mapping without an image
  change. A studio's recorded account is sticky once it has booted — move it
  with `fleet recycle <id> --account mapped` (see the fleet-cockpit skill for
  the account-mapping mechanics and the `fleet ls` ACCOUNT column).
- **Know which token sits in which slot, by evidence, never by guess.** Label
  every slot with the account's own email. Confirm a slot's mapping against
  what is actually on screen — the limit message's reset time, the usage
  reset times — never assume. When unsure which token is where, re-upload the
  token into a known slot rather than guessing which existing slot it already
  occupies.
- **Usage-sync data is a SOURCE, never the decision-maker.** A local usage
  tool's reading (`fleet accounts sync`) feeds the fleet's own failover logic,
  but the fleet's failover stays in charge of the actual decision. Any fixture
  standing in for that external tool's output must be captured from the REAL
  tool, never hand-invented — three bugs in a row traced back to one invented
  fixture shape that didn't match what the real tool actually emits.
- **An org monthly spend cap is not a window.** "You've hit your org's
  monthly spend limit" does not reset at the 5h/7d mark. Failover marks the
  slot KIND `spend_cap`, held until the next UTC month start; `fleet accounts
  sync` never clears it. Once an admin raises the cap, free it with `fleet
  accounts clear <slot>`. Hold a slot by hand with `fleet accounts hold <slot>
  [--until ISO] [--reason TEXT]`. Both verbs are audited.
- **`--fresh-session` is for NEW tasks on parked studios only.** After an
  involuntary account replacement, `--fresh-session` discards a potentially
  large session; a plain provision resumes it instead. Reach for
  `--fresh-session` only when deliberately starting fresh work on a studio
  that is already parked, never as the default repair move.
- **On an operator pause order:** park your repo's Claude studios. Keep cheap
  junior studios running if the order allows it. The maestro itself stays up,
  as manager — a pause order is not an order to go dark.
- **Speed over tokens is the default stance** — except when the operator says
  limits are getting close. Once told that, lean toward the junior tier by
  default instead of the Claude tier.

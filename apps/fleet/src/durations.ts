// apps/fleet/src/durations.ts
//
// "What is a minute in ms" — the ONE shared declaration (sweep 14, finding
// S14-F4, refs #485, issue #508). Previously declared module-private in
// src/ratelimit.ts and re-derived inline in src/studio/rate-limit.ts.
//
// It lives ALONE, in a module with zero imports, on purpose: its two
// consumers sit on opposite sides of the CLI/Worker type boundary.
// src/studio/rate-limit.ts is CLI-reachable (cli/readiness-format.ts and
// cli/accounts-format.ts import it), and the cli/, test/, and
// test-integration/ tsconfig projects carry `types: ["bun"]` — NOT
// @cloudflare/workers-types — so every module their graphs reach must not
// name a workers ambient global. Exporting MINUTE_MS from src/ratelimit.ts
// (the first home tried, issue #508's own proposal) failed `bun run check`
// exactly that way: rate-limit.ts's import pulled ratelimit.ts and its
// src/state.ts dependency (which names the ambient D1Database type) into
// the cli project's graph, and tsc answered with 11 `Cannot find name
// 'D1Database'` errors — the same failure src/github/reach.ts's header
// records from the last time this boundary was crossed. Same rule as
// src/base64.ts and src/race-timeout.ts headers: a file the CLI graph can
// reach imports nothing, or it drags the Worker type graph with it.

/** One minute, in milliseconds — the minute-bucket size for every
 *  rate-limit kind (src/ratelimit.ts) and the minute-of-hour offset
 *  arithmetic in src/studio/rate-limit.ts's reset-time parsing. */
export const MINUTE_MS = 60_000;

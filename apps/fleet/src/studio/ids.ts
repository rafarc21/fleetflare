// Segments are alnum runs joined by single hyphens (no leading/trailing/
// double hyphen within a segment), so the only "--" in a valid id is a
// DELIMITER. A naive `[a-z0-9-]+` segment class (hyphen inside the same class
// as the delimiter) is ambiguous: greedy backtracking finds a split for
// "a--b--c" too (repo "a--b", role "c"), which must be rejected.
//
// Both patterns are built from ONE segment source so the id grammar and the
// standalone segment check can never disagree — P3 Task 2 needs the latter
// on its own, and P4a's dynamic repo selection still does: repo.ts's
// repoIdSegment runs it over a repo's short name before that name is ever
// allowed to become the repo half of a studio id.
//
// Issue #269 (multiple studios per role per repo) adds a THIRD segment, and
// the unambiguous-by-construction property above is what makes that safe:
//
//   <repo>--<role>          instance 1 — the default, first, or only one.
//   <repo>--<role>--<n>     instance n, n >= 2.
//
// `n` is a bare decimal integer and the segment class has no digits-only
// exception, so `--<n>` can never read as part of a hyphenated role
// (`web-studio`, `release-studio`): those hyphens are SINGLE by grammar, so
// "fleetflare--web-studio--2" has exactly three segments and the only numeric
// one is the last. Two spellings of the same studio would be worse than an
// ambiguous parse — two D1 rows, two DO names, two `studio:` labels — so the
// grammar is CANONICAL as well as unambiguous: `--1` is refused (instance 1 is
// the bare form), as are `--0`, a negative, a leading zero and anything
// non-numeric in that position.
//
// The charset has no DOT, and that is a hard external constraint rather than
// a style choice (board #21): a studio id becomes a DNS label.
// container/studio-bringup.sh runs `tailscale up --hostname="$STUDIO_ID"`,
// and `fleet ls`'s HOST column is that label plus the tailnet suffix
// (observed: `fleetflare--web-studio-8.example-tailnet.ts.net`). A dot inside the
// id would split that label in two. A repo whose name HAS a dot is therefore
// not rejected — repo.ts's repoIdSegment folds `.` and `_` onto `-` before
// the name reaches this grammar. See that function for why the fold is safe.
// The instance suffix costs at most a few characters against the 63-character
// DNS label limit (the same limit @cloudflare/sandbox's own sanitizeSandboxId
// enforces — see sandbox-api.ts), which the longest live id today
// (`exampleorg-com--release-studio`, 35) clears with room to spare.
const SEGMENT = "[a-z0-9]+(?:-[a-z0-9]+)*";
// No leading zero, so one instance has exactly one spelling. `1` matches here
// and is rejected in code, which is what lets the refusal SAY why rather than
// read as a generic "bad studio id".
const INSTANCE = "[1-9][0-9]*";
const ID_RE = new RegExp(`^(${SEGMENT})--(${SEGMENT})(?:--(${INSTANCE}))?$`);
const SEGMENT_RE = new RegExp(`^${SEGMENT}$`);
const INSTANCE_RE = new RegExp(`^${INSTANCE}$`);
// Broader than INSTANCE on purpose: parseStudioTarget uses it to notice that a
// segment WANTED to be an instance number before deciding whether it is a
// valid one. See that function's own comment.
const ALL_DIGITS_RE = /^[0-9]+$/;

/** A studio id, taken apart. `instance` is ALWAYS a positive integer — 1 for
 *  the two-segment form — so a reader never has to handle "absent" as a third
 *  case, and `buildStudioId` puts the same value back where it came from. */
export interface StudioId {
  repo: string;
  role: string;
  instance: number;
  /** The id verbatim. Equal to `buildStudioId(this)` for every id that parses. */
  full: string;
}

export function parseStudioId(raw: string): StudioId | null {
  const m = ID_RE.exec(raw);
  if (!m) return null;
  if (m[3] === undefined) return { repo: m[1], role: m[2], instance: 1, full: raw };
  const instance = Number(m[3]);
  // `<repo>--<role>--1` names the studio `<repo>--<role>` already names.
  // Accepting it would fork one studio into two ids; see this file's header.
  if (instance < 2) return null;
  return { repo: m[1], role: m[2], instance, full: raw };
}

/**
 * The id for one {repo, role, instance} — the ONLY place an id is assembled.
 *
 * Instance 1 builds the BARE two-segment form, which is what makes issue
 * #269 fully backward compatible: every id in production keeps meaning
 * exactly what it always meant, and a caller that knows nothing about
 * instances (`undefined`/`null`) lands on it.
 *
 * Takes a validated instance — `parseStudioId` is the validator, and a caller
 * reading an instance off a request body checks it there (spawn.ts). The
 * result of this function parses back to its own input, so a mistake shows up
 * at the next parse rather than as a silently wrong id.
 */
export function buildStudioId(parts: { repo: string; role: string; instance?: number | null }): string {
  const n = parts.instance ?? 1;
  return n <= 1 ? `${parts.repo}--${parts.role}` : `${parts.repo}--${parts.role}--${n}`;
}

/**
 * The LOWEST free instance number for one repo+role, counting the bare
 * two-segment id as instance 1 — issue #269's allocation rule for
 * `fleet spawn <role> --new` / `ff <role> --new`.
 *
 * Lowest FREE, not one-past-the-highest: destroying `<repo>--<role>--2` and
 * spawning again should reuse 2 rather than leave a permanent hole and drift
 * toward `--17` on a fleet that has never run more than three of a role. So
 * on {1, 2, 4} the answer is 3.
 *
 * Takes ids rather than registry rows so this stays a pure function of the
 * grammar, callable from both sides of the wire (spawn.ts over D1 rows,
 * cli/ff.ts over the `GET /studio/` listing it already fetched). An id that
 * does not parse is SKIPPED — the same "one bad row must not fail the whole
 * decision" posture registry.ts's listStudios and repo.ts's claimedBy take.
 */
export function nextFreeInstance(ids: Iterable<string>, repo: string, role: string): number {
  const taken = new Set<number>();
  for (const id of ids) {
    const parsed = parseStudioId(id);
    if (parsed === null || parsed.repo !== repo || parsed.role !== role) continue;
    taken.add(parsed.instance);
  }
  let n = 1;
  while (taken.has(n)) n++;
  return n;
}

/**
 * What a human may type where a studio has to be named — issue #269 item 3's
 * `fleet task assign <n> <target>`.
 *
 * Three shapes, and the operator is not asked to say which:
 *   - `pilot`            a ROLE, in whatever repo the caller is standing in.
 *   - `pilot--2`         that role's instance 2, same repo resolution.
 *   - `websites--pilot`  a FULL id, already qualified, no repo context needed.
 *   - `websites--pilot--2`  the same, with an instance.
 *
 * `pilot--2` is the one genuinely ambiguous string: under the id grammar it is
 * also a perfectly valid FULL id (repo "pilot", role "2"). It is resolved in
 * favour of the instance reading, and that is safe by construction rather than
 * by preference — a role is a file under `fleet/blueprint/roles/` named in
 * fleet.json's `roles`, and no role is an all-digit string. A repo whose name
 * IS all digits still works on the other side of the delimiter (`2024--pilot`,
 * `2024--pilot--3`), because only the LAST segment is read as a number.
 *
 * So: strip a trailing all-digit segment as the instance, then count what is
 * left — one segment is a role, two are `<repo>--<role>`, anything else is a
 * refusal. Refusing beats guessing here for `studioIdIn`'s own reason: a
 * wrongly resolved target is a valid id belonging to a different studio, and
 * a task assigned to it simply never reaches anyone.
 *
 * `<role>--1` and `<repo>--<role>--1` are ACCEPTED and normalised onto
 * instance 1 (the bare id), unlike `parseStudioId`, which refuses them. The
 * difference is deliberate: this is an input grammar for a human, where
 * spelling instance 1 out loud is a reasonable thing to do, while that one is
 * the canonical form of a stored id, where two spellings would be a bug.
 */
export type StudioTarget =
  | { kind: "role"; role: string; instance: number }
  | { kind: "id"; repo: string; role: string; instance: number };

export function parseStudioTarget(raw: string): StudioTarget | null {
  const parts = raw.split("--");
  let instance = 1;
  // An all-digit final segment is read as an instance number and NOTHING else.
  // Falling through to the role/repo reading when it is a malformed one
  // (`pilot--0`, `pilot--01`) would turn a typo'd instance into a studio with
  // a role named "0" — a valid id segment, so a valid id, so a task that
  // reaches nobody. Refuse instead, which is what "never silently guess"
  // means at this boundary.
  if (ALL_DIGITS_RE.test(parts[parts.length - 1])) {
    if (parts.length < 2 || !INSTANCE_RE.test(parts[parts.length - 1])) return null;
    instance = Number(parts.pop());
  }
  if (!parts.every((p) => SEGMENT_RE.test(p))) return null;
  if (parts.length === 1) return { kind: "role", role: parts[0], instance };
  if (parts.length === 2) return { kind: "id", repo: parts[0], role: parts[1], instance };
  return null;
}

/** True when `raw` is a valid single id segment (a repo or a role half).
 *  Accepts `undefined` so callers can validate a possibly-absent value —
 *  e.g. the result of splitting a configured repo slug — in one check. */
export function isIdSegment(raw: string | undefined): raw is string {
  return raw !== undefined && SEGMENT_RE.test(raw);
}

import { describe, it, expect, vi } from "vitest";
import { decideHeal, healBareContainer, replacementEvent } from "../src/studio/do";
import { HEAL_ATTEMPT_KEY, STATUS_KEY, type HealAttempt } from "../src/studio/provision";
import { OBSERVED_KEY, emptyObserved, type Observed } from "../src/studio/observed";
import type { StudioStatus, StudioReadiness } from "../src/studio/types";
import { readyOverride } from "../cli/readiness-format";
import { fakeStorage as doStorage } from "./helpers/do-storage";

// ---------------------------------------------------------------------------
// Issue #1146 — a NEW incarnation is a new heal episode.
//
// Measured 2026-10-16: a studio restarted with a new incarnation came back
// BARE and stayed bare. Its auto-heal marker (HEAL_ATTEMPT_KEY) was still
// armed by an EARLIER heal of the previous container, and decideHeal read
// that as "already healed once, still bare" and stood down forever. Nothing
// clears the marker on a replacement: incarnationPatch (do.ts) stamps
// `replacedAt` and leaves the marker alone, and only a `provisioned` verdict
// disarms it.
//
// So the marker is only binding for the episode it was armed in. Armed AFTER
// the replacement that is now bare -> same episode, stand down. Armed BEFORE
// it -> an old container's marker, a new episode, heal once.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-10-16T16:40:03.000Z");
const STUDIO_ID = "acme--web-studio";
const REPLACED_AT = "2026-10-16T16:39:03.000Z";

function status(over: Partial<StudioStatus> = {}): StudioStatus {
  return { id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null, ...over } as StudioStatus;
}

const bare = (checkedAt = NOW.toISOString(), reason = "no git checkout at /workspace/acme"): StudioReadiness =>
  ({ kind: "bare", reason, checkedAt });

const armed = (over: Partial<HealAttempt> = {}): HealAttempt =>
  ({ armed: true, attemptedAt: "2026-10-15T09:00:00.000Z", reason: "bare", ...over });

describe("decideHeal — an armed marker from an earlier incarnation does not bind", () => {
  it("a marker armed BEFORE the replacement is an old container's: heal once for the new one", () => {
    const d = decideHeal(status(), bare(), armed(), null, NOW, null, REPLACED_AT);
    expect(d.kind).toBe("heal");
  });

  it("a marker armed AFTER the replacement is this episode's: still stands down", () => {
    const d = decideHeal(
      status(), bare(), armed({ attemptedAt: "2026-10-16T16:39:30.000Z" }), null, NOW, null, REPLACED_AT,
    );
    expect(d.kind).toBe("stand-down");
    expect(d.kind === "stand-down" && d.why).toContain("2026-10-16T16:39:30.000Z");
  });

  it("no replacement recorded keeps the old rule exactly: an armed marker stands down", () => {
    expect(decideHeal(status(), bare(), armed(), null, NOW, null, null).kind).toBe("stand-down");
  });
});

describe("healBareContainer — records each attempt on Observed, so READY can say what it is doing", () => {
  function store(seed: { marker?: HealAttempt; observed?: Partial<Observed> }) {
    const initial: Record<string, unknown> = {};
    if (seed.marker) initial[HEAL_ATTEMPT_KEY] = seed.marker;
    if (seed.observed) initial[OBSERVED_KEY] = { ...emptyObserved(), ...seed.observed };
    const s = doStorage(initial);
    return { ...s, map: s.map as Map<string, unknown> };
  }

  it("a new incarnation's bare container heals, and Observed.healAttemptedAt is stamped", async () => {
    const s = store({
      marker: armed(),
      observed: { replacedAt: REPLACED_AT, incarnation: "new-token" },
    });
    const heal = vi.fn(async () => {});

    const d = await healBareContainer(
      s as never, STUDIO_ID, status(), bare(), () => NOW, heal, async () => {}, s as never,
    );

    expect(d.kind).toBe("heal");
    expect(heal).toHaveBeenCalledTimes(1);
    expect((s.map.get(OBSERVED_KEY) as Observed).healAttemptedAt).toBe(NOW.toISOString());
  });

  it("a rollout-killed heal clears healAttemptedAt, so READY does not claim a heal that never ran", async () => {
    const s = store({ observed: { replacedAt: REPLACED_AT } });
    // The restart is what writes the rollout-killed error onto the row.
    const healWithRollout = async () => {
      s.map.set(STATUS_KEY, status({ error: "Runtime signalled the container to exit due to a new version rollout: 0" }));
    };

    await healBareContainer(
      s as never, STUDIO_ID, status(), bare(), () => NOW, healWithRollout, async () => {}, s as never,
    );

    expect((s.map.get(OBSERVED_KEY) as Observed).healAttemptedAt).toBeNull();
  });
});

describe("readyOverride — replaced-and-not-brought-up says what the auto-heal is doing", () => {
  const replaced = (over: Partial<Observed> = {}, readiness: StudioReadiness = bare("2026-10-16T16:39:10.000Z")) =>
    status({
      observed: { ...emptyObserved(), replacedAt: REPLACED_AT, ...over },
      readiness,
    });

  it("no heal attempted yet: 'auto-heal pending', never a plain 'running'", () => {
    expect(readyOverride(replaced(), NOW)).toBe("bare: replaced 1m — auto-heal pending");
  });

  it("heal attempted for this replacement, no verdict since: 'auto-heal running'", () => {
    const s = replaced({ healAttemptedAt: "2026-10-16T16:39:40.000Z" });
    expect(readyOverride(s, NOW)).toBe("bare: replaced 1m — auto-heal running");
  });

  it("heal attempted and the verdict since is still bare: 'auto-heal failed: <reason>'", () => {
    const s = replaced(
      { healAttemptedAt: "2026-10-16T16:39:40.000Z" },
      bare("2026-10-16T16:39:55.000Z", "no git checkout at /workspace/acme"),
    );
    expect(readyOverride(s, NOW)).toBe("bare: replaced 1m — auto-heal failed: no git checkout at /workspace/acme");
  });

  it("the old wording never comes back", () => {
    expect(readyOverride(replaced(), NOW)).not.toContain("not brought up");
  });
});

describe("replacementEvent — one board event per replace", () => {
  it("names the studio, the old and new incarnation, and says the cause is unknown", () => {
    const ev = replacementEvent(STUDIO_ID, REPLACED_AT, "old-token", "", 1_000, "abc123");
    expect(ev.from).toBe(STUDIO_ID);
    expect(ev.to).toBe("board");
    expect(ev.kind).toBe("report");
    expect(ev.project).toBe("acme");
    expect(ev.ref).toBe(STUDIO_ID);
    expect(ev.body).toContain("replaced");
    expect(ev.body).toContain("old-token");
    expect(ev.body).toContain("no incarnation");
    expect(ev.body).toContain("cause unknown");
  });
});

// ---------------------------------------------------------------------------
// Issue #1152 review (maestro, 2026-10-16). Three changes the review asked for
// that can be pinned without a live studio:
//   1. An OSS (glm) lead is never healed. A replaced container is already
//      running, so restartUngated's router env is never applied to it
//      (do.ts restartUngated: `if (!container.running)` gates the await), and
//      the bring-up would run on the Claude env the container was started with.
//   2. A cooldown caps heals across replacements: one heal per 30 min.
//   3. READY says `failed` once the attempt window passes with no verdict,
//      instead of `running` forever when later checks are inconclusive.
// ---------------------------------------------------------------------------

describe("review #1152 — an OSS lead is never healed onto a Claude-env container", () => {
  it("a glm row stands down with a reason that names the OSS lead", () => {
    const d = decideHeal(status({ leadType: "glm" }), bare(), undefined);
    expect(d.kind).toBe("stand-down");
    expect(d.kind === "stand-down" && d.why).toContain("OSS lead");
  });

  it("READY says the heal is skipped for an OSS lead, not 'pending'", () => {
    const s = status({
      leadType: "glm",
      observed: { ...emptyObserved(), replacedAt: REPLACED_AT },
      readiness: bare("2026-10-16T16:39:10.000Z"),
    });
    expect(readyOverride(s, NOW)).toBe("bare: replaced 1m — auto-heal skipped: OSS lead");
  });
});

describe("review #1152 — cooldown caps heals across replacements", () => {
  it("an earlier container's heal armed 20 min ago is still cooling down: stand down", () => {
    const d = decideHeal(
      status(), bare(), armed({ attemptedAt: "2026-10-16T16:20:03.000Z" }), null, NOW, null, REPLACED_AT,
    );
    expect(d.kind).toBe("stand-down");
    expect(d.kind === "stand-down" && d.why).toContain("cooling down");
  });

  it("an earlier container's heal armed 35 min ago is outside the cooldown: heal", () => {
    const d = decideHeal(
      status(), bare(), armed({ attemptedAt: "2026-10-16T16:05:03.000Z" }), null, NOW, null, REPLACED_AT,
    );
    expect(d.kind).toBe("heal");
  });
});

describe("review #1152 — READY stops saying 'running' once the attempt window passes", () => {
  it("an attempt 15 min old with no verdict since reads failed, not running", () => {
    const s = status({
      observed: {
        ...emptyObserved(), replacedAt: REPLACED_AT, healAttemptedAt: "2026-10-16T16:39:40.000Z",
      },
      readiness: bare("2026-10-16T16:39:10.000Z"),
    });
    expect(readyOverride(s, new Date("2026-10-16T16:55:00.000Z"))).toBe(
      "bare: replaced 15m — auto-heal failed: no verdict since the attempt",
    );
  });
});

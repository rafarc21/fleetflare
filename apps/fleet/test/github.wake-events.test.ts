import { describe, it, expect } from "vitest";
import { WAKE_EVENTS, WAVE_LOG_TITLE, deltaDigest, maestroIdFor } from "../src/github/wake-events";

const repo = { full_name: "acme-org/websites" };

describe("WAKE_EVENTS", () => {
  it("watches the four events the App actually delivers, and never push", () => {
    expect([...WAKE_EVENTS].sort()).toEqual(["issue_comment", "issues", "pull_request", "workflow_run"]);
    expect(WAKE_EVENTS.has("push")).toBe(false);
  });

  it("does not watch check_suite — measured 2026-09-11, the App never sends it", () => {
    expect(WAKE_EVENTS.has("check_suite")).toBe(false);
  });

  it("does not watch workflow_job — one delivery per JOB, same information as workflow_run", () => {
    expect(WAKE_EVENTS.has("workflow_job")).toBe(false);
  });
});

describe("maestroIdFor", () => {
  it("routes a repo's events to that repo's own maestro", () => {
    expect(maestroIdFor("acme-org/websites")).toBe("websites--maestro");
    expect(maestroIdFor("acme-org/sample")).toBe("sample--maestro");
  });

  it("returns null for a payload with no repository, rather than a bogus id", () => {
    expect(maestroIdFor(undefined)).toBeNull();
    expect(maestroIdFor("nonsense")).toBeNull();
  });

  // Board #40. The wake side missed #22's fold, so every delivery for a
  // dotted repo went to `demosite.life--maestro` — a name nothing else uses,
  // so idFromName minted a fresh empty DO and the live maestro
  // `demosite-life--maestro` was never woken, silently.
  it("folds a dotted repo name the same way spawn does", () => {
    expect(maestroIdFor("demositeltda/demosite.life")).toBe("demosite-life--maestro");
    expect(maestroIdFor("o/exampleorg.com")).toBe("exampleorg-com--maestro");
  });

  it("folds underscores too, and a run of separators to one hyphen", () => {
    expect(maestroIdFor("o/my_repo")).toBe("my-repo--maestro");
    expect(maestroIdFor("o/a._-b")).toBe("a-b--maestro");
  });

  it("lowercases, because github.com repo names are case-insensitive", () => {
    expect(maestroIdFor("Demositeltda/Demosite.Life")).toBe("demosite-life--maestro");
  });

  it("refuses rather than guesses when no fold makes a valid segment", () => {
    expect(maestroIdFor("o/café")).toBeNull();
    expect(maestroIdFor("o/-lead")).toBeNull();
    expect(maestroIdFor("o/lead-")).toBeNull();
  });
});

describe("deltaDigest", () => {
  // Board #111: `repo`'s own maestro id is `websites--maestro` (see
  // maestroIdFor's own tests above), so this fixture's label now names
  // maestro's OWN assignment -- under the #111 ownership filter this is
  // what demonstrates "own task wakes"; a DIFFERENT studio's label here
  // would now correctly return null (see the "does not wake" cases below).
  it("names what fired, the task, and its new state", () => {
    const d = deltaDigest("issues", {
      action: "labeled", repository: repo,
      issue: { number: 131, title: "fleet task state verb", state: "open", labels: [{ name: "studio:websites--maestro" }, { name: "in-flight" }] },
    });
    expect(d).toBe(
      'WAKE EVENT(issues.labeled) acme-org/websites #131 "fleet task state verb" state=open labels=studio:websites--maestro,in-flight',
    );
  });

  // Board #111: a task assigned to some OTHER lane already gets its own
  // targeted wake (board #236's wakeTaskOnComment/wakeOnComment) -- a
  // second, generic maestro wake for the same delta is pure noise.
  it("REFUSES to wake maestro for an issues event on a task assigned to a DIFFERENT studio", () => {
    expect(deltaDigest("issues", {
      action: "labeled", repository: repo,
      issue: { number: 131, title: "fleet task state verb", state: "open", labels: [{ name: "studio:websites--web-studio" }] },
    })).toBeNull();
  });

  it("wakes maestro for an issues event on a task assigned to maestro itself", () => {
    const d = deltaDigest("issues", {
      action: "labeled", repository: repo,
      issue: { number: 131, title: "fleet task state verb", state: "open", labels: [{ name: "studio:websites--maestro" }] },
    });
    expect(d).toBe(
      'WAKE EVENT(issues.labeled) acme-org/websites #131 "fleet task state verb" state=open labels=studio:websites--maestro',
    );
  });

  it("wakes maestro for an issues event on a backlog task (no studio: label at all)", () => {
    const d = deltaDigest("issues", {
      action: "labeled", repository: repo,
      issue: { number: 131, title: "fleet task state verb", state: "open", labels: [{ name: "in-flight" }] },
    });
    expect(d).toContain("#131");
  });

  // Ambiguous (more than one studio: label) is treated as maestro's own --
  // label drift is exactly what maestro, not a lane, should see.
  it("wakes maestro on an ambiguous (two studio: labels) task -- drift is maestro's business", () => {
    const d = deltaDigest("issues", {
      action: "labeled", repository: repo,
      issue: {
        number: 131, title: "fleet task state verb", state: "open",
        labels: [{ name: "studio:websites--web-studio" }, { name: "studio:websites--other-studio" }],
      },
    });
    expect(d).toContain("#131");
  });

  it("REFUSES to wake maestro for an issue_comment on a task assigned to a DIFFERENT studio", () => {
    expect(deltaDigest("issue_comment", {
      action: "created", repository: repo,
      issue: {
        number: 131, title: "fleet task state verb", state: "open",
        labels: [{ name: "studio:websites--web-studio" }],
      },
      comment: { user: { login: "rafarc21" }, body: "hi" },
    })).toBeNull();
  });

  it("wakes maestro for an issue_comment on a task assigned to maestro itself", () => {
    const d = deltaDigest("issue_comment", {
      action: "created", repository: repo,
      issue: {
        number: 131, title: "fleet task state verb", state: "open",
        labels: [{ name: "studio:websites--maestro" }],
      },
      comment: { user: { login: "rafarc21" }, body: "hi" },
    });
    expect(d).toContain("#131");
  });

  it("wakes maestro for an issue_comment on a backlog task (no studio: label at all)", () => {
    const d = deltaDigest("issue_comment", {
      action: "created", repository: repo,
      issue: { number: 131, title: "fleet task state verb", state: "open", labels: [] },
      comment: { user: { login: "rafarc21" }, body: "hi" },
    });
    expect(d).toContain("#131");
  });

  // Ambiguous (more than one studio: label) is treated as maestro's own --
  // label drift is exactly what maestro, not a lane, should see.
  it("wakes maestro on an issue_comment for an ambiguous (two studio: labels) task -- drift is maestro's business", () => {
    const d = deltaDigest("issue_comment", {
      action: "created", repository: repo,
      issue: {
        number: 131, title: "fleet task state verb", state: "open",
        labels: [{ name: "studio:websites--web-studio" }, { name: "studio:websites--other-studio" }],
      },
      comment: { user: { login: "rafarc21" }, body: "hi" },
    });
    expect(d).toContain("#131");
  });

  it("carries who commented and what they said, trimmed to one line", () => {
    const d = deltaDigest("issue_comment", {
      action: "created", repository: repo,
      issue: { number: 131, title: "fleet task state verb", state: "open" },
      comment: { user: { login: "rafarc21" }, body: "ENVELOPE\nstate: done\nPR: #138" },
    });
    expect(d).toBe(
      'WAKE EVENT(issue_comment.created) acme-org/websites #131 "fleet task state verb" by rafarc21: ENVELOPE state: done PR: #138',
    );
  });

  it("reports a PR's mergeable-facing state, not just that it changed", () => {
    const d = deltaDigest("pull_request", {
      action: "closed", repository: repo,
      pull_request: { number: 138, title: "blueprint: maestro supervision", state: "closed", merged: true, draft: false },
    });
    expect(d).toBe(
      'WAKE EVENT(pull_request.closed) acme-org/websites PR #138 "blueprint: maestro supervision" state=closed merged=true draft=false',
    );
  });

  it("still wakes on pull_request.opened, unaffected by the synchronize skip", () => {
    const d = deltaDigest("pull_request", {
      action: "opened", repository: repo,
      pull_request: { number: 139, title: "a new PR", state: "open", merged: false, draft: false },
    });
    expect(d).toBe(
      'WAKE EVENT(pull_request.opened) acme-org/websites PR #139 "a new PR" state=open merged=false draft=false',
    );
  });

  // Board #111: maestro itself never holds a PR -- only the studios/lanes it
  // supervises do -- so every synchronize (fired on every push to a PR
  // branch) is inherently noise from maestro's own perspective.
  it("REFUSES to wake on pull_request.synchronize -- maestro never holds a PR", () => {
    expect(deltaDigest("pull_request", {
      action: "synchronize", repository: repo,
      pull_request: { number: 138, title: "blueprint: maestro supervision", state: "open", merged: false, draft: false },
    })).toBeNull();
  });

  it("reports a finished CI run's verdict, its workflow and its branch", () => {
    const d = deltaDigest("workflow_run", {
      action: "completed", repository: repo,
      workflow_run: {
        name: "fleet check", conclusion: "failure", head_branch: "35-terminal-watch",
        html_url: "https://github.com/acme-org/websites/actions/runs/1",
      },
    });
    expect(d).toBe(
      'WAKE EVENT(workflow_run.completed) acme-org/websites "fleet check" ' +
      "branch=35-terminal-watch conclusion=failure " +
      "https://github.com/acme-org/websites/actions/runs/1",
    );
  });

  it("REFUSES to wake on a workflow_run that only started — requested is not a delta", () => {
    // workflow_run fires on requested, in_progress AND completed. Waking on
    // all three triples the token cost of every CI run for no extra signal:
    // only the conclusion changes anything maestro supervises.
    expect(deltaDigest("workflow_run", {
      action: "requested", repository: repo,
      workflow_run: {
        name: "fleet check", conclusion: null, head_branch: "35-terminal-watch",
        html_url: "https://github.com/acme-org/websites/actions/runs/1",
      },
    })).toBeNull();
  });

  it("REFUSES to wake on a workflow_run still in_progress", () => {
    expect(deltaDigest("workflow_run", {
      action: "in_progress", repository: repo,
      workflow_run: {
        name: "fleet check", conclusion: null, head_branch: "35-terminal-watch",
        html_url: "https://github.com/acme-org/websites/actions/runs/1",
      },
    })).toBeNull();
  });

  it("returns null for check_suite — the App never sends it, so nothing watches it", () => {
    expect(deltaDigest("check_suite", {
      action: "completed", repository: repo,
      check_suite: { head_branch: "35-terminal-watch", conclusion: "failure", pull_requests: [{ number: 139 }] },
    })).toBeNull();
  });

  it("REFUSES to wake on maestro's own wave log — that is the feedback loop", () => {
    // Maestro comments every wave on this issue. Waking on its own comment
    // makes each wave cause the next one, forever, at Claude-token cost.
    expect(deltaDigest("issue_comment", {
      action: "created", repository: repo,
      issue: { number: 9, title: WAVE_LOG_TITLE, state: "open" },
      comment: { user: { login: "example-bot[bot]" }, body: "🎯 WAVE SWEEP #4" },
    })).toBeNull();
    expect(deltaDigest("issues", {
      action: "edited", repository: repo, issue: { number: 9, title: WAVE_LOG_TITLE, state: "open" },
    })).toBeNull();
  });

  it("returns null for an event that is not a wake event", () => {
    expect(deltaDigest("push", { repository: repo })).toBeNull();
  });

  it("returns null rather than a half-empty digest when the payload is unusable", () => {
    expect(deltaDigest("issues", { action: "opened", repository: repo })).toBeNull();
    expect(deltaDigest("pull_request", { action: "opened", repository: repo })).toBeNull();
    expect(deltaDigest("workflow_run", { action: "completed", repository: repo })).toBeNull();
    expect(deltaDigest("issues", null)).toBeNull();
  });
});

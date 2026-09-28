import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

// container/server.ts cannot be imported (Bun.serve at top level), so these
// assert on its source text, injected as TEST_CONTAINER_SERVER_SRC by
// vitest.config.ts. Brittle by intent: the argv below is load-bearing and its
// syntax was verified the hard way (IS#34) — a well-meaning edit is more
// likely to break it than the other way around.
//
// What was measured against the pinned CLI (2.1.224), live in the real
// container image as root (evidence:
// https://github.com/acme-org/websites/issues/34#issuecomment-5301104765):
//
// - The single-argv space-separated form is CORRECT. The CLI's tokenizer is
//   paren-aware: spaces inside "(...)" belong to the rule, spaces outside
//   split rules. This string parses into exactly six rules.
// - "Bash(git *)" is first-class wildcard syntax ("Bash(git:*)" is the legacy
//   prefix spelling; both work). An unbalanced token like "Bash(git" would be
//   silently ignored — the failure mode is every mutating command denied, and
//   headless there is no prompt and no error, just a stuck agent.
// - Widening the list is fine (e.g. adding "Bash(mkdir *)" when a real task
//   needs it) — update the expected string here in the same commit, and keep
//   every Bash rule in the paren-wrapped "(prefix *)" form.
const ARGV = /runClaude\(\[([\s\S]*?)\]/;

function argvSlice(): string {
  const m = env.TEST_CONTAINER_SERVER_SRC.match(ARGV);
  expect(m, "runClaude([...]) argv array not found in container/server.ts").not.toBeNull();
  return m![1];
}

describe("container claude argv", () => {
  it("pins the verified --allowedTools rules exactly", () => {
    expect(argvSlice()).toMatch(
      /"--allowedTools",\s*"Bash\(git \*\) Bash\(gh \*\) Bash\(bun \*\) Bash\(fleet \*\) Edit Write"/,
    );
  });

  // Operator directive 2026-08-19, superseding this test's prior form: the
  // container runs claude as root, and 2.1.224 refuses
  // --dangerously-skip-permissions under root UNLESS IS_SANDBOX=1 is set
  // (verified live — see the comment above runClaude, and Dockerfile's own
  // `ENV IS_SANDBOX=1`, pinned below). With that var now baked into the
  // image, the flag is passed. `--allowedTools` (pinned above) stays
  // alongside it, belt and braces, not a replacement.
  it("passes --dangerously-skip-permissions (never the bypassPermissions spelling, which was never verified)", () => {
    const argv = argvSlice();
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("bypassPermissions");
  });
});

// ---------------------------------------------------------------------------
// container images — IS_SANDBOX=1 (operator directive 2026-08-19)
// ---------------------------------------------------------------------------
// Neither Dockerfile can be imported or executed by a test — same "no
// filesystem in workerd" reasoning as TEST_CONTAINER_SERVER_SRC above (see
// vitest.config.ts's own comment on these two bindings). This proves only
// that the declaration is present in the image source; the Docker image
// smoke test (task report) is what proves it actually unlocks the flag at
// runtime against the real, built image.
describe("container images pin ENV IS_SANDBOX=1", () => {
  it("Dockerfile.studio (interactive studio image, studio-bringup.sh's claude launch)", () => {
    expect(env.TEST_DOCKERFILE_STUDIO_SRC).toContain("ENV IS_SANDBOX=1");
  });

  it("Dockerfile (headless batch/task image, server.ts's runClaude)", () => {
    expect(env.TEST_DOCKERFILE_TASK_SRC).toContain("ENV IS_SANDBOX=1");
  });
});

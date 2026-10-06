import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { rescueMintPermissions } from "../src/studio/rescue";

// Issue #45 item 3: rescue-branch DISCOVERY only lists and fetches from the
// private rescue remote, so its token is contents:read. Rescue itself pushes
// and keeps contents:write. Least privilege: a read token that leaks from a
// provision exec cannot write the archive.
describe("rescue token permissions (issue #45)", () => {
  it("discovery reads, push writes + widens to workflows (issue #233: a worktree touching .github/workflows/* must mint a token that can push one)", () => {
    expect(rescueMintPermissions("discovery")).toEqual({ contents: "read" });
    expect(rescueMintPermissions("push")).toEqual({ contents: "write", workflows: "write" });
  });

  // StudioDO cannot be constructed here (see studio.backup-guard.test.ts's
  // #94 block), so the wiring is source-pinned: the one rescue-target mint
  // takes its permissions from resolveRescueTarget's own `permissions`
  // argument (rescue.ts computes it from rescueMintPermissions(purpose), and
  // retries narrower on a rejection -- see rescue.ts's mintRescuePushToken),
  // and discovery asks as "discovery". Hard-coding write again, or dropping
  // the purpose on the discovery port, fails this test.
  it("do.ts mints the rescue-remote token by purpose; discovery passes \"discovery\"", () => {
    const src: string = (env as unknown as { TEST_STUDIO_DO_SRC: string }).TEST_STUDIO_DO_SRC;
    const start = src.indexOf("  private rescueTarget(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  }", start));
    // Issue #7 routes the mint through containerToken; the permissions it
    // asks for still come from resolveRescueTarget's own by-purpose
    // computation (PR #236 review round 2: do.ts no longer hard-codes
    // rescueMintPermissions(purpose) itself, so a rejection on the full
    // request can be retried narrower inside rescue.ts, not here).
    expect(body).toContain("containerToken(this.env, await workRepoSlug(), repo, permissions)");
    expect(body).toContain("async (repo, permissions) =>");
    // Issue #45 item 6: rescue's own port passes NO purpose — the default
    // must stay "push" (write), or rescue would push with a read token.
    expect(body).toContain('purpose: "push" | "discovery" = "push"');
    expect(body).not.toContain('contents: "write"');
    expect(src).toContain(`rescueTarget: (slug: string) => this.rescueTarget(async () => slug, "discovery"),`);
    // PR #50 review: the PUSH port (syncDeps) passes no purpose, so it gets
    // the "push" default = write. Passing "discovery" there would push with
    // a read token: every rescue refused, work lost at teardown.
    const syncStart = src.indexOf("  private syncDeps(");
    expect(syncStart).toBeGreaterThan(-1);
    const syncBody = src.slice(syncStart, src.indexOf("\n  }", syncStart));
    expect(syncBody).toContain("rescueTarget: () => this.rescueTarget(() => this.workRepoSlug(null)),");
    expect(syncBody).not.toMatch(/this\.rescueTarget\([^\n]*"discovery"/);
  });
});

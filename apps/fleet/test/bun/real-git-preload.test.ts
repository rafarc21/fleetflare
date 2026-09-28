import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixPathIfStudioWrapperIsAheadOfRealGit } from "./real-git-preload";

/**
 * Issue #353 round 2 -- unit coverage for the `bun test` preload's own
 * detection logic, exercised against FAKE wrapper/real-git paths (never this
 * machine's own `/usr/local/bin/git`, whatever it happens to be here) so both
 * branches -- "a studio wrapper genuinely sits at this path" and "nothing of
 * ours does" -- are provable regardless of what environment this suite
 * itself happens to run in. See real-git-preload.ts's own header for what
 * problem this closes and why: `bun test`'s real-git fixtures resolve "real
 * git" via `Bun.which("git")` / a bare `git` word, which inside an actual
 * studio container is this repo's own #253 safety wrapper, not real git.
 */
let root: string;
let savedPath: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  if (savedPath !== undefined) process.env.PATH = savedPath;
});

describe("#353 real-git-preload: fixPathIfStudioWrapperIsAheadOfRealGit", () => {
  test("no-op when nothing lives at the wrapper path at all", () => {
    root = mkdtempSync(join(tmpdir(), "fleet-preload-test-"));
    savedPath = process.env.PATH;
    const before = process.env.PATH;
    fixPathIfStudioWrapperIsAheadOfRealGit(join(root, "does-not-exist"), join(root, "also-missing"));
    expect(process.env.PATH).toBe(before);
  });

  test("no-op when the wrapper path holds something that is NOT the fleet wrapper", () => {
    root = mkdtempSync(join(tmpdir(), "fleet-preload-test-"));
    savedPath = process.env.PATH;
    const notWrapper = join(root, "git");
    writeFileSync(notWrapper, "#!/bin/bash\necho not the fleet wrapper\n");
    chmodSync(notWrapper, 0o755);
    const realGit = join(root, "real-git");
    writeFileSync(realGit, "#!/bin/bash\necho real git\n");
    chmodSync(realGit, 0o755);
    const before = process.env.PATH;
    fixPathIfStudioWrapperIsAheadOfRealGit(notWrapper, realGit);
    expect(process.env.PATH).toBe(before);
  });

  test("no-op when the wrapper IS the fleet wrapper but there is no real git to fall back to", () => {
    root = mkdtempSync(join(tmpdir(), "fleet-preload-test-"));
    savedPath = process.env.PATH;
    const wrapper = join(root, "git");
    writeFileSync(wrapper, "#!/bin/bash\n# fleet: issue #253. Installed at /usr/local/bin/git\nexit 1\n");
    chmodSync(wrapper, 0o755);
    const before = process.env.PATH;
    fixPathIfStudioWrapperIsAheadOfRealGit(wrapper, join(root, "no-such-real-git"));
    expect(process.env.PATH).toBe(before);
  });

  test("prepends a shim dir symlinked to the real git when the fleet wrapper is detected", () => {
    root = mkdtempSync(join(tmpdir(), "fleet-preload-test-"));
    savedPath = process.env.PATH;
    const wrapper = join(root, "git");
    writeFileSync(
      wrapper,
      "#!/bin/bash\n# fleet: issue #253. Installed at /usr/local/bin/git, which comes\nexit 1\n",
    );
    chmodSync(wrapper, 0o755);
    const realGit = join(root, "real-git");
    writeFileSync(realGit, "#!/bin/bash\necho real git\n");
    chmodSync(realGit, 0o755);
    const before = process.env.PATH ?? "";

    fixPathIfStudioWrapperIsAheadOfRealGit(wrapper, realGit);

    expect(process.env.PATH).not.toBe(before);
    expect(process.env.PATH?.endsWith(before)).toBe(true);
    const shimDir = process.env.PATH!.slice(0, process.env.PATH!.length - before.length - 1);
    expect(readlinkSync(join(shimDir, "git"))).toBe(realGit);
  });

  test("the marker check reads the wrapper's actual generated text, not a hardcoded path check", () => {
    // A file at a totally different path from where the real wrapper lives
    // in production, but carrying the SAME header text, is still detected --
    // the marker is about CONTENT, not location.
    root = mkdtempSync(join(tmpdir(), "fleet-preload-test-"));
    savedPath = process.env.PATH;
    const wrapper = join(root, "some-other-name-entirely");
    writeFileSync(wrapper, "#!/bin/bash\n# fleet: issue #253. Installed at /wherever/git\nexit 1\n");
    chmodSync(wrapper, 0o755);
    const realGit = join(root, "real-git");
    writeFileSync(realGit, "#!/bin/bash\necho real git\n");
    chmodSync(realGit, 0o755);
    const before = process.env.PATH ?? "";

    fixPathIfStudioWrapperIsAheadOfRealGit(wrapper, realGit);

    expect(process.env.PATH).not.toBe(before);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { blueprintCredentialWriteCmd, credentialWriteCmd, tokenEnv } from "../../src/studio/credentials";

/**
 * Board task #149 — measured in a live container, not reasoned about.
 *
 * The blueprint clone is `git clone "https://github.com/${BLUEPRINT_REPO}.git"
 * /opt/blueprint` (container/studio-bringup.sh). For every studio whose WORK
 * repo has a different owner than the blueprint repo, the work-repo credential
 * cannot read the blueprint repo — so the clone has to reach a DIFFERENT
 * credential. That is the whole job of blueprintCredentialWriteCmd.
 *
 * This test asserts the PROPERTY that job comes down to: for the exact URL
 * bring-up clones, git must hand back the BLUEPRINT token. Not that some
 * config key exists, not that some file was written — which credential git
 * actually picks, asked of git itself.
 *
 * Two real failure modes this caught, both invisible to a string assertion:
 *   1. a `credential.<url>.helper` key without the `.git` suffix never matches
 *      the clone URL at all (git's credential URL match includes the path, and
 *      the path there is `<owner>/<repo>.git`);
 *   2. even when it matches, git does not PREFER the more specific section —
 *      it appends that section's helpers to the bare `credential.helper` list
 *      and takes the first complete answer, which is always the work-repo
 *      store. The list has to be reset first.
 */

const BLUEPRINT_REPO = "acme-org/websites";
const BLUEPRINT_TOKEN = "ghs_blueprintTokenForTheBlueprintRepo";
const WORK_TOKEN = "github_pat_workTokenForThePersonalWorkRepo";

/** The URL bring-up actually clones, read out of bring-up itself rather than
 *  retyped here — the coupling between the config key and that URL is exactly
 *  what failure mode 1 above is, so the test must not restate it by hand. */
function blueprintCloneUrl(repo: string): string {
  const src = readFileSync(join(import.meta.dir, "../../container/studio-bringup.sh"), "utf8");
  const m = /git clone --depth 1 "([^"]+)" "\$dir"/.exec(src);
  if (!m) throw new Error("blueprint clone line not found in studio-bringup.sh");
  return m[1]!.replace("${BLUEPRINT_REPO}", repo);
}

/** Both commands hardcode /workspace, which no test host has. Only the
 *  credential FILE location is rewritten — the config KEY and the helper
 *  ordering, the two things under test, stay byte-identical. */
function localize(cmd: string, dir: string): string {
  return cmd.replaceAll("/workspace/", `${dir}/`);
}

function gitEnv(dir: string): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    HOME: dir,
    GIT_CONFIG_GLOBAL: join(dir, ".gitconfig"),
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** A container-shaped git setup: the work-repo credential already installed
 *  (credentials.ts’s own credentialWriteCmd, the untouched existing mechanism), then
 *  the blueprint credential on top. */
function setup(): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-bpcred-"));
  const env = gitEnv(dir);
  mkdirSync(join(dir, ".config", "gh"), { recursive: true });
  // #110 review: each token rides the exec's env, exactly as sbExec hands it over.
  for (const [cmd, token] of [
    [credentialWriteCmd(), WORK_TOKEN], [blueprintCredentialWriteCmd(BLUEPRINT_REPO), BLUEPRINT_TOKEN],
  ] as const) {
    const r = Bun.spawnSync({
      cmd: ["bash", "-c", localize(cmd, dir)], env: { ...env, ...tokenEnv(token) }, stdout: "pipe", stderr: "pipe",
    });
    if (r.exitCode !== 0) throw new Error(`setup command failed: ${r.stderr.toString()}`);
  }
  return { dir, env };
}

function credentialFor(url: string, env: Record<string, string>): string {
  const r = Bun.spawnSync({
    cmd: ["git", "credential", "fill"],
    stdin: Buffer.from(`url=${url}\n\n`),
    env, stdout: "pipe", stderr: "pipe",
  });
  return r.stdout.toString();
}

describe("blueprintCredentialWriteCmd, asked of git", () => {
  test("git serves the BLUEPRINT token for the URL bring-up clones", () => {
    const { dir, env } = setup();
    try {
      expect(credentialFor(blueprintCloneUrl(BLUEPRINT_REPO), env)).toContain(`password=${BLUEPRINT_TOKEN}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the work repo still gets the work token — the blueprint credential never widens", () => {
    const { dir, env } = setup();
    try {
      expect(credentialFor("https://github.com/acme-org/sample.git", env)).toContain(`password=${WORK_TOKEN}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a second provision re-runs it and the blueprint token still wins", () => {
    const { dir, env } = setup();
    try {
      const again = Bun.spawnSync({
        cmd: ["bash", "-c", localize(blueprintCredentialWriteCmd(BLUEPRINT_REPO), dir)],
        env: { ...env, ...tokenEnv(BLUEPRINT_TOKEN) }, stdout: "pipe", stderr: "pipe",
      });
      expect(again.exitCode).toBe(0);
      expect(credentialFor(blueprintCloneUrl(BLUEPRINT_REPO), env)).toContain(`password=${BLUEPRINT_TOKEN}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

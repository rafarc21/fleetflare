import { describe, it, expect } from "vitest";
import type { Env } from "../src/env";
import { mintPrivateCloneToken } from "../src/github/auth";

// #715: the git proxy's token for a private leg is read-only, and only the GitHub
// App can mint one. A PAT's permissions are fixed when it is issued, so a
// PAT-served owner must be refused before any mint or upstream call.

const REPO = "acme/example";
const PAT_ONLY_MESSAGE = "private clone needs the GitHub App on this owner";

const patEnv = { GITHUB_TOKEN: "github_pat_TESTONLY_not_real" } as unknown as Env;
const patAndAppEnv = {
  GITHUB_TOKEN: "github_pat_TESTONLY_not_real",
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "TESTONLY",
  GITHUB_INSTALLATION_ID: "2",
} as unknown as Env;

describe("mintPrivateCloneToken: App-only, read-only", () => {
  it("a PAT-served owner is refused with the named leg error", async () => {
    await expect(mintPrivateCloneToken(patEnv, REPO)).rejects.toThrow(PAT_ONLY_MESSAGE);
  });

  it("a PAT-served owner is refused even when the App is also configured: the PAT wins the owner, so no App mint runs", async () => {
    await expect(mintPrivateCloneToken(patAndAppEnv, REPO)).rejects.toThrow(PAT_ONLY_MESSAGE);
  });

  it("the refusal never returns the PAT as a token", async () => {
    const result = await mintPrivateCloneToken(patEnv, REPO).then(
      (t) => t,
      (err: Error) => err.message,
    );
    expect(result).not.toContain("github_pat_TESTONLY");
  });
});

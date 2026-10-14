import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnippet } from "./exec-snippet";

const REEMIT = readFileSync(join(import.meta.dir, "../../../../gates/session-reemit.sh"), "utf8");

function reemit(payload: unknown, workingSet: string) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-ws-"));
  mkdirSync(join(dir, ".fleet"), { recursive: true });
  writeFileSync(join(dir, ".fleet", "working-set.md"), workingSet);
  try {
    return runSnippet({
      script: REEMIT, stdin: JSON.stringify(payload), shell: "bash",
      env: { FLEET_WORKSPACE: dir },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("session re-emit hook", () => {
  test("replays the working set when source is compact", () => {
    const r = reemit({ source: "compact" }, "THE BRIEF");
    expect(r.stdout).toContain("THE BRIEF");
    expect(r.code).toBe(0);
  });

  test("replays it on clear too", () => {
    expect(reemit({ source: "clear" }, "THE BRIEF").stdout).toContain("THE BRIEF");
  });

  test("stays silent on a normal startup — bring-up already sent the prompt", () => {
    const r = reemit({ source: "startup" }, "THE BRIEF");
    expect(r.stdout.trim()).toBe("");
    expect(r.code).toBe(0);
  });

  test("stays silent on resume — --continue restores the transcript itself", () => {
    expect(reemit({ source: "resume" }, "THE BRIEF").stdout.trim()).toBe("");
  });

  test("a missing working-set file is silent, never a crash", () => {
    const r = runSnippet({
      script: REEMIT, stdin: JSON.stringify({ source: "compact" }), shell: "bash",
      env: { FLEET_WORKSPACE: "/no/such/dir" },
    });
    // Review finding (Minor): code-only left this vacuous -- deleting the
    // guard line still exits 0 via the trailing `exit 0`, while leaking the
    // "Context was compacted..." header with no body. Assert stdout too.
    expect(r.stdout.trim()).toBe("");
    expect(r.code).toBe(0);
  });

  test("malformed payload is silent, never a crash", () => {
    const r = runSnippet({ script: REEMIT, stdin: "not json", shell: "bash" });
    expect(r.code).toBe(0);
    // Review finding (Minor, M5): code-only was vacuous here too -- no
    // FLEET_WORKSPACE override means the default path (/workspace/...) does
    // not exist on the runner, so exit 0 held regardless of what the
    // malformed-payload branch actually does. The test right below seeds a
    // real working-set file so this assertion has something to catch.
    expect(r.stdout.trim()).toBe("");
  });

  test("malformed payload stays silent even with a real working set on disk to leak (review Minor)", () => {
    // The test above only proves silence with an UNSET FLEET_WORKSPACE,
    // where the default path (/workspace/...) does not exist on the runner
    // -- so a code-only, no-seed check would pass whether or not the
    // malformed-payload branch actually stays silent, purely because there
    // is nothing on disk to leak. Seeding a real file here is what makes
    // the assertion mean something: an empty `case` guard regression that
    // let a malformed payload fall through to the compact/clear branch
    // would leak THIS content, and the code-only check above would still
    // read 0 either way.
    const dir = mkdtempSync(join(tmpdir(), "fleet-ws-"));
    mkdirSync(join(dir, ".fleet"), { recursive: true });
    writeFileSync(join(dir, ".fleet", "working-set.md"), "THE BRIEF");
    try {
      const malformed = runSnippet({
        script: REEMIT, stdin: "not json", shell: "bash",
        env: { FLEET_WORKSPACE: dir },
      });
      expect(malformed.code).toBe(0);
      expect(malformed.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an all-whitespace working set (empty ROLE_PROMPT_B64 -> a one-newline file) is treated as nothing to replay, not a bare header (review Minor)", () => {
    // studio-bringup.sh writes the working set as `printf '%s\n' "$role_prompt"`
    // -- when ROLE_PROMPT_B64 decodes to an empty string (unset, or empty),
    // that is ONE byte on disk (a lone newline), not zero. The file is still
    // readable, so a readability-only guard lets the hook print the
    // "Context was compacted..." header with nothing real under it.
    const r = reemit({ source: "compact" }, "\n");
    expect(r.stdout.trim()).toBe("");
    expect(r.code).toBe(0);
  });
});

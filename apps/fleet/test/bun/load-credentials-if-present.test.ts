// Board issue #208, PR #215 round 2 fix C(1) (MINOR): `loadCredentialsIfPresent`
// (cli/fleet.ts) is the SOFT, non-exiting variant of `loadCredentials`, meant
// to let `scripts/sensors/run.ts`'s platform-replacements sensor soft-fail to
// "n/a" when no credential is available, alongside two other sensors in the
// same `Promise.all` that need none at all (see that function's own doc
// comment). Before this fix it only handled a MISSING file softly — a file
// that EXISTS but holds malformed JSON still threw straight out of
// `file.json()`, uncaught, which would have killed the whole `Promise.all`
// exactly like the bug this feature exists to avoid.
//
// A real subprocess, not an in-process import: `CREDENTIALS_PATH`
// (cli/fleet.ts) resolves `homedir()` once at module load, so the only way to
// point it at a throwaway fixture directory is a fresh process with its own
// HOME — the same idiom test/bun/ff-no-tty.test.ts already uses for the same
// reason.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FLEET_MODULE = join(import.meta.dir, "../../cli/fleet.ts");

async function runLoadCredentialsIfPresent(home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const runner = join(home, "run.ts");
  writeFileSync(
    runner,
    `import { loadCredentialsIfPresent } from ${JSON.stringify(FLEET_MODULE)};\n` +
      `const result = await loadCredentialsIfPresent();\n` +
      `console.log(JSON.stringify(result));\n`,
  );
  const proc = Bun.spawn({
    cmd: [process.execPath, runner],
    env: { ...process.env, HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("loadCredentialsIfPresent — malformed JSON (#208 fix round 2, item C1)", () => {
  test("malformed JSON in ~/.fleet/credentials returns null -- soft-fails like the missing-file case, never throws", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-creds-home-"));
    try {
      mkdirSync(join(home, ".fleet"));
      const credentials = join(home, ".fleet", "credentials");
      writeFileSync(credentials, "{ this is not valid json");
      chmodSync(credentials, 0o600);

      const { code, stdout } = await runLoadCredentialsIfPresent(home);

      expect(code).toBe(0);
      expect(stdout.trim()).toBe("null");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Control case, same process shape: a well-formed file still round-trips
  // through the real subprocess -- proves a passing malformed-JSON test above
  // isn't just an artifact of the runner itself always printing "null".
  test("well-formed credentials file still loads normally through the same runner", async () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-creds-home-"));
    try {
      mkdirSync(join(home, ".fleet"));
      const credentials = join(home, ".fleet", "credentials");
      writeFileSync(
        credentials,
        JSON.stringify({ workerUrl: "https://example.com", accessClientId: "id", accessClientSecret: "secret" }),
      );
      chmodSync(credentials, 0o600);

      const { code, stdout } = await runLoadCredentialsIfPresent(home);

      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({
        workerUrl: "https://example.com", accessClientId: "id", accessClientSecret: "secret",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

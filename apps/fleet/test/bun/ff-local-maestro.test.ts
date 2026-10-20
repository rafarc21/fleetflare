// `ff maestro --local` / bare `ff --local` must REFUSE, never spawn — fleet
// task #1248 (finding S2). ffDecision already refuses the maestro role for
// the CLOUD form (board issue #250: maestro is ALWAYS LOCAL, never a cloud
// studio), but the `--local` path short-circuits ffDecision entirely, so
// cli/ff.ts's ffLocal must carry the SAME refusal itself. Otherwise
// `ff maestro --local` would run a LOCAL maestro — which is exactly what the
// operator starts by hand per docs/setup.md, never something `ff` spawns.
//
// bun:test lane, not vitest: cli/ff.ts is Bun-only and never imported from
// the vitest suite — same harness as ff-no-tty.test.ts / cli.spawn-no-remote.
// A real subprocess of cli/ff.ts against a stub Worker proves the refusal
// fires BEFORE any /studio/local/spawn POST (the stub sees zero such calls).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FF = join(import.meta.dir, "../../cli/ff.ts");

let server: ReturnType<typeof Bun.serve>;
let home: string;
let repo: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      // Any route reached at all is a sign the refusal did NOT fire early —
      // the maestro refusal must precede every fetch in the local path.
      return new Response("not found", { status: 404 });
    },
  });
  home = mkdtempSync(join(tmpdir(), "ff-local-maestro-home-"));
  mkdirSync(join(home, ".fleet"));
  const credentials = join(home, ".fleet", "credentials");
  writeFileSync(credentials, JSON.stringify({
    workerUrl: `http://127.0.0.1:${server.port}`,
    accessClientId: "id", accessClientSecret: "s",
  }));
  chmodSync(credentials, 0o600);
  repo = mkdtempSync(join(tmpdir(), "ff-local-maestro-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/faux.git"], { cwd: repo });
});

afterAll(() => {
  server?.stop(true);
  for (const dir of [home, repo]) if (dir) rmSync(dir, { recursive: true, force: true });
});

async function runFfLocal(args: string[]) {
  const proc = Bun.spawn({
    cmd: [process.execPath, FF, ...args],
    cwd: repo,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ORCA_"))),
      HOME: home, TERM_PROGRAM: "not-orca",
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const killer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(killer);
  return { code, stdout, stderr };
}

describe("ff --local refuses the maestro role (S2)", () => {
  test("`ff maestro --local` exits non-zero with the ffDecision refusal message", async () => {
    const r = await runFfLocal(["maestro", "--local"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("maestro runs locally, not as a cloud studio");
  }, 40_000);

  test("bare `ff --local` (defaults to maestro) exits non-zero with the same message", async () => {
    const r = await runFfLocal(["--local"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("maestro runs locally, not as a cloud studio");
  }, 40_000);
});
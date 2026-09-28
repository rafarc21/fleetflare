import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { denylistFileContent } from "../../src/leak-gate";
import { leakGateInstallCmd, STUDIO_GH_LEAK_REFUSAL } from "../../src/studio/gh-wrapper";

/**
 * Issue #1 -- the container `gh` wrapper. Real bash, a fake real gh that
 * records its argv and stdin. Fake terms only (acmeclient, 999999999): this
 * file ships in a public repo.
 */

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const ON = denylistFileContent({ patterns: ["acmeclient", "9{9}"] });
const SYS_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

type Studio = {
  dir: string;
  bin: string;
  install: () => { code: number; stderr: string };
  gh: (args: string[], stdin?: string) => { code: number; stderr: string };
  realArgv: () => string[] | null;
  realStdin: () => string;
};

function studio(denylist: string | null): Studio {
  const d = mkdtempSync(join(tmpdir(), "fleet-gh-"));
  dir = d;
  const bin = join(d, "bin");
  const realDir = join(d, "real");
  mkdirSync(realDir);
  const real = join(realDir, "gh");
  writeFileSync(real, `#!/bin/bash\nprintf '%s\\0' "$@" > '${d}/argv'\ncat > '${d}/stdin'\nexit 0\n`);
  chmodSync(real, 0o755);
  const list = join(d, "denylist");
  if (denylist !== null) writeFileSync(list, denylist);
  const cmd = leakGateInstallCmd({
    scanPath: join(bin, "fleet-leak-scan"),
    ghWrapperPath: join(bin, "gh"),
    realGh: real,
    denylistPath: list,
  });
  const env = { PATH: `${bin}:${realDir}:${SYS_PATH}` };
  const s: Studio = {
    dir: d,
    bin,
    install: () => {
      const r = Bun.spawnSync({ cmd: ["bash", "-c", cmd], env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode ?? -1, stderr: r.stderr.toString() };
    },
    gh: (args, stdin = "") => {
      const r = Bun.spawnSync({
        cmd: ["bash", "-c", 'gh "$@"', "gh", ...args],
        env, cwd: d, stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe",
      });
      return { code: r.exitCode ?? -1, stderr: r.stderr.toString() };
    },
    realArgv: () => {
      const f = join(d, "argv");
      if (!existsSync(f)) return null;
      return readFileSync(f, "utf8").split("\0").slice(0, -1);
    },
    realStdin: () => readFileSync(join(d, "stdin"), "utf8"),
  };
  return s;
}

function installed(denylist: string | null = ON): Studio {
  const s = studio(denylist);
  const r = s.install();
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  return s;
}

function expectRefused(s: Studio, r: { code: number; stderr: string }): void {
  expect(r.code).toBe(1);
  expect(r.stderr).toContain(STUDIO_GH_LEAK_REFUSAL);
  expect(r.stderr.toLowerCase()).not.toContain("acmeclient");
  expect(r.stderr).not.toContain("999999999");
  expect(s.realArgv()).toBeNull();
}

describe("gh wrapper: argv text", () => {
  test("--body hit refused, real gh not run, index named (mutant: gh body not scanned)", () => {
    const s = installed();
    const r = s.gh(["issue", "create", "--title", "t", "--body", "has acmeclient"]);
    expectRefused(s, r);
    expect(r.stderr).toContain("#1");
  });

  test("--title hit refused", () => {
    const s = installed();
    expectRefused(s, s.gh(["issue", "create", "--title", "AcmeClient bug", "--body", "b"]));
  });

  test("-b hit refused", () => {
    const s = installed();
    expectRefused(s, s.gh(["issue", "create", "-t", "t", "-b", "id 999999999"]));
  });

  test("--body= hit refused", () => {
    const s = installed();
    expectRefused(s, s.gh(["issue", "create", "--title", "t", "--body=acmeclient"]));
  });

  test("pr comment --body hit refused", () => {
    const s = installed();
    expectRefused(s, s.gh(["pr", "comment", "5", "--body", "acmeclient"]));
  });

  test("api -f body= hit refused", () => {
    const s = installed();
    expectRefused(s, s.gh(["api", "repos/o/r/issues", "-f", "body=acmeclient"]));
  });

  test("global -R before the command still gated", () => {
    const s = installed();
    expectRefused(s, s.gh(["-R", "o/r", "issue", "create", "--body", "acmeclient"]));
  });

  test("clean write reaches real gh with identical argv", () => {
    const s = installed();
    const args = ["issue", "create", "--title", "a b", "--body", "line1\nline2 $HOME *", "-R", "o/r"];
    const r = s.gh(args);
    expect(r.code).toBe(0);
    expect(s.realArgv()).toEqual(args);
  });

  test("clean non-write command passes through untouched", () => {
    const s = installed();
    const r = s.gh(["repo", "view", "o/x"]);
    expect(r.code).toBe(0);
    expect(s.realArgv()).toEqual(["repo", "view", "o/x"]);
  });
});

describe("gh wrapper: default deny, every command scanned", () => {
  const cases: [string, string[]][] = [
    ["repo view with term (mutant: allowlist of gated commands)", ["repo", "view", "acmeclient/x"]],
    ["alias", ["co", "acmeclient"]],
    ["project item-create --title", ["project", "item-create", "1", "--owner", "o", "--title", "acmeclient"]],
    ["repo edit --description", ["repo", "edit", "--description", "for acmeclient"]],
    ["label create", ["label", "create", "acmeclient"]],
    ["workflow run -f", ["workflow", "run", "w.yml", "-f", "name=acmeclient"]],
    ["extension", ["myext", "--note", "999999999"]],
  ];
  for (const [name, args] of cases) {
    test(`${name} hit refused`, () => {
      const s = installed();
      expectRefused(s, s.gh(args));
    });
  }

  test("workflow run -F key=@file hit refused (mutant: -F files only for api)", () => {
    const s = installed();
    writeFileSync(join(s.dir, "v.txt"), "acmeclient\n");
    expectRefused(s, s.gh(["workflow", "run", "w.yml", "-F", "name=@v.txt"]));
  });

  test("workflow run -F key=value clean passes (not read as a file)", () => {
    const s = installed();
    const args = ["workflow", "run", "w.yml", "-F", "name=value"];
    const r = s.gh(args);
    expect(r.code).toBe(0);
    expect(s.realArgv()).toEqual(args);
  });

  test("unknown command --body-file hit refused", () => {
    const s = installed();
    writeFileSync(join(s.dir, "b.md"), "acmeclient\n");
    expectRefused(s, s.gh(["myext", "--body-file", "b.md"]));
  });
});

describe("gh wrapper: gist stdin, release assets", () => {
  test("gist create with no file args: stdin hit refused (mutant: stdin gist unscanned)", () => {
    const s = installed();
    expectRefused(s, s.gh(["gist", "create"], "has acmeclient\n"));
  });

  test("gist create -d desc, no file args: stdin hit refused", () => {
    const s = installed();
    expectRefused(s, s.gh(["gist", "create", "-d", "desc", "-f", "x.txt"], "has acmeclient\n"));
  });

  test("clean stdin gist hands real gh identical stdin", () => {
    const s = installed();
    const body = "clean gist\n";
    const r = s.gh(["gist", "create", "--public"], body);
    expect(r.code).toBe(0);
    expect(s.realStdin()).toBe(body);
  });

  test("release create positional asset hit refused (mutant: assets unscanned)", () => {
    const s = installed();
    writeFileSync(join(s.dir, "notes.bin"), "acmeclient\n");
    expectRefused(s, s.gh(["release", "create", "v1", "notes.bin"]));
  });

  test("release upload asset#label hit refused", () => {
    const s = installed();
    writeFileSync(join(s.dir, "a.bin"), "acmeclient\n");
    expectRefused(s, s.gh(["release", "upload", "v1", "a.bin#Display label"]));
  });

  test("release upload clean asset passes", () => {
    const s = installed();
    writeFileSync(join(s.dir, "a.bin"), "clean\n");
    const args = ["release", "upload", "v1", "a.bin#lbl"];
    const r = s.gh(args);
    expect(r.code).toBe(0);
    expect(s.realArgv()).toEqual(args);
  });
});

describe("gh wrapper: file contents", () => {
  test("api -F body=@file hit refused (mutant: @file fields not read)", () => {
    const s = installed();
    writeFileSync(join(s.dir, "b.md"), "acmeclient\n");
    expectRefused(s, s.gh(["api", "repos/o/r/issues", "-F", "body=@b.md"]));
  });

  test("api --field=body=@file hit refused", () => {
    const s = installed();
    writeFileSync(join(s.dir, "b.md"), "acmeclient\n");
    expectRefused(s, s.gh(["api", "repos/o/r/issues", "--field=body=@b.md"]));
  });

  test("api --input file hit refused", () => {
    const s = installed();
    writeFileSync(join(s.dir, "b.json"), '{"body":"acmeclient"}\n');
    expectRefused(s, s.gh(["api", "repos/o/r/issues", "--input", "b.json"]));
  });

  test("--body-file f hit refused (mutant: body file not read)", () => {
    const s = installed();
    writeFileSync(join(s.dir, "b.md"), "acmeclient\n");
    expectRefused(s, s.gh(["issue", "create", "--title", "t", "--body-file", "b.md"]));
  });

  test("--body-file=f hit refused", () => {
    const s = installed();
    writeFileSync(join(s.dir, "b.md"), "acmeclient\n");
    expectRefused(s, s.gh(["issue", "create", "--title", "t", "--body-file=b.md"]));
  });

  test("pr create -F f hit refused", () => {
    const s = installed();
    writeFileSync(join(s.dir, "b.md"), "acmeclient\n");
    expectRefused(s, s.gh(["pr", "create", "--title", "t", "-F", "b.md"]));
  });

  test("release --notes-file hit refused", () => {
    const s = installed();
    writeFileSync(join(s.dir, "n.md"), "acmeclient\n");
    expectRefused(s, s.gh(["release", "create", "v1", "--notes-file", "n.md"]));
  });

  test("gist create file hit refused", () => {
    const s = installed();
    writeFileSync(join(s.dir, "g.txt"), "acmeclient\n");
    expectRefused(s, s.gh(["gist", "create", "g.txt"]));
  });

  test("unreadable named file refused", () => {
    const s = installed();
    expectRefused(s, s.gh(["issue", "create", "--title", "t", "--body-file", "nope.md"]));
  });

  test("--body-file - stdin hit refused (mutant: stdin not captured)", () => {
    const s = installed();
    expectRefused(s, s.gh(["issue", "create", "--title", "t", "--body-file", "-"], "has acmeclient\n"));
  });

  test("clean --body-file - hands real gh identical stdin", () => {
    const s = installed();
    const body = "clean line one\nline two\n";
    const r = s.gh(["issue", "create", "--title", "t", "--body-file", "-"], body);
    expect(r.code).toBe(0);
    expect(s.realStdin()).toBe(body);
  });
});

describe("gh wrapper: fail closed", () => {
  test("gate file missing refuses (mutant: denylist missing -> a pass)", () => {
    const s = installed(null);
    expectRefused(s, s.gh(["issue", "create", "--title", "t", "--body", "clean"]));
  });

  test("invalid pattern refuses (mutant: scanner errors swallowed -> a pass)", () => {
    const s = installed(denylistFileContent({ patterns: ["acme["] }));
    expectRefused(s, s.gh(["issue", "create", "--title", "t", "--body", "clean"]));
  });

  test("scanner absent refuses", () => {
    const s = installed();
    rmSync(join(s.bin, "fleet-leak-scan"));
    expectRefused(s, s.gh(["issue", "create", "--title", "t", "--body", "clean"]));
  });

  test("gate off: a hit passes", () => {
    const s = installed(denylistFileContent({ off: "work repo is private" }));
    const r = s.gh(["issue", "create", "--title", "t", "--body", "acmeclient"]);
    expect(r.code).toBe(0);
    expect(s.realArgv()).toEqual(["issue", "create", "--title", "t", "--body", "acmeclient"]);
  });
});

describe("leakGateInstallCmd", () => {
  test("second run is idempotent and the wrapper still gates", () => {
    const s = installed();
    const r = s.install();
    expect(r.code).toBe(0);
    expectRefused(s, s.gh(["issue", "create", "--body", "acmeclient"]));
  });

  test("fails when gh on PATH does not resolve to the wrapper", () => {
    const s = studio(ON);
    const shadow = join(s.dir, "shadow");
    mkdirSync(shadow);
    writeFileSync(join(shadow, "gh"), "#!/bin/bash\nexit 0\n");
    chmodSync(join(shadow, "gh"), 0o755);
    const cmd = leakGateInstallCmd({
      scanPath: join(s.bin, "fleet-leak-scan"), ghWrapperPath: join(s.bin, "gh"),
      realGh: join(s.dir, "real", "gh"), denylistPath: join(s.dir, "denylist"),
    });
    const r = Bun.spawnSync({ cmd: ["bash", "-c", cmd], env: { PATH: `${shadow}:${s.bin}:${SYS_PATH}` }, stdin: "ignore" });
    expect(r.exitCode).not.toBe(0);
  });

  test("defaults target the container paths", () => {
    const cmd = leakGateInstallCmd();
    expect(cmd).toContain("'/usr/local/bin/fleet-leak-scan'");
    expect(cmd).toContain("'/usr/local/bin/gh'");
    expect(cmd.endsWith(`[ "$(command -v gh)" = '/usr/local/bin/gh' ]`)).toBe(true);
  });
});

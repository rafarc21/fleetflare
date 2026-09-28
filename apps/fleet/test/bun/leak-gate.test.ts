import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDenylist, scanText, denylistFileContent, leakScanScript,
  LEAK_DENYLIST_MISSING, LEAK_SCAN_ERROR, LEAK_HIT_PREFIX,
} from "../../src/leak-gate";

/**
 * Issue #1 -- the public-repo leak gate's core: the denylist format, the
 * Worker-side scan, and the container-side `fleet-leak-scan` script. Fake
 * terms only (acmeclient, 999999999): this file ships in a public repo.
 */

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function scanner(denylist: string | null): { run: (text: string) => { code: number; stderr: string } } {
  dir = mkdtempSync(join(tmpdir(), "fleet-leak-"));
  const list = join(dir, "denylist");
  if (denylist !== null) writeFileSync(list, denylist);
  const script = join(dir, "fleet-leak-scan");
  writeFileSync(script, leakScanScript(list));
  chmodSync(script, 0o755);
  return {
    run: (text: string) => {
      const r = Bun.spawnSync({ cmd: [script], stdin: Buffer.from(text), stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode ?? -1, stderr: r.stderr.toString() };
    },
  };
}

const ON = denylistFileContent({ patterns: ["acmeclient", "9{9}"] });

describe("parseDenylist", () => {
  test("one pattern per line, blank lines and CRs dropped", () => {
    expect(parseDenylist("acmeclient\r\n\n9{9}\n")).toEqual(["acmeclient", "9{9}"]);
  });

  test("zero patterns is an error, never an empty (pass-everything) list", () => {
    expect(() => parseDenylist("\n \n")).toThrow();
  });
});

describe("scanText", () => {
  test("returns 1-based indexes of every matching pattern, case-insensitive", () => {
    expect(scanText(["acmeclient", "nothing", "9{9}"], "Notes for AcmeClient, id 999999999")).toEqual([1, 3]);
  });

  test("clean text returns no hits", () => {
    expect(scanText(["acmeclient"], "plain text")).toEqual([]);
  });

  test("an invalid pattern throws (mutant: scanner errors swallowed -> a pass)", () => {
    expect(() => scanText(["acme(", "x"], "text")).toThrow();
  });
});

describe("fleet-leak-scan (container scanner script)", () => {
  test("clean text exits 0", () => {
    expect(scanner(ON).run("plain text\n").code).toBe(0);
  });

  test("a hit exits 1 and names the pattern INDEX, never the term", () => {
    const r = scanner(ON).run("hello ACMECLIENT and 999999999\n");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(LEAK_HIT_PREFIX);
    expect(r.stderr).toContain("#1");
    expect(r.stderr).toContain("#2");
    expect(r.stderr.toLowerCase()).not.toContain("acmeclient");
    expect(r.stderr).not.toContain("9{9}");
  });

  test("a missing denylist refuses (mutant: denylist missing -> a pass)", () => {
    const r = scanner(null).run("plain text\n");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(LEAK_DENYLIST_MISSING);
  });

  test("a denylist without the fleet header refuses", () => {
    const r = scanner("acmeclient\n").run("plain text\n");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(LEAK_DENYLIST_MISSING);
  });

  test("an 'on' header with zero patterns refuses", () => {
    expect(scanner(`${denylistFileContent({ patterns: ["x"] }).split("\n")[0]}\n`).run("plain\n").code).toBe(2);
  });

  test("an invalid pattern refuses (mutant: scanner errors swallowed -> a pass)", () => {
    const r = scanner(denylistFileContent({ patterns: ["acme["] })).run("plain text\n");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(LEAK_SCAN_ERROR);
  });

  test("an 'off' gate passes everything and says why", () => {
    const r = scanner(denylistFileContent({ off: "work repo is private" })).run("acmeclient\n");
    expect(r.code).toBe(0);
  });

  test("binary-looking input is still scanned", () => {
    expect(scanner(ON).run("\u0000\u0001acmeclient\u0000\n").code).toBe(1);
  });

  test("file arguments are scanned instead of stdin", () => {
    const s = scanner(ON);
    const f = join(dir!, "body.md");
    writeFileSync(f, "body with acmeclient\n");
    const r = Bun.spawnSync({ cmd: [join(dir!, "fleet-leak-scan"), f], stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(1);
    expect(s).toBeDefined();
  });

  test("an unreadable file argument refuses", () => {
    scanner(ON);
    const r = Bun.spawnSync({ cmd: [join(dir!, "fleet-leak-scan"), join(dir!, "nope")], stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(2);
  });
});

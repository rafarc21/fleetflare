import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnippet } from "./exec-snippet";
import {
  tarAndStatCmd, asideListCmd, asidePackCmd, asidePartReadCmd, asideMarkCmd, SESSION_EXCLUDES_PATH,
} from "../../src/studio/session-sync";

/**
 * Issue #37: `--fresh-session` (#28) moves an un-resumable session to
 * `~/.claude/projects/fleet-aside-*`. It stayed inside the main session tar,
 * so an OVERSIZE one kept that tar over SESSION_TOTAL_MAX: sync refused every
 * tick and neither the old nor the new session reached R2. Now the main tar
 * leaves aside dirs out (and their subagents out of its budget), and each
 * aside dir ships once as its own split archive.
 *
 * Real commands, real GNU tools, temp HOME. Same lane guard as
 * session-tar-budget.test.ts: GNU find/stat/split only.
 */
function gnuLane(): boolean {
  const find = spawnSync("find", ["--version"], { encoding: "utf8" });
  if (find.status !== 0 || !/GNU findutils/.test(find.stdout ?? "")) return false;
  const stat = spawnSync("stat", ["-c", "%s", "/"], { encoding: "utf8" });
  return stat.status === 0 && /^\d+$/.test((stat.stdout ?? "").trim());
}
const suite = gnuLane() ? describe : describe.skip;

const ROOT = "-workspace-acmeclient";
const ASIDE = "fleet-aside-20260929T100000Z-42--workspace-acmeclient";
const OLD_ID = "a1c006ac-dd42-48a7-a063-90400c353858";
const NEW_ID = "b1c006ac-dd42-48a7-a063-90400c353858";

let base: string;
let home: string;
let sync: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "fleet-aside-"));
  home = join(base, "home");
  sync = join(base, "sync");
  mkdirSync(join(home, ".claude", "projects", ROOT), { recursive: true });
  writeFileSync(join(home, ".claude.json"), '{"ok":true}');
  writeFileSync(join(home, ".claude", "projects", ROOT, `${NEW_ID}.jsonl`), '{"type":"user"}\n');
  const aside = join(home, ".claude", "projects", ASIDE);
  mkdirSync(join(aside, OLD_ID, "subagents"), { recursive: true });
  writeFileSync(join(aside, `${OLD_ID}.jsonl`), '{"type":"user","old":true}\n'.repeat(1000));
  // A big aside subagent: counted in the budget, it would push live
  // subagents out of the main tar.
  writeFileSync(join(aside, OLD_ID, "subagents", "agent-1.jsonl"), "x".repeat(300_000) + "\n");
  // A LIVE subagent, older than the aside one and outside the live window:
  // with the aside counted, 300k + this > budget and this one is dropped.
  const live = join(home, ".claude", "projects", ROOT, NEW_ID, "subagents");
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, "agent-live.jsonl"), "y".repeat(50_000) + "\n");
  const old = Date.now() / 1000 - 3 * 86_400;
  utimesSync(join(live, "agent-live.jsonl"), old, old);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function sh(script: string) {
  const r = runSnippet({ script, sourced: true, shell: "sh", timeout: 60_000 });
  return r;
}

suite("#37 — aside dirs leave the main tar and ship on their own", () => {
  test("main tar: no fleet-aside-* member, and no aside path in the subagent excludes", () => {
    const r = sh(tarAndStatCmd(home, sync, 100_000, 60));
    expect(r.code).toBe(0);
    const members = sh(`tar -tzf ${join(sync, "latest.tar.gz")}`).stdout.split("\n").filter(Boolean);
    expect(members.some((m) => m.includes(`${ROOT}/${NEW_ID}.jsonl`))).toBe(true);
    expect(members.some((m) => m.includes("agent-live.jsonl"))).toBe(true);
    expect(members.some((m) => m.includes("fleet-aside-"))).toBe(false);
    const excludes = readFileSync(join(sync, SESSION_EXCLUDES_PATH.split("/").at(-1)!), "utf8");
    expect(excludes).not.toContain("fleet-aside-");
    expect(excludes).not.toContain("agent-live.jsonl");
  });

  test("list → pack → parts → mark: parts rebuild the exact tar, marked dir is not listed again", () => {
    expect(sh(asideListCmd(home)).stdout.trim()).toBe(ASIDE);

    const packed = sh(asidePackCmd(ASIDE, home, sync, "64k"));
    expect(packed.code).toBe(0);
    const [sizeLine, shaLine] = packed.stdout.trim().split("\n");
    const size = Number(sizeLine);
    const tarPath = join(sync, "aside", `${ASIDE}.tar.gz`);
    const tarBytes = readFileSync(tarPath);
    expect(size).toBe(tarBytes.length);
    expect(shaLine).toBe(createHash("sha256").update(tarBytes).digest("hex"));

    const parts = Math.ceil(size / 65536);
    expect(parts).toBeGreaterThan(1);
    const rebuilt = Buffer.concat(
      Array.from({ length: parts }, (_, i) => Buffer.from(sh(asidePartReadCmd(ASIDE, i, sync)).stdout.replace(/\s/g, ""), "base64")),
    );
    expect(rebuilt.equals(tarBytes)).toBe(true);
    const listed = sh(`tar -tzf ${tarPath}`).stdout;
    expect(listed).toContain(`${ASIDE}/${OLD_ID}.jsonl`);
    expect(listed).toContain(`${ASIDE}/${OLD_ID}/subagents/agent-1.jsonl`);

    expect(sh(asideMarkCmd(ASIDE, home, sync)).code).toBe(0);
    expect(sh(asideListCmd(home)).stdout.trim()).toBe("");
    // The aside itself stays on disk (never deleted); the staging copy goes.
    expect(existsSync(join(home, ".claude", "projects", ASIDE, `${OLD_ID}.jsonl`))).toBe(true);
    expect(readdirSync(join(sync, "aside"))).toEqual([]);
  });

  test("no aside dirs: list prints nothing and exits 0", () => {
    rmSync(join(home, ".claude", "projects", ASIDE), { recursive: true });
    const r = sh(asideListCmd(home));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});

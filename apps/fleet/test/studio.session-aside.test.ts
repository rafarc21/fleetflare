import { describe, it, expect, vi } from "vitest";
import {
  shipAsideSessions, asideListCmd, asidePackCmd, asideMarkCmd, SESSION_ASIDE_MAX, type SessionSyncDeps,
} from "../src/studio/session-sync";
import { SESSION_SINGLE_READ_MAX } from "../src/studio/archive";

// Issue #37: an aside dir (#28's --fresh-session) ships once, as its own
// split archive under sessions/<id>/aside/<dir>/, then gets a marker so it is
// not shipped again. The real commands run in a real shell in
// test/bun/session-aside.test.ts; this pins the Worker-side flow.

const ID = "acmeclient--pilot";
const DIR = "fleet-aside-20260929T100000Z-42--workspace-acmeclient";
const b64 = (n: number) => btoa("\u0007".repeat(n));

function deps(answers: (cmd: string) => { code: number; stdout: string; stderr?: string }) {
  const execs: string[] = [];
  const puts: { key: string; bytes: Uint8Array }[] = [];
  const d: SessionSyncDeps = {
    exec: vi.fn(async (cmd: string) => {
      execs.push(cmd);
      const a = answers(cmd);
      return { code: a.code, stdout: a.stdout, stderr: a.stderr ?? "" };
    }),
    r2Put: vi.fn(async (key: string, bytes: Uint8Array) => { puts.push({ key, bytes }); }),
    r2List: async () => [],
    r2Delete: async () => {},
    now: () => new Date("2026-09-29T10:05:00.000Z"),
    notify: async () => {},
    burnAlertThresholdTokens: 0,
  } as unknown as SessionSyncDeps;
  return { d, execs, puts };
}

describe("shipAsideSessions (issue #37)", () => {
  it("ships every part, then the manifest, then marks the dir; junk list lines ignored", async () => {
    const size = SESSION_SINGLE_READ_MAX + 1000;
    let part = 0;
    const { d, execs, puts } = deps((cmd) => {
      if (cmd === asideListCmd()) return { code: 0, stdout: `${DIR}\nnot an aside dir\n../escape\n` };
      if (cmd === asidePackCmd(DIR)) return { code: 0, stdout: `${size}\nabc123\n` };
      if (cmd.includes(".part-")) return { code: 0, stdout: b64(part++ === 0 ? SESSION_SINGLE_READ_MAX : 1000) };
      return { code: 0, stdout: "" };
    });
    const r = await shipAsideSessions(d, ID);

    expect(r).toEqual({ shipped: [DIR], failed: [] });
    expect(puts.map((p) => p.key)).toEqual([
      `sessions/${ID}/aside/${DIR}/part-0000`,
      `sessions/${ID}/aside/${DIR}/part-0001`,
      `sessions/${ID}/aside/${DIR}/manifest.json`,
    ]);
    expect(JSON.parse(new TextDecoder().decode(puts[2].bytes))).toMatchObject({ dir: DIR, parts: 2, bytes: size, sha256: "abc123" });
    expect(execs.at(-1)).toBe(asideMarkCmd(DIR));
  });

  it("over SESSION_ASIDE_MAX: nothing read or written, not marked, reported", async () => {
    const { d, execs, puts } = deps((cmd) => {
      if (cmd === asideListCmd()) return { code: 0, stdout: `${DIR}\n` };
      if (cmd === asidePackCmd(DIR)) return { code: 0, stdout: `${SESSION_ASIDE_MAX + 1}\nabc\n` };
      return { code: 0, stdout: "" };
    });
    const r = await shipAsideSessions(d, ID);
    expect(r.shipped).toEqual([]);
    expect(r.failed[0]).toMatchObject({ dir: DIR });
    expect(r.failed[0].reason).toContain("SESSION_ASIDE_MAX");
    expect(puts).toEqual([]);
    expect(execs).not.toContain(asideMarkCmd(DIR));
  });

  it("a short part read: no manifest, not marked; the next dir still ships", async () => {
    const DIR2 = "fleet-aside-20260929T100001Z-43--workspace-acmeclient";
    const { d, execs, puts } = deps((cmd) => {
      if (cmd === asideListCmd()) return { code: 0, stdout: `${DIR}\n${DIR2}\n` };
      if (cmd === asidePackCmd(DIR) || cmd === asidePackCmd(DIR2)) return { code: 0, stdout: "100\nabc\n" };
      if (cmd.includes(`${DIR}.tar.gz.part-`)) return { code: 0, stdout: b64(40) };
      if (cmd.includes(`${DIR2}.tar.gz.part-`)) return { code: 0, stdout: b64(100) };
      return { code: 0, stdout: "" };
    });
    const r = await shipAsideSessions(d, ID);
    expect(r.shipped).toEqual([DIR2]);
    expect(r.failed.map((f) => f.dir)).toEqual([DIR]);
    expect(puts.some((p) => p.key === `sessions/${ID}/aside/${DIR}/manifest.json`)).toBe(false);
    expect(execs).not.toContain(asideMarkCmd(DIR));
    expect(execs).toContain(asideMarkCmd(DIR2));
  });

  it("pack fails: reported, never marked", async () => {
    const { d, execs } = deps((cmd) => {
      if (cmd === asideListCmd()) return { code: 0, stdout: `${DIR}\n` };
      if (cmd === asidePackCmd(DIR)) return { code: 2, stdout: "", stderr: "tar: disk full" };
      return { code: 0, stdout: "" };
    });
    const r = await shipAsideSessions(d, ID);
    expect(r.failed[0].reason).toContain("disk full");
    expect(execs).not.toContain(asideMarkCmd(DIR));
  });

  it("nothing aside: one list exec, nothing else", async () => {
    const { d, execs, puts } = deps(() => ({ code: 0, stdout: "" }));
    expect(await shipAsideSessions(d, ID)).toEqual({ shipped: [], failed: [] });
    expect(execs).toEqual([asideListCmd()]);
    expect(puts).toEqual([]);
  });
});

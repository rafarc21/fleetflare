import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { runSnippet } from "./exec-snippet";
import { tarAndStatCmd, SESSION_EXCLUDES_PATH } from "../../src/studio/session-sync";
import { SESSION_SUBAGENT_RAW_BUDGET } from "../../src/studio/archive";
import { extractJsonlMembers, parseUsageIncrement, type BurnCursor } from "../../src/studio/burn";

// Issue #202. The measurement that drives this file (taken read-only inside
// the live fleetflare--release-studio container, 2026-09-24, one project key
// `-workspace-fleetflare`, one root session, 28 jsonl files):
//
//   class                       files   raw bytes    gz bytes   share of gz
//   whole `projects` (shipped)     28  21,877,297   5,018,969        100%
//   root session jsonl              1   2,593,739     603,934       12.0%
//   subagents/*.jsonl              27  18,853,358   4,414,729       88.0%
//
// Compression is ~4.28x for BOTH classes (root 4.29x, subagents 4.27x), so
// compression cannot tell them apart — only EXCLUSION changes the number.
//
// And the age rule the brief suggested prunes NOTHING here: all 28 files are
// <= 2 days old (`<1d` = 11 files / 8,738,659 bytes; `1-7d` and `7-30d`
// EMPTY). 18 MiB of subagent transcript accumulated in TWO days. Age is not
// the bound; subagent COUNT and SIZE is. So the rule under test is a
// newest-mtime-first RAW BYTE BUDGET over `subagents/*.jsonl` only, with
// every non-subagent member kept unconditionally.
//
// These tests run the REAL `tarAndStatCmd()` string in a real shell against
// a temp HOME, with real GNU find/sort/awk/tar — the same lane
// worktree-session-adopt.test.ts uses for the real adopt command.
//
// Fix round, reviewer item 2 — LANE GUARD. The command under test is written
// for the container's Debian-family base image and uses two GNU-only things
// the shipped string cannot give up: `find -printf` (BSD find has no such
// option at all) and `stat -c` (BSD stat spells it `-f`). On macOS every test
// in this file therefore failed on the TOOL, not on the behaviour — a false
// red that says nothing about the code. The suite is skipped unless both GNU
// tools are actually present; CI's Linux lane is where the coverage lives,
// and it is not weakened by this guard.

/** True only when `find` is GNU findutils (so `-printf` exists) AND `stat`
 *  takes GNU's `-c` format flag. BSD find exits non-zero on `--version`, and
 *  BSD stat rejects `-c` — both are detected by running them, not by
 *  sniffing `process.platform`, so a GNU-coreutils macOS box still runs. */
function gnuLane(): boolean {
  const find = spawnSync("find", ["--version"], { encoding: "utf8" });
  if (find.status !== 0 || !/GNU findutils/.test(find.stdout ?? "")) return false;
  const stat = spawnSync("stat", ["-c", "%s", "/"], { encoding: "utf8" });
  return stat.status === 0 && /^\d+$/.test((stat.stdout ?? "").trim());
}

const suite = gnuLane() ? describe : describe.skip;

let home: string;
let sync: string;
let out: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "fleet-tarbudget-"));
  home = join(base, "home");
  sync = join(base, "sync");
  out = join(base, "out");
  mkdirSync(home, { recursive: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(home, ".claude.json"), '{"ok":true}');
});

afterEach(() => {
  for (const d of [home, sync, out]) rmSync(join(d, ".."), { recursive: true, force: true });
});

const ROOT_KEY = "-workspace-fleetflare";
const WT_KEY = "-workspace-fleetflare--claude-worktrees-row-tells-truth-85-pr1";
const DAY = 86_400;

const nowSec = () => Date.now() / 1000;

/** The 24h cap on how far back a burn watermark may hold the tree. Spelled
 *  out rather than imported: this lane is about BEHAVIOUR in a real shell, and
 *  the constant's own value/identity is pinned where constants are pinned
 *  (test/studio.archive.test.ts's table, and the exact-command assertions in
 *  test/studio.session.test.ts). */
const LOOKBACK_SECONDS = 86_400;

/** One `type:"assistant"` line carrying usage, padded to a realistic
 *  (highly compressible) transcript line length. */
function assistantLine(outTokens: number, pad: number): string {
  return `${JSON.stringify({
    type: "assistant",
    message: { usage: { input_tokens: 1, output_tokens: outTokens }, content: "x".repeat(pad) },
  })}\n`;
}

/** A transcript of `lines` assistant lines, each worth `outTokens`. */
function transcript(lines: number, outTokens: number, pad: number): string {
  let s = "";
  for (let i = 0; i < lines; i++) s += assistantLine(outTokens, pad);
  return s;
}

function writeSession(key: string, name: string, body: string, ageDays: number): string {
  const dir = join(home, ".claude", "projects", key);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  const t = Date.now() / 1000 - ageDays * DAY;
  utimesSync(path, t, t);
  return path;
}

function writeSubagentAt(key: string, name: string, body: string, mtimeSeconds: number): string {
  const dir = join(home, ".claude", "projects", key, "subagents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  utimesSync(path, mtimeSeconds, mtimeSeconds);
  return path;
}

function writeSubagent(key: string, name: string, body: string, ageDays: number): string {
  return writeSubagentAt(key, name, body, nowSec() - ageDays * DAY);
}

/**
 * Moves EVERY file and directory under HOME `seconds` further into the past.
 *
 * The command under test reads its clock with `date +%s`, which is the real
 * one and cannot be wound forward, so the only faithful way to simulate a
 * stalled tick is to move the whole world back by the same amount. Uniform
 * and blind: no file's age is special-cased, so every comparison the awk
 * program makes afterwards is EXACTLY the comparison a real stall of
 * `seconds` would have produced. A caller carrying a watermark must age that
 * by the same amount (see the stall helper inside the test below) — the
 * watermark is an absolute container epoch, so it moves with everything else.
 */
function shiftHomeBack(seconds: number): void {
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      const st = statSync(p);
      utimesSync(p, st.atimeMs / 1000 - seconds, st.mtimeMs / 1000 - seconds);
    }
  };
  walk(home);
}

/** A one-line, valid `type:"assistant"` transcript whose file is EXACTLY
 *  `bytes` long (trailing newline included). The byte-budget boundary tests
 *  need sizes that land on the budget to the byte, which `transcript()`'s
 *  JSON-shaped lines cannot promise. */
function exactFile(bytes: number): string {
  const head = JSON.stringify({
    type: "assistant",
    message: { usage: { input_tokens: 1, output_tokens: 1 }, content: "" },
  });
  const floor = Buffer.byteLength(head) + 1; // + the newline
  if (bytes < floor) throw new Error(`cannot build a ${bytes}-byte transcript (floor is ${floor})`);
  const body = `${head.replace('"content":""', `"content":"${"x".repeat(bytes - floor)}"`)}\n`;
  if (Buffer.byteLength(body) !== bytes) throw new Error(`built ${Buffer.byteLength(body)} bytes, wanted ${bytes}`);
  return body;
}

const TAR = () => join(sync, "latest.tar.gz");

/** Every symlink under `root` whose target does not exist — i.e. exactly the
 *  breakage a restore hits when a link survived into the tar but the member
 *  it points at was excluded from it. */
function danglingLinks(root: string): string[] {
  const bad: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        const raw = readlinkSync(p);
        if (!existsSync(isAbsolute(raw) ? raw : resolve(dirname(p), raw))) bad.push(p.slice(root.length));
        continue;
      }
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return bad;
}

/**
 * Runs the REAL command against the temp HOME/sync dir, with the watermark a
 * prior tick left behind (0 = none yet, the first-tick case).
 *
 * Returns BOTH values the command prints, in the order syncSessionTick parses
 * them: the tar's size and `startedAt`, the container epoch at the start of
 * THIS tar. `startedAt` is 0 when the command printed no watermark line at
 * all — which is also what a zero `k` means to the awk program, so a caller
 * threading it back in gets the first-tick rule rather than nonsense.
 */
function runTar(budget?: number, watermark = 0): { size: number; startedAt: number } {
  const res = runSnippet({
    script: tarAndStatCmd(home, sync, budget, undefined, watermark),
    sourced: true, shell: "sh", timeout: 120_000,
  });
  if (res.code !== 0) throw new Error(`tar cmd failed (${res.code}): ${res.stderr}`);
  const lines = res.stdout.trim().split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const size = Number.parseInt(lines[0] ?? "", 10);
  expect(Number.isFinite(size)).toBe(true);
  expect(size).toBe(statSync(TAR()).size);
  const startedAt = Number.parseInt(lines[1] ?? "", 10);
  return { size, startedAt: Number.isFinite(startedAt) ? startedAt : 0 };
}

/** The control: main's shipped command, whole `projects` dir, no selection. */
function runTarUnbounded(): number {
  const tar = join(sync, "unbounded.tar.gz");
  const res = runSnippet({
    script: `mkdir -p ${sync} && tar -C ${home} -czf ${tar} .claude/projects .claude.json && gzip -t ${tar} && stat -c %s ${tar}`,
    sourced: true, shell: "sh", timeout: 120_000,
  });
  if (res.code !== 0) throw new Error(`control tar failed (${res.code}): ${res.stderr}`);
  return Number.parseInt(res.stdout.trim(), 10);
}

/** The AGE rule the brief proposed, as a control: exclude subagent
 *  transcripts older than `days`, keep everything else. */
function runTarByAge(days: number): number {
  const tar = join(sync, "byage.tar.gz");
  const exc = join(sync, "byage-excludes.txt");
  const res = runSnippet({
    script:
      `mkdir -p ${sync} && ` +
      `( cd ${home} && find .claude/projects -path '*/subagents/*' -name '*.jsonl' -type f -mtime +${days} -print ) > ${exc} && ` +
      `tar -C ${home} --anchored --no-wildcards -X ${exc} -czf ${tar} .claude/projects .claude.json && ` +
      `gzip -t ${tar} && stat -c %s ${tar}`,
    sourced: true, shell: "sh", timeout: 120_000,
  });
  if (res.code !== 0) throw new Error(`age-rule tar failed (${res.code}): ${res.stderr}`);
  return Number.parseInt(res.stdout.trim(), 10);
}

function members(tar = TAR()): string[] {
  const res = runSnippet({ script: `tar -tzf ${tar}`, sourced: true, shell: "sh", timeout: 60_000 });
  if (res.code !== 0) throw new Error(`tar -t failed: ${res.stderr}`);
  return res.stdout.split("\n").filter((l) => l.length > 0);
}

/** Extracts the produced tar the way bring-up's restore step does, into a
 *  fresh root, and returns that root. */
function restore(): string {
  const res = runSnippet({ script: `mkdir -p ${out} && tar -C ${out} -xzf ${TAR()}`, sourced: true, shell: "sh", timeout: 120_000 });
  if (res.code !== 0) throw new Error(`restore untar failed: ${res.stderr}`);
  return out;
}

/** What `claude --continue` resumes: the newest non-subagent transcript under
 *  a project key. */
function continueTarget(root: string, key: string): { name: string; bytes: string } {
  const dir = join(root, ".claude", "projects", key);
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  let best: { name: string; mtime: number } | null = null;
  for (const name of files) {
    const m = statSync(join(dir, name)).mtimeMs;
    if (!best || m > best.mtime) best = { name, mtime: m };
  }
  if (!best) throw new Error(`no transcript under ${key}`);
  return { name: best.name, bytes: readFileSync(join(dir, best.name), "utf8") };
}

// ---------------------------------------------------------------------------

suite("tarAndStatCmd — subagent raw-byte budget (#202)", () => {
  test("a 30-day history ships a SMALLER tar that still restores and --continue resumes the RIGHT session", () => {
    // Root session: one long-lived transcript, still being appended to.
    const rootBody = transcript(900, 300, 2_400);
    writeSession(ROOT_KEY, "0f0f0f0f-1111-4222-8333-444444444444.jsonl", rootBody, 0);
    // 30 days of subagents, ~700 KiB each: well past the real budget.
    let rawSub = 0;
    for (let d = 0; d < 30; d++) {
      for (let k = 0; k < 2; k++) {
        const body = transcript(260, 100, 2_400);
        rawSub += Buffer.byteLength(body);
        writeSubagent(ROOT_KEY, `sub-${d}-${k}.jsonl`, body, 29 - d);
      }
    }
    expect(rawSub).toBeGreaterThan(SESSION_SUBAGENT_RAW_BUDGET);

    const before = runTarUnbounded();
    const after = runTar().size;

    // The point of the change.
    expect(after).toBeLessThan(before);

    // Restore contract: the root transcript is there, byte-identical, and is
    // what --continue picks.
    const root = restore();
    const target = continueTarget(root, ROOT_KEY);
    expect(target.name).toBe("0f0f0f0f-1111-4222-8333-444444444444.jsonl");
    expect(target.bytes).toBe(rootBody);
    expect(readFileSync(join(root, ".claude.json"), "utf8")).toBe('{"ok":true}');
    // ... and it is the SAME file the unbounded snapshot would have resumed.
    expect(target.name).toBe(continueTarget(home, ROOT_KEY).name);

    // Only subagent transcripts were ever dropped.
    const kept = new Set(members());
    expect(kept.has(`.claude/projects/${ROOT_KEY}/0f0f0f0f-1111-4222-8333-444444444444.jsonl`)).toBe(true);
    const droppedNonSub = readdirSync(join(home, ".claude", "projects", ROOT_KEY))
      .filter((f) => f.endsWith(".jsonl"))
      .filter((f) => !kept.has(`.claude/projects/${ROOT_KEY}/${f}`));
    expect(droppedNonSub).toEqual([]);
    // Newest-first: the newest subagent survives, the oldest does not.
    expect(kept.has(`.claude/projects/${ROOT_KEY}/subagents/sub-29-0.jsonl`)).toBe(true);
    expect(kept.has(`.claude/projects/${ROOT_KEY}/subagents/sub-0-0.jsonl`)).toBe(false);
  }, 180_000);

  test("a worktree-keyed session survives the selection even when it is old and buried under newer subagents", () => {
    // #116/#120/#146: the worktree-keyed original, the adopted root copy, and
    // the pre-adopt backup are ALL how a heal resumes the right session.
    const id = "b1c006ac-dd42-48a7-a063-90400c353858";
    const wtBody = transcript(40, 10, 400);
    writeSession(WT_KEY, `${id}.jsonl`, wtBody, 25);
    writeSession(ROOT_KEY, `${id}.jsonl`, wtBody, 25);
    writeSession(ROOT_KEY, `${id}.jsonl.pre-adopt-1758000000`, "old\n", 25);
    // Bury them under far more, far newer subagent bytes than the budget.
    for (let i = 0; i < 40; i++) writeSubagent(ROOT_KEY, `s${i}.jsonl`, transcript(20, 5, 400), 0.01 * i);

    runTar(50_000);
    const kept = new Set(members());
    expect(kept.has(`.claude/projects/${WT_KEY}/${id}.jsonl`)).toBe(true);
    expect(kept.has(`.claude/projects/${ROOT_KEY}/${id}.jsonl`)).toBe(true);
    expect(kept.has(`.claude/projects/${ROOT_KEY}/${id}.jsonl.pre-adopt-1758000000`)).toBe(true);
    // The budget really did bite — otherwise this test proves nothing.
    expect([...kept].filter((m) => m.includes("/subagents/") && m.endsWith(".jsonl")).length).toBeLessThan(40);

    const root = restore();
    expect(readFileSync(join(root, ".claude", "projects", WT_KEY, `${id}.jsonl`), "utf8")).toBe(wtBody);
    expect(continueTarget(root, WT_KEY).name).toBe(`${id}.jsonl`);
  }, 120_000);

  test("the tar stays BOUNDED as subagent count grows — the failure mode age does not touch", () => {
    writeSession(ROOT_KEY, "0f0f0f0f-1111-4222-8333-444444444444.jsonl", transcript(50, 10, 400), 0);
    const sub = (n: number, from: number) => {
      for (let i = from; i < n; i++) writeSubagent(ROOT_KEY, `s${i}.jsonl`, transcript(30, 5, 400), 0.002 * i);
    };

    sub(20, 0);
    const at20 = runTar(60_000).size;
    const age20 = runTarByAge(7);
    const unbounded20 = runTarUnbounded();

    sub(200, 20);
    const at200 = runTar(60_000).size;
    const age200 = runTarByAge(7);
    const unbounded200 = runTarUnbounded();

    // AGE DOES NOT BOUND: every file is < 2 days old (exactly what was
    // measured), so a 7-day age rule excludes nothing at all — its tar is the
    // whole directory, and it grows 10x with the subagent count.
    expect(age20).toBe(unbounded20);
    expect(age200).toBe(unbounded200);
    expect(age200).toBeGreaterThan(age20 * 3);

    // THE BUDGET DOES: 10x the subagents, essentially the same tar.
    expect(at200).toBeLessThan(at20 * 1.2);
    expect(at200).toBeLessThan(unbounded200 / 2);
  }, 120_000);

  test("burn counts every line exactly once across ticks, even as finished subagents fall out of the budget", async () => {
    // The real regime: syncSession runs every 300s, subagents are born and
    // finish BETWEEN ticks, and the corpus outgrows the budget many times
    // over. 13 ticks x 5 subagents = 65 transcripts / ~104 KB raw against a
    // 40 KB budget, so most of them are evicted before the run ends.
    const budget = 40_000;
    const TICKS = 13;
    const PER_TICK = 5;
    const LINES = 10;
    const OUT = 100;

    let cursor: BurnCursor = { fileOffsets: {} };
    let turns = 0;
    let outputTokens = 0;
    let parseSkips = 0;
    let rootLines = 0;

    for (let tick = 0; tick < TICKS; tick++) {
      // The root session keeps growing — it is never a budget candidate.
      rootLines += LINES;
      writeSession(ROOT_KEY, "root.jsonl", transcript(rootLines, OUT, 100), 0);
      // This tick's subagents run and finish; each tick is strictly newer.
      for (let k = 0; k < PER_TICK; k++) {
        const idx = tick * PER_TICK + k;
        writeSubagentAt(ROOT_KEY, `s${idx}.jsonl`, transcript(LINES, OUT, 100), Date.now() / 1000 - (TICKS - tick) * 600 + k);
      }
      runTar(budget);
      const r = parseUsageIncrement(cursor, await extractJsonlMembers(new Uint8Array(readFileSync(TAR()))));
      cursor = r.cursor;
      turns += r.delta.turns;
      outputTokens += r.delta.outputTokens;
      parseSkips += r.parseSkips;
    }

    // Eviction really happened — otherwise this test proves nothing.
    const last = new Set(members());
    expect(last.has(`.claude/projects/${ROOT_KEY}/subagents/s0.jsonl`)).toBe(false);
    expect([...last].filter((m) => m.includes("/subagents/") && m.endsWith(".jsonl")).length)
      .toBeLessThan(TICKS * PER_TICK);

    // Exact burn regardless: the root session always, and every one of the 65
    // subagents in FULL — a subagent is only ever evicted once it has stopped
    // growing, and the cursor never re-counts what it already counted.
    const expectedTurns = TICKS * LINES + TICKS * PER_TICK * LINES;
    expect(turns).toBe(expectedTurns);
    expect(outputTokens).toBe(expectedTurns * OUT);
    expect(parseSkips).toBe(0);

    // A further tick over the very same tar adds nothing.
    const again = parseUsageIncrement(cursor, await extractJsonlMembers(new Uint8Array(readFileSync(TAR()))));
    expect(again.delta.turns).toBe(0);
  }, 180_000);

  // -------------------------------------------------------------------------
  // Fix round, reviewer item 1 — BURN MUST NOT LOSE COUNTS.
  //
  // The shipped rule drops a file F as soon as `newer subagent bytes + F`
  // exceeds the budget, EVEN IF F was appended to since the last tar. F's tail
  // then never reaches any snapshot, so burn's cursor never sees it and those
  // tokens are lost for good — reproduced on a real `acme-os--maestro` tar:
  // one line appended to a kept subagent, 13 MiB of newer subagent files
  // landing before the next tick, the file dropped at ticks 4 and 5, the line
  // never counted.
  //
  // Real burst rates from that same studio: 10.1 MiB of subagent transcript
  // inside FIVE MINUTES, 26.3 MiB inside an hour. A burst that big between two
  // 300s ticks is normal load for a fan-out studio, not a pathological case.
  // -------------------------------------------------------------------------

  test("an appended subagent is counted even when MORE than the budget of newer bytes lands in the same interval", async () => {
    const budget = 40_000;
    const OUT = 100;
    let cursor: BurnCursor = { fileOffsets: {} };
    let turns = 0;

    /** One syncSession tick: tar, then feed that tar to burn exactly the way
     *  syncSessionTick does. Deliberately threads NO watermark (0 on every
     *  tick) — this test is the pin on the FIRST-TICK fallback, the
     *  `now - 600` live window, which is the only rule a studio whose DO has
     *  never stored a watermark has. */
    const tick = async (): Promise<{ delta: number; kept: Set<string> }> => {
      runTar(budget);
      const bytes = new Uint8Array(readFileSync(TAR()));
      const kept = new Set(members());
      const r = parseUsageIncrement(cursor, await extractJsonlMembers(bytes));
      cursor = r.cursor;
      turns += r.delta.turns;
      expect(r.parseSkips).toBe(0);
      return { delta: r.delta.turns, kept };
    };

    const member = (name: string) => `.claude/projects/${ROOT_KEY}/subagents/${name}`;

    // Tick 1 — the root session plus ONE subagent, `g`, well inside the budget.
    writeSession(ROOT_KEY, "root.jsonl", transcript(1, OUT, 100), 0);
    const g = writeSubagentAt(ROOT_KEY, "g.jsonl", transcript(4, OUT, 100), nowSec() - 1_500);
    const first = await tick();
    expect(first.kept.has(member("g.jsonl"))).toBe(true);
    expect(first.delta).toBe(5); // 1 root line + 4 subagent lines

    // Between tick 1 and tick 2: `g` gets ONE more line ...
    appendFileSync(g, assistantLine(OUT, 100));
    utimesSync(g, nowSec() - 60, nowSec() - 60);
    // ... and THEN a burst of strictly newer subagent bytes, far past the
    // budget, lands before the next tick.
    let burstBytes = 0;
    let burstLines = 0;
    for (let i = 0; i < 12; i++) {
      const body = transcript(4, OUT, 1_000);
      burstBytes += Buffer.byteLength(body);
      burstLines += 4;
      writeSubagentAt(ROOT_KEY, `burst${i}.jsonl`, body, nowSec() - 50 + i);
    }
    expect(burstBytes).toBeGreaterThan(budget);

    // Tick 2 — `g` changed since the previous tar, so it is admitted WHATEVER
    // the budget says, and its one new line is counted. This is the assertion
    // the shipped rule fails: it drops `g` here and the line is gone forever.
    const second = await tick();
    expect(second.kept.has(member("g.jsonl"))).toBe(true);
    expect(second.delta).toBe(burstLines + 1);

    // Later ticks: nothing is written any more, and everything ages out of the
    // live window. Now `g` IS a budget candidate again and the burst evicts it
    // — which is fine, because its tail was already counted, and the cursor
    // never re-counts a line it has seen.
    const aged = nowSec() - 3_000;
    utimesSync(g, aged, aged);
    for (let i = 0; i < 12; i++) {
      const p = join(home, ".claude", "projects", ROOT_KEY, "subagents", `burst${i}.jsonl`);
      utimesSync(p, aged + 100 + i, aged + 100 + i);
    }
    const third = await tick();
    expect(third.kept.has(member("g.jsonl"))).toBe(false); // the budget really did bite
    expect(third.delta).toBe(0);
    const fourth = await tick();
    expect(fourth.delta).toBe(0);

    // Exactly once, across the whole run.
    expect(turns).toBe(5 + 1 + burstLines);
  }, 180_000);

  // -------------------------------------------------------------------------
  // Review round 3, reviewer item 1 — BURN STILL LOSES COUNTS WHEN SYNC STALLS.
  //
  // The live window above is WALL CLOCK (`n = $(date +%s)`, admit while
  // `mtime >= now - 600`). It only bounds the gap between two tars if EVERY
  // tick succeeds. This fleet has had 20-minute DO outages and exec wedges at
  // the memory ceiling in the same moments as fan-out bursts, so the ticks
  // stall exactly when the bursts happen.
  //
  // Reproduced on a real `acme-os--maestro` tar in the GNU lane: subagent G2
  // is appended to (+2 lines, +14 output tokens), the ticks then stall past
  // 600s (G2's last write ends up 700s older than the next tick that lands),
  // and 14 MiB of newer subagent bytes arrive in the meantime. G2 falls
  // outside the budget AND outside the wall-clock window, so it is excluded at
  // ticks 4 and 5 and those two lines are never counted by anything.
  //
  // The fix is a WATERMARK: the container epoch at the start of the tar whose
  // burn was last PARSED. A file newer than that watermark cannot have been
  // counted yet, whatever the clock says, so it is admitted.
  // -------------------------------------------------------------------------

  test("a tick that STALLS past the live window still counts the appended lines — exactly once, and never again", async () => {
    const budget = 40_000;
    const OUT = 100;
    const APPEND_OUT = 7; // two appended lines => +14 output tokens, as measured

    let cursor: BurnCursor = { fileOffsets: {} };
    let watermark = 0;
    let turns = 0;
    let outputTokens = 0;

    /** One syncSession tick, wired exactly like syncSessionTick: the stored
     *  watermark goes IN to the command, and the watermark the command printed
     *  is adopted ONLY after the burn parse over this tick's bytes came back
     *  clean. */
    const tick = async (): Promise<{ delta: { turns: number; outputTokens: number }; kept: Set<string> }> => {
      const { startedAt } = runTar(budget, watermark);
      const bytes = new Uint8Array(readFileSync(TAR()));
      const kept = new Set(members());
      const r = parseUsageIncrement(cursor, await extractJsonlMembers(bytes));
      cursor = r.cursor;
      turns += r.delta.turns;
      outputTokens += r.delta.outputTokens;
      expect(r.parseSkips).toBe(0);
      watermark = startedAt;
      return { delta: r.delta, kept };
    };

    /** `seconds` of wall clock pass. `date +%s` cannot be wound forward, so the
     *  world moves back instead — every mtime under HOME and the watermark the
     *  DO is carrying, by the same amount. */
    const stall = (seconds: number) => {
      shiftHomeBack(seconds);
      if (watermark > 0) watermark -= seconds;
    };

    const member = (name: string) => `.claude/projects/${ROOT_KEY}/subagents/${name}`;

    // Tick 1 — the root session plus subagent G2, comfortably inside the budget.
    writeSession(ROOT_KEY, "root.jsonl", transcript(1, OUT, 100), 0);
    const g2 = writeSubagentAt(ROOT_KEY, "g2.jsonl", transcript(4, OUT, 100), nowSec() - 1_500);
    const first = await tick();
    expect(first.kept.has(member("g2.jsonl"))).toBe(true);
    expect(first.delta.turns).toBe(5); // 1 root line + 4 subagent lines

    // 50s later: G2 is appended to, AFTER the tar tick 1 parsed.
    stall(50);
    appendFileSync(g2, `${assistantLine(APPEND_OUT, 100)}${assistantLine(APPEND_OUT, 100)}`);
    utimesSync(g2, nowSec() - 40, nowSec() - 40);

    // Then the fan-out burst: strictly newer subagent bytes, past the budget.
    let burstBytes = 0;
    let burstLines = 0;
    for (let i = 0; i < 12; i++) {
      const body = transcript(4, OUT, 1_000);
      burstBytes += Buffer.byteLength(body);
      burstLines += 4;
      writeSubagentAt(ROOT_KEY, `burst${i}.jsonl`, body, nowSec() - 35 + i);
    }
    expect(burstBytes).toBeGreaterThan(budget);

    // THE STALL. The next tick does not land for another 860s, so by the time
    // it does, G2's last write is 900s old — well past the 600s wall-clock
    // window that is the ONLY thing protecting it today.
    stall(860);
    expect(nowSec() - statSync(g2).mtimeMs / 1000).toBeGreaterThan(700);

    // Tick 2 — the first tick after the stall. G2 is newer than the watermark,
    // so it is admitted however stale the wall clock thinks it is, and both
    // appended lines are counted HERE. This is the assertion the wall-clock
    // rule fails: it drops G2 and those 14 output tokens are gone for good.
    const second = await tick();
    expect(second.kept.has(member("g2.jsonl"))).toBe(true);
    expect(second.delta.turns).toBe(burstLines + 2);
    expect(second.delta.outputTokens).toBe(burstLines * OUT + 2 * APPEND_OUT);

    // Tick 3 — nothing new is written. G2 now sits BEHIND the watermark tick 2
    // earned, so it is a budget candidate again and the burst evicts it. No
    // re-count: the two lines were already counted, once.
    const third = await tick();
    expect(third.kept.has(member("g2.jsonl"))).toBe(false); // the budget really did bite
    expect(third.delta.turns).toBe(0);
    const fourth = await tick();
    expect(fourth.delta.turns).toBe(0);

    // Exactly once, across the whole run.
    expect(turns).toBe(5 + 2 + burstLines);
    expect(outputTokens).toBe(5 * OUT + burstLines * OUT + 2 * APPEND_OUT);
  }, 180_000);

  test("the command prints the tar-start watermark beside the size, and it is this tick's own clock", () => {
    writeSession(ROOT_KEY, "root.jsonl", transcript(1, 10, 100), 0);
    writeSubagentAt(ROOT_KEY, "s.jsonl", transcript(1, 10, 100), nowSec() - 100);
    const before = nowSec();
    const { size, startedAt } = runTar(40_000);
    expect(size).toBeGreaterThan(0);
    // The excludes file is written immediately before `tar` runs, so its mtime
    // is the start of THIS tar — not a stale value, not the end of it.
    expect(startedAt).toBeGreaterThanOrEqual(Math.floor(before) - 1);
    expect(startedAt).toBeLessThanOrEqual(Math.ceil(nowSec()) + 1);
    expect(startedAt).toBe(Math.floor(statSync(join(sync, "subagent-excludes.txt")).mtimeMs / 1000));
  }, 60_000);

  test("a watermark older than the 24h lookback still sheds stale subagents — an outage cannot pin the tree forever", () => {
    // The watermark admits anything newer than the last PARSED tar. Left
    // uncapped, a studio whose DO was down for a day would admit a day of
    // subagent transcript on the tick that recovers, and the snapshot would
    // blow past the budget entirely. `n = max(W, now - 24h)` is the cap: past
    // 24h the budget takes over again. A long outage is already visible on the
    // row, so shedding old files there costs nothing.
    const budget = 40_000;
    let watermark = 0;

    writeSession(ROOT_KEY, "root.jsonl", transcript(1, 10, 100), 0);
    writeSubagentAt(ROOT_KEY, "seed.jsonl", transcript(1, 10, 100), nowSec() - 120);
    watermark = runTar(budget, watermark).startedAt;

    // Four hours pass, then a subagent finishes and a burst of newer, bigger
    // transcripts lands on top of it.
    shiftHomeBack(4 * 3_600);
    watermark -= 4 * 3_600;
    writeSubagentAt(ROOT_KEY, "old.jsonl", exactFile(5_000), nowSec() - 100);
    for (let i = 0; i < 6; i++) writeSubagentAt(ROOT_KEY, `n${i}.jsonl`, exactFile(10_000), nowSec() - 50 + i);

    // Then 26 more hours of stall: the watermark is now 30h old and `old.jsonl`
    // 26h old — inside the watermark, but OUTSIDE the 24h lookback.
    shiftHomeBack(26 * 3_600);
    watermark -= 26 * 3_600;
    const oldAge = nowSec() - statSync(join(home, ".claude", "projects", ROOT_KEY, "subagents", "old.jsonl")).mtimeMs / 1000;
    expect(oldAge).toBeGreaterThan(LOOKBACK_SECONDS);
    expect(nowSec() - watermark).toBeGreaterThan(LOOKBACK_SECONDS);

    runTar(budget, watermark);
    const kept = new Set(members());
    // Past the lookback the budget decides again, and the burst outranks it.
    expect(kept.has(`.claude/projects/${ROOT_KEY}/subagents/old.jsonl`)).toBe(false);
    // The root session is never a candidate, whatever the watermark says.
    expect(kept.has(`.claude/projects/${ROOT_KEY}/root.jsonl`)).toBe(true);
  }, 120_000);

  test("the newest subagent transcript is admitted even when it ALONE is bigger than the whole budget", () => {
    // A single fan-out subagent can out-write the budget by itself. The
    // shipped rule adds its size first and then asks `total > budget`, so the
    // one and only transcript is excluded and the snapshot carries NO subagent
    // history at all. Stale on purpose: only the never-drop-the-newest rule
    // can save this one.
    const budget = 40_000;
    writeSession(ROOT_KEY, "root.jsonl", transcript(1, 10, 100), 0);
    writeSubagentAt(ROOT_KEY, "huge.jsonl", exactFile(90_000), Date.now() / 1000 - 7_200);

    runTar(budget);
    expect(members()).toContain(`.claude/projects/${ROOT_KEY}/subagents/huge.jsonl`);
  }, 60_000);

  test("a LIVE subagent transcript bigger than the budget survives a burst of newer bytes", () => {
    // Same oversized file, but now it is still being written AND newer files
    // have already filled the budget ahead of it. Being live is what admits it.
    const budget = 40_000;
    const at = nowSec();
    writeSession(ROOT_KEY, "root.jsonl", transcript(1, 10, 100), 0);
    writeSubagentAt(ROOT_KEY, "huge.jsonl", exactFile(90_000), at - 60);
    for (let i = 0; i < 6; i++) writeSubagentAt(ROOT_KEY, `n${i}.jsonl`, exactFile(10_000), at - 40 + i);

    runTar(budget);
    expect(members()).toContain(`.claude/projects/${ROOT_KEY}/subagents/huge.jsonl`);
  }, 60_000);

  test("subagent bytes summing EXACTLY to the budget all survive — the boundary is `>`, never `>=`", () => {
    // Boundary pin (reviewer nit): four 10,000-byte transcripts against a
    // 40,000-byte budget. All four are stale, so the live rule cannot mask the
    // comparison — the only thing deciding them is `total > budget`. Mutate
    // that to `total >= budget` and the fourth file is excluded, which this
    // test catches.
    const budget = 40_000;
    writeSession(ROOT_KEY, "root.jsonl", transcript(1, 10, 100), 0);
    const stale = Date.now() / 1000 - 7_200;
    for (let i = 0; i < 4; i++) writeSubagentAt(ROOT_KEY, `e${i}.jsonl`, exactFile(10_000), stale - i * 60);

    runTar(budget);
    const kept = new Set(members());
    for (let i = 0; i < 4; i++) {
      expect(kept.has(`.claude/projects/${ROOT_KEY}/subagents/e${i}.jsonl`)).toBe(true);
    }
    expect(readFileSync(join(sync, "subagent-excludes.txt"), "utf8")).toBe("");
  }, 60_000);

  test("a symlink under `subagents/` is never archived, so a dropped target cannot leave a dangling link", () => {
    // Reviewer nit: `-type f` means a symlinked transcript skips the budget
    // entirely — it is never a candidate, so it is always archived AS A LINK,
    // while the real file it points at can be excluded by the very same tar.
    // The restore then has a link to nothing. This is the shape the ONE real
    // symlink in the fleet (`websites--web-studio`) has.
    const budget = 20_000;
    writeSession(ROOT_KEY, "root.jsonl", transcript(1, 10, 100), 0);
    const stale = Date.now() / 1000 - 7_200;
    writeSubagentAt(ROOT_KEY, "target.jsonl", exactFile(30_000), stale - 600);
    for (let i = 0; i < 3; i++) writeSubagentAt(ROOT_KEY, `n${i}.jsonl`, exactFile(10_000), stale - i);
    const subagents = join(home, ".claude", "projects", ROOT_KEY, "subagents");
    symlinkSync("target.jsonl", join(subagents, "link.jsonl"));

    runTar(budget);
    const kept = new Set(members());
    // The target really is dropped — otherwise this test proves nothing.
    expect(kept.has(`.claude/projects/${ROOT_KEY}/subagents/target.jsonl`)).toBe(false);
    // ... and the link does not survive it.
    expect(kept.has(`.claude/projects/${ROOT_KEY}/subagents/link.jsonl`)).toBe(false);
    expect(danglingLinks(restore())).toEqual([]);
  }, 60_000);

  test("a symlink OUTSIDE `subagents/` still rides into the tar — narrowing the rule cannot dangle it", () => {
    // Review round 3 item 2: the drop-every-symlink rule was scoped down to
    // `subagents/`. It is safe precisely because subagent transcripts are the
    // only class this command ever excludes, so a link anywhere else points at
    // a member that is always archived. Dropping such a link would have cost
    // the restore a real file for no reason at all.
    const budget = 20_000;
    writeSession(ROOT_KEY, "root.jsonl", transcript(1, 10, 100), 0);
    const stale = nowSec() - 7_200;
    for (let i = 0; i < 3; i++) writeSubagentAt(ROOT_KEY, `n${i}.jsonl`, exactFile(10_000), stale - i);
    const projectDir = join(home, ".claude", "projects", ROOT_KEY);
    symlinkSync("root.jsonl", join(projectDir, "alias.jsonl"));

    runTar(budget);
    const kept = new Set(members());
    // The budget really did bite on the subagents — otherwise this proves nothing.
    expect(kept.has(`.claude/projects/${ROOT_KEY}/subagents/n2.jsonl`)).toBe(false);
    // ... and the non-subagent link survived, pointing at a member that is there.
    expect(kept.has(`.claude/projects/${ROOT_KEY}/alias.jsonl`)).toBe(true);
    expect(danglingLinks(restore())).toEqual([]);
  }, 60_000);

  test("the exclude list is written inside the sync dir, never into the tarred tree", () => {
    writeSession(ROOT_KEY, "root.jsonl", transcript(5, 10, 100), 0);
    for (let i = 0; i < 10; i++) writeSubagent(ROOT_KEY, `s${i}.jsonl`, transcript(10, 5, 400), 0.01 * i);
    runTar(5_000);
    expect(SESSION_EXCLUDES_PATH.startsWith("/workspace/.session-sync/")).toBe(true);
    expect(statSync(join(sync, "subagent-excludes.txt")).size).toBeGreaterThan(0);
    expect(members().some((m) => m.includes("subagent-excludes"))).toBe(false);
  }, 60_000);
});

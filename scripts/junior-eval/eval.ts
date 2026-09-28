// scripts/junior-eval/eval.ts — replay real commits against Workers AI models.
// Manual, never CI. See README.md next to this file.
//   run     --models a,b --commits h1,h2 | --auto 10  --out <dir>
//   packets --out <dir>     (blind, shuffled judge packets + key.json)
//   score   --out <dir>     (reads <dir>/judge/*.json verdicts, prints table)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { applyBlocks, parseBlocks, toUnifiedDiff } from "../../skills/junior/src/blocks";
import { ApiError, callOnce } from "../../skills/junior/src/client";
import { defaultAuthDeps, resolveTransport } from "../../skills/junior/src/auth";
import { SYSTEM_EDIT } from "../../skills/junior/src/main";

export interface EvalResult { model: string; commit: string; status: string; secs: number; neurons: number; text?: string }
export interface Verdict { model: string; commit: string; s: number; harmful: boolean }
export interface Row { model: string; n: number; mean: number; perfect: number; harmful: number; failed: number; p50: number; costPerTask: number }

export function aggregate(results: EvalResult[], verdicts: Verdict[]): Row[] {
  const by = new Map<string, { r: EvalResult; v?: Verdict }[]>();
  for (const r of results) {
    const v = verdicts.find((x) => x.model === r.model && x.commit === r.commit);
    by.set(r.model, [...(by.get(r.model) ?? []), { r, v }]);
  }
  const rows: Row[] = [];
  for (const [model, xs] of by) {
    const n = xs.length;
    const secs = xs.map((x) => x.r.secs).sort((a, b) => a - b);
    rows.push({
      model, n,
      mean: xs.reduce((s, x) => s + (x.v?.s ?? 0), 0) / n,
      perfect: xs.filter((x) => x.v?.s === 3).length,
      harmful: xs.filter((x) => x.v?.harmful).length,
      failed: xs.filter((x) => x.r.status !== "ok").length,
      // p50 is the upper of the two middle values for an even sample count, not an
      // averaged median — the tool's own --auto default (10) always produces an even count.
      p50: secs[Math.floor(n / 2)],
      costPerTask: Number((xs.reduce((s, x) => s + x.r.neurons, 0) / n * 0.011 / 1000).toFixed(4)),
    });
  }
  return rows.sort((a, b) => b.mean - a.mean);
}

const git = (...a: string[]) => spawnSync("git", a, { encoding: "utf8", maxBuffer: 64 << 20 }).stdout;

function pickCommits(n: number): string[] {
  const out: string[] = [];
  for (const h of git("log", "--no-merges", "--format=%h", "-400").trim().split("\n")) {
    const stat = git("show", "--numstat", "--format=", h).trim().split("\n");
    if (stat.length !== 1) continue;
    const [add, del, f] = stat[0].split("\t");
    const t = Number(add) + Number(del);
    if (!(t >= 3 && t <= 40) || !/\.(ts|js|mjs|sh)$/.test(f)) continue;
    const size = git("show", `${h}^:${f}`).split("\n").length;
    if (size > 1 && size < 1500) out.push(h);
    if (out.length === n) break;
  }
  return out;
}

function task(h: string) {
  const f = git("show", "--name-only", "--format=", h).trim();
  return { h, f, msg: git("log", "-1", "--format=%B", h).trim(), pre: git("show", `${h}^:${f}`) };
}

async function run(models: string[], commits: string[], out: string) {
  mkdirSync(join(out, "raw"), { recursive: true });
  const transport = resolveTransport(process.env, defaultAuthDeps(process.env));
  const tasks = commits.map(task);
  const results: EvalResult[] = [];
  await Promise.all(models.map(async (model) => {
    for (const t of tasks) {
      const start = Date.now();
      let rec: EvalResult;
      try {
        const user = `Task (the commit message describing the change to make):\n${t.msg}\n\nFile: ${t.f}\n\`\`\`\n${t.pre}\`\`\``;
        const r = await callOnce(transport, { model, messages: [{ role: "system", content: SYSTEM_EDIT }, { role: "user", content: user }], max_tokens: 64_000 }, fetch);
        const applied = applyBlocks(new Map([[t.f, t.pre]]), parseBlocks(r.content), () => false);
        rec = { model, commit: t.h, status: applied.ok ? "ok" : applied.error, secs: Math.round((Date.now() - start) / 1000), neurons: r.usage.neurons ?? 0, text: r.content };
      } catch (e) {
        rec = { model, commit: t.h, status: `api-error: ${e instanceof ApiError ? e.message : String(e)}`, secs: Math.round((Date.now() - start) / 1000), neurons: 0 };
      }
      results.push(rec);
      console.log(JSON.stringify({ ...rec, text: undefined }));
    }
  }));
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 1));
}

function packets(out: string) {
  const results: EvalResult[] = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
  mkdirSync(join(out, "packets"), { recursive: true });
  const key: Record<string, Record<string, string>> = {};
  for (const h of [...new Set(results.map((r) => r.commit))]) {
    const t = task(h);
    const cands = results.filter((r) => r.commit === h).map((r) => {
      const a = applyBlocks(new Map([[t.f, t.pre]]), parseBlocks(r.text ?? ""), () => false);
      return { model: r.model, diff: a.ok ? toUnifiedDiff(new Map([[t.f, t.pre]]), a.after) : `(EDIT FAILED: ${r.status})\n${(r.text ?? "").slice(0, 3000)}` };
    }).sort(() => Math.random() - 0.5);
    key[h] = Object.fromEntries(cands.map((c, i) => [String.fromCharCode(65 + i), c.model]));
    const md = [`# Commit ${h}`, "", "## Task given to candidates", t.msg, "", "## Reference diff", "```diff", git("show", "--format=", h), "```",
      ...cands.flatMap((c, i) => ["", `## Candidate ${String.fromCharCode(65 + i)}`, "```diff", c.diff, "```"])].join("\n");
    writeFileSync(join(out, "packets", `${h}.md`), md);
  }
  writeFileSync(join(out, "key.json"), JSON.stringify(key, null, 1));
  console.log(`packets: ${Object.keys(key).length} in ${join(out, "packets")}. Judge them per README.md, verdicts into ${join(out, "judge")}/*.json`);
}

function score(out: string) {
  const results: EvalResult[] = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
  const key: Record<string, Record<string, string>> = JSON.parse(readFileSync(join(out, "key.json"), "utf8"));
  const verdicts: Verdict[] = [];
  const dir = join(out, "judge");
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".json")) : []) {
    const j: Record<string, Record<string, { s: number; harmful: boolean }>> = JSON.parse(readFileSync(join(dir, f), "utf8"));
    for (const [h, byLetter] of Object.entries(j)) {
      for (const [L, v] of Object.entries(byLetter)) verdicts.push({ model: key[h][L], commit: h, s: v.s, harmful: v.harmful });
    }
  }
  console.table(aggregate(results, verdicts));
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const out = flag("--out") ?? "junior-eval-out";
  if (cmd === "run") {
    const commits = flag("--commits")?.split(",") ?? pickCommits(Number(flag("--auto") ?? 10));
    await run((flag("--models") ?? "@cf/zai-org/glm-5.3,@cf/deepseek-ai/deepseek-v4-pro-0813").split(","), commits, out);
  } else if (cmd === "packets") packets(out);
  else if (cmd === "score") score(out);
  else { console.error("usage: eval.ts run|packets|score [--out dir] [--models a,b] [--commits h1,h2 | --auto N]"); process.exit(2); }
}

// skills/junior/src/main.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyBlocks, parseBlocks, toUnifiedDiff } from "./blocks";
import { ApiError, AuthError, callWithPolicy, DEEPSEEK, GLM, type ChatMessage, type ChatResult } from "./client";
import { defaultAuthDeps, resolveTransport } from "./auth";

export const EXIT = { OK: 0, USAGE: 2, API: 3, INVALID: 4, TIMEOUT: 5, AUTH: 6 } as const;
export const DEFAULT_MAX_TOKENS = 64_000;
export const INPUT_CAP_TOKENS = 200_000;
const USAGE = "usage: junior.sh --task \"<instruction>\" [--mode edit|text] [--model glm|deepseek] [--timeout <s>] file...";

export const SYSTEM_EDIT = `You are a careful junior engineer. A senior engineer reviews every change you propose.
Make exactly the change the task asks for. Nothing more: no unrelated edits, no reformatting, no renames the task did not ask for.
Output ONLY edit blocks, nothing else. Each block is:

path/to/file
<<<<<<< SEARCH
exact lines copied from the file
=======
replacement lines
>>>>>>> REPLACE

SEARCH must match the file exactly, including indentation, and must be unique in that file.
Keep SEARCH small: just enough lines to be unique.
To create a new file, leave SEARCH empty.`;

export const SYSTEM_TEXT = `You are a careful junior engineer. A senior engineer reviews your answer.
Answer the task directly and concisely. Do not invent facts that are not in the provided files.`;

interface Args { task: string; mode: "edit" | "text"; model: "glm" | "deepseek"; timeoutS: number; files: string[] }

function parseArgs(argv: string[]): Args | string {
  const a: Args = { task: "", mode: "edit", model: "glm", timeoutS: 300, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const val = () => argv[++i] ?? "";
    if (t === "--task") a.task = val();
    else if (t === "--mode") { const v = val(); if (v !== "edit" && v !== "text") return `bad --mode ${v}`; a.mode = v; }
    else if (t === "--model") { const v = val(); if (v !== "glm" && v !== "deepseek") return `bad --model ${v}`; a.model = v; }
    else if (t === "--timeout") { const n = Number(val()); if (!(n > 0)) return "bad --timeout"; a.timeoutS = n; }
    else if (t.startsWith("--")) return `unknown flag ${t}`;
    else a.files.push(t);
  }
  return a.task.trim() === "" ? "missing --task" : a;
}

function userPrompt(task: string, files: Map<string, string>): string {
  let s = `Task:\n${task}\n`;
  for (const [p, c] of files) s += `\nFile: ${p}\n\`\`\`\n${c}${c.endsWith("\n") ? "" : "\n"}\`\`\`\n`;
  return s;
}

function k(n: number): string { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

function telemetry(model: string, startMs: number, r: ChatResult | null, calls: number, status: string): string {
  const secs = Math.round((Date.now() - startMs) / 1000);
  const cost = r?.usage.neurons != null ? `$${(r.usage.neurons * 0.011 / 1000).toFixed(4)}` : "$?";
  return `junior: model=${model.split("/").pop()} secs=${secs} in=${k(r?.usage.in ?? 0)} out=${k(r?.usage.out ?? 0)} ${cost} calls=${calls} status=${status}`;
}

export async function main(argv: string[], env: Record<string, string | undefined>, cwd: string): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") { console.error(`${args}\n${USAGE}`); return EXIT.USAGE; }

  const files = new Map<string, string>();
  for (const f of args.files) {
    const p = join(cwd, f);
    if (!existsSync(p)) { console.error(`junior: input file not found: ${f}`); return EXIT.USAGE; }
    files.set(f, readFileSync(p, "utf8"));
  }
  const chars = args.task.length + [...files.values()].reduce((n, c) => n + c.length, 0);
  if (chars / 4 > INPUT_CAP_TOKENS) {
    console.error(`junior: input too large (~${Math.round(chars / 4)} tokens > ${INPUT_CAP_TOKENS}); split the task`);
    return EXIT.USAGE;
  }

  const models = args.model === "glm" ? [GLM, DEEPSEEK] : [DEEPSEEK, GLM];
  const messages: ChatMessage[] = [
    { role: "system", content: args.mode === "edit" ? SYSTEM_EDIT : SYSTEM_TEXT },
    { role: "user", content: userPrompt(args.task, files) },
  ];
  const signal = AbortSignal.timeout(args.timeoutS * 1000);
  const start = Date.now();
  let calls = 0;
  let model = models[0];
  let last: ChatResult | null = null;

  try {
    const transport = resolveTransport(env, defaultAuthDeps(env));
    const first = await callWithPolicy({ transport, models, messages, maxTokens: DEFAULT_MAX_TOKENS, signal });
    calls += first.calls; model = first.model; last = first.result;

    if (args.mode === "text") {
      console.log(last.content.trim());
      console.error(telemetry(model, start, last, calls, "ok"));
      return EXIT.OK;
    }

    const exists = (p: string) => existsSync(join(cwd, p));
    let applied = applyBlocks(files, parseBlocks(last.content), exists);
    if (!applied.ok) {
      const repairMsgs: ChatMessage[] = [
        ...messages,
        { role: "assistant", content: last.content },
        { role: "user", content: `Your edit blocks failed: ${applied.error}\nReply with the corrected complete set of edit blocks only.` },
      ];
      const orderedModels = [model, ...models.filter((m) => m !== model)];
      const second = await callWithPolicy({ transport, models: orderedModels, messages: repairMsgs, maxTokens: DEFAULT_MAX_TOKENS, signal });
      calls += second.calls; model = second.model; last = second.result;
      applied = applyBlocks(files, parseBlocks(last.content), exists);
    }
    if (!applied.ok) {
      console.error(`junior: invalid edit: ${applied.error}\n--- raw output ---\n${last.content}`);
      console.error(telemetry(model, start, last, calls, "invalid"));
      return EXIT.INVALID;
    }
    const diff = toUnifiedDiff(files, applied.after);
    if (diff === "") {
      console.error("junior: invalid edit: blocks produced no change");
      console.error(telemetry(model, start, last, calls, "invalid"));
      return EXIT.INVALID;
    }
    const dir = join(cwd, ".junior");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "*\n");
    writeFileSync(join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.patch`), diff);
    process.stdout.write(diff);
    console.error(telemetry(model, start, last, calls, "ok"));
    return EXIT.OK;
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      console.error(`junior: timed out after ${args.timeoutS}s`);
      console.error(telemetry(model, start, last, calls, "timeout"));
      return EXIT.TIMEOUT;
    }
    if (e instanceof AuthError) { console.error(`junior: ${e.message}`); return EXIT.AUTH; }
    if (e instanceof ApiError) {
      console.error(`junior: ${e.message}`);
      console.error(telemetry(model, start, last, calls, "api-error"));
      return EXIT.API;
    }
    // Catch-all for any otherwise-unclassified Error reaching this point:
    // network-level throws while calling the model (connection refused, DNS
    // failure — cases classify() in client.ts never sees, because it only
    // classifies a completed HTTP response wrapped as ApiError), but also
    // local git/fs errors from applying the model's output (e.g. toUnifiedDiff's
    // "git diff failed: ..." if git isn't installed, or mkdirSync/writeFileSync
    // failing under .junior/ due to disk-full or permission-denied). This file's
    // exit-code contract is EXIT.{OK,USAGE,API,INVALID,TIMEOUT,AUTH}; letting
    // an arbitrary Error escape here crashes with a raw stack trace and a
    // non-contract exit code, so we report it as EXIT.API/status=api-error even
    // though it may not actually be an API failure.
    if (e instanceof Error) {
      console.error(`junior: ${e.message}`);
      console.error(telemetry(model, start, last, calls, "api-error"));
      return EXIT.API;
    }
    throw e;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), process.env, process.cwd()));
}

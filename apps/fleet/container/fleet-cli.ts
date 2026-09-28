#!/usr/bin/env bun
/**
 * The agent's only channel for progress and gate requests. Talks to this
 * container's own server over localhost. No network, no credentials.
 */
const PORT = Number(process.env.PORT ?? 8080);
const BASE = `http://127.0.0.1:${PORT}`;

const GATE_ACTIONS = ["merge_staging", "deploy_staging", "merge_main", "deploy_prod"];

async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`fleet: ${path} failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "milestone") {
  const text = args.join(" ").trim();
  if (!text) { console.error("fleet milestone <text>"); process.exit(1); }
  await post("/internal/milestone", { text });
} else if (cmd === "request-approval") {
  const action = args[0];
  if (!action || !GATE_ACTIONS.includes(action)) {
    console.error(`fleet request-approval <${GATE_ACTIONS.join("|")}> [--pr N] [--target ID]`);
    process.exit(1);
  }
  const params: Record<string, string> = {};
  for (const key of ["pr", "target", "repo", "ref"]) {
    const v = flag(args, key);
    if (v !== undefined) params[key] = v;
  }
  await post("/internal/approval", { action, params });
  console.log(`fleet: requested ${action}. End your turn now — the operator decides next.`);
} else {
  console.error("fleet <milestone|request-approval> ...");
  process.exit(1);
}

/**
 * Shared fixtures for the session-adoption suites (#749, sweep 33 F5): the
 * repo's root/worktree project keys, the session ids, and the first-line
 * transcript shapes every adopt test stages under a temp HOME.
 */
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REPO = "fleetflare";
export const ROOT_KEY = "-workspace-fleetflare";
export const WT_KEY = "-workspace-fleetflare--claude-worktrees-row-tells-truth-85-pr1";
export const WT_ID = "b1c006ac-dd42-48a7-a063-90400c353858";
export const ROOT_ID = "0f0f0f0f-1111-4222-8333-444444444444";
export const CLI = '{"type":"user","entrypoint":"cli","sessionId":"x"}\n';
export const SDK = '{"type":"user","entrypoint":"sdk-cli","sessionId":"x"}\n';
export const TEAMMATE = '{"type":"user","entrypoint":"cli","teamName":"crew","sessionId":"x"}\n';

// Each suite builds its own temp HOME in beforeEach; projects()/session()
// resolve against whatever was set last.
let home = "";
export function setAdoptHome(dir: string): void {
  home = dir;
}

export function projects(key: string): string {
  return join(home, ".claude", "projects", key);
}

export function session(key: string, id: string, body: string, ageSeconds: number): string {
  mkdirSync(projects(key), { recursive: true });
  const path = join(projects(key), `${id}.jsonl`);
  writeFileSync(path, body);
  const t = Math.floor(Date.now() / 1000) - ageSeconds;
  utimesSync(path, t, t);
  return path;
}

/**
 * Issue #1153 (B2/B3): a glm-led studio's member subagents must reach the
 * fleet's translation route, never Anthropic.
 *
 * Members are nested `claude -p` processes started from the lead's Bash-tool
 * shell. They inherit that shell's environment, and the env the container
 * carries is only as good as the process that launched it. So the route is
 * written where `claude` reads it for EVERY child it starts: the `env` block of
 * ~/.claude/settings.json. And the OAuth token a Claude-led studio's failover
 * once pushed into tmux is purged, with the credentials file, on every glm
 * bring-up.
 *
 * Every command here runs in the container, in one Worker-sent exec. The spawn
 * token rides the exec's env (`tokenEnv`), never argv, and never the bring-up
 * log.
 */
import { BRINGUP_CMD } from "./provision";
import { tokenEnv, FLEET_TOKEN_ENV } from "./credentials";
import { STUDIO_TMUX, withStudioTmux } from "./tmux";

export const GLM_BASE_URL_ENV = "FLEET_GLM_BASE_URL";
const OAUTH_VAR = "CLAUDE_CODE_OAUTH_TOKEN";
const CREDENTIALS_PATH = "$HOME/.claude/.credentials.json";

/**
 * Merge the route into ~/.claude/settings.json's `env` block. Merge, never
 * clobber: the lead-gate hooks and bring-up's own keys live in the same file.
 * Fails (non-zero) when the token or the route is missing, so the caller can
 * stop the bring-up rather than launch an unrouted lead.
 */
export function glmSettingsEnvCmd(): string {
  // Single-quoted `python3 -c` (no heredoc): the `&&` in glmBringupCmd must sit
  // on the same line as the step it guards, and a heredoc terminator would not.
  // The code has no single quote, so it needs no escaping.
  // Review F2: a truncated or non-object file is replaced, not fatal. The write
  // goes through a mode-600 temp file and an atomic rename, so a crash mid-write
  // leaves the old file or the new one, never a half-written one.
  const code = [
    "import json, os",
    'p = os.path.expanduser("~/.claude/settings.json")',
    "os.makedirs(os.path.dirname(p), exist_ok=True)",
    "try:",
    "    s = json.load(open(p))",
    "except (FileNotFoundError, ValueError):",
    "    s = {}",
    "if not isinstance(s, dict): s = {}",
    'e = s.get("env") if isinstance(s.get("env"), dict) else {}',
    's["env"] = e',
    `e["ANTHROPIC_BASE_URL"] = os.environ["${GLM_BASE_URL_ENV}"]`,
    `e["ANTHROPIC_AUTH_TOKEN"] = os.environ["${FLEET_TOKEN_ENV}"]`,
    'tmp = p + ".fleet-glm"',
    "fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)",
    'with os.fdopen(fd, "w") as f: json.dump(s, f)',
    "os.replace(tmp, p)",
  ].join("\n");
  return `python3 -c '${code}'`;
}

/**
 * Unset the OAuth token in both tmux scopes (global, and the studio session),
 * across whichever tmux server is live, and delete the credentials file. Every
 * step is best-effort: no tmux server yet on a fresh container is normal, and
 * a purge that cannot run must not block the bring-up that follows.
 */
export function glmCredentialPurgeCmd(): string {
  const tmux = [
    `${STUDIO_TMUX} set-environment -gu ${OAUTH_VAR} 2>/dev/null || true`,
    `${STUDIO_TMUX} set-environment -t studio -u ${OAUTH_VAR} 2>/dev/null || true`,
    `rm -f "${CREDENTIALS_PATH}"`,
  ].join("\n");
  return withStudioTmux(tmux);
}

/**
 * The one command a glm bring-up runs: settings and purge first, then
 * bring-up. `&&` on the settings step is the fail-closed part: if the route
 * cannot be written, bring-up never starts and no lead launches unrouted.
 * Review F3: bring-up runs with the token and route removed from its env, so
 * the tmux server it starts does not keep them in its global environment.
 */
export function glmBringupCmd(bringupCmd: string): string {
  const stripped = `env -u ${OAUTH_VAR} -u ${FLEET_TOKEN_ENV} -u ${GLM_BASE_URL_ENV} ${bringupCmd}`;
  return `${glmCredentialPurgeCmd()}\n${glmSettingsEnvCmd()} && ${stripped}`;
}

/** The env for that exec: the spawn token (tokenEnv) and the route. */
export function glmBringupEnv(spawnToken: string, baseUrl: string): Record<string, string> {
  return { ...tokenEnv(spawnToken), [GLM_BASE_URL_ENV]: baseUrl };
}

export type BringupExecPlan =
  | { kind: "run"; cmd: string; env?: Record<string, string> }
  | { kind: "refuse"; reason: string };

/**
 * The Worker's decision for one exec. Only the bring-up command of a glm
 * studio is rewritten. Everything else passes through with its env exactly as
 * given, undefined included.
 */
export function planBringupExec(input: {
  cmd: string;
  leadType: "claude" | "glm";
  env?: Record<string, string>;
  spawnToken: string | null;
  baseUrl: string;
}): BringupExecPlan {
  if (input.cmd !== BRINGUP_CMD || input.leadType !== "glm") {
    return { kind: "run", cmd: input.cmd, env: input.env };
  }
  if (!input.spawnToken) {
    return { kind: "refuse", reason: "glm lead has no spawn token on file; refusing bring-up rather than launching an unrouted lead" };
  }
  return {
    kind: "run",
    cmd: glmBringupCmd(BRINGUP_CMD),
    env: { ...(input.env ?? {}), ...glmBringupEnv(input.spawnToken, input.baseUrl) },
  };
}

export interface BringupRow { leadType: "claude" | "glm"; spawnToken: string | null }
export type RawExec = (cmd: string, env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Review F1: the single wrapper every bring-up exec goes through, so the
 * decision is testable without building a StudioDO. The row is read lazily,
 * and only for the bring-up command.
 */
export function withGlmBringup(
  readRow: () => Promise<BringupRow>, baseUrl: string, exec: RawExec,
): RawExec {
  return async (cmd, env) => {
    if (cmd !== BRINGUP_CMD) return exec(cmd, env);
    const row = await readRow();
    const plan = planBringupExec({ cmd, leadType: row.leadType, env, spawnToken: row.spawnToken, baseUrl });
    if (plan.kind === "refuse") return { code: 1, stdout: "", stderr: plan.reason };
    return exec(plan.cmd, plan.env);
  };
}

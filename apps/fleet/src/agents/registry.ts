import type { Env } from "../env";

/**
 * Board issue #334 (public release): the legacy Telegram surface — the
 * `/tg` webhook, AgentDO, DeployDO approvals and operator alerts — is OFF
 * unless `FLEET_TELEGRAM` is exactly "on" AND the bot token, webhook secret
 * and operator id are all configured. The operator's Telegram user id comes
 * from config (`TELEGRAM_OPERATOR_ID`), never from code. Every Telegram call
 * site reads its token and recipient from here, so "off" has one meaning.
 */
export interface TelegramConfig {
  token: string;
  webhookSecret: string;
  /** Telegram user id of the one operator; in a DM also the chat id. */
  operatorId: string;
}

export function telegramConfig(env: Env): TelegramConfig | null {
  if (env.FLEET_TELEGRAM !== "on") return null;
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  const operatorId = env.TELEGRAM_OPERATOR_ID?.trim();
  if (!token || !webhookSecret || !operatorId) return null;
  return { token, webhookSecret, operatorId };
}

export interface AgentRecord {
  id: string;
  role: string;
  project: string;
  /** Telegram chat this agent speaks in. In a DM this equals the operator's user id. */
  chatId: string;
}

/** Day 1 fleet: one agent. Grows to a D1 table when the second project onboards. */
export const AGENTS: Omit<AgentRecord, "chatId">[] = [
  { id: "cto", role: "cto", project: "websites" },
];

/** The agent for `project`, speaking in the operator's chat — undefined when Telegram is off. */
export function agentForProject(project: string, env: Env): AgentRecord | undefined {
  const tg = telegramConfig(env);
  const agent = AGENTS.find((a) => a.project === project && a.role === "cto");
  return tg && agent ? { ...agent, chatId: tg.operatorId } : undefined;
}

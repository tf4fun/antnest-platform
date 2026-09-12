import type { UsageUpdate } from "@agentclientprotocol/sdk";
import type { SessionCost, SessionUsage } from "./types";

export function projectUsage(current: SessionUsage | undefined, update: UsageUpdate): SessionUsage | undefined {
  if (!Number.isSafeInteger(update.used) || update.used < 0 || !Number.isSafeInteger(update.size) || update.size < 0) return current;
  const cost = sessionCost(update.cost) ?? current?.cost;
  return { used: update.used, size: update.size, ...(cost ? { cost } : {}) };
}

function sessionCost(value: unknown): SessionCost | undefined {
  if (!value || typeof value !== "object") return;
  const { amount, currency } = value as Record<string, unknown>;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return;
  if (typeof currency !== "string" || currency.length !== 3 || !/^[A-Z]{3}$/.test(currency)) return;
  return { amount, currency };
}

export function formatSessionCost(cost: SessionCost | undefined): string {
  if (!cost) return "Not reported";
  return `${cost.currency} ${cost.amount}`;
}

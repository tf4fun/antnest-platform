export type AgentOwnershipScope = Readonly<{ organizationId: string; agentId: string }>;
export type AgentOwnershipFence = AgentOwnershipScope &
  Readonly<{ ownerInstanceId: string; epoch: string }>;

export const MAX_AGENT_LEASE_EPOCH = "9223372036854775807";

export class AgentOwnershipLostError extends Error {
  public constructor() {
    super("Agent worker ownership is unavailable");
    this.name = "AgentOwnershipLostError";
  }
}

export class AgentLeaseEpochExhaustedError extends Error {
  public constructor() {
    super("Agent worker ownership epoch is exhausted");
    this.name = "AgentLeaseEpochExhaustedError";
  }
}

export function ownershipScope(input: AgentOwnershipScope): AgentOwnershipScope {
  return Object.freeze({
    organizationId: identity(input.organizationId),
    agentId: identity(input.agentId),
  });
}

export function ownershipFence(input: AgentOwnershipFence): AgentOwnershipFence {
  const scope = ownershipScope(input);
  const ownerInstanceId = identity(input.ownerInstanceId);
  const epoch = input.epoch;
  if (
    typeof epoch !== "string" ||
    !/^[1-9][0-9]{0,18}$/u.test(epoch) ||
    BigInt(epoch) > BigInt(MAX_AGENT_LEASE_EPOCH)
  )
    throw new TypeError("Invalid Agent ownership epoch");
  return Object.freeze({ ...scope, ownerInstanceId, epoch });
}

export function ownershipInstance(value: string): string {
  return identity(value);
}

export function leaseDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000)
    throw new RangeError("Agent lease duration must be between 1000 and 300000 milliseconds");
  return value;
}

export function transactionBudget(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000)
    throw new RangeError("Agent transaction budget must be between 1 and 300000 milliseconds");
  return value;
}

function identity(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || value.trim() !== value)
    throw new TypeError("Invalid Agent ownership identity");
  return value;
}

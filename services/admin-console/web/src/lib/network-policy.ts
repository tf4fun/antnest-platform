export type NetworkAction = "allow_all" | "deny_all";
export type NetworkAssignment = {
  agent_id: string;
  action: NetworkAction;
  resource_version: number;
};
export type NetworkPolicy = NetworkAssignment & {
  attachment: { state: "open" | "closed"; resource_version: number };
};
export type PendingNetwork = {
  action: NetworkAction;
  expected_resource_version: number;
  idempotency_key: string;
};
type PendingStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Network policy response is invalid.");
  return value as Record<string, unknown>;
}
function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Network policy version is invalid.");
  return value;
}
function action(value: unknown): NetworkAction {
  if (value !== "allow_all" && value !== "deny_all")
    throw new Error("Network policy selection is invalid.");
  return value;
}
function assignment(value: unknown, agentID: string): NetworkAssignment {
  const source = object(value);
  if (source.agent_id !== agentID)
    throw new Error("Network policy belongs to another Agent.");
  return {
    agent_id: agentID,
    action: action(source.action),
    resource_version: version(source.resource_version),
  };
}
export function decodeNetworkPolicy(
  value: unknown,
  agentID: string,
): NetworkPolicy {
  const assigned = assignment(value, agentID);
  const attachment = object(object(value).attachment);
  if (attachment.state !== "open" && attachment.state !== "closed")
    throw new Error("Network attachment is invalid.");
  return {
    ...assigned,
    attachment: {
      state: attachment.state,
      resource_version: version(attachment.resource_version),
    },
  };
}
export function decodeNetworkAssignment(
  value: unknown,
  agentID: string,
  intent: PendingNetwork,
): NetworkAssignment {
  const result = assignment(value, agentID);
  if (
    result.action !== intent.action ||
    (result.resource_version !== intent.expected_resource_version &&
      result.resource_version !== intent.expected_resource_version + 1)
  )
    throw new Error("The network policy update was not confirmed.");
  return result;
}
export function networkFailureUncertain(cause: unknown): boolean {
  const status =
    cause instanceof Error
      ? (cause as Error & { status?: number }).status
      : undefined;
  return (
    status === undefined ||
    status < 400 ||
    status >= 500 ||
    status === 408 ||
    status === 429
  );
}
export function pendingNetworkKey(
  scope: string,
  agentID: string,
  requestID = "",
): string {
  if (!scope) throw new Error("Account scope is unavailable.");
  return `antnest:network-policy:${JSON.stringify([scope, agentID])}:${requestID}`;
}
export function readPendingNetwork(
  storage: Pick<PendingStorage, "getItem" | "key" | "length">,
  scope: string,
  agentID: string,
): PendingNetwork | undefined {
  const prefix = pendingNetworkKey(scope, agentID);
  const keys = Array.from({ length: storage.length }, (_, index) =>
    storage.key(index),
  )
    .filter((key): key is string => key !== null && key.startsWith(prefix))
    .sort();
  const key = keys[0];
  if (!key) return undefined;
  const raw = storage.getItem(key);
  if (raw === null) return undefined;
  const parsed = object(JSON.parse(raw));
  if (
    typeof parsed.idempotency_key !== "string" ||
    !/^[!-~]{16,200}$/.test(parsed.idempotency_key) ||
    key !== prefix + parsed.idempotency_key
  )
    throw new Error("Saved network request is invalid.");
  return {
    action: action(parsed.action),
    expected_resource_version: version(parsed.expected_resource_version),
    idempotency_key: parsed.idempotency_key,
  };
}
export function savePendingNetwork(
  storage: Pick<PendingStorage, "setItem">,
  scope: string,
  agentID: string,
  pending: PendingNetwork,
): void {
  storage.setItem(
    pendingNetworkKey(scope, agentID, pending.idempotency_key),
    JSON.stringify(pending),
  );
}
export function clearPendingNetwork(
  storage: Pick<PendingStorage, "removeItem">,
  scope: string,
  agentID: string,
  pending: PendingNetwork,
): void {
  storage.removeItem(
    pendingNetworkKey(scope, agentID, pending.idempotency_key),
  );
}

export type NetworkAction = "allow_all" | "deny_all";
export type NetworkPort = number | { from: number; to: number };
export type NetworkRule = {
  action: "allow" | "deny";
  cidrs?: string[];
  domains?: string[];
  ports?: NetworkPort[];
  protocol?: "tcp";
};
export type V1Spec = { schema_version: 1; action: NetworkAction };
export type V2Spec = {
  schema_version: 2;
  default: "allow" | "deny";
  rules: NetworkRule[];
};
export type NetworkSpec = V1Spec | V2Spec;
export type NetworkAssignment = {
  agent_id: string;
  resource_version: number;
} & ({ action: NetworkAction } | { spec: V2Spec });
export type NetworkPolicy = NetworkAssignment & {
  attachment: {
    state: "open" | "closed" | "pending";
    resource_version: number;
  };
};
export type PendingNetwork = {
  expected_resource_version: number;
  idempotency_key: string;
} & ({ action: NetworkAction } | { spec: NetworkSpec });
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
function fail(message: string): never {
  throw new Error(`Network policy spec is invalid: ${message}`);
}
function keys(source: Record<string, unknown>, allowed: string[]): void {
  for (const name of Object.keys(source))
    if (!allowed.includes(name)) fail(`unexpected field ${name}`);
}
function strings(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > 64)
    fail(`${name} requires 1-64 entries`);
  if (value.some((entry) => typeof entry !== "string"))
    fail(`${name} must be strings`);
  return value as string[];
}
function canonicalCIDR(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(
    value,
  );
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (
    match.slice(1, 5).some((part) => part.length > 1 && part.startsWith("0")) ||
    octets.some((octet) => octet > 255) ||
    String(prefix) !== match[5]
  )
    return false;
  let address = 0;
  for (const octet of octets) address = address * 256 + octet;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) >>> 0 === address;
}
const DOMAIN =
  /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
function port(value: unknown): NetworkPort {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1 || value > 65535)
      fail("port out of range");
    return value;
  }
  const range = object(value);
  keys(range, ["from", "to"]);
  if (
    typeof range.from !== "number" ||
    typeof range.to !== "number" ||
    !Number.isSafeInteger(range.from) ||
    !Number.isSafeInteger(range.to) ||
    range.from < 1 ||
    range.from > 65535 ||
    range.to < 1 ||
    range.to > 65535 ||
    range.from > range.to
  )
    fail("port range is invalid");
  return { from: range.from, to: range.to };
}
function rule(value: unknown): NetworkRule {
  const source = object(value);
  keys(source, ["action", "cidrs", "domains", "ports", "protocol"]);
  if (source.action !== "allow" && source.action !== "deny")
    fail("rule action must be allow or deny");
  const cidrs = strings(source.cidrs, "cidrs");
  const domains = strings(source.domains, "domains");
  if (cidrs.length > 0 && domains.length > 0)
    fail("cidrs and domains are mutually exclusive");
  if (source.cidrs !== undefined && cidrs.length === 0)
    fail("cidrs requires 1-64 entries");
  if (source.domains !== undefined && domains.length === 0)
    fail("domains requires 1-64 entries");
  for (const cidr of cidrs) if (!canonicalCIDR(cidr)) fail(`cidr ${cidr}`);
  for (const domain of domains)
    if (domain.length > 253 || !DOMAIN.test(domain)) fail(`domain ${domain}`);
  let ports: NetworkPort[] | undefined;
  if (source.ports !== undefined) {
    if (
      !Array.isArray(source.ports) ||
      source.ports.length === 0 ||
      source.ports.length > 64
    )
      fail("ports requires 1-64 entries");
    ports = source.ports.map(port);
  }
  let protocol: "tcp" | undefined;
  if (source.protocol !== undefined) {
    if (source.protocol !== "tcp") fail("protocol must be tcp");
    protocol = "tcp";
  }
  const decoded: NetworkRule = { action: source.action };
  if (cidrs.length > 0) decoded.cidrs = cidrs;
  if (domains.length > 0) decoded.domains = domains;
  if (ports !== undefined) decoded.ports = ports;
  if (protocol !== undefined) decoded.protocol = protocol;
  return decoded;
}
export function decodeNetworkSpec(value: unknown): NetworkSpec {
  const source = object(value);
  keys(source, ["schema_version", "action", "default", "rules"]);
  if (source.schema_version === 1) {
    if (source.default !== undefined || source.rules !== undefined)
      fail("schema_version 1 carries action only");
    return { schema_version: 1, action: action(source.action) };
  }
  if (source.schema_version !== 2) fail("unsupported schema_version");
  if (source.action !== undefined) fail("schema_version 2 carries no action");
  if (source.default !== "allow" && source.default !== "deny")
    fail("default must be allow or deny");
  if (!Array.isArray(source.rules) || source.rules.length > 128)
    fail("rules must be an array of at most 128");
  return {
    schema_version: 2,
    default: source.default,
    rules: (source.rules as unknown[]).map(rule),
  };
}
export function canonicalNetworkSpec(spec: NetworkSpec): string {
  const decoded = decodeNetworkSpec(spec);
  if (decoded.schema_version === 1)
    return JSON.stringify({ schema_version: 1, action: decoded.action });
  return JSON.stringify({
    schema_version: 2,
    default: decoded.default,
    rules: decoded.rules.map((entry) => {
      const wire: Record<string, unknown> = { action: entry.action };
      if (entry.cidrs?.length) wire.cidrs = entry.cidrs;
      if (entry.domains?.length) wire.domains = entry.domains;
      if (entry.ports?.length)
        wire.ports = entry.ports.map((value) =>
          typeof value === "number"
            ? value
            : { from: value.from, to: value.to },
        );
      if (entry.protocol) wire.protocol = entry.protocol;
      return wire;
    }),
  });
}
function assignment(value: unknown, agentID: string): NetworkAssignment {
  const source = object(value);
  if (source.agent_id !== agentID)
    throw new Error("Network policy belongs to another Agent.");
  const resource_version = version(source.resource_version);
  keys(source, [
    "agent_id",
    "action",
    "spec",
    "resource_version",
    "attachment",
  ]);
  const hasAction = source.action !== undefined;
  const hasSpec = source.spec !== undefined;
  if (hasAction === hasSpec)
    throw new Error("Network policy selection is invalid.");
  if (hasAction)
    return {
      agent_id: agentID,
      action: action(source.action),
      resource_version,
    };
  const spec = decodeNetworkSpec(source.spec);
  if (spec.schema_version !== 2)
    throw new Error("Network policy selection is invalid.");
  return { agent_id: agentID, spec, resource_version };
}
export function decodeNetworkPolicy(
  value: unknown,
  agentID: string,
): NetworkPolicy {
  const assigned = assignment(value, agentID);
  const attachment = object(object(value).attachment);
  if (
    attachment.state !== "open" &&
    attachment.state !== "closed" &&
    attachment.state !== "pending"
  )
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
  const matches =
    "action" in intent
      ? "action" in result && result.action === intent.action
      : intent.spec.schema_version === 1
        ? "action" in result && result.action === intent.spec.action
        : "spec" in result &&
          canonicalNetworkSpec(result.spec) ===
            canonicalNetworkSpec(intent.spec);
  if (
    !matches ||
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
  return normalizePending(parsed);
}
function normalizePending(value: unknown): PendingNetwork {
  const pending = object(value);
  keys(pending, [
    "action",
    "spec",
    "expected_resource_version",
    "idempotency_key",
  ]);
  if (
    typeof pending.idempotency_key !== "string" ||
    !/^[!-~]{16,200}$/.test(pending.idempotency_key)
  )
    throw new Error("Saved network request is invalid.");
  const shared = {
    expected_resource_version: version(pending.expected_resource_version),
    idempotency_key: pending.idempotency_key,
  };
  const hasAction = pending.action !== undefined;
  const hasSpec = pending.spec !== undefined;
  if (hasAction === hasSpec)
    throw new Error("Saved network request is invalid.");
  if (hasAction) return { ...shared, action: action(pending.action) };
  const spec = decodeNetworkSpec(pending.spec);
  return {
    ...shared,
    spec: JSON.parse(canonicalNetworkSpec(spec)),
  };
}
export function savePendingNetwork(
  storage: Pick<PendingStorage, "setItem">,
  scope: string,
  agentID: string,
  pending: PendingNetwork,
): void {
  const snapshot = normalizePending(pending);
  storage.setItem(
    pendingNetworkKey(scope, agentID, pending.idempotency_key),
    JSON.stringify(snapshot),
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

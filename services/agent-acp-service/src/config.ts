import ipaddr from "ipaddr.js";

const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

export type AgentAcpConfig = {
  listen: { host: string; port: number };
  databaseUrl: string;
  agentControllerUrl: URL;
  clientMcpKey: Buffer;
  clientMcpBlockedCidrs: string[];
  controllerTimeoutMs: number;
  maxWebSocketPayloadBytes: number;
  shutdownTimeoutMs: number;
  telemetry: {
    disabled: boolean;
    serviceName: string;
    endpoint?: URL;
  };
};

export class ConfigError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AgentAcpConfig {
  const databaseUrl = required(environment, "ANTNEST_ACP_DATABASE_URL");
  assertUrlScheme(databaseUrl, "ANTNEST_ACP_DATABASE_URL", ["postgres:", "postgresql:"]);

  return {
    listen: parseListen(environment.ANTNEST_ACP_LISTEN ?? ":8080"),
    databaseUrl,
    agentControllerUrl: normalizedHttpUrl(
      required(environment, "ANTNEST_AGENT_CONTROLLER_URL"),
      "ANTNEST_AGENT_CONTROLLER_URL",
    ),
    clientMcpKey: parseEncryptionKey(required(environment, "ANTNEST_ACP_CLIENT_MCP_KEY")),
    clientMcpBlockedCidrs: parseCidrs(environment.ANTNEST_ACP_CLIENT_MCP_BLOCKED_CIDRS),
    controllerTimeoutMs: parseDuration(
      environment.ANTNEST_ACP_CONTROLLER_TIMEOUT ?? "5s",
      "ANTNEST_ACP_CONTROLLER_TIMEOUT",
    ),
    maxWebSocketPayloadBytes: parseInteger(
      environment.ANTNEST_ACP_MAX_PROMPT_BYTES ?? String(DEFAULT_MAX_PAYLOAD_BYTES),
      "ANTNEST_ACP_MAX_PROMPT_BYTES",
      1_024,
      MAX_PAYLOAD_BYTES,
    ),
    shutdownTimeoutMs: parseDuration(
      environment.ANTNEST_ACP_SHUTDOWN_TIMEOUT ?? "15s",
      "ANTNEST_ACP_SHUTDOWN_TIMEOUT",
    ),
    telemetry: telemetryConfig(environment),
  };
}

function telemetryConfig(environment: NodeJS.ProcessEnv): AgentAcpConfig["telemetry"] {
  const endpoint = optional(environment.OTEL_EXPORTER_OTLP_ENDPOINT);
  return {
    disabled: parseBoolean(environment.OTEL_SDK_DISABLED ?? "false", "OTEL_SDK_DISABLED"),
    serviceName: optional(environment.OTEL_SERVICE_NAME) ?? "agent-acp-service",
    ...(endpoint === undefined
      ? {}
      : { endpoint: normalizedHttpUrl(endpoint, "OTEL_EXPORTER_OTLP_ENDPOINT") }),
  };
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = optional(environment[name]);
  if (value === undefined) {
    throw new ConfigError(`${name} is required`);
  }
  return value;
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function normalizedHttpUrl(value: string, name: string): URL {
  const url = parseUrl(value, name);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${name} must use http or https`);
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new ConfigError(`${name} must not contain credentials, query, or fragment`);
  }
  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }
  return url;
}

function assertUrlScheme(value: string, name: string, schemes: string[]): void {
  const url = parseUrl(value, name);
  if (!schemes.includes(url.protocol)) {
    throw new ConfigError(`${name} uses an unsupported URL scheme`);
  }
}

function parseUrl(value: string, name: string): URL {
  try {
    return new URL(value);
  } catch (error) {
    throw new ConfigError(`${name} must be a valid URL`, { cause: error });
  }
}

function parseListen(value: string): { host: string; port: number } {
  const normalized = value.trim();
  const ipv6 = /^\[([^\]]+)\]:(\d+)$/u.exec(normalized);
  if (ipv6 !== null) {
    return { host: requireCapture(ipv6[1]), port: parsePort(requireCapture(ipv6[2])) };
  }
  const separator = normalized.lastIndexOf(":");
  if (separator < 0 || normalized.slice(0, separator).includes(":")) {
    throw new ConfigError("ANTNEST_ACP_LISTEN must be :port, host:port, or [ipv6]:port");
  }
  const host = normalized.slice(0, separator).trim();
  const port = normalized.slice(separator + 1);
  return { host: host.length === 0 ? "0.0.0.0" : host, port: parsePort(port) };
}

function parsePort(value: string): number {
  return parseInteger(value, "ANTNEST_ACP_LISTEN port", 1, 65_535);
}

function parseEncryptionKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new ConfigError("ANTNEST_ACP_CLIENT_MCP_KEY must be canonical base64");
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new ConfigError("ANTNEST_ACP_CLIENT_MCP_KEY must encode exactly 32 bytes");
  }
  return key;
}

function parseCidrs(value: string | undefined): string[] {
  const normalized = optional(value);
  if (normalized === undefined) {
    return [];
  }
  return normalized.split(",").map((entry) => {
    const cidr = entry.trim();
    if (cidr.length === 0) {
      throw new ConfigError("ANTNEST_ACP_CLIENT_MCP_BLOCKED_CIDRS contains an empty entry");
    }
    try {
      ipaddr.parseCIDR(cidr);
    } catch (error) {
      throw new ConfigError(`Invalid blocked CIDR ${cidr}`, { cause: error });
    }
    return cidr;
  });
}

function parseDuration(value: string, name: string): number {
  const match = /^(\d+)(ms|s|m)$/u.exec(value.trim());
  if (match === null) {
    throw new ConfigError(`${name} must be a duration using ms, s, or m`);
  }
  const amount = Number(requireCapture(match[1]));
  const unit = requireCapture(match[2]);
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : 60_000;
  return boundedNumber(amount * multiplier, name, 1, 3_600_000);
}

function parseInteger(value: string, name: string, minimum: number, maximum: number): number {
  if (!/^\d+$/u.test(value.trim())) {
    throw new ConfigError(`${name} must be an integer`);
  }
  return boundedNumber(Number(value), name, minimum, maximum);
}

function boundedNumber(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseBoolean(value: string, name: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new ConfigError(`${name} must be true or false`);
}

function requireCapture(value: string | undefined): string {
  if (value === undefined) {
    throw new ConfigError("Configuration parser invariant failed");
  }
  return value;
}

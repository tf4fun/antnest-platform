const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
import { ServiceAuthentication } from "./adapters/service-authentication.js";
import { CallerContextVerifier } from "./adapters/caller-context.js";
import { RequestAuthentication } from "./transport/request-authentication.js";
import { parse as parsePostgresConnection } from "pg-connection-string";
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const DEFAULT_STATE_DELIVERY_TIMEOUT_MS = 10_000;
export const MAINTENANCE_KID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const PUBLISHED_DEVELOPMENT_VALUES = [
  "antnest-postgres-dev",
  "antnest-egress-dev",
  "antnest-runtime-controller-dev",
  "antnest-agent-acp-dev",
  "antnest-identity-dev",
  "antnest-agent-controller-dev",
  "antnest-skill-registry-dev",
  "antnest-temporal-dev",
  "antnest-admin-dev",
  "antnest-skill-registry-local-development-token",
];

export type AgentAcpConfig = {
  authentication: RequestAuthentication;
  dependencyFetchers: { controller?: typeof fetch; registry?: typeof fetch };
  listen: { host: string; port: number };
  controlListen: { host: string; port: number };
  databaseUrl: string;
  databaseTimeoutMs: number;
  stateDeliveryTimeoutMs: number;
  clientMcpKey: Buffer;
  developmentSecretWarnings: string[];
  allowDevelopmentSettings: boolean;
  skillMaintenanceSigning?: { kid: string; privateKey: KeyObject };
  skillLearningControllerUrl?: string;
  skillLearningDebugAgentId?: string;
  skillDiscovery?: { registryUrl: string };
  runTimeoutMs: number;
  providerAllowPrivateEndpoints: boolean;
  maxWebSocketPayloadBytes: number;
  maxConfigurationBytes: number;
  shutdownTimeoutMs: number;
  telemetry: {
    captureRpcContent?: boolean;
    disabled: boolean;
    serviceName: string;
    endpoint?: URL;
    tracesEnabled: boolean;
    metricsEnabled: boolean;
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
  const allowPublicDevSecrets = parseBoolean(
    environment.ANTNEST_ALLOW_PUBLIC_DEV_SECRETS || "false",
    "ANTNEST_ALLOW_PUBLIC_DEV_SECRETS",
  );
  const developmentSecretWarnings: string[] = [];
  const checkPublished = (name: string, published: boolean): void => {
    if (!published) return;
    if (!allowPublicDevSecrets) throw new ConfigError(`${name} uses a published development value`);
    if (!developmentSecretWarnings.includes(name)) developmentSecretWarnings.push(name);
  };
  let databasePassword: string;
  try {
    databasePassword = parsePostgresConnection(databaseUrl).password ?? "";
  } catch {
    throw new ConfigError("ANTNEST_ACP_DATABASE_URL must be a valid PostgreSQL connection string");
  }
  checkPublished(
    "ANTNEST_ACP_DATABASE_URL",
    PUBLISHED_DEVELOPMENT_VALUES.includes(databasePassword),
  );
  const clientMcpKey = parseEncryptionKey(required(environment, "ANTNEST_ACP_CLIENT_MCP_KEY"));
  checkPublished(
    "ANTNEST_ACP_CLIENT_MCP_KEY",
    clientMcpKey.every((value) => value === clientMcpKey[0]),
  );
  const allowDevelopmentSettings = parseBoolean(
    environment.ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS ?? "false",
    "ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS",
  );
  const workload = new ServiceAuthentication(environment);
  const identityUrl = normalizedHttpUrl(
    required(environment, "ANTNEST_ACP_IDENTITY_URL"),
    "ANTNEST_ACP_IDENTITY_URL",
  );
  const identityFetch = workload.fetchFor("identity-service", identityUrl.toString());
  const authentication = new RequestAuthentication(
    workload,
    new CallerContextVerifier(identityUrl.toString(), identityFetch),
  );
  const discovery = parseSkillDiscovery(environment);
  const learningController = parseSkillLearningControllerUrl(environment);
  const dependencyFetchers: AgentAcpConfig["dependencyFetchers"] = {};
  const origins = new Set([identityUrl.origin]);
  if (discovery.skillDiscovery !== undefined) {
    const origin = new URL(discovery.skillDiscovery.registryUrl).origin;
    if (origins.has(origin)) throw new ConfigError("Dependency origins must be distinct");
    origins.add(origin);
    dependencyFetchers.registry = workload.fetchFor(
      "skill-registry",
      discovery.skillDiscovery.registryUrl,
    );
  }
  if (learningController.skillLearningControllerUrl !== undefined) {
    const origin = new URL(learningController.skillLearningControllerUrl).origin;
    if (origins.has(origin)) throw new ConfigError("Dependency origins must be distinct");
    dependencyFetchers.controller = workload.fetchFor(
      "agent-controller",
      learningController.skillLearningControllerUrl,
    );
  }

  return {
    authentication,
    dependencyFetchers,
    providerAllowPrivateEndpoints: parseBoolean(
      environment.ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS ?? "false",
      "ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS",
    ),
    listen: parseListen(environment.ANTNEST_ACP_LISTEN ?? ":8080"),
    controlListen: parseListen(environment.ANTNEST_ACP_CONTROL_LISTEN ?? ":8081"),
    databaseUrl,
    databaseTimeoutMs: parseDuration(
      environment.ANTNEST_ACP_DATABASE_TIMEOUT ?? "10s",
      "ANTNEST_ACP_DATABASE_TIMEOUT",
    ),
    stateDeliveryTimeoutMs: parseDuration(
      environment.ANTNEST_ACP_STATE_DELIVERY_TIMEOUT ?? `${DEFAULT_STATE_DELIVERY_TIMEOUT_MS}ms`,
      "ANTNEST_ACP_STATE_DELIVERY_TIMEOUT",
    ),
    clientMcpKey,
    developmentSecretWarnings,
    allowDevelopmentSettings,
    ...parseSkillMaintenanceSigning(environment),
    ...learningController,
    ...parseSkillLearningDebugAgentId(environment, allowDevelopmentSettings),
    ...discovery,
    runTimeoutMs: parseDuration(
      environment.ANTNEST_ACP_RUN_TIMEOUT ?? "30m",
      "ANTNEST_ACP_RUN_TIMEOUT",
    ),
    maxWebSocketPayloadBytes: parseInteger(
      environment.ANTNEST_ACP_MAX_PROMPT_BYTES ?? String(DEFAULT_MAX_PAYLOAD_BYTES),
      "ANTNEST_ACP_MAX_PROMPT_BYTES",
      1_024,
      MAX_PAYLOAD_BYTES,
    ),
    maxConfigurationBytes: parseInteger(
      environment.ANTNEST_ACP_MAX_CONFIGURATION_BYTES ?? String(DEFAULT_MAX_PAYLOAD_BYTES),
      "ANTNEST_ACP_MAX_CONFIGURATION_BYTES",
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

function parseSkillDiscovery(
  environment: NodeJS.ProcessEnv,
): Pick<AgentAcpConfig, "skillDiscovery"> {
  const registryUrl = optional(environment.ANTNEST_ACP_SKILL_REGISTRY_URL);
  if (environment.ANTNEST_ACP_SKILL_REGISTRY_TOKEN || environment.ANTNEST_ACP_SKILL_SOURCE_TOKEN)
    throw new ConfigError(
      "Legacy Registry/source tokens are unsupported; use service authentication",
    );
  if (registryUrl === undefined) return {};
  if (optional(environment.ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY) === undefined)
    throw new ConfigError("Skill discovery requires Runtime observation signing configuration");
  const url = normalizedHttpUrl(registryUrl, "ANTNEST_ACP_SKILL_REGISTRY_URL");
  if (url.pathname !== "/") throw new ConfigError("Skill discovery Registry URL must be an origin");
  return { skillDiscovery: { registryUrl: url.toString() } };
}

function parseSkillLearningDebugAgentId(
  environment: NodeJS.ProcessEnv,
  allowDevelopmentSettings: boolean,
): Pick<AgentAcpConfig, "skillLearningDebugAgentId"> {
  const value = optional(environment.ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID);
  if (value === undefined) return {};
  if (!allowDevelopmentSettings)
    throw new ConfigError(
      "ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID requires ANTNEST_ACP_ALLOW_DEVELOPMENT_SETTINGS=true",
    );
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u.test(value))
    throw new ConfigError("Invalid Skill learning debug Agent ID");
  return { skillLearningDebugAgentId: value };
}

function parseSkillLearningControllerUrl(
  environment: NodeJS.ProcessEnv,
): Pick<AgentAcpConfig, "skillLearningControllerUrl"> {
  const value = optional(environment.ANTNEST_ACP_SKILL_LEARNING_CONTROLLER_URL);
  return value === undefined
    ? {}
    : {
        skillLearningControllerUrl: normalizedHttpUrl(
          value,
          "ANTNEST_ACP_SKILL_LEARNING_CONTROLLER_URL",
        ).toString(),
      };
}

function parseSkillMaintenanceSigning(
  environment: NodeJS.ProcessEnv,
): Pick<AgentAcpConfig, "skillMaintenanceSigning"> {
  const kid = environment.ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID || undefined;
  const encoded = optional(environment.ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY);
  if (kid === undefined && encoded === undefined) return {};
  if (kid === undefined || encoded === undefined)
    throw new ConfigError(
      "Skill maintenance signing kid and private key must be configured together",
    );
  if (!MAINTENANCE_KID_PATTERN.test(kid))
    throw new ConfigError("Invalid Skill maintenance signing kid");
  if (
    encoded.length > 4096 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
  )
    throw new ConfigError("Skill maintenance private key must be canonical base64 PKCS8 DER");
  const der = Buffer.from(encoded, "base64");
  if (der.length === 0 || der.toString("base64") !== encoded)
    throw new ConfigError("Skill maintenance private key must be canonical base64 PKCS8 DER");
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    throw new ConfigError("Skill maintenance private key must be Ed25519 PKCS8 DER");
  }
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new ConfigError("Skill maintenance private key must be Ed25519 PKCS8 DER");
  return { skillMaintenanceSigning: { kid, privateKey } };
}

function telemetryConfig(environment: NodeJS.ProcessEnv): AgentAcpConfig["telemetry"] {
  const endpoint = optional(environment.OTEL_EXPORTER_OTLP_ENDPOINT);
  const exportByDefault = endpoint !== undefined;
  return {
    captureRpcContent: parseBoolean(
      (environment.ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT ?? "false").trim().toLowerCase(),
      "ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT",
    ),
    disabled: parseBoolean(environment.OTEL_SDK_DISABLED ?? "false", "OTEL_SDK_DISABLED"),
    serviceName: optional(environment.OTEL_SERVICE_NAME) ?? "agent-acp-service",
    tracesEnabled: signalEnabled(environment.OTEL_TRACES_EXPORTER, exportByDefault),
    metricsEnabled: signalEnabled(environment.OTEL_METRICS_EXPORTER, exportByDefault),
    ...(endpoint === undefined
      ? {}
      : { endpoint: normalizedHttpUrl(endpoint, "OTEL_EXPORTER_OTLP_ENDPOINT") }),
  };
}

function signalEnabled(value: string | undefined, fallback: boolean): boolean {
  const normalized = optional(value)?.toLowerCase();
  if (normalized === undefined) {
    return fallback;
  }
  if (normalized === "otlp") {
    return true;
  }
  if (normalized === "none") {
    return false;
  }
  throw new ConfigError("OTEL signal exporter must be otlp or none");
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
import { createPrivateKey, type KeyObject } from "node:crypto";

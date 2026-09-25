export type ServiceConfig = {
  acpBaseUrl: URL;
  controllerBaseUrl: URL | undefined;
  host: string;
  port: number;
  maxOwners: number;
  maxAcpPromptBytes: number;
  idleMs: number;
  sweepIntervalMs: number;
  telemetry: {
    disabled: boolean;
    endpoint?: URL;
    serviceName: string;
  };
};

export function parseServiceConfig(
  environment: Record<string, string | undefined>,
): ServiceConfig {
  const rawUrl = environment.ANTNEST_AGENT_ACP_SERVICE_URL;
  let acpBaseUrl: URL;
  try {
    if (rawUrl === undefined) throw new Error("missing URL");
    acpBaseUrl = new URL(rawUrl);
    if (
      !["http:", "https:"].includes(acpBaseUrl.protocol) ||
      acpBaseUrl.username !== "" ||
      acpBaseUrl.password !== "" ||
      acpBaseUrl.pathname !== "/" ||
      acpBaseUrl.search !== "" ||
      acpBaseUrl.hash !== ""
    )
      throw new Error("invalid URL");
  } catch {
    throw new Error("Invalid ACP service URL");
  }
  let controllerBaseUrl: URL | undefined;
  const rawControllerUrl = environment.ANTNEST_AGENT_CONTROLLER_URL;
  if (rawControllerUrl !== undefined) {
    try {
      controllerBaseUrl = new URL(rawControllerUrl);
      if (
        !["http:", "https:"].includes(controllerBaseUrl.protocol) ||
        controllerBaseUrl.username !== "" ||
        controllerBaseUrl.password !== "" ||
        controllerBaseUrl.pathname !== "/" ||
        controllerBaseUrl.search !== "" ||
        controllerBaseUrl.hash !== ""
      ) throw new Error("invalid URL");
    } catch {
      throw new Error("Invalid Controller service URL");
    }
  }
  const rawPort = environment.ANTNEST_AGENT_UI_BRIDGE_PORT ?? "8080";
  const port = Number(rawPort);
  if (
    !/^[0-9]+$/u.test(rawPort) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("Invalid Bridge listen port");
  const rawMaxOwners = environment.ANTNEST_AGENT_UI_BRIDGE_MAX_OWNERS ?? "16";
  const maxOwners = Number(rawMaxOwners);
  if (!/^[0-9]+$/u.test(rawMaxOwners) ||
    !Number.isSafeInteger(maxOwners) || maxOwners < 1)
    throw new Error("Invalid Bridge owner capacity");
  const rawAcpPromptBytes = environment.ANTNEST_AGENT_UI_ACP_MAX_PROMPT_BYTES ?? "16777216";
  const maxAcpPromptBytes = Number(rawAcpPromptBytes);
  if (!/^[0-9]+$/u.test(rawAcpPromptBytes) ||
    !Number.isSafeInteger(maxAcpPromptBytes) ||
    maxAcpPromptBytes < 1024 || maxAcpPromptBytes > 64 * 1024 * 1024)
    throw new Error("Invalid ACP prompt bound");
  const idleMs = durationMilliseconds(
    environment.ANTNEST_AGENT_UI_BRIDGE_IDLE_MS, 300_000, true,
    "Invalid Bridge idle lifetime");
  const sweepIntervalMs = durationMilliseconds(
    environment.ANTNEST_AGENT_UI_BRIDGE_SWEEP_INTERVAL_MS, 30_000, false,
    "Invalid Bridge sweep interval");
  const rawDisabled = environment.OTEL_SDK_DISABLED ?? "false";
  if (rawDisabled !== "true" && rawDisabled !== "false")
    throw new Error("Invalid OTEL_SDK_DISABLED");
  let endpoint: URL | undefined;
  if (environment.OTEL_EXPORTER_OTLP_ENDPOINT) {
    try {
      endpoint = new URL(environment.OTEL_EXPORTER_OTLP_ENDPOINT);
      if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username ||
        endpoint.password || endpoint.search || endpoint.hash)
        throw new Error("invalid endpoint");
    } catch {
      throw new Error("Invalid OTLP endpoint");
    }
  }
  const serviceName = environment.OTEL_SERVICE_NAME ?? "agent-ui";
  if (!serviceName.trim()) throw new Error("Invalid OTEL_SERVICE_NAME");
  return {
    acpBaseUrl,
    controllerBaseUrl,
    host: environment.ANTNEST_AGENT_UI_BRIDGE_HOST ?? "0.0.0.0",
    port,
    maxOwners,
    maxAcpPromptBytes,
    idleMs,
    sweepIntervalMs,
    telemetry: { disabled: rawDisabled === "true", endpoint, serviceName },
  };
}

function durationMilliseconds(value: string | undefined, fallback: number,
  allowZero: boolean, error: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^[0-9]+$/u.test(value) || !Number.isSafeInteger(parsed) ||
    parsed < (allowZero ? 0 : 1))
    throw new Error(error);
  return parsed;
}

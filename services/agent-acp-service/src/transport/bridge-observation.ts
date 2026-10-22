import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { BridgeObservationService } from "../application/bridge-observation.js";
import { activeHttpSpan } from "../telemetry/http.js";
import { recordBoundaryError } from "../telemetry/diagnostics.js";
import { trustedIdentity } from "./trusted-identity.js";
import { httpFailure } from "./public-error.js";

const PREFIX = "/rpc/agent-acp/workspace/sessions/";

export type BridgeObservationRoute =
  { kind: "session"; sessionId: string } | { kind: "intent"; sessionId: string; intentId: string };

export function bridgeObservationRoute(
  rawPath: string | undefined,
): BridgeObservationRoute | undefined {
  if (rawPath === undefined || !rawPath.startsWith(PREFIX) || rawPath.includes("?"))
    return undefined;
  const remainder = rawPath.slice(PREFIX.length);
  const parts = remainder.split("/");
  if (parts.length === 2 && parts[1] === "execution") {
    const sessionId = identifier(parts[0]);
    return sessionId === null ? undefined : { kind: "session", sessionId };
  }
  if (parts.length === 3 && parts[1] === "intents") {
    const sessionId = identifier(parts[0]);
    const intentId = identifier(parts[2]);
    return sessionId === null || intentId === null
      ? undefined
      : { kind: "intent", sessionId, intentId };
  }
  return undefined;
}

export async function serveBridgeObservation(
  request: IncomingMessage,
  response: ServerResponse,
  route: BridgeObservationRoute,
  service: Pick<BridgeObservationService, "readIntent" | "readSession"> | undefined,
  ready: () => Promise<boolean>,
): Promise<void> {
  const span = activeHttpSpan();
  span?.setAttributes({
    "rpc.system.name": "json-over-http",
    "rpc.service": "agent-acp",
    "rpc.method": route.kind === "intent" ? "read_workspace_intent" : "read_workspace_execution",
  });
  try {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      failure(response, "method_not_allowed");
      return;
    }
    const identity = trustedIdentity(request.headers);
    if (identity === null) {
      failure(response, "access_denied");
      return;
    }
    if (service === undefined || !(await ready()))
      throw new Error("Bridge observation unavailable");
    const binding = { ...identity, connectionId: randomUUID() };
    const result =
      route.kind === "intent"
        ? await service.readIntent(binding, route.sessionId, route.intentId)
        : await service.readSession(binding, route.sessionId);
    if (result === null) {
      failure(response, "intent_unknown");
      return;
    }
    json(response, 200, result);
  } catch (error) {
    const failure = mapFailure(error);
    if (span !== undefined) recordBoundaryError(span, error, "workspace.bridge_observation");
    json(response, failure.status, failure.body);
  }
}

function identifier(raw: string | undefined): string | null {
  if (raw === undefined || raw.length === 0) return null;
  try {
    const decoded = decodeURIComponent(raw);
    return decoded.length > 0 &&
      decoded.length <= 200 &&
      ![...decoded].some((character) => {
        const code = character.codePointAt(0)!;
        return code <= 31 || code === 127 || character === "\\" || character === "/";
      })
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function mapFailure(error: unknown): { status: number; body: object } {
  if (error instanceof DomainError) {
    if (error.code === "session_not_found" || error.code === "session_access_denied")
      return httpFailure("session_not_found");
    if (error.code === "access_denied") return httpFailure("access_denied");
  }
  return httpFailure("workspace_observation_unavailable");
}

function failure(response: ServerResponse, code: string): void {
  const value = httpFailure(code);
  json(response, value.status, value.body);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

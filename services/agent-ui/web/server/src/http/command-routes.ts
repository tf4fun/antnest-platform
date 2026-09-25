import { randomUUID } from "node:crypto";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { acpPromptRequestBytes, SessionNotFoundError } from "../adapters/acp-http.ts";
import type {
  HistoryCondition,
  HistoryTokens,
} from "../bridge/history-token.ts";
import {
  OperationConflictError,
  OperationReconciliationTimeoutError,
  type Operation,
  type PromptIntent,
} from "../bridge/operations.ts";
import type { BridgeScope } from "../bridge/registry.ts";
import { ReplayCapacityError } from "../bridge/replay-load-gate.ts";
import { BridgeCapacityError } from "../bridge/registry.ts";

const prefix = ["api", "app", "workspace", "v1", "agents"];
const id = z.string().min(1).max(200);
const block = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
  z
    .object({
      type: z.literal("image"),
      data: z.string(),
      mimeType: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("audio"),
      data: z.string(),
      mimeType: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("resource_link"),
      name: z.string(),
      uri: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("resource"),
      resource: z.object({ uri: z.string() }).passthrough(),
    })
    .passthrough(),
]);
const promptSchema = z.strictObject({
  intentId: id,
  expectedAppendVersion: z.number().int().nonnegative().safe(),
  prompt: z.array(block).min(1),
});
const cancelSchema = z.strictObject({ expectedRunId: id });
const bodyLimit = 67_108_864;
const defaultAcpPromptBytes = 16 * 1024 * 1024;

type Operations = {
  submit(input: PromptIntent): {
    operationId: string;
    acceptance: "bridge";
    phase: "dispatching";
  };
  read(sessionId: string, intentId: string): Promise<Operation>;
  cancel(
    sessionId: string,
    intentId: string,
    runId: string,
  ): Promise<Operation>;
};

type AuthorizedSession = {
  condition: HistoryCondition;
  operations: Operations;
  release(): void;
};

export function createCommandHandler(dependencies: {
  tokens: HistoryTokens;
  maxAcpPromptBytes?: number;
  authorize(
    scope: BridgeScope,
    sessionId: string,
    requireHistory: boolean,
  ): Promise<AuthorizedSession>;
}): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const parts = routeParts(new URL(request.url).pathname);
    if (parts === null)
      return error(
        404,
        "route_not_found",
        "Workspace route was not found",
        "none",
      );
    const [agentId, sessionId, resource, intentId, action] = parts;
    if (
      agentId === undefined ||
      sessionId === undefined ||
      resource === undefined ||
      (resource !== "prompts" && resource !== "operations")
    )
      return null;
    if (
      resource === "prompts" &&
      (intentId !== undefined || request.method !== "POST")
    )
      return null;
    if (
      resource === "operations" &&
      (intentId === undefined ||
        (action === undefined
          ? request.method !== "GET"
          : action !== "cancel" || request.method !== "POST"))
    )
      return null;
    const scope = trustedScope(request);
    if (scope === null)
      return error(
        401,
        "unauthenticated",
        "Trusted identity is missing",
        "login",
      );
    if (scope.agentId !== agentId)
      return error(403, "access_denied", "Agent access denied", "none");
    let authorized: AuthorizedSession;
    try {
      authorized = await dependencies.authorize(
        scope,
        sessionId,
        resource === "prompts",
      );
    } catch (cause) {
      const capacity = bridgeCapacityResponse(cause);
      if (capacity !== null) return capacity;
      const missing = missingSessionResponse(cause);
      if (missing !== null) return missing;
      if (cause instanceof OperationReconciliationTimeoutError)
        return error(504, "workspace_deadline_exceeded", "Operation reconciliation timed out", "retry_read");
      if (cause instanceof ReplayCapacityError)
        return error(
          429,
          "replay_capacity_exceeded",
          "Concurrent replay queue is full",
          "retry_read",
        );
      return error(
        503,
        "upstream_unavailable",
        "Session access could not be verified",
        "retry_read",
      );
    }
    try {
      if (!sameCondition(authorized.condition, { ...scope, sessionId }))
        return error(403, "access_denied", "Session access denied", "none");
      if (resource === "prompts") {
        const maxAcpPromptBytes = dependencies.maxAcpPromptBytes ?? defaultAcpPromptBytes;
        const body = promptSchema.parse(await readBody(request, Math.min(bodyLimit, maxAcpPromptBytes)));
        if (request.headers.get("idempotency-key") !== body.intentId)
          return error(
            409,
            "intent_key_mismatch",
            "Idempotency key must match intent ID",
            "none",
          );
        const token = request.headers.get("if-match");
        if (token === null)
          return error(
            428,
            "history_condition_required",
            "Current history condition is required",
            "refresh",
          );
        if (!dependencies.tokens.matches(token, authorized.condition))
          return error(
            409,
            "stale_history",
            "History condition is stale",
            "refresh",
          );
        if (acpPromptRequestBytes({
          sessionId,
          intentId: body.intentId,
          expectedAppendVersion: body.expectedAppendVersion,
          prompt: body.prompt as ContentBlock[],
        }) > maxAcpPromptBytes)
          throw new BodyTooLargeError();
        const accepted = authorized.operations.submit({
          sessionId,
          intentId: body.intentId,
          expectedAppendVersion: body.expectedAppendVersion,
          prompt: body.prompt as ContentBlock[],
        });
        return json(accepted, 202);
      }
      if (action === "cancel") {
        const body = cancelSchema.parse(await readBody(request));
        return json(
          await authorized.operations.cancel(
            sessionId,
            intentId!,
            body.expectedRunId,
          ),
        );
      }
      return json(await authorized.operations.read(sessionId, intentId!));
    } catch (cause) {
      const missing = missingSessionResponse(cause);
      if (missing !== null) return missing;
      if (cause instanceof BodyTooLargeError)
        return error(
          413,
          "request_too_large",
          "Request body exceeds the limit",
          "none",
        );
      if (cause instanceof z.ZodError || cause instanceof SyntaxError)
        return error(422, "invalid_request", "Request body is invalid", "none");
      if (cause instanceof OperationConflictError)
        return error(
          409,
          "operation_conflict",
          cause.message,
          "query_operation",
        );
      return error(
        503,
        "upstream_unavailable",
        "Workspace operation is unavailable",
        "retry_read",
      );
    } finally {
      authorized.release();
    }
  };
}

export function routeParts(pathname: string): string[] | null {
  const raw = pathname.split("/").slice(1);
  if (raw.length < prefix.length + 3 || raw.some((part) => part.length === 0))
    return null;
  const parts: string[] = [];
  try {
    for (const part of raw) {
      const decoded = decodeURIComponent(part);
      if (
        decoded.length === 0 ||
        decoded.length > 200 ||
        /[/\\\x00-\x1f]/u.test(decoded)
      )
        return null;
      parts.push(decoded);
    }
  } catch {
    return null;
  }
  if (!prefix.every((part, index) => parts[index] === part)) return null;
  const rest = parts.slice(prefix.length);
  if (rest[1] !== "sessions" || rest.length < 4 || rest.length > 8) return null;
  return [rest[0]!, rest[2]!, ...rest.slice(3)];
}

export function trustedScope(request: Request): BridgeScope | null {
  const organizationId = request.headers.get("x-antnest-organization-id");
  const principalId = request.headers.get("x-antnest-principal-id");
  const headerAgentId = request.headers.get("x-antnest-agent-id");
  if (
    !organizationId ||
    !principalId ||
    !headerAgentId ||
    ![organizationId, principalId, headerAgentId].every(
      (value) =>
        value.length <= 200 && value.trim() === value && !value.includes(","),
    )
  )
    return null;
  return { organizationId, principalId, agentId: headerAgentId };
}

export function bridgeCapacityResponse(cause: unknown): Response | null {
  return cause instanceof BridgeCapacityError
    ? error(429, "bridge_capacity_exceeded", "Bridge owner capacity is exhausted", "retry_read")
    : null;
}

export function missingSessionResponse(cause: unknown): Response | null {
  return cause instanceof SessionNotFoundError
    ? error(404, "session_not_found", "Session not found", "none") : null;
}

function sameCondition(
  actual: HistoryCondition,
  expected: BridgeScope & { sessionId: string },
): boolean {
  return (
    actual.organizationId === expected.organizationId &&
    actual.principalId === expected.principalId &&
    actual.agentId === expected.agentId &&
    actual.sessionId === expected.sessionId
  );
}

export class BodyTooLargeError extends Error {}

export async function readBody(
  request: Request,
  limit = bodyLimit,
): Promise<unknown> {
  request.signal.throwIfAborted();
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new SyntaxError();
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > limit
  )
    throw new BodyTooLargeError();
  const reader = request.body?.getReader();
  if (reader === undefined) throw new SyntaxError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await readWhileConnected(reader, request.signal);
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    request.signal.throwIfAborted();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new SyntaxError("Invalid JSON encoding");
  }
}

async function readWhileConnected(
  reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  signal.throwIfAborted();
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([reader.read(), interrupted]); }
  finally { signal.removeEventListener("abort", abort); }
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function error(
  status: number,
  code: string,
  message: string,
  recovery: "refresh" | "query_operation" | "login" | "retry_read" | "none",
): Response {
  return json(
    {
      code,
      message,
      requestId: randomUUID(),
      retryable: status >= 500,
      recovery,
    },
    status,
  );
}

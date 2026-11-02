import type { ListSessionsResponse, NewSessionResponse } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { AgentAccessRevokedError } from "../adapters/acp-http.ts";
import { BridgeCapacityError, type BridgeScope } from "../bridge/registry.ts";
import { error, json, readBody, trustedScope, BodyTooLargeError } from "./command-routes.ts";

const prefix = "/api/app/workspace/v1/agents/";
const emptyBody = z.strictObject({});

export function createSessionHandler(dependencies: {
  list(scope: BridgeScope, cursor?: string): Promise<ListSessionsResponse>;
  create(scope: BridgeScope): Promise<NewSessionResponse>;
}): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(prefix)) return null;
    const suffix = url.pathname.slice(prefix.length).split("/");
    if (suffix.length !== 2 || suffix[1] !== "sessions") return null;
    let agentId: string;
    try {
      agentId = decodeURIComponent(suffix[0]!);
    } catch {
      return error(422, "invalid_request", "Agent ID is invalid", "none");
    }
    if (!validId(agentId) || (request.method !== "GET" && request.method !== "POST"))
      return error(422, "invalid_request", "Session request is invalid", "none");
    const scope = trustedScope(request);
    if (scope === null)
      return error(401, "unauthenticated", "Trusted identity is missing", "login");
    if (scope.agentId !== agentId)
      return error(403, "access_denied", "Agent access denied", "none");
    const cursors = url.searchParams.getAll("cursor");
    if ([...url.searchParams.keys()].some((key) => key !== "cursor") ||
      cursors.length > 1 || (cursors.length === 1 && !validCursor(cursors[0]!)) ||
      (request.method === "POST" && cursors.length > 0))
      return error(422, "invalid_request", "Session cursor is invalid", "none");
    try {
      if (request.method === "POST") {
        emptyBody.parse(await readBody(request));
        const created = await dependencies.create(scope);
        return json({ sessionId: created.sessionId }, 201);
      }
      const page = await dependencies.list(scope, cursors[0]);
      return json({
        items: page.sessions.map((session) => ({
          sessionId: session.sessionId,
          title: session.title ?? "",
          updatedAt: session.updatedAt ?? null,
          activeOperationId: null,
        })),
        nextCursor: page.nextCursor ?? null,
      });
    } catch (cause) {
      if (cause instanceof BodyTooLargeError)
        return error(413, "request_too_large", "Request body exceeds the limit", "none");
      if (cause instanceof z.ZodError || cause instanceof SyntaxError)
        return error(422, "invalid_request", "Session request body is invalid", "none");
      if (cause instanceof BridgeCapacityError)
        return error(429, "bridge_capacity_exceeded", "Bridge owner capacity is exhausted", "retry_read");
      if (cause instanceof AgentAccessRevokedError)
        return error(403, "access_denied", "Agent access denied", "none");
      return error(503, "upstream_unavailable", "Session request is unavailable", "retry_read");
    }
  };
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= 200 &&
    !/[/\\\x00-\x1f\x7f]/u.test(value);
}

function validCursor(value: string): boolean {
  return value.length > 0 && value.length <= 4096 &&
    !/[\x00-\x1f\x7f]/u.test(value);
}

import type { IncomingMessage, ServerResponse } from "node:http";

import type { LearningStatusReader } from "../application/learning-status-reader.js";
import { DomainError } from "../domain/errors.js";
import { trustedIdentity } from "./trusted-identity.js";

const PREFIX = "/rpc/agent-acp/workspace/agents/";
const SUFFIX = "/learning-status";

export type LearningStatusRoute = {
  agentId: string;
  invalid: boolean;
};

export function learningStatusRoute(rawUrl: string | undefined): LearningStatusRoute | undefined {
  if (rawUrl === undefined) return undefined;
  const queryStart = rawUrl.indexOf("?");
  const path = queryStart < 0 ? rawUrl : rawUrl.slice(0, queryStart);
  if (!path.startsWith(PREFIX) || !path.endsWith(SUFFIX)) return undefined;
  const rawId = path.slice(PREFIX.length, -SUFFIX.length);
  const agentId = identifier(rawId);
  if (agentId === null) return undefined;
  const query = new URLSearchParams(queryStart < 0 ? "" : rawUrl.slice(queryStart + 1));
  return { agentId, invalid: [...query.keys()].length > 0 };
}

export async function serveLearningStatus(
  request: IncomingMessage,
  response: ServerResponse,
  route: LearningStatusRoute,
  reader: Pick<LearningStatusReader, "read"> | undefined,
  ready: () => Promise<boolean>,
): Promise<void> {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    json(response, 405, { code: "method_not_allowed", message: "Use GET", retryable: false });
    return;
  }
  const identity = trustedIdentity(request.headers);
  if (identity === null) {
    json(response, 401, {
      code: "access_denied",
      message: "Trusted identity required",
      retryable: false,
    });
    return;
  }
  if (identity.agentId !== route.agentId) {
    json(response, 404, { code: "agent_not_found", message: "Agent not found", retryable: false });
    return;
  }
  if (route.invalid) {
    json(response, 400, {
      code: "invalid_request",
      message: "Invalid learning status query",
      retryable: false,
    });
    return;
  }
  try {
    if (reader === undefined || !(await ready()))
      throw new Error("Learning status read unavailable");
    const page = await reader.read(identity);
    json(response, 200, page);
  } catch (error) {
    if (error instanceof DomainError && error.code === "access_denied") {
      json(response, 404, {
        code: "agent_not_found",
        message: "Agent not found",
        retryable: false,
      });
      return;
    }
    json(response, 503, {
      code: "learning_status_unavailable",
      message: "Learning status unavailable",
      retryable: true,
    });
  }
}

function identifier(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw);
    return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

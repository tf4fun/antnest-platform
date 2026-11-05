import type { IncomingMessage, ServerResponse } from "node:http";

import type { LearningChangeReader } from "../application/learning-change-reader.js";
import { DomainError } from "../domain/errors.js";
import { trustedIdentity } from "./trusted-identity.js";
import { errorHeaders, httpFailure } from "./public-error.js";
import { ERROR_CODES } from "../errors.gen.js";

const PREFIX = "/rpc/agent-acp/workspace/agents/";
const SUFFIX = "/learning-changes";

export type LearningChangeRoute = {
  agentId: string;
  input: { after?: string; before?: string };
  limit: number;
  invalid: boolean;
};

export function learningChangeRoute(rawUrl: string | undefined): LearningChangeRoute | undefined {
  if (rawUrl === undefined) return undefined;
  const queryStart = rawUrl.indexOf("?");
  const path = queryStart < 0 ? rawUrl : rawUrl.slice(0, queryStart);
  if (!path.startsWith(PREFIX) || !path.endsWith(SUFFIX)) return undefined;
  const rawId = path.slice(PREFIX.length, -SUFFIX.length);
  const agentId = identifier(rawId);
  if (agentId === null) return undefined;
  const query = new URLSearchParams(queryStart < 0 ? "" : rawUrl.slice(queryStart + 1));
  const keys = [...query.keys()];
  const invalid =
    keys.some((key) => !["after", "before", "limit"].includes(key)) ||
    new Set(keys).size !== keys.length ||
    (query.has("after") && query.has("before")) ||
    [...query.values()].some((value) => value.length > 4096);
  const limitRaw = query.get("limit");
  const limit = limitRaw === null ? 20 : Number(limitRaw);
  const invalidLimit = limitRaw !== null && (!/^[1-9][0-9]?$/u.test(limitRaw) || limit > 20);
  const after = query.get("after");
  const before = query.get("before");
  return {
    agentId,
    input: {
      ...(after === null ? {} : { after }),
      ...(before === null ? {} : { before }),
    },
    limit,
    invalid: invalid || invalidLimit || after === "" || before === "",
  };
}

export async function serveLearningChanges(
  request: IncomingMessage,
  response: ServerResponse,
  route: LearningChangeRoute,
  reader: Pick<LearningChangeReader, "list"> | undefined,
  ready: () => Promise<boolean>,
): Promise<void> {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    failure(response, ERROR_CODES.METHOD_NOT_ALLOWED);
    return;
  }
  const identity = trustedIdentity(request.headers);
  if (identity === null) {
    failure(response, ERROR_CODES.ACCESS_DENIED);
    return;
  }
  if (identity.agentId !== route.agentId) {
    failure(response, ERROR_CODES.AGENT_NOT_FOUND);
    return;
  }
  if (route.invalid) {
    failure(response, ERROR_CODES.INVALID_REQUEST);
    return;
  }
  try {
    if (reader === undefined || !(await ready()))
      throw new Error("Learning change read unavailable");
    const page = await reader.list(identity, route.input, route.limit);
    json(response, 200, page);
  } catch (error) {
    if (error instanceof DomainError && error.code === "cursor_expired") {
      failure(response, ERROR_CODES.CURSOR_EXPIRED);
      return;
    }
    if (error instanceof DomainError && error.code === "access_denied") {
      failure(response, ERROR_CODES.AGENT_NOT_FOUND);
      return;
    }
    failure(response, ERROR_CODES.LEARNING_CHANGES_UNAVAILABLE);
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

function failure(response: ServerResponse, code: string): void {
  const value = httpFailure(code);
  json(response, value.status, value.body);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed) return;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (status >= 400) Object.assign(headers, errorHeaders(body));
  else headers["cache-control"] = "no-store";
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

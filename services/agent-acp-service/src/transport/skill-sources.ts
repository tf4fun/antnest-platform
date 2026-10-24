import type { IncomingMessage, ServerResponse } from "node:http";
import type { SkillSources } from "../application/skill-sources.js";
import { resolveErrorDefinition } from "../domain/error-catalog.js";
import {
  SkillSourceError,
  skillSourceArtifactSchema,
  skillSourceInspectSchema,
  type SkillSourceArtifact,
  type SkillSourceInspect,
} from "../domain/skill-source.js";
import { authenticatedCaller } from "./trusted-identity.js";
import { readRpcRequest, RpcRequestError } from "./rpc-request.js";

const PREFIX = "/internal/skill-sources/";
export type SourceOperation =
  | { route: "inspect"; input: SkillSourceInspect }
  | { route: "artifact"; input: SkillSourceArtifact };
export function skillSourceRoute(
  rawUrl: string | undefined,
): "inspect" | "artifact" | "invalid" | undefined {
  if (!rawUrl?.startsWith(PREFIX)) return undefined;
  const path = rawUrl.slice(PREFIX.length);
  return path === "inspect" || path === "artifact" ? path : "invalid";
}

export async function serveSkillSource(
  request: IncomingMessage,
  response: ServerResponse,
  route: "inspect" | "artifact" | "invalid",
  options:
    | {
        service: Pick<SkillSources, "inspect" | "artifact">;
      }
    | undefined,
  ready: () => Promise<boolean>,
  forward?: (operation: SourceOperation, signal: AbortSignal, deadline: number) => Promise<boolean>,
  lifetime?: { signal: AbortSignal; deadline: number },
): Promise<void> {
  if (options === undefined || authenticatedCaller(request) !== "skill-registry") {
    json(response, "unauthorized");
    return;
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    json(response, "method_not_allowed");
    return;
  }
  if (route === "invalid") {
    json(response, "invalid_request");
    return;
  }
  const disconnected = new AbortController();
  const close = () => {
    if (!response.writableEnded) disconnected.abort();
  };
  response.once("close", close);
  const deadline = lifetime?.deadline ?? Date.now() + 8500;
  const signal = AbortSignal.any([
    disconnected.signal,
    AbortSignal.timeout(Math.max(0, Math.min(8500, deadline - Date.now()))),
    ...(lifetime === undefined ? [] : [lifetime.signal]),
  ]);
  try {
    const maximum = route === "inspect" ? 8192 : 4096;
    const parsed = await readRpcRequest(request, maximum);
    signal.throwIfAborted();
    const checked =
      route === "inspect"
        ? skillSourceInspectSchema.safeParse(parsed)
        : skillSourceArtifactSchema.safeParse(parsed);
    if (!checked.success) {
      json(response, "invalid_request");
      return;
    }
    if (!(await ready())) throw new SkillSourceError("source_unavailable");
    if (route === "inspect") {
      const input = skillSourceInspectSchema.parse(parsed);
      if (await forward?.({ route, input }, signal, deadline)) return;
      const value = await options.service.inspect(input, signal);
      signal.throwIfAborted();
      jsonBody(response, 200, value);
    } else {
      const input = skillSourceArtifactSchema.parse(parsed);
      if (await forward?.({ route, input }, signal, deadline)) return;
      const value = await options.service.artifact(input, signal);
      signal.throwIfAborted();
      response.writeHead(200, {
        "Content-Type": "application/zip",
        "Cache-Control": "no-store",
        "Content-Length": value.package.artifact.length,
        ETag: `"${value.package.artifactDigest}"`,
        "X-Antnest-Artifact-Digest": value.package.artifactDigest,
        "X-Antnest-Content-Digest": value.projection.content_digest,
        "X-Antnest-Source-Sequence": String(value.projection.sequence),
      });
      response.end(value.package.artifact);
    }
  } catch (error) {
    sourceFailure(response, error);
  } finally {
    response.off("close", close);
  }
}

export function sourceFailure(response: ServerResponse, error: unknown): void {
  if (error instanceof RpcRequestError) {
    json(response, error.code);
    return;
  }
  const failure =
    error instanceof SkillSourceError ? error : new SkillSourceError("source_unavailable");
  json(response, failure.code);
}

function json(response: ServerResponse, code: string): void {
  const definition = resolveErrorDefinition(code, "skill_source");
  jsonBody(response, definition.httpStatus, {
    error: { code: definition.code, message: definition.message },
  });
}
function jsonBody(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

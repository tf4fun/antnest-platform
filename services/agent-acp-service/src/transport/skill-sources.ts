import type { IncomingMessage, ServerResponse } from "node:http";
import type { SkillSources } from "../application/skill-sources.js";
import {
  SkillSourceError,
  skillSourceArtifactSchema,
  skillSourceInspectSchema,
} from "../domain/skill-source.js";
import { authenticatedCaller } from "./trusted-identity.js";
import { readRpcRequest, RpcRequestError } from "./rpc-request.js";

const PREFIX = "/internal/skill-sources/";
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
): Promise<void> {
  if (options === undefined || authenticatedCaller(request) !== "skill-registry") {
    json(response, 401, "unauthorized", "Source reader authorization required");
    return;
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    json(response, 405, "method_not_allowed", "Use POST");
    return;
  }
  if (route === "invalid") {
    json(response, 400, "invalid_request", "Invalid source request");
    return;
  }
  const disconnected = new AbortController();
  const close = () => {
    if (!response.writableEnded) disconnected.abort();
  };
  response.once("close", close);
  const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(8500)]);
  try {
    const maximum = route === "inspect" ? 8192 : 4096;
    const parsed = await readRpcRequest(request, maximum);
    signal.throwIfAborted();
    const checked =
      route === "inspect"
        ? skillSourceInspectSchema.safeParse(parsed)
        : skillSourceArtifactSchema.safeParse(parsed);
    if (!checked.success) {
      json(response, 400, "invalid_request", "Invalid source fields");
      return;
    }
    if (!(await ready())) throw new SkillSourceError("source_unavailable");
    if (route === "inspect") {
      const input = skillSourceInspectSchema.parse(parsed);
      jsonBody(response, 200, await options.service.inspect(input, signal));
    } else {
      const input = skillSourceArtifactSchema.parse(parsed);
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
    if (error instanceof RpcRequestError) {
      json(response, error.status, error.code, error.message);
      return;
    }
    const failure =
      error instanceof SkillSourceError ? error : new SkillSourceError("source_unavailable");
    json(
      response,
      failure.code === "not_found" ? 404 : failure.code === "content_changed" ? 409 : 503,
      failure.code,
      failure.message,
    );
  } finally {
    response.off("close", close);
  }
}

function json(response: ServerResponse, status: number, code: string, message: string): void {
  jsonBody(response, status, { error: { code, message } });
}
function jsonBody(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

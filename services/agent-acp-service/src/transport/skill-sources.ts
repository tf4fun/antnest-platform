import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SkillSources } from "../application/skill-sources.js";
import {
  SkillSourceError,
  skillSourceArtifactSchema,
  skillSourceInspectSchema,
} from "../domain/skill-source.js";

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
        token: string;
        service: Pick<SkillSources, "inspect" | "artifact">;
      }
    | undefined,
  ready: () => Promise<boolean>,
): Promise<void> {
  const provided = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${options?.token ?? ""}`);
  if (
    options === undefined ||
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    json(response, 401, "unauthorized", "Source reader authorization required");
    return;
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    json(response, 405, "method_not_allowed", "Use POST");
    return;
  }
  if (
    route === "invalid" ||
    !/^application\/json(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "")
  ) {
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
    const chunks: Buffer[] = [];
    let bytes = 0;
    const maximum = route === "inspect" ? 8192 : 4096;
    for await (const chunk of request) {
      signal.throwIfAborted();
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      bytes += part.length;
      if (bytes > maximum) {
        response.setHeader("Connection", "close");
        json(response, 400, "invalid_request", "Source request exceeds its bound");
        return;
      }
      chunks.push(part);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      json(response, 400, "invalid_request", "Invalid source JSON");
      return;
    }
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

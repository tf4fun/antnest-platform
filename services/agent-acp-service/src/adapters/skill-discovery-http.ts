import { createHash } from "node:crypto";
import {
  skillSearchResultSchema,
  SkillDiscoveryError,
  type SkillLoadInput,
} from "../domain/skill-discovery.js";
import { inspectDiscoveryPackage } from "../domain/skill-discovery-package.js";
import type {
  SkillDiscoveryPort,
  SkillDiscoveryScope,
  SkillDiscoverySearchInput,
} from "../ports/skill-discovery.js";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export class RegistrySkillDiscoveryClient implements SkillDiscoveryPort {
  public constructor(
    private readonly origin: string,
    private readonly fetchFn: Fetch,
  ) {}

  public async search(input: SkillDiscoverySearchInput, signal: AbortSignal) {
    return this.request("search", input, signal, async (response) => {
      if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json")
        throw invalid();
      const bytes = await readBounded(response, 128 * 1024);
      const parsed = skillSearchResultSchema.safeParse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      if (
        !parsed.success ||
        parsed.data.items.length > (input.limit ?? 20) ||
        new Set(parsed.data.items.map((item) => JSON.stringify(item.skill_ref))).size !==
          parsed.data.items.length
      )
        throw invalid();
      return parsed.data;
    });
  }

  public async load(input: SkillDiscoveryScope & SkillLoadInput, signal: AbortSignal) {
    return this.request("load", input, signal, async (response, operationSignal) => {
      const length = response.headers.get("content-length");
      const artifactDigest = response.headers.get("x-antnest-artifact-digest");
      if (
        response.headers.get("content-type") !== "application/zip" ||
        !length ||
        !/^[1-9][0-9]*$/u.test(length) ||
        Number(length) > 8 * 1024 * 1024 ||
        !artifactDigest ||
        !/^sha256:[0-9a-f]{64}$/u.test(artifactDigest) ||
        response.headers.get("etag") !== `"${artifactDigest}"` ||
        response.headers.get("x-antnest-content-digest") !== input.expected_digest
      )
        throw invalid();
      const bytes = await readBounded(response, 8 * 1024 * 1024);
      if (
        String(bytes.length) !== length ||
        `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== artifactDigest
      )
        throw invalid();
      const pkg = await inspectDiscoveryPackage(bytes, operationSignal);
      if (pkg.contentDigest !== input.expected_digest) throw invalid();
      return {
        ...pkg,
        artifactDigest,
        ...(pkg.requiresRuntimeDelivery ? { artifact: bytes } : {}),
      };
    });
  }

  private async request<T>(
    action: "search" | "load",
    input: SkillDiscoverySearchInput | (SkillDiscoveryScope & SkillLoadInput),
    signal: AbortSignal,
    read: (response: Response, signal: AbortSignal) => Promise<T>,
  ) {
    signal.throwIfAborted();
    const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(12000)]);
    let response: Response | undefined;
    try {
      response = await this.fetchFn(
        new URL(`/internal/skill-discovery/${action}`, this.origin).toString(),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          redirect: "error",
          signal: operationSignal,
        },
      );
      if (!response.ok)
        throw new SkillDiscoveryError(
          response.status === 404
            ? "not_found"
            : response.status === 409
              ? "content_changed"
              : response.status === 502
                ? "source_invalid"
                : "source_unavailable",
        );
      const result = await read(response, operationSignal);
      operationSignal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof SkillDiscoveryError) throw error;
      throw new SkillDiscoveryError(
        operationSignal.aborted || response === undefined ? "source_unavailable" : "source_invalid",
      );
    } finally {
      if (response?.body && !response.body.locked)
        await response.body.cancel().catch(() => undefined);
    }
  }
}
async function readBounded(response: Response, max: number): Promise<Buffer> {
  if (!response.body) throw invalid();
  const reader = response.body.getReader(),
    chunks: Buffer[] = [];
  let size = 0;
  try {
    let part = await reader.read();
    while (!part.done) {
      size += part.value.byteLength;
      if (size > max) throw invalid();
      chunks.push(Buffer.from(part.value));
      part = await reader.read();
    }
    return Buffer.concat(chunks);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
function invalid() {
  return new SkillDiscoveryError("source_invalid");
}

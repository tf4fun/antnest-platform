import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  skillProjectionSchema,
  type SkillProjection,
  type SkillSourceRecord,
} from "../domain/skill-source.js";
import type { RuntimeSkillMaintenanceSigner } from "./runtime-skill-maintenance-signer.js";
import type { RuntimeBinding } from "../domain/types.js";
import type { RuntimeConnectionAuthority } from "../ports/runtime-connections.js";
import { tracedFetch } from "../telemetry/http.js";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export class RegistrySkillProjectionClient {
  public constructor(
    private readonly url: string,
    private readonly fetchFn: Fetch,
  ) {}

  public async send(projection: SkillProjection, signal: AbortSignal): Promise<void> {
    const input = skillProjectionSchema.parse(projection);
    const response = await this.fetchFn(
      new URL("internal/skill-projections", this.url).toString(),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      },
    );
    const body: unknown = JSON.parse(await boundedText(response, 4096));
    const result = z
      .strictObject({
        outcome: z.enum(["applied", "replayed", "superseded"]),
        sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .safeParse(body);
    if (
      !response.ok ||
      !result.success ||
      (result.data.outcome === "superseded"
        ? result.data.sequence < input.sequence
        : result.data.sequence !== input.sequence)
    )
      throw new Error("Registry projection was not acknowledged");
  }
}

/** Uses the existing signed, read-only observe action. No new learning task,
 * mutable effect intent or model request is created for source verification. */
export class RuntimeSkillSourceVerifier {
  public constructor(
    private readonly signer: Pick<RuntimeSkillMaintenanceSigner, "sign">,
    private readonly connections: Pick<
      RuntimeConnectionAuthority,
      "fetchFor" | "retainOperation" | "releaseOperation"
    >,
  ) {}

  public async verify(
    record: SkillSourceRecord,
    binding: RuntimeBinding,
    signal: AbortSignal,
  ): Promise<"current" | "changed" | "unknown"> {
    const requestId = `source-${randomUUID()}`;
    const body = Buffer.from(
      JSON.stringify({
        action: "observe",
        request_id: requestId,
        job_id: record.taskId,
        generation: record.generation,
        effect_request_id: record.effectRequestId,
        expected_target_digest: record.projection.content_digest,
      }),
    );
    const url = new URL(binding.mcpEndpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.pathname !== "/mcp" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid current Runtime endpoint");
    url.pathname = "/internal/skill-maintenance/observe";
    const authorization = this.signer.sign({
      organizationId: record.projection.organization_id,
      agentId: record.projection.agent_id,
      executionId: binding.executionId,
      jobId: record.taskId,
      generation: record.generation,
      action: "observe",
      requestId,
      body,
    });
    this.connections.retainOperation(requestId, binding);
    try {
      const response = await tracedFetch(this.connections.fetchFor(binding), "runtime")(
        url.toString(),
        {
          method: "POST",
          headers: {
            Authorization: authorization,
            "Content-Type": "application/json",
            "X-Antnest-Expected-Execution-ID": binding.executionId,
          },
          body: new Uint8Array(body),
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        },
      );
      const result = z
        .strictObject({
          request_id: z.string(),
          action: z.literal("observe"),
          execution_id: z.string(),
          outcome: z.enum(["applied", "conflict", "unknown"]),
          observed_digest: z
            .string()
            .regex(/^sha256:[0-9a-f]{64}$/u)
            .nullable(),
        })
        .safeParse(JSON.parse(await boundedText(response, 4096)));
      if (
        !response.ok ||
        !result.success ||
        result.data.request_id !== requestId ||
        result.data.execution_id !== binding.executionId
      )
        return "unknown";
      if (result.data.outcome === "conflict") return "changed";
      if (
        result.data.outcome !== "applied" ||
        result.data.observed_digest !== record.projection.content_digest
      )
        return "unknown";
      return "current";
    } finally {
      this.connections.releaseOperation(requestId);
    }
  }
}

async function boundedText(response: Response, maximum: number): Promise<string> {
  if (response.body === null) throw new Error("Empty source response");
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Buffer[] = [];
  try {
    let part = await reader.read();
    while (!part.done) {
      bytes += part.value.byteLength;
      if (bytes > maximum) throw new Error("Source response exceeds its bound");
      chunks.push(Buffer.from(part.value));
      part = await reader.read();
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

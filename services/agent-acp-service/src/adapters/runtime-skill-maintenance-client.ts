import { createHash } from "node:crypto";
import { z } from "zod";

import type { LearningCandidatePackage } from "../domain/learning-candidate-package.js";
import {
  RuntimeMaintenancePreviouslyDispatchedError,
  RuntimeMaintenanceRejectedError,
  RuntimeMaintenanceUnknownError,
} from "../domain/learning-maintenance-errors.js";
import type { LearningTaskClaim } from "../domain/learning-scan.js";
import type { RuntimeSkillMaintenanceSigner } from "./runtime-skill-maintenance-signer.js";
import { tracedFetch } from "../telemetry/http.js";
import type { RuntimeBinding } from "../domain/types.js";
import type { RuntimeConnectionAuthority } from "../ports/runtime-connections.js";
import { runtimeAdmissionDenial } from "../domain/runtime-admission-error.js";

type IntentPort = {
  reserve(input: {
    claim: LearningTaskClaim;
    requestId: string;
    action: "prepare" | "check" | "commit" | "observe" | "cancel" | "release";
    executionId: string;
    mcpEndpoint: string;
    revision: string;
    connectionId: string;
    bodySha256: string;
    requestFacts: Record<string, unknown>;
  }): Promise<{ dispatch: boolean; state: "pending" | "unknown" | "settled" }>;
  settle(claim: LearningTaskClaim, requestId: string, receipt: unknown): Promise<void>;
  reject(
    claim: LearningTaskClaim,
    requestId: string,
    rejection: { status: number; code: string },
  ): Promise<void>;
  markUnknown(claim: LearningTaskClaim, requestId: string): Promise<void>;
};

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const key = z.string().regex(/^[0-9a-f]{64}$/u);
const receiptSchema = z.strictObject({
  request_id: z.string(),
  action: z.literal("prepare"),
  execution_id: z.string(),
  outcome: z.literal("prepared"),
  observed_digest: digest,
  storage_key: key,
});
export type PreparedSkillReceipt = z.infer<typeof receiptSchema>;
const checkReceiptSchema = z.strictObject({
  request_id: z.string(),
  action: z.literal("check"),
  execution_id: z.string(),
  outcome: z.literal("checked"),
  observed_digest: digest,
});
export type CheckedSkillReceipt = z.infer<typeof checkReceiptSchema>;
const commitReceiptSchema = z.union([
  z.strictObject({
    request_id: z.string(),
    action: z.literal("commit"),
    execution_id: z.string(),
    outcome: z.literal("applied"),
    observed_digest: digest,
  }),
  z.strictObject({
    request_id: z.string(),
    action: z.literal("commit"),
    execution_id: z.string(),
    outcome: z.literal("blocked"),
    observed_digest: z.null(),
    blocked_reason: z.enum([
      "foreground_running",
      "managed_call_in_flight",
      "background_task_running",
      "writers_unknown",
      "policy_changed",
      "execution_changed",
    ]),
    blocked_subject_id: z.string().nullable().optional(),
  }),
]);
export type CommittedSkillReceipt = z.infer<typeof commitReceiptSchema>;
const observeReceiptSchema = z.strictObject({
  request_id: z.string(),
  action: z.literal("observe"),
  execution_id: z.string(),
  outcome: z.enum(["applied", "conflict", "unknown"]),
  observed_digest: digest.nullable(),
});
export type ObservedSkillReceipt = z.infer<typeof observeReceiptSchema>;
const cancelReceiptSchema = z.strictObject({
  request_id: z.string(),
  action: z.literal("cancel"),
  execution_id: z.string(),
  outcome: z.literal("cancelled"),
  observed_digest: z.null(),
});
export type CancelledSkillReceipt = z.infer<typeof cancelReceiptSchema>;
const releaseReceiptSchema = z.strictObject({
  request_id: z.string(),
  action: z.literal("release"),
  execution_id: z.string(),
  outcome: z.literal("released"),
  observed_digest: z.null(),
});
export type ReleasedSkillReceipt = z.infer<typeof releaseReceiptSchema>;

export class RuntimeSkillMaintenanceClient {
  public constructor(
    private readonly signer: RuntimeSkillMaintenanceSigner,
    private readonly intents: IntentPort,
    private readonly connections: Pick<
      RuntimeConnectionAuthority,
      "fetchFor" | "retainOperation" | "releaseOperation"
    >,
  ) {}

  public async prepare(input: {
    claim: LearningTaskClaim;
    binding: RuntimeBinding;
    candidateId: string;
    requestId: string;
    package: LearningCandidatePackage;
    expectedBaseDigest: string | null;
    signal: AbortSignal;
  }): Promise<PreparedSkillReceipt> {
    const { claim, binding, candidateId, requestId } = input;
    input.signal.throwIfAborted();
    if (
      !/^[!-~]{1,200}$/u.test(candidateId) ||
      candidateId.includes("/") ||
      candidateId.includes("\\") ||
      input.package.artifact.length > 8 * 1024 * 1024 ||
      input.package.artifactDigest !== sha256(input.package.artifact) ||
      !digest.safeParse(input.package.targetDigest).success ||
      !/^\.antnest\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.package.packagePath) ||
      (input.expectedBaseDigest !== null && !digest.safeParse(input.expectedBaseDigest).success)
    )
      throw new Error("Invalid learning candidate package or preparation target");
    const metadataFacts = {
      action: "prepare",
      request_id: requestId,
      job_id: claim.taskId,
      generation: claim.generation,
      candidate_id: candidateId,
      package_path: input.package.packagePath,
      expected_base_digest: input.expectedBaseDigest,
      target_digest: input.package.targetDigest,
      artifact_digest: input.package.artifactDigest,
      package_rules_version: 1,
    };
    const metadata = Buffer.from(JSON.stringify(metadataFacts), "utf8");
    if (metadata.length > 4 * 1024) throw new Error("Learning candidate metadata is too large");
    const boundary = multipartBoundary(requestId, metadata, input.package.artifact);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n`),
      metadata,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="artifact"\r\n\r\n`),
      input.package.artifact,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const parsed = await this.send({
      claim,
      binding,
      requestId,
      action: "prepare",
      body,
      requestFacts: metadataFacts,
      contentType: `multipart/form-data; boundary=${boundary}`,
      signal: input.signal,
    });
    const receipt = receiptSchema.safeParse(parsed);
    if (
      !receipt.success ||
      receipt.data.request_id !== requestId ||
      receipt.data.execution_id !== binding.executionId ||
      receipt.data.observed_digest !== input.package.targetDigest
    ) {
      await this.intents.markUnknown(claim, requestId);
      throw new RuntimeMaintenanceUnknownError(
        "Runtime Skill preparation receipt does not match the request",
      );
    }
    await this.settle(claim, requestId, receipt.data);
    return receipt.data;
  }

  public async check(input: {
    claim: LearningTaskClaim;
    binding: RuntimeBinding;
    candidateId: string;
    requestId: string;
    package: LearningCandidatePackage;
    signal: AbortSignal;
  }): Promise<CheckedSkillReceipt> {
    if (
      !/^[!-~]{1,200}$/u.test(input.candidateId) ||
      input.candidateId.includes("/") ||
      input.candidateId.includes("\\") ||
      !digest.safeParse(input.package.targetDigest).success ||
      !/^\.antnest\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.package.packagePath)
    )
      throw new Error("Invalid learning candidate check target");
    const requestFacts = {
      action: "check",
      request_id: input.requestId,
      job_id: input.claim.taskId,
      generation: input.claim.generation,
      candidate_id: input.candidateId,
      package_path: input.package.packagePath,
      target_digest: input.package.targetDigest,
      package_rules_version: 1,
    };
    const body = Buffer.from(JSON.stringify(requestFacts));
    const parsed = await this.send({
      claim: input.claim,
      binding: input.binding,
      requestId: input.requestId,
      action: "check",
      body,
      requestFacts,
      contentType: "application/json",
      signal: input.signal,
    });
    const receipt = checkReceiptSchema.safeParse(parsed);
    if (
      !receipt.success ||
      receipt.data.request_id !== input.requestId ||
      receipt.data.execution_id !== input.binding.executionId ||
      receipt.data.observed_digest !== input.package.targetDigest
    ) {
      await this.intents.markUnknown(input.claim, input.requestId);
      throw new RuntimeMaintenanceUnknownError(
        "Runtime Skill check receipt does not match the request",
      );
    }
    await this.settle(input.claim, input.requestId, receipt.data);
    return receipt.data;
  }

  public async commit(input: {
    claim: LearningTaskClaim;
    binding: RuntimeBinding;
    candidateId: string;
    requestId: string;
    package: LearningCandidatePackage;
    expectedBaseDigest: string | null;
    signal: AbortSignal;
  }): Promise<CommittedSkillReceipt> {
    if (
      !validCandidateId(input.candidateId) ||
      !validPackageTarget(input.package) ||
      (input.expectedBaseDigest !== null && !digest.safeParse(input.expectedBaseDigest).success)
    )
      throw new Error("Invalid learning candidate commit target");
    const parsed = await this.sendControl(input, "commit", {
      candidate_id: input.candidateId,
      package_path: input.package.packagePath,
      expected_base_digest: input.expectedBaseDigest,
      target_digest: input.package.targetDigest,
    });
    const receipt = commitReceiptSchema.safeParse(parsed);
    if (
      !receipt.success ||
      receipt.data.request_id !== input.requestId ||
      receipt.data.execution_id !== input.binding.executionId ||
      (receipt.data.outcome === "applied" &&
        receipt.data.observed_digest !== input.package.targetDigest)
    ) {
      await this.intents.markUnknown(input.claim, input.requestId);
      throw new RuntimeMaintenanceUnknownError(
        "Runtime Skill commit receipt does not match the request",
      );
    }
    await this.settle(input.claim, input.requestId, receipt.data);
    return receipt.data;
  }

  public async observe(input: {
    claim: LearningTaskClaim;
    binding: RuntimeBinding;
    requestId: string;
    effectRequestId: string;
    expectedTargetDigest: string | null;
    signal: AbortSignal;
  }): Promise<ObservedSkillReceipt> {
    if (
      !/^[!-~]{1,128}$/u.test(input.effectRequestId) ||
      input.effectRequestId.includes("/") ||
      input.effectRequestId.includes("\\") ||
      (input.expectedTargetDigest !== null && !digest.safeParse(input.expectedTargetDigest).success)
    )
      throw new Error("Invalid Skill effect observation target");
    const parsed = await this.sendControl(input, "observe", {
      effect_request_id: input.effectRequestId,
      expected_target_digest: input.expectedTargetDigest,
    });
    const receipt = observeReceiptSchema.safeParse(parsed);
    if (
      !receipt.success ||
      receipt.data.request_id !== input.requestId ||
      receipt.data.execution_id !== input.binding.executionId ||
      (receipt.data.outcome === "applied" &&
        receipt.data.observed_digest !== input.expectedTargetDigest)
    ) {
      await this.intents.markUnknown(input.claim, input.requestId);
      throw new RuntimeMaintenanceUnknownError(
        "Runtime Skill observe receipt does not match the request",
      );
    }
    if (receipt.data.outcome === "unknown")
      await this.intents.markUnknown(input.claim, input.requestId);
    else await this.settle(input.claim, input.requestId, receipt.data);
    return receipt.data;
  }

  public async cancel(input: {
    claim: LearningTaskClaim;
    binding: RuntimeBinding;
    requestId: string;
    signal: AbortSignal;
  }): Promise<CancelledSkillReceipt> {
    const parsed = await this.sendControl(input, "cancel", {});
    const receipt = cancelReceiptSchema.safeParse(parsed);
    if (
      !receipt.success ||
      receipt.data.request_id !== input.requestId ||
      receipt.data.execution_id !== input.binding.executionId
    ) {
      await this.intents.markUnknown(input.claim, input.requestId);
      throw new RuntimeMaintenanceUnknownError(
        "Runtime Skill cancel receipt does not match the request",
      );
    }
    await this.settle(input.claim, input.requestId, receipt.data);
    return receipt.data;
  }

  public async release(input: {
    claim: LearningTaskClaim;
    binding: RuntimeBinding;
    requestId: string;
    storageClass: "candidate";
    storageKey: string;
    packagePath: string;
    expectedDigest: string;
    signal: AbortSignal;
  }): Promise<ReleasedSkillReceipt> {
    if (
      !key.safeParse(input.storageKey).success ||
      !validPackagePath(input.packagePath) ||
      !digest.safeParse(input.expectedDigest).success
    )
      throw new Error("Invalid Skill release target");
    const parsed = await this.sendControl(input, "release", {
      storage_class: input.storageClass,
      storage_key: input.storageKey,
      package_path: input.packagePath,
      expected_digest: input.expectedDigest,
    });
    const receipt = releaseReceiptSchema.safeParse(parsed);
    if (
      !receipt.success ||
      receipt.data.request_id !== input.requestId ||
      receipt.data.execution_id !== input.binding.executionId
    ) {
      await this.intents.markUnknown(input.claim, input.requestId);
      throw new RuntimeMaintenanceUnknownError(
        "Runtime Skill release receipt does not match the request",
      );
    }
    await this.settle(input.claim, input.requestId, receipt.data);
    return receipt.data;
  }

  private async sendControl(
    input: {
      claim: LearningTaskClaim;
      binding: RuntimeBinding;
      requestId: string;
      signal: AbortSignal;
    },
    action: "commit" | "observe" | "cancel" | "release",
    extra: Record<string, unknown>,
  ): Promise<unknown> {
    const requestFacts = {
      action,
      request_id: input.requestId,
      job_id: input.claim.taskId,
      generation: input.claim.generation,
      ...extra,
    };
    return this.send({
      ...input,
      action,
      body: Buffer.from(JSON.stringify(requestFacts)),
      requestFacts,
      contentType: "application/json",
    });
  }

  private async send(input: {
    claim: LearningTaskClaim;
    binding: RuntimeBinding;
    requestId: string;
    action: "prepare" | "check" | "commit" | "observe" | "cancel" | "release";
    body: Buffer;
    requestFacts: Record<string, unknown>;
    contentType: string;
    signal: AbortSignal;
  }): Promise<unknown> {
    input.signal.throwIfAborted();
    const authorization = this.signer.sign({
      organizationId: input.claim.organizationId,
      agentId: input.claim.agentId,
      executionId: input.binding.executionId,
      jobId: input.claim.taskId,
      generation: input.claim.generation,
      action: input.action,
      requestId: input.requestId,
      body: input.body,
    });
    const url = maintenanceUrl(input.binding.mcpEndpoint, input.action);
    // Pin and verify the original sender before creating any durable effect intent.
    if (["observe", "cancel", "release"].includes(input.action))
      this.connections.retainOperation(input.requestId, input.binding, { cleanup: true });
    else this.connections.retainOperation(input.requestId, input.binding);
    const send = tracedFetch(this.connections.fetchFor(input.binding), "antnest-runtime");
    const reservation = await this.intents.reserve({
      claim: input.claim,
      requestId: input.requestId,
      action: input.action,
      executionId: input.binding.executionId,
      mcpEndpoint: input.binding.mcpEndpoint,
      revision: input.binding.revision,
      connectionId: input.binding.connectionId,
      bodySha256: sha256(input.body),
      requestFacts: input.requestFacts,
    });
    if (!reservation.dispatch) {
      if (reservation.state === "settled") this.connections.releaseOperation(input.requestId);
      throw new RuntimeMaintenancePreviouslyDispatchedError(reservation.state);
    }
    let response: Response;
    try {
      response = await send(url, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": input.contentType,
          "X-Antnest-Expected-Execution-ID": input.binding.executionId,
        },
        body: new Uint8Array(input.body),
        signal: input.signal,
        redirect: "error",
      });
    } catch (error) {
      await this.intents.markUnknown(input.claim, input.requestId);
      throw new RuntimeMaintenanceUnknownError("Runtime Skill maintenance outcome is unknown", {
        cause: error,
      });
    }
    let raw: string;
    try {
      raw = await boundedResponse(response);
    } catch (error) {
      await this.intents.markUnknown(input.claim, input.requestId);
      throw new RuntimeMaintenanceUnknownError("Runtime Skill maintenance response is incomplete", {
        cause: error,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      await this.intents.markUnknown(input.claim, input.requestId);
      throw new RuntimeMaintenanceUnknownError("Runtime Skill maintenance response is invalid", {
        cause: error,
      });
    }
    if (!response.ok) {
      const admissionCode = runtimeAdmissionDenial(response, parsed);
      if (admissionCode !== null && reservation.state !== "unknown") {
        await this.intents.reject(input.claim, input.requestId, {
          status: response.status,
          code: admissionCode,
        });
        this.connections.releaseOperation(input.requestId);
        throw new RuntimeMaintenanceRejectedError(response.status, admissionCode);
      }
      const error = z
        .object({
          error: z.object({
            code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
            message: z.string(),
            retryable: z.boolean(),
          }),
        })
        .safeParse(parsed);
      if (
        !error.success ||
        response.status >= 500 ||
        response.status === 408 ||
        response.status === 429 ||
        error.data.error.retryable ||
        reservation.state === "unknown"
      ) {
        await this.intents.markUnknown(input.claim, input.requestId);
        throw new RuntimeMaintenanceUnknownError("Runtime Skill maintenance outcome is unknown");
      }
      await this.intents.reject(input.claim, input.requestId, {
        status: response.status,
        code: error.data.error.code,
      });
      this.connections.releaseOperation(input.requestId);
      throw new RuntimeMaintenanceRejectedError(response.status, error.data.error.code);
    }
    return parsed;
  }

  private async settle(
    claim: LearningTaskClaim,
    requestId: string,
    receipt: unknown,
  ): Promise<void> {
    await this.intents.settle(claim, requestId, receipt);
    this.connections.releaseOperation(requestId);
  }
}

function validCandidateId(value: string): boolean {
  return /^[!-~]{1,200}$/u.test(value) && !value.includes("/") && !value.includes("\\");
}

function validPackageTarget(value: LearningCandidatePackage): boolean {
  return digest.safeParse(value.targetDigest).success && validPackagePath(value.packagePath);
}

function validPackagePath(value: string): boolean {
  return /^\.antnest\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

function sha256(body: Buffer): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function multipartBoundary(requestId: string, metadata: Buffer, artifact: Buffer): string {
  for (let index = 0; index < 10; index++) {
    const seed = createHash("sha256")
      .update(requestId)
      .update(metadata)
      .update(artifact)
      .update(String(index))
      .digest("hex")
      .slice(0, 32);
    const boundary = `antnest-skill-${seed}`;
    const separator = Buffer.from(`\r\n--${boundary}`);
    if (!metadata.includes(separator) && !artifact.includes(separator)) return boundary;
  }
  throw new Error("Cannot construct an unambiguous Skill multipart boundary");
}

function maintenanceUrl(endpoint: string, action: string): string {
  const url = new URL(endpoint);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.pathname !== "/mcp" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error("Invalid Runtime MCP endpoint for Skill maintenance");
  url.pathname = `/internal/skill-maintenance/${action}`;
  return url.toString();
}

async function boundedResponse(response: Response): Promise<string> {
  if (response.body === null)
    throw new RuntimeMaintenanceUnknownError("Runtime returned no maintenance response");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    let part = await reader.read();
    while (!part.done) {
      total += part.value.byteLength;
      if (total > 16 * 1024)
        throw new RuntimeMaintenanceUnknownError("Runtime maintenance response is too large");
      chunks.push(Buffer.from(part.value));
      part = await reader.read();
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof RuntimeMaintenanceUnknownError) throw error;
    throw new RuntimeMaintenanceUnknownError("Runtime maintenance response stream is incomplete", {
      cause: error,
    });
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  TemporarySkillFailure,
  temporaryErrorSchema,
  temporaryInstalledSchema,
  temporaryReleasedSchema,
} from "../domain/temporary-skills.js";
import type { LoadedSkillText } from "../ports/skill-discovery.js";
import type {
  TemporaryAgentScope,
  TemporarySkillScope,
  TemporarySkillRuntime,
} from "../ports/temporary-skills.js";
import { tracedFetch } from "../telemetry/http.js";
import type { RuntimeSkillMaintenanceSigner } from "./runtime-skill-maintenance-signer.js";
import type { RuntimeBinding } from "../domain/types.js";
import type { RuntimeConnectionAuthority } from "../ports/runtime-connections.js";
import { runtimeAdmissionDenial } from "../domain/runtime-admission-error.js";

const statusSchema = z.object({
  status: z.literal("ready"),
  agent_id: z.string().min(1).max(200),
  execution_id: z.string().min(1).max(200),
});
export class RuntimeSkillTemporaryClient implements TemporarySkillRuntime {
  public constructor(
    private readonly signer: RuntimeSkillMaintenanceSigner | undefined,
    private readonly connections: Pick<RuntimeConnectionAuthority, "fetchFor" | "retainRun">,
    private readonly limits = { installTimeoutMs: 75000, cleanupTimeoutMs: 12000 },
    private readonly currentBinding?: (scope: TemporaryAgentScope) => RuntimeBinding | null,
  ) {
    for (const [name, value] of Object.entries(limits))
      if (
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > (name === "installTimeoutMs" ? 75000 : 12000)
      )
        throw new Error("Invalid temporary Skill timeout");
  }
  public async install(scope: TemporarySkillScope, loaded: LoadedSkillText, signal: AbortSignal) {
    if (signal.aborted || !loaded.artifact || loaded.artifact.length > 8 * 1024 * 1024)
      throw new TemporarySkillFailure("none", true);
    const requestId = `request_${randomUUID().replaceAll("-", "")}`;
    const boundary = `temporary_${randomUUID().replaceAll("-", "")}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n`),
      Buffer.from(
        JSON.stringify({
          action: "temporary_install",
          request_id: requestId,
          job_id: scope.runId,
          generation: 1,
          content_digest: loaded.contentDigest,
          artifact_digest: loaded.artifactDigest,
          package_rules_version: 1,
        }),
      ),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="artifact"\r\n\r\n`),
      loaded.artifact,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const operation = AbortSignal.any([signal, AbortSignal.timeout(this.limits.installTimeoutMs)]);
    const raw = await this.dispatch(
      scope,
      "temporary_install",
      requestId,
      body,
      `multipart/form-data; boundary=${boundary}`,
      operation,
    );
    const result = temporaryInstalledSchema.safeParse(raw);
    if (
      !result.success ||
      result.data.request_id !== requestId ||
      result.data.job_id !== scope.runId ||
      result.data.execution_id !== scope.executionId ||
      result.data.content_digest !== loaded.contentDigest ||
      result.data.artifact_digest !== loaded.artifactDigest ||
      !result.data.temporary_path.endsWith(`/${loaded.contentDigest.slice(7)}/package`)
    )
      throw new TemporarySkillFailure("unknown", false);
    return { path: result.data.temporary_path, unpacked_size: result.data.unpacked_size };
  }
  public async cleanup(scope: TemporarySkillScope, signal: AbortSignal): Promise<void> {
    const operation = AbortSignal.any([signal, AbortSignal.timeout(this.limits.cleanupTimeoutMs)]);
    try {
      const binding = this.currentBinding?.(scope) ?? null;
      const original = runtimeBinding(scope);
      const target = binding ?? original;
      if (
        target.executionId === original.executionId &&
        (target.revision !== original.revision ||
          target.connectionId !== original.connectionId ||
          target.mcpEndpoint !== original.mcpEndpoint)
      )
        throw new TemporarySkillFailure("unknown", false);
      const send = tracedFetch(this.connections.fetchFor(target), "runtime");
      const status = await bounded(async () => {
        const response = await send(new URL("/status", target.mcpEndpoint).toString(), {
          method: "GET",
          headers: { "X-Antnest-Expected-Execution-ID": target.executionId },
          redirect: "error",
          signal: operation,
        });
        if (!response.ok) throw new TemporarySkillFailure("unknown", false);
        return statusSchema.parse(await jsonBounded(response, operation));
      }, operation);
      if (status.agent_id !== scope.agentId) throw new TemporarySkillFailure("unknown", false);
      if (status.execution_id !== target.executionId)
        throw new TemporarySkillFailure("unknown", false);
      if (status.execution_id !== scope.executionId) return;
      const requestId = `release_${randomUUID().replaceAll("-", "")}`;
      const body = Buffer.from(
        JSON.stringify({
          action: "temporary_release",
          request_id: requestId,
          job_id: scope.runId,
          generation: 1,
        }),
      );
      for (;;) {
        try {
          const result = temporaryReleasedSchema.parse(
            await this.dispatch(
              scope,
              "temporary_release",
              requestId,
              body,
              "application/json",
              operation,
            ),
          );
          if (
            result.request_id !== requestId ||
            result.job_id !== scope.runId ||
            result.execution_id !== scope.executionId
          )
            throw new TemporarySkillFailure("unknown", false);
          return;
        } catch (error) {
          if (
            error instanceof TemporarySkillFailure &&
            error.remoteCode === "runtime_busy" &&
            error.effectState === "none" &&
            error.runtimeCallStopped &&
            !operation.aborted
          ) {
            await delay(100, undefined, { signal: operation });
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      // A denied/failed release proves nothing about the earlier install.
      throw new TemporarySkillFailure(
        "unknown",
        false,
        error instanceof TemporarySkillFailure ? error.remoteCode : undefined,
      );
    }
  }
  private async dispatch(
    scope: TemporarySkillScope,
    action: "temporary_install" | "temporary_release",
    requestId: string,
    body: Buffer<ArrayBuffer>,
    contentType: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const dispatchState = { dispatched: false };
    try {
      signal.throwIfAborted();
      if (!this.signer) throw new TemporarySkillFailure("none", true);
      const binding = runtimeBinding(scope);
      if (action === "temporary_install") this.connections.retainRun(scope.runId, binding);
      const send = tracedFetch(this.connections.fetchFor(binding), "runtime");
      const authorization = this.signer.sign({
        organizationId: scope.organizationId,
        agentId: scope.agentId,
        executionId: scope.executionId,
        jobId: scope.runId,
        generation: 1,
        action,
        requestId,
        body,
      });
      signal.throwIfAborted();
      return await bounded(async () => {
        dispatchState.dispatched = true;
        const response = await send(
          new URL(
            `/internal/skill-temporary/${action === "temporary_install" ? "install" : "release"}`,
            scope.mcpEndpoint,
          ).toString(),
          {
            method: "POST",
            redirect: "error",
            headers: {
              Authorization: authorization,
              "Content-Type": contentType,
              "X-Antnest-Expected-Execution-ID": binding.executionId,
            },
            body,
            signal,
          },
        );
        const raw = await jsonBounded(response, signal);
        const admissionCode = runtimeAdmissionDenial(response, raw);
        if (admissionCode !== null) throw new TemporarySkillFailure("none", true, admissionCode);
        if (response.headers.get("cache-control") !== "no-store")
          throw new TemporarySkillFailure("unknown", false);
        if (!response.ok) {
          const error = temporaryErrorSchema.safeParse(raw);
          if (!error.success) throw new TemporarySkillFailure("unknown", false);
          throw new TemporarySkillFailure(
            error.data.error.effect_state,
            error.data.error.runtime_call_stopped,
            error.data.error.code,
          );
        }
        return raw;
      }, signal);
    } catch (error) {
      if (error instanceof TemporarySkillFailure) throw error;
      throw new TemporarySkillFailure(
        dispatchState.dispatched ? "unknown" : "none",
        !dispatchState.dispatched,
      );
    }
  }
}
function runtimeBinding(scope: TemporarySkillScope): RuntimeBinding {
  return {
    revision: scope.revision,
    executionId: scope.executionId,
    mcpEndpoint: scope.mcpEndpoint,
    connectionId: scope.connectionId,
  };
}
async function jsonBounded(response: Response, signal: AbortSignal): Promise<unknown> {
  if (
    response.headers.get("content-type")?.split(";", 1)[0] !== "application/json" ||
    !response.body
  )
    throw new TemporarySkillFailure("unknown", false);
  const reader = response.body.getReader(),
    chunks: Buffer[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) throw new TemporarySkillFailure("unknown", false);
      chunks.push(Buffer.from(part.value));
    }
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
async function bounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const interrupted = Promise.withResolvers<never>();
  const abort = () => interrupted.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.race([work(), interrupted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

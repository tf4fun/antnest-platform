import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { RuntimeSkillMaintenanceClient } from "../../src/adapters/runtime-skill-maintenance-client.js";
import {
  RuntimeMaintenanceUnknownError,
  RuntimeMaintenancePreviouslyDispatchedError,
  RuntimeMaintenanceRejectedError,
} from "../../src/domain/learning-maintenance-errors.js";
import { RuntimeSkillMaintenanceSigner } from "../../src/adapters/runtime-skill-maintenance-signer.js";
import { buildLearningCandidatePackage } from "../../src/domain/learning-candidate-package.js";
import type { LearningTaskClaim } from "../../src/domain/learning-scan.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const signer = new RuntimeSkillMaintenanceSigner("key-1", privateKey, () => 1_800_000_000);
const admitted = {
  reserve: () => Promise.resolve({ dispatch: true, state: "pending" as const }),
  settle: () => Promise.resolve(),
  reject: () => Promise.resolve(),
  markUnknown: () => Promise.resolve(),
};
const evidenceId = `evidence_${"a".repeat(32)}`;
const evidence = {
  sourceRunId: "run-1",
  truncated: false,
  items: [
    {
      evidenceId,
      sourceId: "user-1",
      kind: "authenticated_user" as const,
      scope: "user_prompt" as const,
      text: "Inspect first",
    },
  ],
};
const candidate = buildLearningCandidatePackage(
  {
    decision: "propose",
    name: "inspect-first",
    description: "Inspect first.",
    instructions: "unused",
    rules: [{ text: "Inspect first", evidenceIds: [evidenceId] }],
  },
  evidence,
);
const claim: LearningTaskClaim = {
  taskId: "job-1",
  claimId: "claim-1",
  generation: 1,
  organizationId: "org-1",
  agentId: "agent-1",
  ownerId: "owner-1",
  sourceRunId: "run-1",
  frozenPolicy: {},
};
const binding = { mcpEndpoint: "http://runtime.test:8093/mcp", executionId: "execution-1" };
const request = {
  claim,
  binding,
  candidateId: "candidate-1",
  requestId: "prepare-1",
  package: candidate,
  expectedBaseDigest: null,
  signal: new AbortController().signal,
};

describe("Runtime Skill maintenance client", () => {
  it("marks an in-flight commit unknown when lifecycle cancellation cuts its HTTP response", async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const markUnknown = vi.fn(() => Promise.resolve());
    const settle = vi.fn(() => Promise.resolve());
    const fetchFn = vi.fn((_url: string, init: RequestInit): Promise<Response> => {
      entered.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("HTTP response cancelled")), {
          once: true,
        });
      });
    });
    const client = new RuntimeSkillMaintenanceClient(
      signer,
      { ...admitted, markUnknown, settle },
      fetchFn,
    );
    const committing = client.commit({
      ...request,
      requestId: "commit-in-flight",
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort(new Error("Agent lifecycle closed"));
    await expect(committing).rejects.toBeInstanceOf(RuntimeMaintenanceUnknownError);
    expect(markUnknown).toHaveBeenCalledWith(claim, "commit-in-flight");
    expect(settle).not.toHaveBeenCalled();
  });

  it("records the exact body before HTTP and never redispatches a durable replay", async () => {
    const order: string[] = [];
    const reserve = vi.fn<(input: unknown) => Promise<{ dispatch: boolean; state: "pending" }>>(
      () => {
        order.push("reserve");
        return Promise.resolve({ dispatch: true, state: "pending" as const });
      },
    );
    const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() => {
      order.push("fetch");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            request_id: "prepare-1",
            action: "prepare",
            execution_id: binding.executionId,
            outcome: "prepared",
            observed_digest: candidate.targetDigest,
            storage_key: "a".repeat(64),
          }),
          { status: 200 },
        ),
      );
    });
    await new RuntimeSkillMaintenanceClient(signer, { ...admitted, reserve }, fetchFn).prepare(
      request,
    );
    expect(order).toEqual(["reserve", "fetch"]);
    const body = Buffer.from(fetchFn.mock.calls[0]![1].body as Uint8Array);
    expect(reserve.mock.calls[0]![0]).toMatchObject({
      claim,
      requestId: "prepare-1",
      action: "prepare",
      executionId: binding.executionId,
      bodySha256: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      requestFacts: { candidate_id: request.candidateId, target_digest: candidate.targetDigest },
    });

    const replay = {
      reserve: vi.fn(() => Promise.resolve({ dispatch: false, state: "unknown" as const })),
    };
    await expect(
      new RuntimeSkillMaintenanceClient(signer, { ...admitted, ...replay }, fetchFn).prepare(
        request,
      ),
    ).rejects.toBeInstanceOf(RuntimeMaintenancePreviouslyDispatchedError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("durably settles a checked receipt and a deterministic rejection", async () => {
    const settle = vi.fn(() => Promise.resolve());
    const reject = vi.fn(() => Promise.resolve());
    const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            request_id: "check-1",
            action: "check",
            execution_id: binding.executionId,
            outcome: "checked",
            observed_digest: candidate.targetDigest,
          }),
          { status: 200 },
        ),
      ),
    );
    const client = new RuntimeSkillMaintenanceClient(
      signer,
      { ...admitted, settle, reject },
      fetchFn,
    );
    await client.check({ ...request, requestId: "check-1" });
    expect(settle).toHaveBeenCalledWith(
      claim,
      "check-1",
      expect.objectContaining({ outcome: "checked" }),
    );
    fetchFn.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: "request_conflict",
              message: "Skill maintenance request was not admitted",
              retryable: false,
            },
          }),
          { status: 409 },
        ),
      ),
    );
    await expect(client.check({ ...request, requestId: "check-2" })).rejects.toBeInstanceOf(
      RuntimeMaintenanceRejectedError,
    );
    expect(reject).toHaveBeenCalledWith(claim, "check-2", {
      status: 409,
      code: "request_conflict",
    });
  });
  it("signs the exact prepare multipart body and checks the Runtime receipt identity", async () => {
    const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            request_id: "prepare-1",
            action: "prepare",
            execution_id: "execution-1",
            outcome: "prepared",
            observed_digest: candidate.targetDigest,
            storage_key: "a".repeat(64),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const client = new RuntimeSkillMaintenanceClient(signer, admitted, fetchFn);
    expect(await client.prepare(request)).toMatchObject({
      outcome: "prepared",
      observed_digest: candidate.targetDigest,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("http://runtime.test:8093/internal/skill-maintenance/prepare");
    expect(init.method).toBe("POST");
    const body = Buffer.from(init.body as Uint8Array);
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Antnest-Expected-Execution-ID"]).toBe("execution-1");
    expect(headers["Content-Type"]).toContain("multipart/form-data; boundary=");
    const [head, payload, signature] = headers
      .Authorization!.slice("AntnestMaintenance ".length)
      .split(".");
    expect(
      verify(
        null,
        Buffer.from(`antnest-skill-maintenance-v1\n${head}.${payload}`),
        publicKey,
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({
      action: "prepare",
      request_id: "prepare-1",
      body_sha256: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    });
    expect(body.includes(candidate.artifact)).toBe(true);
    expect(body.toString("utf8")).toContain('"candidate_id":"candidate-1"');
  });

  it("rejects a mismatched success receipt and does not retry an uncertain response", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            request_id: "wrong",
            action: "prepare",
            execution_id: "execution-1",
            outcome: "prepared",
            observed_digest: candidate.targetDigest,
            storage_key: "a".repeat(64),
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(
      new RuntimeSkillMaintenanceClient(signer, admitted, fetchFn).prepare(request),
    ).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("classifies network loss and server failure as unknown without redispatch", async () => {
    for (const fetchFn of [
      vi.fn(() => Promise.reject(new Error("connection lost"))),
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: "maintenance_unavailable" } }), {
            status: 503,
          }),
        ),
      ),
    ]) {
      await expect(
        new RuntimeSkillMaintenanceClient(signer, admitted, fetchFn).prepare(request),
      ).rejects.toBeInstanceOf(RuntimeMaintenanceUnknownError);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
  });

  it("sends a separately signed bounded check request after preparation", async () => {
    const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            request_id: "check-1",
            action: "check",
            execution_id: "execution-1",
            outcome: "checked",
            observed_digest: candidate.targetDigest,
          }),
          { status: 200 },
        ),
      ),
    );
    const client = new RuntimeSkillMaintenanceClient(signer, admitted, fetchFn);
    expect(await client.check({ ...request, requestId: "check-1" })).toMatchObject({
      outcome: "checked",
    });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("http://runtime.test:8093/internal/skill-maintenance/check");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(Buffer.from(init.body as Uint8Array).toString())).toEqual({
      action: "check",
      request_id: "check-1",
      job_id: "job-1",
      generation: 1,
      candidate_id: "candidate-1",
      package_path: candidate.packagePath,
      target_digest: candidate.targetDigest,
      package_rules_version: 1,
    });
  });

  it("commits a checked candidate and distinguishes a writer block from success", async () => {
    const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            request_id: "commit-1",
            action: "commit",
            execution_id: binding.executionId,
            outcome: "blocked",
            observed_digest: null,
            blocked_reason: "background_task_running",
            blocked_subject_id: "bash:123",
          }),
          { status: 200 },
        ),
      ),
    );
    const result = await new RuntimeSkillMaintenanceClient(signer, admitted, fetchFn).commit({
      ...request,
      requestId: "commit-1",
    });
    expect(result).toMatchObject({ outcome: "blocked", blocked_reason: "background_task_running" });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("http://runtime.test:8093/internal/skill-maintenance/commit");
    expect(JSON.parse(Buffer.from(init.body as Uint8Array).toString())).toEqual({
      action: "commit",
      request_id: "commit-1",
      job_id: claim.taskId,
      generation: claim.generation,
      candidate_id: request.candidateId,
      package_path: candidate.packagePath,
      expected_base_digest: null,
      target_digest: candidate.targetDigest,
    });
  });

  it("observes an uncertain effect and cancels the generation with separately signed requests", async () => {
    const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>((_url, init) => {
      const body = JSON.parse(Buffer.from(init.body as Uint8Array).toString()) as {
        action: string;
        request_id: string;
      };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            request_id: body.request_id,
            action: body.action,
            execution_id: binding.executionId,
            outcome: body.action === "observe" ? "unknown" : "cancelled",
            observed_digest: null,
          }),
          { status: 200 },
        ),
      );
    });
    const client = new RuntimeSkillMaintenanceClient(signer, admitted, fetchFn);
    expect(
      await client.observe({
        claim,
        binding,
        requestId: "observe-1",
        effectRequestId: "commit-1",
        expectedTargetDigest: candidate.targetDigest,
        signal: request.signal,
      }),
    ).toMatchObject({ outcome: "unknown" });
    expect(
      await client.cancel({ claim, binding, requestId: "cancel-1", signal: request.signal }),
    ).toMatchObject({ outcome: "cancelled" });
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      "http://runtime.test:8093/internal/skill-maintenance/observe",
      "http://runtime.test:8093/internal/skill-maintenance/cancel",
    ]);
  });

  it("keeps a returned unknown observation provisional instead of settling it", async () => {
    const markUnknown = vi.fn(() => Promise.resolve());
    const settle = vi.fn(() => Promise.resolve());
    const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>((_url, init) => {
      const body = JSON.parse(Buffer.from(init.body as Uint8Array).toString()) as {
        request_id: string;
      };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            request_id: body.request_id,
            action: "observe",
            execution_id: "execution-1",
            outcome: "unknown",
            observed_digest: null,
          }),
          { status: 200 },
        ),
      );
    });
    const client = new RuntimeSkillMaintenanceClient(
      signer,
      { ...admitted, markUnknown, settle },
      fetchFn,
    );
    await client.observe({
      claim,
      binding: { mcpEndpoint: "http://runtime.test:8093/mcp", executionId: "execution-1" },
      requestId: "observe-provisional",
      effectRequestId: "commit-1",
      expectedTargetDigest: candidate.targetDigest,
      signal: new AbortController().signal,
    });
    expect(markUnknown).toHaveBeenCalledWith(claim, "observe-provisional");
    expect(settle).not.toHaveBeenCalled();
  });

  it("releases only a keyed hidden item with an exact expected digest", async () => {
    const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            request_id: "release-1",
            action: "release",
            execution_id: binding.executionId,
            outcome: "released",
            observed_digest: null,
          }),
          { status: 200 },
        ),
      ),
    );
    const client = new RuntimeSkillMaintenanceClient(signer, admitted, fetchFn);
    expect(
      await client.release({
        claim,
        binding,
        requestId: "release-1",
        storageClass: "candidate",
        storageKey: "a".repeat(64),
        packagePath: candidate.packagePath,
        expectedDigest: candidate.targetDigest,
        signal: request.signal,
      }),
    ).toMatchObject({ outcome: "released" });
    expect(
      JSON.parse(Buffer.from(fetchFn.mock.calls[0]![1].body as Uint8Array).toString()),
    ).toMatchObject({
      storage_class: "candidate",
      storage_key: "a".repeat(64),
      expected_digest: candidate.targetDigest,
    });
    await expect(
      client.release({
        claim,
        binding,
        requestId: "release-2",
        storageClass: "candidate",
        storageKey: `revert-${"a".repeat(64)}`,
        packagePath: candidate.packagePath,
        expectedDigest: candidate.targetDigest,
        signal: request.signal,
      }),
    ).rejects.toThrow("Invalid");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

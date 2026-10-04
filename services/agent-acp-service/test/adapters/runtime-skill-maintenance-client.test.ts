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
import type { RuntimeBinding } from "../../src/domain/types.js";

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
const binding = {
  revision: `rtv_${"a".repeat(32)}`,
  connectionId: `rci_${"b".repeat(32)}`,
  mcpEndpoint: "http://runtime.test:8093/mcp",
  executionId: "execution-1",
};
function connectionsFor(fetchFn: (url: string, init: RequestInit) => Promise<Response>) {
  return {
    fetchFor: vi.fn<(binding: RuntimeBinding) => typeof fetch>(
      () =>
        (url, init = {}) =>
          fetchFn(
            url instanceof Request ? url.url : typeof url === "string" ? url : url.href,
            init,
          ),
    ),
    retainOperation: vi.fn<(id: string, binding: RuntimeBinding) => void>(),
    releaseOperation: vi.fn<(id: string) => void>(),
  };
}
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
  it("checks the original connection before recording an intent and releases only after durable settlement", async () => {
    const order: string[] = [];
    const fetchFn = vi.fn(() => {
      order.push("fetch");
      return Promise.resolve(
        Response.json({
          request_id: "check-1",
          action: "check",
          execution_id: binding.executionId,
          outcome: "checked",
          observed_digest: candidate.targetDigest,
        }),
      );
    });
    const connections = connectionsFor(fetchFn);
    connections.retainOperation.mockImplementation(() => {
      order.push("retain");
    });
    connections.releaseOperation.mockImplementation(() => {
      order.push("release");
    });
    const reserve = vi.fn(() => {
      order.push("reserve");
      return Promise.resolve({ dispatch: true, state: "pending" as const });
    });
    const settle = vi.fn(() => {
      order.push("settle");
      return Promise.resolve();
    });
    const client = new RuntimeSkillMaintenanceClient(
      signer,
      { ...admitted, reserve, settle },
      connections,
    );
    await client.check({ ...request, requestId: "check-1" });
    expect(order).toEqual(["retain", "reserve", "fetch", "settle", "release"]);
    expect(connections.fetchFor).toHaveBeenCalledWith(binding);
    expect(connections.retainOperation).toHaveBeenCalledWith("check-1", binding);
    expect(connections.releaseOperation).toHaveBeenCalledWith("check-1");
    connections.retainOperation.mockImplementation(() => {
      throw new Error("Runtime connection is unavailable");
    });
    await expect(client.check({ ...request, requestId: "check-missing-key" })).rejects.toThrow(
      "unavailable",
    );
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, "runtime_unauthorized"],
    [403, "caller_not_allowed"],
    [403, "host_not_allowed"],
  ] as const)(
    "settles first-dispatch native admission denial %i/%s as a confirmed rejection",
    async (status, code) => {
      const reject = vi.fn(() => Promise.resolve()),
        markUnknown = vi.fn(() => Promise.resolve());
      const connections = connectionsFor(() =>
        Promise.resolve(
          Response.json(
            { code, message: "Runtime request rejected", retryable: false },
            {
              status,
              headers:
                status === 401 ? { "WWW-Authenticate": 'Bearer realm="antnest-service"' } : {},
            },
          ),
        ),
      );
      const client = new RuntimeSkillMaintenanceClient(
        signer,
        { ...admitted, reject, markUnknown },
        connections,
      );
      await expect(
        client.check({ ...request, requestId: "admission-denied" }),
      ).rejects.toMatchObject({ status, code });
      expect(reject).toHaveBeenCalledWith(claim, "admission-denied", { status, code });
      expect(markUnknown).not.toHaveBeenCalled();
      expect(connections.releaseOperation).toHaveBeenCalledWith("admission-denied");
    },
  );

  it("keeps the prior unknown effect and its credential when an observation retry is denied", async () => {
    const reject = vi.fn(() => Promise.resolve()),
      markUnknown = vi.fn(() => Promise.resolve());
    const connections = connectionsFor(() =>
      Promise.resolve(
        Response.json(
          { code: "runtime_unauthorized", message: "Runtime request rejected", retryable: false },
          { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="antnest-service"' } },
        ),
      ),
    );
    const client = new RuntimeSkillMaintenanceClient(
      signer,
      {
        ...admitted,
        reserve: () => Promise.resolve({ dispatch: true, state: "unknown" as const }),
        reject,
        markUnknown,
      },
      connections,
    );
    await expect(
      client.observe({
        claim,
        binding,
        requestId: "observe-retry",
        effectRequestId: "commit-1",
        expectedTargetDigest: candidate.targetDigest,
        signal: request.signal,
      }),
    ).rejects.toBeInstanceOf(RuntimeMaintenanceUnknownError);
    expect(reject).not.toHaveBeenCalled();
    expect(markUnknown).toHaveBeenCalledWith(claim, "observe-retry");
    expect(connections.releaseOperation).not.toHaveBeenCalled();
  });

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
      connectionsFor(fetchFn),
    );
    const committing = client.commit({
      ...request,
      requestId: "commit-in-flight",
      signal: controller.signal,
    });
    const rejected = expect(committing).rejects.toBeInstanceOf(RuntimeMaintenanceUnknownError);
    await entered.promise;
    controller.abort(new Error("Agent lifecycle closed"));
    await rejected;
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
    await new RuntimeSkillMaintenanceClient(
      signer,
      { ...admitted, reserve },
      connectionsFor(fetchFn),
    ).prepare(request);
    expect(order).toEqual(["reserve", "fetch"]);
    const body = Buffer.from(fetchFn.mock.calls[0]![1].body as Uint8Array);
    expect(reserve.mock.calls[0]![0]).toMatchObject({
      claim,
      requestId: "prepare-1",
      action: "prepare",
      executionId: binding.executionId,
      revision: binding.revision,
      connectionId: binding.connectionId,
      bodySha256: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      requestFacts: { candidate_id: request.candidateId, target_digest: candidate.targetDigest },
    });

    const replay = {
      reserve: vi.fn(() => Promise.resolve({ dispatch: false, state: "unknown" as const })),
    };
    await expect(
      new RuntimeSkillMaintenanceClient(
        signer,
        { ...admitted, ...replay },
        connectionsFor(fetchFn),
      ).prepare(request),
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
      connectionsFor(fetchFn),
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
    const client = new RuntimeSkillMaintenanceClient(signer, admitted, connectionsFor(fetchFn));
    expect(await client.prepare(request)).toMatchObject({
      outcome: "prepared",
      observed_digest: candidate.targetDigest,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("http://runtime.test:8093/internal/skill-maintenance/prepare");
    expect(init.method).toBe("POST");
    const body = Buffer.from(init.body as Uint8Array);
    const headers = new Headers(init.headers);
    expect(headers.get("X-Antnest-Expected-Execution-ID")).toBe("execution-1");
    expect(headers.get("Content-Type")).toContain("multipart/form-data; boundary=");
    const [head, payload, signature] = headers
      .get("Authorization")!
      .slice("AntnestMaintenance ".length)
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
      new RuntimeSkillMaintenanceClient(signer, admitted, connectionsFor(fetchFn)).prepare(request),
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
        new RuntimeSkillMaintenanceClient(signer, admitted, connectionsFor(fetchFn)).prepare(
          request,
        ),
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
    const client = new RuntimeSkillMaintenanceClient(signer, admitted, connectionsFor(fetchFn));
    expect(await client.check({ ...request, requestId: "check-1" })).toMatchObject({
      outcome: "checked",
    });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("http://runtime.test:8093/internal/skill-maintenance/check");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
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
    const result = await new RuntimeSkillMaintenanceClient(
      signer,
      admitted,
      connectionsFor(fetchFn),
    ).commit({
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
    const client = new RuntimeSkillMaintenanceClient(signer, admitted, connectionsFor(fetchFn));
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
      connectionsFor(fetchFn),
    );
    await client.observe({
      claim,
      binding,
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
    const client = new RuntimeSkillMaintenanceClient(signer, admitted, connectionsFor(fetchFn));
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

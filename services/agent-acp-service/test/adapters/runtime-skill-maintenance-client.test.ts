import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
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

const contract = JSON.parse(
  readFileSync(
    new URL("../../../../contracts/skill-learning/learning-api.schema.json", import.meta.url),
    "utf8",
  ),
) as { $schema: string; $defs: Record<string, object> };
const ajv = new Ajv2020({ strict: false, validateFormats: false });
const installRequestSchema = ajv.compile({
  $schema: contract.$schema,
  $defs: contract.$defs,
  $ref: "#/$defs/install_request",
});
const receiptContract = ajv.compile({
  $schema: contract.$schema,
  $defs: contract.$defs,
  $ref: "#/$defs/maintenance_receipt",
});

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
const otherDigest = `sha256:${"c".repeat(64)}`;
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
  requestId: "install-1",
  package: candidate,
  expectedBaseDigest: null,
  signal: new AbortController().signal,
};
function receipt(fields: Record<string, unknown>, requestId = "install-1") {
  return {
    request_id: requestId,
    action: "install",
    execution_id: binding.executionId,
    ...fields,
  };
}
const applied = receipt({ outcome: "applied", observed_digest: candidate.targetDigest });
function replying(body: unknown) {
  return vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(Response.json(body)),
  );
}
function metadataOf(body: Buffer): unknown {
  const text = body.toString("latin1");
  const start = text.indexOf('name="metadata"\r\n\r\n') + 'name="metadata"\r\n\r\n'.length;
  const end = text.indexOf("\r\n--", start);
  return JSON.parse(body.subarray(start, end).toString("utf8"));
}

describe("Runtime Skill maintenance client", () => {
  it("offers only the atomic install; the held transaction actions are gone", () => {
    const client = new RuntimeSkillMaintenanceClient(
      signer,
      admitted,
      connectionsFor(replying({})),
    );
    for (const removed of ["prepare", "check", "commit", "observe", "cancel", "release"])
      expect(removed in client, removed).toBe(false);
    expect(typeof client.install).toBe("function");
  });

  it("checks the original connection before recording an intent and releases only after durable settlement", async () => {
    const order: string[] = [];
    const fetchFn = vi.fn(() => {
      order.push("fetch");
      return Promise.resolve(Response.json(applied));
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
    expect(await client.install(request)).toEqual(applied);
    expect(order).toEqual(["retain", "reserve", "fetch", "settle", "release"]);
    expect(connections.fetchFor).toHaveBeenCalledWith(binding);
    expect(connections.retainOperation).toHaveBeenCalledWith("install-1", binding);
    expect(connections.releaseOperation).toHaveBeenCalledWith("install-1");
    expect(settle).toHaveBeenCalledWith(claim, "install-1", applied);
    connections.retainOperation.mockImplementation(() => {
      throw new Error("Runtime connection is unavailable");
    });
    await expect(client.install({ ...request, requestId: "install-missing-key" })).rejects.toThrow(
      "unavailable",
    );
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("signs the exact multipart body whose metadata is exactly the contract install request", async () => {
    const fetchFn = replying(applied);
    const reserve = vi.fn<(input: unknown) => Promise<{ dispatch: boolean; state: "pending" }>>(
      () => Promise.resolve({ dispatch: true, state: "pending" as const }),
    );
    await new RuntimeSkillMaintenanceClient(
      signer,
      { ...admitted, reserve },
      connectionsFor(fetchFn),
    ).install({ ...request, expectedBaseDigest: otherDigest });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("http://runtime.test:8093/internal/skill-maintenance/install");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    const body = Buffer.from(init.body as Uint8Array);
    const headers = new Headers(init.headers);
    expect(headers.get("X-Antnest-Expected-Execution-ID")).toBe("execution-1");
    const boundary = /^multipart\/form-data; boundary=(.+)$/u.exec(
      headers.get("Content-Type")!,
    )?.[1];
    expect(boundary).toBeDefined();
    expect(body.subarray(0, boundary!.length + 2).toString()).toBe(`--${boundary}`);
    expect(body.toString("latin1").endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
    expect(body.includes(candidate.artifact)).toBe(true);
    const metadata = metadataOf(body);
    expect(metadata).toEqual({
      action: "install",
      request_id: "install-1",
      job_id: claim.taskId,
      generation: claim.generation,
      package_path: candidate.packagePath,
      expected_base_digest: otherDigest,
      target_digest: candidate.targetDigest,
      artifact_digest: candidate.artifactDigest,
      package_rules_version: 1,
    });
    expect(installRequestSchema(metadata), JSON.stringify(installRequestSchema.errors)).toBe(true);
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
    const bodySha256 = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({
      action: "install",
      request_id: "install-1",
      job_id: claim.taskId,
      generation: claim.generation,
      execution_id: binding.executionId,
      body_sha256: bodySha256,
    });
    expect(reserve.mock.calls[0]![0]).toEqual({
      claim,
      requestId: "install-1",
      action: "install",
      executionId: binding.executionId,
      mcpEndpoint: binding.mcpEndpoint,
      revision: binding.revision,
      connectionId: binding.connectionId,
      bodySha256,
      requestFacts: { ...(metadata as object), candidate_id: request.candidateId },
    });
  });

  it("never redispatches a request the durable ledger already holds", async () => {
    const fetchFn = replying(applied);
    const reserve = vi.fn(() => Promise.resolve({ dispatch: false, state: "unknown" as const }));
    await expect(
      new RuntimeSkillMaintenanceClient(
        signer,
        { ...admitted, reserve },
        connectionsFor(fetchFn),
      ).install(request),
    ).rejects.toBeInstanceOf(RuntimeMaintenancePreviouslyDispatchedError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ["applied", applied],
    [
      "conflict without a target",
      receipt({ outcome: "conflict", observed_digest: null, conflict_reason: "base_changed" }),
    ],
    [
      "conflict on an occupied path",
      receipt({
        outcome: "conflict",
        observed_digest: otherDigest,
        conflict_reason: "target_exists",
      }),
    ],
    [
      "conflict during activation",
      receipt({
        outcome: "conflict",
        observed_digest: otherDigest,
        conflict_reason: "content_changed_during_activation",
      }),
    ],
    [
      "foreground block",
      receipt({ outcome: "blocked", observed_digest: null, blocked_reason: "foreground_running" }),
    ],
    [
      "background writer block",
      receipt({
        outcome: "blocked",
        observed_digest: null,
        blocked_reason: "background_task_running",
        blocked_subject_id: "bash:123",
      }),
    ],
    [
      "managed call block",
      receipt({
        outcome: "blocked",
        observed_digest: null,
        blocked_reason: "managed_call_in_flight",
        blocked_subject_id: "managed:tool-1",
      }),
    ],
    [
      "unknown writer block",
      receipt({ outcome: "blocked", observed_digest: null, blocked_reason: "writers_unknown" }),
    ],
    ["preemption", receipt({ outcome: "preempted", observed_digest: null })],
  ])("settles a contract %s receipt exactly as returned", async (_name, body) => {
    expect(receiptContract(body), JSON.stringify(receiptContract.errors)).toBe(true);
    const settle = vi.fn(() => Promise.resolve());
    const markUnknown = vi.fn(() => Promise.resolve());
    const result = await new RuntimeSkillMaintenanceClient(
      signer,
      { ...admitted, settle, markUnknown },
      connectionsFor(replying(body)),
    ).install(request);
    expect(result).toEqual(body);
    expect(settle).toHaveBeenCalledWith(claim, "install-1", body);
    expect(markUnknown).not.toHaveBeenCalled();
  });

  it.each([
    ["another request", { ...applied, request_id: "install-2" }],
    ["another execution", { ...applied, execution_id: "execution-2" }],
    ["a digest receipt", { ...applied, action: "digest", outcome: "observed" }],
    ["a different applied digest", receipt({ outcome: "applied", observed_digest: otherDigest })],
    [
      "a blocked digest",
      receipt({
        outcome: "blocked",
        observed_digest: otherDigest,
        blocked_reason: "writers_unknown",
      }),
    ],
    [
      "a blocked writer without subject",
      receipt({
        outcome: "blocked",
        observed_digest: null,
        blocked_reason: "background_task_running",
      }),
    ],
    [
      "a retired block reason",
      receipt({ outcome: "blocked", observed_digest: null, blocked_reason: "policy_changed" }),
    ],
    ["a conflict without reason", receipt({ outcome: "conflict", observed_digest: null })],
    [
      "a preemption with digest",
      receipt({ outcome: "preempted", observed_digest: candidate.targetDigest }),
    ],
    ["a retired outcome", receipt({ outcome: "unknown", observed_digest: null })],
    ["an unknown field", { ...applied, storage_key: "a".repeat(64) }],
  ])("treats %s as an unknown outcome", async (_name, body) => {
    const settle = vi.fn(() => Promise.resolve());
    const markUnknown = vi.fn(() => Promise.resolve());
    const fetchFn = replying(body);
    const connections = connectionsFor(fetchFn);
    await expect(
      new RuntimeSkillMaintenanceClient(
        signer,
        { ...admitted, settle, markUnknown },
        connections,
      ).install(request),
    ).rejects.toBeInstanceOf(RuntimeMaintenanceUnknownError);
    expect(markUnknown).toHaveBeenCalledWith(claim, "install-1");
    expect(settle).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // A resend is a new attempt on the current binding; nothing replays this one.
    expect(connections.releaseOperation).toHaveBeenCalledWith("install-1");
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
        client.install({ ...request, requestId: "admission-denied" }),
      ).rejects.toMatchObject({ status, code });
      expect(reject).toHaveBeenCalledWith(claim, "admission-denied", { status, code });
      expect(markUnknown).not.toHaveBeenCalled();
      expect(connections.releaseOperation).toHaveBeenCalledWith("admission-denied");
    },
  );

  it("durably settles a deterministic Runtime rejection", async () => {
    const reject = vi.fn(() => Promise.resolve());
    const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        Response.json(
          {
            error: {
              code: "atomic_skill_replace_unsupported",
              message: "Skill install requires an atomic directory rename",
              retryable: false,
            },
          },
          { status: 409 },
        ),
      ),
    );
    await expect(
      new RuntimeSkillMaintenanceClient(
        signer,
        { ...admitted, reject },
        connectionsFor(fetchFn),
      ).install(request),
    ).rejects.toBeInstanceOf(RuntimeMaintenanceRejectedError);
    expect(reject).toHaveBeenCalledWith(claim, "install-1", {
      status: 409,
      code: "atomic_skill_replace_unsupported",
    });
  });

  it("marks an in-flight install unknown when foreground admission aborts its HTTP request", async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const markUnknown = vi.fn(() => Promise.resolve());
    const settle = vi.fn(() => Promise.resolve());
    const fetchFn = vi.fn((_url: string, init: RequestInit): Promise<Response> => {
      entered.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("HTTP request aborted")), {
          once: true,
        });
      });
    });
    const connections = connectionsFor(fetchFn);
    const installing = new RuntimeSkillMaintenanceClient(
      signer,
      { ...admitted, markUnknown, settle },
      connections,
    ).install({ ...request, requestId: "install-in-flight", signal: controller.signal });
    const rejected = expect(installing).rejects.toBeInstanceOf(RuntimeMaintenanceUnknownError);
    await entered.promise;
    controller.abort(new Error("Foreground Run admitted"));
    await rejected;
    expect(markUnknown).toHaveBeenCalledWith(claim, "install-in-flight");
    expect(settle).not.toHaveBeenCalled();
    expect(connections.releaseOperation).toHaveBeenCalledWith("install-in-flight");
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
      const connections = connectionsFor(fetchFn);
      await expect(
        new RuntimeSkillMaintenanceClient(signer, admitted, connections).install(request),
      ).rejects.toBeInstanceOf(RuntimeMaintenanceUnknownError);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(connections.releaseOperation).toHaveBeenCalledWith("install-1");
    }
  });

  it.each([
    ["a path candidate identity", { candidateId: "candidate/1" }],
    ["a mutated artifact", { package: { ...candidate, artifact: Buffer.from("changed") } }],
    [
      "a path outside managed Skills",
      { package: { ...candidate, packagePath: "skills/inspect-first" } },
    ],
    ["a malformed base", { expectedBaseDigest: "sha256:abc" }],
  ])("rejects %s before any intent or HTTP", async (_name, change) => {
    const reserve = vi.fn(() => Promise.resolve({ dispatch: true, state: "pending" as const }));
    const fetchFn = replying(applied);
    await expect(
      new RuntimeSkillMaintenanceClient(
        signer,
        { ...admitted, reserve },
        connectionsFor(fetchFn),
      ).install({ ...request, ...change }),
    ).rejects.toThrow("Invalid");
    expect(reserve).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

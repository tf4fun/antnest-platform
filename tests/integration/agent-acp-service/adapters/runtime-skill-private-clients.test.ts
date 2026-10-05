import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { RuntimeSkillMaintenanceClient } from "../../../../services/agent-acp-service/src/adapters/runtime-skill-maintenance-client.js";
import { RuntimeSkillMaintenanceSigner } from "../../../../services/agent-acp-service/src/adapters/runtime-skill-maintenance-signer.js";
import { RuntimeSkillSourceVerifier } from "../../../../services/agent-acp-service/src/adapters/skill-source-http.js";
import {
  buildLearningCandidatePackage,
  learningSkillTextPackage,
} from "../../../../services/agent-acp-service/src/domain/learning-candidate-package.js";
import { RuntimeMaintenanceUnknownError } from "../../../../services/agent-acp-service/src/domain/learning-maintenance-errors.js";
import type { LearningTaskClaim } from "../../../../services/agent-acp-service/src/domain/learning-scan.js";
import type { SkillSourceRecord } from "../../../../services/agent-acp-service/src/domain/skill-source.js";
import { runtimeAuthority } from "../support/runtime-authority.js";

const organizationId = `org_${"a".repeat(32)}`;
const agentId = `agent_${"b".repeat(32)}`;
const claim: LearningTaskClaim = {
  organizationId,
  agentId,
  ownerId: `user_${"c".repeat(32)}`,
  taskId: "job-1",
  claimId: "claim-1",
  generation: 1,
  sourceRunId: "run-1",
  frozenPolicy: {},
};
const evidenceId = `evidence_${"d".repeat(32)}`;
const candidate = buildLearningCandidatePackage(
  {
    decision: "propose",
    name: "inspect-first",
    description: "Inspect first.",
    instructions: "unused",
    rules: [{ text: "Inspect first", evidenceIds: [evidenceId] }],
  },
  {
    sourceRunId: claim.sourceRunId,
    truncated: false,
    items: [
      {
        evidenceId,
        sourceId: "user-1",
        kind: "authenticated_user",
        scope: "user_prompt",
        text: "Inspect first",
      },
    ],
  },
);
const source: SkillSourceRecord = {
  projection: {
    organization_id: organizationId,
    agent_id: agentId,
    owner_id: claim.ownerId,
    name: "inspect-first",
    description: "Inspect first.",
    sequence: 1,
    content_digest: candidate.targetDigest,
    active: true,
  },
  packagePath: candidate.packagePath,
  candidateId: "candidate-1",
  taskId: claim.taskId,
  generation: claim.generation,
  effectRequestId: "commit-1",
  package: learningSkillTextPackage(candidate.skillText),
};
type Ticket = {
  action: string;
  request_id: string;
  body_sha256: string;
  organization_id: string;
  agent_id: string;
  execution_id: string;
};
type Authority = ReturnType<typeof runtimeAuthority>;

async function withPeer(
  work: (peer: {
    authority: Authority;
    signer: RuntimeSkillMaintenanceSigner;
    paths: string[];
  }) => Promise<void>,
  hold?: (ticket: Ticket, response: ServerResponse) => boolean,
) {
  const keys = generateKeyPairSync("ed25519");
  const signer = new RuntimeSkillMaintenanceSigner(
    "private-client-test",
    keys.privateKey,
  );
  let authority: Authority | undefined;
  let peerFailure: unknown;
  const paths: string[] = [];
  const server = createServer((request, response) => {
    if (!authority || !authority.admit(request, response)) return;
    const current = authority;
    void (async () => {
      expect(request.method).toBe("POST");
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers["antnest-caller-context"]).toBeUndefined();
      const [header, payload, signature] = request.headers
        .authorization!.slice("AntnestMaintenance ".length)
        .split(".") as [string, string, string];
      expect(
        verify(
          null,
          Buffer.from(`antnest-skill-maintenance-v1\n${header}.${payload}`),
          keys.publicKey,
          Buffer.from(signature, "base64url"),
        ),
      ).toBe(true);
      const ticket = JSON.parse(
        Buffer.from(payload, "base64url").toString(),
      ) as Ticket;
      const chunks: Buffer[] = [];
      for await (const chunk of request as AsyncIterable<Buffer>)
        chunks.push(chunk);
      const body = Buffer.concat(chunks);
      expect(ticket.body_sha256).toBe(
        `sha256:${createHash("sha256").update(body).digest("hex")}`,
      );
      expect(ticket).toMatchObject({
        organization_id: organizationId,
        agent_id: agentId,
        execution_id: current.binding.executionId,
      });
      expect(request.url).toBe(`/internal/skill-maintenance/${ticket.action}`);
      paths.push(request.url!);
      if (hold?.(ticket, response)) return;
      const outcomes: Record<string, string> = {
        prepare: "prepared",
        check: "checked",
        commit: "applied",
        observe: "applied",
        cancel: "cancelled",
        release: "released",
      };
      response
        .writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        })
        .end(
          JSON.stringify({
            request_id: ticket.request_id,
            action: ticket.action,
            execution_id: current.binding.executionId,
            outcome: outcomes[ticket.action],
            observed_digest: ["cancel", "release"].includes(ticket.action)
              ? null
              : candidate.targetDigest,
            ...(ticket.action === "prepare"
              ? { storage_key: "e".repeat(64) }
              : {}),
          }),
        );
    })().catch((error: unknown) => {
      peerFailure = error;
      response.writeHead(500, { "Content-Type": "application/json" }).end("{}");
    });
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing peer port");
    authority = runtimeAuthority(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
      "execution-1",
      { organizationId, agentId },
    );
    await work({ authority, signer, paths });
    if (peerFailure)
      throw peerFailure instanceof Error
        ? peerFailure
        : new Error("Runtime skill peer failed", { cause: peerFailure });
  } finally {
    await authority?.connections.close();
    if (authority)
      expect(existsSync(authority.connections.directory)).toBe(false);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function intents() {
  return {
    reserve: vi.fn(() =>
      Promise.resolve({ dispatch: true, state: "pending" as const }),
    ),
    settle: vi.fn(() => Promise.resolve()),
    reject: vi.fn(() => Promise.resolve()),
    markUnknown: vi.fn(() => Promise.resolve()),
  };
}
function closeAdmission(authority: Authority) {
  const closed = structuredClone(authority.configuration);
  closed.revision++;
  closed.agents[0]!.accepting_runs = false;
  delete closed.agents[0]!.runtime!.credential;
  authority.connections.prepare(closed).commit();
}

it("authenticates every maintenance action and source observation with an independent exact-byte ticket", async () => {
  await withPeer(async ({ authority, signer, paths }) => {
    const ledger = intents();
    const client = new RuntimeSkillMaintenanceClient(
      signer,
      ledger,
      authority.connections,
    );
    const base = {
      claim,
      binding: authority.binding,
      candidateId: source.candidateId,
      package: candidate,
      expectedBaseDigest: null,
      signal: new AbortController().signal,
    };
    await client.prepare({ ...base, requestId: "prepare-1" });
    await client.check({ ...base, requestId: "check-1" });
    await client.commit({ ...base, requestId: "commit-1" });
    await client.observe({
      ...base,
      requestId: "observe-1",
      effectRequestId: "commit-1",
      expectedTargetDigest: candidate.targetDigest,
    });
    await client.cancel({ ...base, requestId: "cancel-1" });
    await client.release({
      ...base,
      requestId: "release-1",
      storageClass: "candidate",
      storageKey: "e".repeat(64),
      packagePath: candidate.packagePath,
      expectedDigest: candidate.targetDigest,
    });
    expect(
      await new RuntimeSkillSourceVerifier(
        signer,
        authority.connections,
      ).verify(source, authority.binding, base.signal),
    ).toBe("current");
    expect(paths).toEqual(
      [
        "prepare",
        "check",
        "commit",
        "observe",
        "cancel",
        "release",
        "observe",
      ].map((action) => `/internal/skill-maintenance/${action}`),
    );
    expect(ledger.settle).toHaveBeenCalledTimes(6);
    expect(ledger.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: authority.binding.revision,
        connectionId: authority.binding.connectionId,
        executionId: authority.binding.executionId,
        mcpEndpoint: authority.binding.mcpEndpoint,
      }),
    );
  });
});

it("retains an in-flight source read through closure and rejects later reads before HTTP", async () => {
  const entered = Promise.withResolvers<ServerResponse>();
  await withPeer(
    async ({ authority, signer, paths }) => {
      const verifier = new RuntimeSkillSourceVerifier(
        signer,
        authority.connections,
      );
      const reading = verifier.verify(
        source,
        authority.binding,
        new AbortController().signal,
      );
      const response = await entered.promise;
      closeAdmission(authority);
      const file = join(
        authority.connections.directory,
        authority.binding.connectionId,
        "antnest-runtime",
      );
      expect(existsSync(file)).toBe(true);
      await expect(
        verifier.verify(
          source,
          authority.binding,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "runtime_connection_unavailable" });
      expect(paths).toHaveLength(1);
      response.end("}");
      expect(await reading).toBe("current");
      expect(existsSync(file)).toBe(false);
    },
    (ticket, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write(
        JSON.stringify({
          request_id: ticket.request_id,
          action: "observe",
          execution_id: "execution-1",
          outcome: "applied",
          observed_digest: candidate.targetDigest,
        }).slice(0, -1),
      );
      entered.resolve(response);
      return true;
    },
  );
});

it("preserves an unknown commit's original authority through closure and allows only cleanup observation", async () => {
  const entered = Promise.withResolvers<void>();
  await withPeer(
    async ({ authority, signer, paths }) => {
      const ledger = intents();
      const client = new RuntimeSkillMaintenanceClient(
        signer,
        ledger,
        authority.connections,
      );
      const controller = new AbortController();
      const base = {
        claim,
        binding: authority.binding,
        candidateId: source.candidateId,
        package: candidate,
        expectedBaseDigest: null,
      };
      const commit = client.commit({
        ...base,
        requestId: "commit-1",
        signal: controller.signal,
      });
      const rejected = expect(commit).rejects.toBeInstanceOf(
        RuntimeMaintenanceUnknownError,
      );
      await entered.promise;
      closeAdmission(authority);
      controller.abort();
      await rejected;
      const file = join(
        authority.connections.directory,
        authority.binding.connectionId,
        "antnest-runtime",
      );
      expect(existsSync(file)).toBe(true);
      expect(ledger.markUnknown).toHaveBeenCalledWith(claim, "commit-1");
      await expect(
        client.check({
          ...base,
          requestId: "late-check",
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "runtime_connection_unavailable" });
      await client.observe({
        claim,
        binding: authority.binding,
        requestId: "cleanup-observe",
        effectRequestId: "commit-1",
        expectedTargetDigest: candidate.targetDigest,
        signal: new AbortController().signal,
      });
      expect(paths).toEqual([
        "/internal/skill-maintenance/commit",
        "/internal/skill-maintenance/observe",
      ]);
      // An observation receipt does not itself settle the original durable commit intent.
      expect(existsSync(file)).toBe(true);
    },
    (ticket, response) => {
      if (ticket.action !== "commit") return false;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.flushHeaders();
      entered.resolve();
      return true;
    },
  );
});

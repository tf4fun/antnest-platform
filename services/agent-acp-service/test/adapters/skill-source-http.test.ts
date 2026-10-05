import { generateKeyPairSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  RegistrySkillProjectionClient,
  RuntimeSkillSourceVerifier,
} from "../../src/adapters/skill-source-http.js";
import { RuntimeSkillMaintenanceSigner } from "../../src/adapters/runtime-skill-maintenance-signer.js";
import { learningSkillTextPackage } from "../../src/domain/learning-candidate-package.js";
import type { RuntimeBinding } from "../../src/domain/types.js";

const projection = {
  organization_id: `org_${"a".repeat(32)}`,
  agent_id: `agent_${"b".repeat(32)}`,
  owner_id: `user_${"c".repeat(32)}`,
  name: "inspect-first",
  description: "Inspect first.",
  sequence: 3,
  content_digest: `sha256:${"d".repeat(64)}`,
  active: true,
};

it("sends only metadata to the fixed Registry route, bounds acknowledgements and propagates cancellation", async () => {
  const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(Response.json({ outcome: "applied", sequence: 3 })),
  );
  const client = new RegistrySkillProjectionClient("http://registry/", fetchFn);
  await client.send(projection, new AbortController().signal);
  expect(fetchFn.mock.calls[0]?.[0]).toBe("http://registry/internal/skill-projections");
  const init = fetchFn.mock.calls[0]?.[1];
  expect(init?.redirect).toBe("error");
  expect(init?.method).toBe("PUT");
  expect(typeof init?.body).toBe("string");
  expect(JSON.parse(init?.body as string)).toEqual(projection);
  fetchFn.mockResolvedValue(Response.json({ outcome: "replayed", sequence: 2 }));
  await expect(client.send(projection, new AbortController().signal)).rejects.toThrow(
    "acknowledged",
  );
  fetchFn.mockResolvedValue(new Response("x".repeat(4097)));
  await expect(client.send(projection, new AbortController().signal)).rejects.toThrow("bound");
});

it("observes the current complete package with an execution-bound read-only ticket, never prepare/commit", async () => {
  const signer = new RuntimeSkillMaintenanceSigner(
    "source-test",
    generateKeyPairSync("ed25519").privateKey,
  );
  const pkg = learningSkillTextPackage(
    '---\nname: "inspect-first"\ndescription: "Inspect first."\n---\nInspect first.\n',
  );
  const record = {
    projection: { ...projection, content_digest: pkg.targetDigest },
    packagePath: ".antnest/skills/inspect-first",
    candidateId: "candidate-1",
    taskId: "task-1",
    generation: 2,
    effectRequestId: "commit-1",
    package: pkg,
  };
  let outcome = "applied";
  const fetchFn = vi.fn((_url: string, init: RequestInit) => {
    const request = JSON.parse(Buffer.from(init.body as Uint8Array).toString()) as {
      request_id: string;
    };
    return Promise.resolve(
      Response.json({
        request_id: request.request_id,
        action: "observe",
        execution_id: "current-execution",
        outcome,
        observed_digest: outcome === "applied" ? pkg.targetDigest : null,
      }),
    );
  });
  const connections = {
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
  const verifier = new RuntimeSkillSourceVerifier(signer, connections);
  const binding = {
    revision: `rtv_${"a".repeat(32)}`,
    executionId: "current-execution",
    mcpEndpoint: "http://runtime:8080/mcp",
    connectionId: `rci_${"b".repeat(32)}`,
  };
  expect(await verifier.verify(record, binding, new AbortController().signal)).toBe("current");
  expect(connections.fetchFor).toHaveBeenCalledWith(binding);
  expect(connections.retainOperation).toHaveBeenCalledWith(expect.any(String), binding);
  expect(connections.releaseOperation).toHaveBeenCalledWith(
    connections.retainOperation.mock.calls[0]![0],
  );
  expect(fetchFn.mock.calls[0]?.[0]).toBe("http://runtime:8080/internal/skill-maintenance/observe");
  const init = fetchFn.mock.calls[0]![1];
  const request: unknown = JSON.parse(Buffer.from(init.body as Uint8Array).toString());
  expect(request).toMatchObject({
    action: "observe",
    job_id: "task-1",
    generation: 2,
    effect_request_id: "commit-1",
    expected_target_digest: pkg.targetDigest,
  });
  const headers = new Headers(init.headers);
  expect(headers.get("X-Antnest-Expected-Execution-ID")).toBe("current-execution");
  expect(headers.get("Authorization")).toMatch(/^AntnestMaintenance /u);
  outcome = "conflict";
  expect(await verifier.verify(record, binding, new AbortController().signal)).toBe("changed");
  outcome = "unknown";
  expect(await verifier.verify(record, binding, new AbortController().signal)).toBe("unknown");
  fetchFn.mockImplementation(() => Promise.resolve(new Response("busy", { status: 503 })));
  await expect(verifier.verify(record, binding, new AbortController().signal)).rejects.toThrow();
});

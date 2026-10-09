import { createHash, generateKeyPairSync } from "node:crypto";
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

it("reads the active digest with an execution-bound read-only ticket, never install", async () => {
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
    effectRequestId: "install-1",
    package: pkg,
  };
  let receipt: (requestId: string) => unknown = (requestId) => ({
    request_id: requestId,
    action: "digest",
    execution_id: "current-execution",
    outcome: "observed",
    observed_digest: pkg.targetDigest,
  });
  const fetchFn = vi.fn((_url: string, init: RequestInit) => {
    const request = JSON.parse(Buffer.from(init.body as Uint8Array).toString()) as {
      request_id: string;
    };
    return Promise.resolve(Response.json(receipt(request.request_id)));
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
  const verify = () => verifier.verify(record, binding, new AbortController().signal);
  expect(await verify()).toBe("current");
  expect(connections.fetchFor).toHaveBeenCalledWith(binding);
  expect(connections.retainOperation).toHaveBeenCalledWith(expect.any(String), binding);
  expect(connections.releaseOperation).toHaveBeenCalledWith(
    connections.retainOperation.mock.calls[0]![0],
  );
  expect(fetchFn.mock.calls[0]?.[0]).toBe("http://runtime:8080/internal/skill-maintenance/digest");
  const init = fetchFn.mock.calls[0]![1];
  const body = Buffer.from(init.body as Uint8Array);
  const request = JSON.parse(body.toString()) as { request_id: string };
  expect(request).toEqual({
    action: "digest",
    request_id: connections.retainOperation.mock.calls[0]![0],
    job_id: "task-1",
    generation: 2,
    package_path: ".antnest/skills/inspect-first",
  });
  const headers = new Headers(init.headers);
  expect(headers.get("Content-Type")).toBe("application/json");
  expect(headers.get("X-Antnest-Expected-Execution-ID")).toBe("current-execution");
  const [, payload] = headers
    .get("Authorization")!
    .replace(/^AntnestMaintenance /u, "")
    .split(".") as [string, string, string];
  expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({
    execution_id: "current-execution",
    job_id: "task-1",
    generation: 2,
    action: "digest",
    request_id: request.request_id,
    body_sha256: `sha256:${createHash("sha256").update(body).digest("hex")}`,
  });

  const observed = (digest: string | null) => (requestId: string) => ({
    request_id: requestId,
    action: "digest",
    execution_id: "current-execution",
    outcome: "observed",
    observed_digest: digest,
  });
  receipt = observed(`sha256:${"e".repeat(64)}`);
  expect(await verify()).toBe("changed");
  receipt = observed(null);
  expect(await verify()).toBe("changed");
  // Foreground work owns the Runtime; the read did not settle.
  receipt = (requestId) => ({
    ...observed(null)(requestId),
    outcome: "blocked",
    blocked_reason: "foreground_running",
  });
  expect(await verify()).toBe("unknown");
  receipt = (requestId) => ({ ...observed(null)(requestId), outcome: "preempted" });
  expect(await verify()).toBe("unknown");
  for (const invalid of [
    (requestId: string) => ({ ...observed(pkg.targetDigest)(requestId), request_id: "other" }),
    (requestId: string) => ({ ...observed(pkg.targetDigest)(requestId), execution_id: "old" }),
    (requestId: string) => ({ ...observed(pkg.targetDigest)(requestId), action: "install" }),
    (requestId: string) => ({ ...observed(pkg.targetDigest)(requestId), outcome: "applied" }),
    (requestId: string) => ({
      ...observed(pkg.targetDigest)(requestId),
      conflict_reason: "base_changed",
    }),
    (requestId: string) => ({
      ...observed(pkg.targetDigest)(requestId),
      outcome: "blocked",
      blocked_reason: "managed_call_in_flight",
    }),
  ]) {
    receipt = invalid;
    expect(await verify()).toBe("unknown");
  }
  fetchFn.mockImplementation(() => Promise.resolve(new Response("busy", { status: 503 })));
  await expect(verify()).rejects.toThrow();
});

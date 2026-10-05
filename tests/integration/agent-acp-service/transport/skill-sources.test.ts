import {
  testAuthentication,
  workloadHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import { afterEach, expect, it, vi } from "vitest";
import { AgentAcpHttpServer } from "../../../../services/agent-acp-service/src/transport/http-server.js";
import { SkillSourceError } from "../../../../services/agent-acp-service/src/domain/skill-source.js";
import { learningSkillTextPackage } from "../../../../services/agent-acp-service/src/domain/learning-candidate-package.js";
import type { AcpApplicationPort } from "../../../../services/agent-acp-service/src/ports/acp-application.js";

let server: AgentAcpHttpServer | undefined;
afterEach(async () => {
  await server?.close();
});
const token = "source-reader-token-with-more-than-32-bytes";
const org = `org_${"a".repeat(32)}`,
  agent = `agent_${"b".repeat(32)}`,
  owner = `user_${"c".repeat(32)}`;
const pkg = learningSkillTextPackage(
  '---\nname: "inspect-first"\ndescription: "Inspect first."\n---\nInspect first.\n',
);
const projection = {
  organization_id: org,
  agent_id: agent,
  owner_id: owner,
  name: pkg.name,
  description: pkg.description,
  sequence: 3,
  content_digest: pkg.targetDigest,
  active: true,
};
const record = {
  projection,
  packagePath: ".antnest/skills/inspect-first",
  candidateId: "candidate-1",
  taskId: "task-1",
  generation: 1,
  effectRequestId: "commit-1",
  package: pkg,
};

it("enforces the source-only bearer, exact contract, body bounds and sanitized failures over real HTTP", async () => {
  const inspect = vi.fn(() => Promise.resolve({ items: [projection] }));
  const artifact = vi.fn(() => Promise.resolve(record));
  server = new AgentAcpHttpServer({
    authentication: testAuthentication(),
    skillSources: { service: { inspect, artifact } },
    ready: () => Promise.resolve(true),
    application: {} as AcpApplicationPort,
    maxWebSocketPayloadBytes: 1024,
  });
  await server.listen("127.0.0.1", 0);
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No server address");
  const url = `http://127.0.0.1:${address.port}`;
  const call = (path: string, body: unknown, credential = token) =>
    fetch(url + path, {
      method: "POST",
      headers: {
        ...(credential === token ? workloadHeaders("skill-registry") : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
  const input = {
    organization_id: org,
    actor_id: owner,
    sources: [{ agent_id: agent, name: pkg.name }],
  };
  const route = "/internal/skill-sources/inspect";
  expect((await call(route, input, "registry-management-token")).status).toBe(
    401,
  );
  expect((await call(route, { ...input, artifact: "body" })).status).toBe(400);
  expect(
    (
      await call(route, {
        ...input,
        sources: [...input.sources, ...input.sources],
      })
    ).status,
  ).toBe(400);
  expect((await call(route + "?actor_id=x", input)).status).toBe(403);
  expect((await call(route, { ...input, pad: "x".repeat(8192) })).status).toBe(
    413,
  );
  expect(await (await call(route, input)).json()).toEqual({
    items: [projection],
  });
  expect(inspect).toHaveBeenCalledTimes(1);
  const artifactInput = {
    organization_id: org,
    actor_id: owner,
    skill_ref: { kind: "agent", agent_id: agent, name: pkg.name, sequence: 3 },
    expected_digest: pkg.targetDigest,
  };
  const response = await call(
    "/internal/skill-sources/artifact",
    artifactInput,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/zip");
  expect(response.headers.get("content-length")).toBe(
    String(pkg.artifact.length),
  );
  expect(response.headers.get("x-antnest-content-digest")).toBe(
    pkg.targetDigest,
  );
  expect(response.headers.get("x-antnest-artifact-digest")).toBe(
    pkg.artifactDigest,
  );
  expect(response.headers.get("etag")).toBe(`"${pkg.artifactDigest}"`);
  expect(response.headers.get("x-antnest-source-sequence")).toBe("3");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(pkg.artifact);
  for (const [code, status] of [
    ["not_found", 404],
    ["content_changed", 409],
    ["source_unavailable", 503],
  ] as const) {
    artifact.mockRejectedValue(new SkillSourceError(code));
    expect(
      (await call("/internal/skill-sources/artifact", artifactInput)).status,
    ).toBe(status);
  }
  artifact.mockRejectedValue(
    new Error("postgres://secret@internal/source-body"),
  );
  const failure = await call("/internal/skill-sources/artifact", artifactInput);
  expect(await failure.text()).not.toMatch(/postgres|secret|source-body/u);
  const ordinary = await call(
    "/rpc/agent-acp/workspace/agents/agent/view",
    {},
    token,
  );
  expect(ordinary.status).not.toBe(200);
});

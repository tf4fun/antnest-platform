import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { RegistrySkillDiscoveryClient } from "../../../../services/agent-acp-service/src/adapters/skill-discovery-http.js";
import { learningSkillTextPackage } from "../../../../services/agent-acp-service/src/domain/learning-candidate-package.js";

it("reads exact Skill identity over real HTTP and cancels unfinished body I/O", async () => {
  const pkg = learningSkillTextPackage(
    '---\nname: "http-procedure"\ndescription: "A procedure"\n---\nInspect the file.\n',
  );
  const scope = {
    organization_id: `org_${"1".repeat(32)}`,
    actor_id: `user_${"2".repeat(32)}`,
  };
  const ref = {
    kind: "agent" as const,
    agent_id: `agent_${"3".repeat(32)}`,
    name: "http-procedure",
    sequence: 1,
  };
  const selected = {
    ...scope,
    skill_ref: ref,
    expected_digest: pkg.targetDigest,
  };
  const search = {
    ...scope,
    requesting_agent_id: `agent_${"4".repeat(32)}`,
    query: "procedure",
  };
  const received: Array<{ headers: Record<string, unknown>; body: unknown }> =
    [];
  let hold = false;
  const dispatched = Promise.withResolvers<void>(),
    disconnected = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()) as unknown,
      });
      if (request.url === "/internal/skill-discovery/search") {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            items: [
              {
                skill_ref: ref,
                name: ref.name,
                description: "A procedure",
                content_digest: pkg.targetDigest,
              },
            ],
          }),
        );
      } else {
        response.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Length": String(pkg.artifact.length),
          ETag: `"${pkg.artifactDigest}"`,
          "X-Antnest-Artifact-Digest": pkg.artifactDigest,
          "X-Antnest-Content-Digest": pkg.targetDigest,
        });
        if (hold) {
          response.once("close", () => disconnected.resolve());
          response.flushHeaders();
          dispatched.resolve();
        } else response.end(pkg.artifact);
      }
    });
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing HTTP fixture port");
    const client = new RegistrySkillDiscoveryClient(
      `http://127.0.0.1:${address.port}`,
      "read-only-fixture-token",
    );
    expect(
      (await client.search(search, new AbortController().signal)).items,
    ).toHaveLength(1);
    expect(
      await client.load(selected, new AbortController().signal),
    ).toMatchObject({
      skillText: pkg.skillText,
      contentDigest: pkg.targetDigest,
      artifactDigest: pkg.artifactDigest,
      requiresRuntimeDelivery: false,
    });
    expect(received[0]?.headers.authorization).toBe(
      "Bearer read-only-fixture-token",
    );
    expect(received[0]?.body).toEqual(search);
    expect(received[1]?.body).toEqual(selected);
    hold = true;
    const controller = new AbortController();
    const pending = client.load(selected, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    await dispatched.promise;
    controller.abort(new Error("Foreground cancelled"));
    await rejected;
    await disconnected.promise;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

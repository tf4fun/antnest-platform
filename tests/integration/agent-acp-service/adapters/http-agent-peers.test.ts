import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HttpAgentPeers } from "../../../../services/agent-acp-service/src/adapters/http-agent-peers.js";
import { PeerAuthentication } from "../../../../services/agent-acp-service/src/adapters/peer-authentication.js";
import { ServiceAuthentication } from "../../../../services/agent-acp-service/src/adapters/service-authentication.js";
import { testSecurityEnvironment } from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import type {
  PeerIdentityRequest,
  PeerPublicationRequest,
} from "../../../../services/agent-acp-service/src/ports/agent-peers.js";

async function fixture(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const directory = mkdtempSync(join(tmpdir(), "acp-peer-rpc-"));
  const workload = new ServiceAuthentication(testSecurityEnvironment());
  const server = createServer(handle);
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await workload.close();
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No listener");
    const origin = `http://127.0.0.1:${address.port}`;
    const membershipFile = join(directory, "membership.json");
    const callersFile = join(directory, "callers.json");
    const tokenDirectory = join(directory, "tokens");
    mkdirSync(tokenDirectory);
    writeFileSync(
      join(tokenDirectory, "acp-b"),
      randomBytes(32).toString("base64url"),
      { mode: 0o600 },
    );
    writeFileSync(
      callersFile,
      JSON.stringify({
        "acp-b": [
          `sha256:${createHash("sha256").update(randomBytes(32)).digest("hex")}`,
        ],
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      membershipFile,
      JSON.stringify({
        version: 1,
        cluster_id: randomUUID(),
        members: [
          { member_id: "acp-a", origin: "http://acp-a.internal:8083" },
          { member_id: "acp-b", origin },
        ],
      }),
    );
    const authentication = new PeerAuthentication({
      memberId: "acp-a",
      membershipFile,
      callersFile,
      tokenDirectory,
      workload,
    });
    const target = {
      registration_id: randomUUID(),
      member_id: "acp-b",
      incarnation_id: randomUUID(),
    };
    const request = (milliseconds = 2000): PeerIdentityRequest => ({
      request_id: randomUUID(),
      deadline_at: new Date(Date.now() + milliseconds).toISOString(),
      membership_sha256: authentication.membership.sha256,
      source: {
        registration_id: randomUUID(),
        member_id: "acp-a",
        incarnation_id: randomUUID(),
      },
      target_member_id: "acp-b",
      challenge: randomBytes(32).toString("hex"),
    });
    return {
      client: new HttpAgentPeers(authentication),
      target,
      request,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

it("performs actual identity and publication RPCs with one unchanged absolute deadline", async () => {
  const bodies: Record<string, unknown>[] = [];
  const paths: string[] = [];
  const test = await fixture((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<
        string,
        unknown
      >;
      bodies.push(body);
      paths.push(request.url!);
      const common = {
        request_id: body.request_id,
        membership_sha256: body.membership_sha256,
        registration: test.target,
      };
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url?.endsWith("identity")
            ? { ...common, challenge: body.challenge }
            : {
                ...common,
                publication: body.publication,
                status: "applied",
                revocation: "joined",
                owned_agents: [],
              },
        ),
      );
    });
  });
  try {
    const request = test.request();
    const identity = await test.client.identify(
      "acp-b",
      request,
      new AbortController().signal,
    );
    expect(identity).toHaveProperty("registration", test.target);
    const publication: PeerPublicationRequest = {
      request_id: request.request_id,
      deadline_at: request.deadline_at,
      membership_sha256: request.membership_sha256,
      source: request.source,
      target: test.target,
      publication: {
        organization_id: "org-1",
        revision: 1,
        authority_sha256: "d".repeat(64),
      },
      hop: 1,
    };
    expect(
      await test.client.publish(
        "acp-b",
        publication,
        new AbortController().signal,
      ),
    ).toHaveProperty("revocation", "joined");
    expect(paths).toEqual([
      "/internal/acp-peer/identity",
      "/internal/acp-peer/publications/apply",
    ]);
    expect(bodies.map((body) => body.deadline_at)).toEqual([
      request.deadline_at,
      request.deadline_at,
    ]);
    expect(bodies).toEqual([request, publication]);
  } finally {
    await test.close();
  }
});

it.each(["deadline", "caller"] as const)(
  "%s cancellation closes an actual held response before dispatcher cleanup",
  async (mode) => {
    const entered = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    const caller = new AbortController();
    const test = await fixture((_request, response) => {
      response.once("close", () => disconnected.resolve());
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
      entered.resolve();
    });
    let outcome: Promise<unknown> | undefined;
    try {
      outcome = test.client
        .identify(
          "acp-b",
          test.request(mode === "deadline" ? 300 : 2000),
          caller.signal,
        )
        .catch((error: unknown) => error);
      await entered.promise;
      if (mode === "caller") caller.abort();
      expect(await outcome).toHaveProperty("code", "deadline_exceeded");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        expect(
          await Promise.race([
            disconnected.promise.then(() => "closed"),
            new Promise<string>((resolve) => {
              timer = setTimeout(() => resolve("still open"), 2000);
            }),
          ]),
        ).toBe("closed");
      } finally {
        clearTimeout(timer);
      }
    } finally {
      caller.abort();
      await outcome;
      await test.close();
    }
  },
);

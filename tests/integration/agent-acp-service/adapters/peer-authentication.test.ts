import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  ServiceAuthentication,
  SERVICE_AUTH_HEADER,
} from "../../../../services/agent-acp-service/src/adapters/service-authentication.js";
import {
  testSecurityEnvironment,
  workloadHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import { PeerAuthentication } from "../../../../services/agent-acp-service/src/adapters/peer-authentication.js";

it("uses a dedicated rotating pair credential on a pinned peer origin while ordinary self-call remains forbidden", async () => {
  const directory = mkdtempSync(join(tmpdir(), "acp-peer-token-"));
  const path = join(directory, "acp-b");
  const original = randomBytes(32).toString("base64url");
  writeFileSync(path, original, { mode: 0o600 });
  const received: string[] = [];
  const server = createServer((request, response) => {
    received.push(String(request.headers[SERVICE_AUTH_HEADER.toLowerCase()]));
    if (request.url === "/redirect")
      response.writeHead(302, { location: "/next" });
    response.end("ok");
  });
  const authentication = new ServiceAuthentication(testSecurityEnvironment());
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No listener");
    const origin = `http://127.0.0.1:${address.port}`;
    expect(() => authentication.fetchFor("agent-acp-service", origin)).toThrow(
      "dependency_origin_invalid",
    );
    const send = authentication.fetchForPeer(origin, path);
    expect(
      await (
        await send(origin, {
          headers: { [SERVICE_AUTH_HEADER]: "Bearer supplied" },
        })
      ).text(),
    ).toBe("ok");
    const next = randomBytes(32).toString("base64url");
    writeFileSync(path + ".next", next, { mode: 0o600 });
    renameSync(path + ".next", path);
    expect(await (await send(origin)).text()).toBe("ok");
    expect(received).toEqual([`Bearer ${original}`, `Bearer ${next}`]);
    writeFileSync(path, next + "\n");
    await expect(send(origin)).rejects.toThrow("service_credential_invalid");
    expect(received).toHaveLength(2);
    writeFileSync(path, next);
    await expect(send("http://untrusted.invalid/")).rejects.toThrow(
      "dependency_origin_invalid",
    );
    await expect(send(origin, { headers: { host: "other" } })).rejects.toThrow(
      "dependency_origin_invalid",
    );
    await expect(send(origin + "/redirect")).rejects.toThrow();
    expect(received).toHaveLength(3);
    rmSync(path);
    await expect(send(origin)).rejects.toThrow("credential_file_invalid");
    expect(received).toHaveLength(3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await authentication.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("authenticates the source from a complete private member map before handling a real HTTP request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "acp-peer-members-"));
  const sender = new ServiceAuthentication(testSecurityEnvironment());
  const receiver = new ServiceAuthentication(testSecurityEnvironment());
  const current = randomBytes(32).toString("base64url");
  const next = randomBytes(32).toString("base64url");
  let peer: PeerAuthentication | undefined;
  const sources: string[] = [];
  const server = createServer((request, response) => {
    const admission = peer?.authenticate(request);
    response.writeHead(admission?.http_status ?? 503);
    if (admission?.code === null) sources.push(admission.caller!);
    response.end(admission?.caller ?? "denied");
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No listener");
    const origin = `http://127.0.0.1:${address.port}`;
    const roster = join(directory, "membership.json");
    const callers = join(directory, "callers.json");
    const tokens = join(directory, "tokens");
    mkdirSync(tokens);
    const outbound = join(directory, "a-to-b");
    writeFileSync(outbound, current, { mode: 0o600 });
    writeFileSync(
      join(tokens, "acp-a"),
      randomBytes(32).toString("base64url"),
      { mode: 0o600 },
    );
    writeFileSync(
      roster,
      JSON.stringify({
        version: 1,
        cluster_id: "10000000-0000-4000-8000-000000000001",
        members: [
          { member_id: "acp-a", origin: "http://acp-a.internal:8083" },
          { member_id: "acp-b", origin },
        ],
      }),
    );
    writeFileSync(
      callers,
      JSON.stringify({
        "acp-a": [current, next].map(
          (token) =>
            `sha256:${createHash("sha256").update(token).digest("hex")}`,
        ),
      }),
      { mode: 0o600 },
    );
    peer = new PeerAuthentication({
      memberId: "acp-b",
      membershipFile: roster,
      callersFile: callers,
      tokenDirectory: tokens,
      workload: receiver,
    });
    const send = sender.fetchForPeer(origin, outbound);
    expect(await (await send(origin)).text()).toBe("acp-a");
    writeFileSync(outbound, next);
    expect(await (await send(origin)).text()).toBe("acp-a");
    const ordinary = await fetch(origin, {
      headers: workloadHeaders("agent-ui"),
      signal: AbortSignal.timeout(3000),
    });
    expect(ordinary.status).toBe(401);
    await ordinary.text();
    const duplicate = await fetch(origin, {
      headers: [
        [SERVICE_AUTH_HEADER, `Bearer ${current}`],
        [SERVICE_AUTH_HEADER, `Bearer ${next}`],
      ],
      signal: AbortSignal.timeout(3000),
    });
    expect(duplicate.status).toBe(401);
    await duplicate.text();
    expect(sources).toEqual(["acp-a", "acp-a"]);
    expect(() => peer!.fetchFor("acp-b")).toThrow(
      "acp_peer_configuration_invalid",
    );
    expect(() => peer!.fetchFor("http://untrusted.invalid")).toThrow(
      "acp_peer_configuration_invalid",
    );
    writeFileSync(roster, "{}");
    expect(peer.membership.members).toHaveLength(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([sender.close(), receiver.close()]);
    rmSync(directory, { recursive: true, force: true });
  }
});

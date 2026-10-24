import { execFileSync } from "node:child_process";
import { createServer, request as httpsRequest } from "node:https";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomBytes, createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ServiceAuthentication } from "../../../../services/agent-acp-service/src/adapters/service-authentication.js";
import { PeerAuthentication } from "../../../../services/agent-acp-service/src/adapters/peer-authentication.js";
import { PeerServer } from "../../../../services/agent-acp-service/src/transport/peer-server.js";

it.each(["token", "mtls"] as const)(
  "verifies real %s TLS peers and refuses a trusted certificate with another service URI",
  async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "antnest-acp-tls-test-"));
    const clients: ServiceAuthentication[] = [];
    const servers: ReturnType<typeof createServer>[] = [];
    const peerServers: PeerServer[] = [];
    const webSocketServers: WebSocketServer[] = [];
    const webSockets: { socket: WebSocket; closed: Promise<void> }[] = [];
    const upgradeSockets: { socket: Duplex; closed: Promise<void> }[] = [];
    const webSocketErrors: unknown[] = [];
    let closingWebSockets = false;
    const watchWebSocket = (socket: WebSocket, expectedFailure = false) => {
      const closed = new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
      });
      socket.on("error", (error) => {
        if (!expectedFailure && !closingWebSockets) webSocketErrors.push(error);
      });
      const receipt = { socket, closed };
      webSockets.push(receipt);
      return receipt;
    };
    const observeUpgrades = (
      server: ReturnType<typeof createServer>,
      authenticate?: (
        request: IncomingMessage,
      ) => ReturnType<PeerAuthentication["authenticate"]>,
    ) => {
      const observed = {
        attempts: 0,
        accepted: 0,
        admissions: [] as ReturnType<PeerAuthentication["authenticate"]>[],
      };
      const webSocketServer = new WebSocketServer({ noServer: true });
      webSocketServers.push(webSocketServer);
      webSocketServer.on("error", (error) => webSocketErrors.push(error));
      server.on("upgrade", (request, socket, head) => {
        const closed = new Promise<void>((resolve) => {
          socket.once("close", () => resolve());
        });
        upgradeSockets.push({ socket, closed });
        let denied = false;
        socket.on("error", (error) => {
          if (!denied && !closingWebSockets) webSocketErrors.push(error);
        });
        observed.attempts++;
        try {
          const admission = authenticate?.(request);
          if (admission !== undefined) observed.admissions.push(admission);
          if (admission !== undefined && admission.code !== null) {
            denied = true;
            socket.end(
              `HTTP/1.1 ${admission.http_status} Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
            );
            return;
          }
          webSocketServer.handleUpgrade(request, socket, head, (connection) => {
            observed.accepted++;
            watchWebSocket(connection);
          });
        } catch (error) {
          webSocketErrors.push(error);
          socket.destroy();
        }
      });
      return observed;
    };
    const openssl = (...arguments_: string[]) =>
      execFileSync("openssl", arguments_, {
        cwd: directory,
        timeout: 10000,
        stdio: "pipe",
      });
    try {
      writeFileSync(
        join(directory, "ca.cnf"),
        "[req]\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n",
      );
      openssl(
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-subj",
        "/CN=DisposableACPTest",
        "-days",
        "1",
        "-keyout",
        "ca.key",
        "-out",
        "ca.pem",
        "-config",
        "ca.cnf",
      );
      for (const [index, name] of [
        "agent-acp-service",
        "identity-service",
        "antnest-runtime",
        "peer-wrong-host",
      ].entries()) {
        writeFileSync(
          join(directory, name + ".ext"),
          `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=${name === "peer-wrong-host" ? "DNS:wrong.internal,URI:antnest://service/agent-acp-service" : `DNS:localhost,IP:127.0.0.1,URI:antnest://service/${name}`}\n`,
        );
        openssl(
          "req",
          "-new",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:P-256",
          "-nodes",
          "-subj",
          `/CN=${name}`,
          "-keyout",
          name + ".key",
          "-out",
          name + ".csr",
        );
        openssl(
          "x509",
          "-req",
          "-in",
          name + ".csr",
          "-CA",
          "ca.pem",
          "-CAkey",
          "ca.key",
          "-set_serial",
          String(index + 10),
          "-days",
          "1",
          "-extfile",
          name + ".ext",
          "-out",
          name + ".pem",
        );
      }
      mkdirSync(join(directory, "tokens"));
      const token = randomBytes(32).toString("base64url");
      writeFileSync(join(directory, "tokens", "identity-service"), token, {
        mode: 0o600,
      });
      writeFileSync(join(directory, "empty.json"), "{}", { mode: 0o600 });
      writeFileSync(
        join(directory, "identity-callers.json"),
        JSON.stringify({
          "agent-acp-service": [
            `sha256:${createHash("sha256").update(token).digest("hex")}`,
          ],
        }),
        { mode: 0o600 },
      );
      const environment = (service: string) => ({
        ANTNEST_SERVICE_AUTH_MODE: mode,
        ANTNEST_SERVICE_AUTH_CALLERS_FILE: join(
          directory,
          service === "identity-service"
            ? "identity-callers.json"
            : "empty.json",
        ),
        ANTNEST_SERVICE_AUTH_TOKEN_DIR: join(directory, "tokens"),
        ANTNEST_TLS_CA_FILE: join(directory, "ca.pem"),
        ANTNEST_TLS_CERT_FILE: join(directory, service + ".pem"),
        ANTNEST_TLS_KEY_FILE: join(directory, service + ".key"),
        ANTNEST_TLS_SERVER_NAME: "localhost",
      });
      const sender = new ServiceAuthentication(
        environment("agent-acp-service"),
      );
      clients.push(sender);
      const pairToken = randomBytes(32).toString("base64url");
      const pairFile = join(directory, "peer-pair-token");
      writeFileSync(pairFile, pairToken, { mode: 0o600 });
      for (const service of ["identity-service", "antnest-runtime"]) {
        const receiver = new ServiceAuthentication(
          environment(service),
          service,
        );
        clients.push(receiver);
        let requests = 0;
        const server = createServer(
          receiver.serverTLS!,
          (request, response) => {
            requests++;
            const admission = receiver.authenticate(request, [
              "agent-acp-service",
            ]);
            response.writeHead(admission.http_status);
            response.end(admission.code ?? "ok");
          },
        );
        const upgrades = observeUpgrades(server);
        servers.push(server);
        server.listen(0, "localhost");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("No listener");
        const origin = `https://localhost:${address.port}`;
        const fetcher = sender.fetchFor("identity-service", origin);
        if (service === "identity-service") {
          expect(
            await (
              await fetcher(origin, { signal: AbortSignal.timeout(3000) })
            ).text(),
          ).toBe("ok");
          expect(requests).toBe(1);
        } else {
          await expect(
            fetcher(origin, { signal: AbortSignal.timeout(3000) }),
          ).rejects.toThrow();
          expect(requests).toBe(0);
        }
        const beforePeer = requests;
        expect(() => receiver.fetchForPeer(origin, pairFile)).toThrow(
          "dependency_origin_invalid",
        );
        await expect(
          sender.fetchForPeer(origin, pairFile)(origin, {
            signal: AbortSignal.timeout(3000),
          }),
        ).rejects.toThrow();
        expect(requests).toBe(beforePeer);
        expect(() =>
          receiver.connectPeer(origin, pairFile, {}, 1024, 3000),
        ).toThrow("dependency_origin_invalid");
        const refusedPeer = watchWebSocket(
          sender.connectPeer(origin, pairFile, {}, 1024, 3000),
          true,
        );
        await expect(once(refusedPeer.socket, "open")).rejects.toThrow(
          "server_identity_invalid",
        );
        await refusedPeer.closed;
        expect(upgrades.attempts).toBe(0);
        expect(upgrades.accepted).toBe(0);
        expect(requests).toBe(beforePeer);
      }
      for (const certificate of ["agent-acp-service", "peer-wrong-host"]) {
        const receiver = new ServiceAuthentication({
          ...environment(certificate),
          ANTNEST_TLS_SERVER_NAME:
            certificate === "peer-wrong-host" ? "wrong.internal" : "localhost",
        });
        clients.push(receiver);
        const holder: { peer?: PeerAuthentication } = {};
        let requests = 0;
        let accepted = 0;
        const server = createServer(
          receiver.serverTLS!,
          (request, response) => {
            requests++;
            const admission = holder.peer?.authenticate(request);
            if (admission?.code === null) accepted++;
            response.writeHead(admission?.http_status ?? 503);
            response.end(admission?.caller ?? "denied");
          },
        );
        const upgrades = observeUpgrades(server, (request) =>
          holder.peer!.authenticate(request),
        );
        servers.push(server);
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("No listener");
        const origin = `https://127.0.0.1:${address.port}`;
        const roster = join(directory, "peer-membership.json");
        const callers = join(directory, "peer-callers.json");
        const peerTokens = join(directory, "peer-tokens-" + certificate);
        mkdirSync(peerTokens);
        writeFileSync(
          join(peerTokens, "acp-a"),
          randomBytes(32).toString("base64url"),
          { mode: 0o600 },
        );
        writeFileSync(
          callers,
          JSON.stringify({
            "acp-a": [
              `sha256:${createHash("sha256").update(pairToken).digest("hex")}`,
            ],
          }),
          { mode: 0o600 },
        );
        writeFileSync(
          roster,
          JSON.stringify({
            version: 1,
            cluster_id: "10000000-0000-4000-8000-000000000001",
            members: [
              { member_id: "acp-a", origin: "https://acp-a.internal:8083" },
              { member_id: "acp-b", origin },
            ],
          }),
        );
        holder.peer = new PeerAuthentication({
          memberId: "acp-b",
          membershipFile: roster,
          callersFile: callers,
          tokenDirectory: peerTokens,
          workload: receiver,
        });
        const send = sender.fetchForPeer(origin, pairFile);
        if (certificate === "peer-wrong-host") {
          await expect(
            send(origin, { signal: AbortSignal.timeout(3000) }),
          ).rejects.toThrow();
          expect(requests).toBe(0);
          const refusedPeer = watchWebSocket(
            sender.connectPeer(origin, pairFile, {}, 1024, 3000),
            true,
          );
          await expect(once(refusedPeer.socket, "open")).rejects.toThrow();
          await refusedPeer.closed;
          expect(upgrades.attempts).toBe(0);
          expect(upgrades.accepted).toBe(0);
          expect(upgrades.admissions).toEqual([]);
          expect(requests).toBe(0);
          continue;
        }
        expect(
          await (
            await send(origin, { signal: AbortSignal.timeout(3000) })
          ).text(),
        ).toBe("acp-a");
        expect(accepted).toBe(1);
        const connectedPeer = watchWebSocket(
          sender.connectPeer(origin, pairFile, {}, 1024, 3000),
        );
        await once(connectedPeer.socket, "open");
        expect(upgrades.attempts).toBe(1);
        expect(upgrades.accepted).toBe(1);
        expect(upgrades.admissions).toEqual([
          expect.objectContaining({
            code: null,
            http_status: 200,
            caller: "acp-a",
          }),
        ]);
        expect(accepted).toBe(1);
        const registration = {
          registration_id: "10000000-0000-4000-8000-000000000001",
          member_id: "acp-b",
          incarnation_id: "10000000-0000-4000-8000-000000000002",
        };
        const peerServer = new PeerServer({
          registration,
          authentication: holder.peer,
          apply: () => Promise.reject(new Error("Identity must not publish")),
        });
        peerServers.push(peerServer);
        await peerServer.listen("127.0.0.1", 0);
        const peerOrigin = `https://127.0.0.1:${peerServer.address()!.port}`;
        const peerResponse = await sender.fetchForPeer(peerOrigin, pairFile)(
          peerOrigin + "/internal/acp-peer/identity",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: AbortSignal.timeout(3000),
            body: JSON.stringify({
              request_id: "10000000-0000-4000-8000-000000000003",
              deadline_at: new Date(Date.now() + 2000).toISOString(),
              membership_sha256: holder.peer.membership.sha256,
              source: { ...registration, member_id: "acp-a" },
              target_member_id: "acp-b",
              challenge: "a".repeat(64),
            }),
          },
        );
        expect(peerResponse.status).toBe(200);
        expect(await peerResponse.json()).toHaveProperty(
          "registration",
          registration,
        );
        const deniedStatus = await new Promise<number | undefined>(
          (resolve, reject) => {
            const request = httpsRequest(
              origin,
              { ...sender.serverTLS },
              (response) => {
                response.resume();
                response.once("end", () => resolve(response.statusCode));
              },
            );
            request.on("error", reject);
            request.setTimeout(3000, () =>
              request.destroy(new Error("test deadline")),
            );
            request.end();
          },
        );
        expect(deniedStatus).toBe(401);
        expect(accepted).toBe(1);
        const missingPair = watchWebSocket(
          new WebSocket(
            origin.replace("https:", "wss:") + "/internal/acp-peer/forward/ws",
            {
              ...sender.serverTLS,
              handshakeTimeout: 3000,
            },
          ),
          true,
        );
        await expect(once(missingPair.socket, "open")).rejects.toThrow(
          "Unexpected server response: 401",
        );
        await missingPair.closed;
        expect(upgrades.attempts).toBe(2);
        expect(upgrades.accepted).toBe(1);
        expect(upgrades.admissions[1]).toMatchObject({
          code: "service_unauthenticated",
          http_status: 401,
        });
        expect(accepted).toBe(1);
        if (mode === "mtls") {
          const other = new ServiceAuthentication(
            environment("identity-service"),
            "identity-service",
          );
          clients.push(other);
          const wrongServiceStatus = await new Promise<number | undefined>(
            (resolve, reject) => {
              const request = httpsRequest(
                origin,
                {
                  ...other.serverTLS,
                  headers: {
                    "Antnest-Service-Authorization": `Bearer ${pairToken}`,
                  },
                },
                (response) => {
                  response.resume();
                  response.once("end", () => resolve(response.statusCode));
                },
              );
              request.on("error", reject);
              request.setTimeout(3000, () =>
                request.destroy(new Error("test deadline")),
              );
              request.end();
            },
          );
          expect(wrongServiceStatus).toBe(403);
          expect(accepted).toBe(1);
          const wrongServicePeer = watchWebSocket(
            new WebSocket(
              origin.replace("https:", "wss:") +
                "/internal/acp-peer/forward/ws",
              {
                ...other.serverTLS,
                headers: {
                  "Antnest-Service-Authorization": `Bearer ${pairToken}`,
                },
                handshakeTimeout: 3000,
              },
            ),
            true,
          );
          await expect(once(wrongServicePeer.socket, "open")).rejects.toThrow(
            "Unexpected server response: 403",
          );
          await wrongServicePeer.closed;
          expect(upgrades.attempts).toBe(3);
          expect(upgrades.accepted).toBe(1);
          expect(upgrades.admissions[2]).toMatchObject({
            code: "caller_not_allowed",
            http_status: 403,
          });
          expect(accepted).toBe(1);
        }
      }
      expect(
        () =>
          new ServiceAuthentication({
            ...environment("agent-acp-service"),
            ANTNEST_TLS_CERT_FILE: join(directory, "identity-service.pem"),
            ANTNEST_TLS_KEY_FILE: join(directory, "identity-service.key"),
          }),
      ).toThrow("tls_configuration_invalid");
      expect(
        () =>
          new ServiceAuthentication({
            ...environment("agent-acp-service"),
            ANTNEST_TLS_SERVER_NAME: "wrong.invalid",
          }),
      ).toThrow("tls_configuration_invalid");
      expect(
        () =>
          new ServiceAuthentication({
            ...environment("agent-acp-service"),
            ANTNEST_TLS_KEY_FILE: "",
          }),
      ).toThrow("complete_tls_configuration_required");
    } finally {
      await Promise.all(peerServers.map((server) => server.close()));
      closingWebSockets = true;
      for (const { socket } of webSockets)
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      for (const { socket } of upgradeSockets) socket.destroy();
      await Promise.all([
        ...webSockets.map(({ closed }) => closed),
        ...upgradeSockets.map(({ closed }) => closed),
      ]);
      await Promise.all(
        webSocketServers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close((error) => {
                if (error !== undefined) webSocketErrors.push(error);
                resolve();
              });
            }),
        ),
      );
      await Promise.all(clients.map((client) => client.close()));
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      rmSync(directory, { recursive: true, force: true });
      expect(webSocketErrors).toEqual([]);
    }
  },
);

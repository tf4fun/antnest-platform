import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomBytes, createHash } from "node:crypto";
import { expect, it } from "vitest";
import { ServiceAuthentication } from "../../../../services/agent-acp-service/src/adapters/service-authentication.js";

it.each(["token", "mtls"] as const)(
  "verifies real %s TLS peers and refuses a trusted certificate with another service URI",
  async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "antnest-acp-tls-test-"));
    const clients: ServiceAuthentication[] = [];
    const servers: ReturnType<typeof createServer>[] = [];
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
      ].entries()) {
        writeFileSync(
          join(directory, name + ".ext"),
          `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1,URI:antnest://service/${name}\n`,
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
      await Promise.all(clients.map((client) => client.close()));
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

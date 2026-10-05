import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { once } from "node:events";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ServiceAuthentication } from "../../../services/agent-ui/web/server/dist/adapters/service-authentication.js";
import { CallerContextVerifier } from "../../../services/agent-ui/web/server/dist/adapters/caller-context.js";
import { RequestAuthentication } from "../../../services/agent-ui/web/server/dist/http/request-authentication.js";
import { createWorkspaceHttpServer } from "../../../services/agent-ui/web/server/dist/http/node-server.js";
import { checkReadiness } from "../../../services/agent-ui/web/server/dist/healthcheck.js";
import { testContext, testJwks } from "./auth-fixture.mjs";

for (const mode of ["token", "mtls"])
  test(`real ${mode} TLS validates DNS/chain/URI, route caller and local health`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "antnest-ui-tls-test-"));
    const clients = [];
    const servers = [];
    const openssl = (...args) =>
      execFileSync("openssl", args, {
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
        "/CN=DisposableUIAuthentication",
        "-days",
        "1",
        "-keyout",
        "ca.key",
        "-out",
        "ca.pem",
        "-config",
        "ca.cnf",
      );
      const services = [
        "agent-ui",
        "identity-service",
        "antnest-runtime",
        "edge-gateway",
      ];
      for (const [index, name] of services.entries()) {
        writeFileSync(
          join(directory, `${name}.ext`),
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
          `${name}.key`,
          "-out",
          `${name}.csr`,
        );
        openssl(
          "x509",
          "-req",
          "-in",
          `${name}.csr`,
          "-CA",
          "ca.pem",
          "-CAkey",
          "ca.key",
          "-set_serial",
          String(index + 10),
          "-days",
          "1",
          "-extfile",
          `${name}.ext`,
          "-out",
          `${name}.pem`,
        );
      }
      const tokens = Object.fromEntries(
        services.map((name) => [name, randomBytes(32).toString("base64url")]),
      );
      mkdirSync(join(directory, "tokens"));
      for (const [name, token] of Object.entries(tokens))
        writeFileSync(join(directory, "tokens", name), token, { mode: 0o600 });
      const hash = (token) =>
        `sha256:${createHash("sha256").update(token).digest("hex")}`;
      writeFileSync(join(directory, "empty.json"), "{}", { mode: 0o600 });
      writeFileSync(
        join(directory, "identity-callers.json"),
        JSON.stringify({ "agent-ui": [hash(tokens["identity-service"])] }),
        { mode: 0o600 },
      );
      writeFileSync(
        join(directory, "ui-callers.json"),
        JSON.stringify({ "edge-gateway": [hash(tokens["agent-ui"])] }),
        { mode: 0o600 },
      );
      const environment = (service) => ({
        ANTNEST_SERVICE_AUTH_MODE: mode,
        ANTNEST_SERVICE_AUTH_CALLERS_FILE: join(
          directory,
          service === "identity-service"
            ? "identity-callers.json"
            : service === "agent-ui"
              ? "ui-callers.json"
              : "empty.json",
        ),
        ANTNEST_SERVICE_AUTH_TOKEN_DIR: join(directory, "tokens"),
        ANTNEST_TLS_CA_FILE: join(directory, "ca.pem"),
        ANTNEST_TLS_CERT_FILE: join(directory, `${service}.pem`),
        ANTNEST_TLS_KEY_FILE: join(directory, `${service}.key`),
        ANTNEST_TLS_SERVER_NAME: "localhost",
      });
      const workload = new ServiceAuthentication(environment("agent-ui"));
      clients.push(workload);
      for (const service of ["identity-service", "antnest-runtime"]) {
        const receiver = new ServiceAuthentication(
          environment(service),
          service,
        );
        clients.push(receiver);
        let requests = 0;
        const server = createServer(receiver.serverTLS, (request, response) => {
          requests++;
          const admitted = receiver.authenticate(request, ["agent-ui"]);
          response.writeHead(admitted.http_status).end(admitted.code ?? "ok");
        });
        servers.push(server);
        server.listen(0, "localhost");
        await once(server, "listening");
        const origin = `https://localhost:${server.address().port}`;
        const fetcher = workload.fetchFor("identity-service", origin);
        if (service === "identity-service") {
          assert.equal(await (await fetcher(origin)).text(), "ok");
          assert.equal(requests, 1);
        } else {
          await assert.rejects(fetcher(origin));
          assert.equal(requests, 0);
        }
      }
      assert.throws(
        () =>
          new ServiceAuthentication({
            ...environment("agent-ui"),
            ANTNEST_TLS_CERT_FILE: join(directory, "identity-service.pem"),
            ANTNEST_TLS_KEY_FILE: join(directory, "identity-service.key"),
          }),
        /tls_configuration_invalid/u,
      );
      assert.throws(
        () =>
          new ServiceAuthentication({
            ...environment("agent-ui"),
            ANTNEST_TLS_SERVER_NAME: "wrong.invalid",
          }),
        /tls_configuration_invalid/u,
      );
      assert.throws(
        () =>
          new ServiceAuthentication({
            ...environment("agent-ui"),
            ANTNEST_TLS_KEY_FILE: "",
          }),
        /complete_tls_configuration_required/u,
      );
      let calls = 0;
      const server = createWorkspaceHttpServer(
        {
          async handle() {
            calls++;
            return Response.json({ ok: true });
          },
        },
        {
          authentication: new RequestAuthentication(
            workload,
            new CallerContextVerifier("https://identity.invalid/", async () =>
              Response.json(testJwks),
            ),
          ),
        },
      );
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const origin = `https://localhost:${server.address().port}`;
      const gateway = new ServiceAuthentication(
        environment("edge-gateway"),
        "edge-gateway",
      );
      clients.push(gateway);
      const fetcher = gateway.fetchFor("agent-ui", origin);
      const response = await fetcher(
        `${origin}/api/app/workspace/v1/agents/agent-1/sessions`,
        {
          headers: {
            "Antnest-Caller-Context": testContext({ agt: "agent-1" }).token,
          },
        },
      );
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(calls, 1);
      assert.equal(
        await checkReadiness({
          ...environment("agent-ui"),
          ANTNEST_AGENT_UI_BRIDGE_PORT: String(server.address().port),
        }),
        true,
      );
      if (mode === "mtls") {
        const runtime = new ServiceAuthentication(
          environment("antnest-runtime"),
          "antnest-runtime",
        );
        clients.push(runtime);
        const denied = await runtime.fetchFor(
          "agent-ui",
          origin,
        )(`${origin}/api/app/workspace/v1/agents/agent-1/sessions`);
        assert.equal(denied.status, 403);
        assert.equal((await denied.json()).code, "caller_not_allowed");
        assert.equal(calls, 1);
      }
    } finally {
      for (const client of clients) await client.close();
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

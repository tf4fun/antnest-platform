import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkServerIdentity } from "node:tls";
import test from "node:test";
import { certificates } from "../edge-gateway/tls-certificates.mjs";
import { createHttpsTarget } from "./https-target.mjs";

async function read(request, options) {
  const done = Promise.withResolvers(),
    closed = Promise.withResolvers();
  const req = request(
    { ...options, agent: false, timeout: 2000 },
    (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.once("error", done.reject);
      response.once("end", () =>
        done.resolve({
          status: response.statusCode,
          body: JSON.parse(body),
          headers: response.headers,
        }),
      );
    },
  );
  req.once("close", closed.resolve);
  req.once("error", done.reject);
  req.once("timeout", () =>
    req.destroy(new Error("HTTPS fixture test request timed out")),
  );
  req.end();
  try {
    return await done.promise;
  } finally {
    req.destroy();
    await closed.promise;
  }
}

test(
  "controlled HTTPS target authenticates both identities and closes raw TLS/DNS sockets",
  { timeout: 8000 },
  async (t) => {
    let stage = "listen";
    t.after(() => t.diagnostic(`last completed fixture stage: ${stage}`));
    const directory = mkdtempSync(join(tmpdir(), "antnest-https-target-"));
    const nonce = "a".repeat(32),
      dnsName = "egress-fixture.example";
    const certificate = certificates(directory, {
      dnsNames: [dnsName],
      ipAddresses: ["1.1.1.1"],
    });
    const fixture = createHttpsTarget({
      key: readFileSync(join(directory, "key.pem")),
      cert: readFileSync(join(directory, "cert.pem")),
      nonce,
    });
    const sockets = [];
    const closures = [];
    try {
      for (const server of [fixture.https, fixture.http, fixture.dns]) {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
      }
      const secure = (path, name = dnsName, ca = certificate.ca) =>
        read(httpsRequest, {
          hostname: "127.0.0.1",
          port: fixture.https.address().port,
          path,
          ca,
          servername: name === "1.1.1.1" ? "" : name,
          checkServerIdentity: (_hostname, cert) =>
            checkServerIdentity(name, cert),
          headers: { Host: `${name}:8443` },
        });
      const status = () =>
        read(httpRequest, {
          hostname: "127.0.0.1",
          port: fixture.http.address().port,
          path: "/status",
        });
      stage = "listeners ready";
      await assert.rejects(secure(`/probe/${nonce}/created/dns`, dnsName, ""));
      stage = "wrong CA rejected";
      await assert.rejects(
        secure(`/probe/${nonce}/created/dns`, "wrong.example"),
        { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
      );
      stage = "wrong hostname rejected";
      assert.deepEqual((await status()).body, { requests: [], errors: [] });
      for (const kind of ["ip", "dns"]) {
        const name = kind === "ip" ? "1.1.1.1" : dnsName;
        const response = await secure(`/probe/${nonce}/created/${kind}`, name);
        assert.equal(response.status, 200);
        assert.equal(response.headers["cache-control"], "no-store");
        assert.deepEqual(response.body, { nonce, phase: "created", kind });
      }
      assert.deepEqual((await status()).body.errors, []);
      assert.equal((await secure(`/probe/${nonce}/created/dns`)).status, 409);
      assert.equal(
        (await secure(`/probe/${"b".repeat(32)}/updated/dns`)).status,
        404,
      );
      assert.equal((await secure("/outside-the-fixture")).status, 404);
      const inventory = (await status()).body;
      stage = "business probes and inventory read";
      assert.deepEqual(inventory.errors, [
        "duplicate HTTPS probe",
        "invalid HTTPS probe",
        "invalid HTTPS probe",
      ]);
      assert.deepEqual(
        inventory.requests,
        ["ip", "dns"].map((kind) => ({
          nonce,
          phase: "created",
          kind,
          peer: "127.0.0.1",
          host: `${kind === "ip" ? "1.1.1.1" : dnsName}:8443`,
        })),
      );
      for (const server of [fixture.https, fixture.dns]) {
        const socket = connect(server.address().port, "127.0.0.1");
        sockets.push(socket);
        closures.push(new Promise((resolve) => socket.once("close", resolve)));
        socket.on("error", () => {});
        await once(socket, "connect");
        socket.write(Buffer.from([0x16]));
      }
      const closing = fixture.close();
      stage = "close requested with partial TLS and DNS sockets";
      assert.equal(fixture.close(), closing);
      await closing;
      stage = "fixture close joined";
      await Promise.all(closures);
      for (const server of [fixture.https, fixture.http, fixture.dns])
        assert.equal(server.listening, false);
    } finally {
      for (const socket of sockets) socket.destroy();
      await Promise.all(closures);
      await fixture.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

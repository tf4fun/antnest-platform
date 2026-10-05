import assert from "node:assert/strict";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:https";

let server;
try {
  const service = process.env.PROBE_SERVICE;
  const uid = Number(process.env.PROBE_UID),
    gid = Number(process.env.PROBE_GID);
  assert.equal(process.getuid(), uid);
  assert.equal(process.getgid(), gid);
  assert.deepEqual(readdirSync("/tls").sort(), [
    "ca.pem",
    "cert.pem",
    "key.pem",
  ]);
  for (const file of ["ca.pem", "cert.pem", "key.pem"]) {
    const row = statSync(`/tls/${file}`);
    assert.equal(row.uid, uid);
    assert.equal(row.gid, gid);
    assert.equal(row.mode & 0o777, 0o600);
    assert.throws(
      () => writeFileSync(`/tls/${file}`, "forbidden"),
      (error) => ["EROFS", "EACCES"].includes(error.code),
    );
  }
  const ca = readFileSync("/tls/ca.pem"),
    cert = readFileSync("/tls/cert.pem"),
    key = readFileSync("/tls/key.pem");
  const leaf = new X509Certificate(cert),
    issuer = new X509Certificate(ca);
  const sans = leaf.subjectAltName.split(", ");
  assert.deepEqual(
    sans.filter((name) => name.startsWith("URI:")),
    [`URI:antnest://service/${service}`],
  );
  assert.deepEqual(
    sans
      .filter((name) => name.startsWith("DNS:"))
      .map((name) => name.slice(4))
      .sort(),
    JSON.parse(process.env.PROBE_DNS_NAMES).sort(),
  );
  assert(
    issuer.ca &&
      !leaf.ca &&
      leaf.verify(issuer.publicKey) &&
      leaf.checkPrivateKey(createPrivateKey(key)),
  );
  let requests = 0;
  server = createServer(
    {
      key,
      cert,
      ca,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    },
    (req, res) => {
      requests++;
      const peer = new X509Certificate(req.socket.getPeerCertificate().raw);
      res
        .writeHead(peer.subjectAltName === leaf.subjectAltName ? 200 : 403)
        .end();
    },
  );
  server.on("tlsClientError", () => {});
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const call = (withCertificate, servername = service) =>
    new Promise((resolve, reject) => {
      const client = request(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          servername,
          ca,
          agent: false,
          minVersion: "TLSv1.3",
          ...(withCertificate ? { key, cert } : {}),
        },
        (res) => {
          res.resume();
          res.once("end", () => resolve(res.statusCode));
        },
      );
      client.setTimeout(3000, () =>
        client.destroy(new Error("probe deadline")),
      );
      client.once("error", reject);
      client.end();
    });
  assert.equal(await call(true), 200);
  await assert.rejects(call(false));
  await assert.rejects(call(true, "wrong.example.invalid"));
  assert.equal(requests, 1);
  console.log(JSON.stringify({ complete: true, service, uid, gid }));
} catch {
  console.error("Development PKI mount and TLS probe failed.");
  process.exitCode = 1;
} finally {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:https";
import { connect } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { certificates } from "./tls-certificates.mjs";
import { startLinkingProvider } from "./oidc-linking-fixture.mjs";

test("abort closes a raw connection that has not completed its TLS handshake", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "antnest-linking-idp-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  certificates(directory, { dnsNames: ["host.docker.internal"] });
  const abort = new AbortController();
  const fixture = await startLinkingProvider({
    directory,
    callback: "https://127.0.0.1/protocol/oidc/callback",
    signal: abort.signal,
    listenHost: "127.0.0.1",
  });
  const socket = connect({
    host: "127.0.0.1",
    port: Number(new URL(fixture.issuer).port),
  });
  socket.on("error", () => {});
  try {
    await once(socket, "connect");
    socket.write(Buffer.from([0x16]));
    await delay(20);
    abort.abort();
    assert.equal(
      await Promise.race([
        fixture.close().then(() => true),
        delay(500).then(() => false),
      ]),
      true,
      "partial TLS connection blocked fixture cleanup",
    );
  } finally {
    socket.destroy();
    await fixture.close();
  }
});

test("linking IdP verifies private CA and hostname and stops on abort", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "antnest-linking-idp-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const certificate = certificates(directory, {
    dnsNames: ["host.docker.internal"],
  });
  const abort = new AbortController();
  const fixture = await startLinkingProvider({
    directory,
    callback: "https://127.0.0.1/protocol/oidc/callback",
    signal: abort.signal,
    listenHost: "127.0.0.1",
  });
  t.after(() => fixture.close());
  const read = (ca) =>
    new Promise((resolve, reject) => {
      const req = request(
        `${fixture.issuer}/.well-known/openid-configuration`,
        {
          ca,
          agent: false,
          lookup: (_name, options, callback) =>
            options.all
              ? callback(null, [{ address: "127.0.0.1", family: 4 }])
              : callback(null, "127.0.0.1", 4),
          timeout: 2000,
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode, body: JSON.parse(body) }),
          );
          response.on("error", reject);
        },
      );
      req.on("error", reject);
      req.on("timeout", () =>
        req.destroy(new Error("fixture request timed out")),
      );
      req.end();
    });
  await assert.rejects(() => read(undefined), {
    code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  });
  const discovery = await read(certificate.ca);
  assert.equal(discovery.status, 200);
  assert.equal(discovery.body.issuer, fixture.issuer);
  assert.equal(fixture.stats().discovery, 1);
  abort.abort();
  await fixture.close();
  await assert.rejects(() => read(certificate.ca), { code: "ECONNREFUSED" });
});

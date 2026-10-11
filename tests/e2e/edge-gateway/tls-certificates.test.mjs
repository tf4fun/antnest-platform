import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { certificates } from "./tls-certificates.mjs";

test("disposable TLS supports one verified browser and Docker IdP hostname", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "antnest-linking-tls-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = certificates(directory, {
    dnsNames: ["host.docker.internal"],
  });
  const leaf = new X509Certificate(readFileSync(join(directory, "cert.pem")));
  assert.equal(leaf.checkIP("127.0.0.1"), "127.0.0.1");
  assert.equal(leaf.checkHost("tls-proxy"), "tls-proxy");
  assert.equal(leaf.checkHost("host.docker.internal"), "host.docker.internal");
  assert.equal(leaf.checkHost("untrusted.example"), undefined);
  assert.equal(leaf.verify(new X509Certificate(result.ca).publicKey), true);
});

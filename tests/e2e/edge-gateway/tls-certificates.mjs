import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, X509Certificate } from "node:crypto";

export function certificates(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const openssl = (args) => {
    const result = spawnSync("openssl", args, {
      cwd: directory,
      encoding: "utf8",
      timeout: 10000,
      killSignal: "SIGKILL",
    });
    assert.ifError(result.error);
    assert.equal(
      result.status,
      0,
      "disposable TLS certificate generation failed",
    );
  };
  openssl([
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    "ca-key.pem",
    "-out",
    "ca.pem",
    "-days",
    "2",
    "-subj",
    "/CN=Antnest disposable HTTPS acceptance CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  openssl([
    "req",
    "-new",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    "key.pem",
    "-out",
    "request.pem",
    "-subj",
    "/CN=127.0.0.1",
  ]);
  writeFileSync(
    resolve(directory, "extensions.cnf"),
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=IP:127.0.0.1,DNS:tls-proxy",
    ].join("\n"),
  );
  openssl([
    "x509",
    "-req",
    "-in",
    "request.pem",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca-key.pem",
    "-set_serial",
    "1",
    "-days",
    "2",
    "-extfile",
    "extensions.cnf",
    "-out",
    "cert.pem",
  ]);
  const certificate = new X509Certificate(
    readFileSync(resolve(directory, "cert.pem")),
  );
  return {
    ca: readFileSync(resolve(directory, "ca.pem"), "utf8"),
    spki: createHash("sha256")
      .update(certificate.publicKey.export({ type: "spki", format: "der" }))
      .digest("base64"),
  };
}

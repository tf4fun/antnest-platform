import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { certificates } from "../edge-gateway/tls-certificates.mjs";
import {
  prepare,
  verifyInventory,
  verifyProbe,
  networkIdentity,
} from "./https-probe.mjs";

test("prepared TLS files support a capability-dropped target while their host directory stays private", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "antnest-egress-prepare-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const nonce = prepare(directory);
  assert.match(nonce, /^[a-f0-9]{32}$/u);
  assert.equal(readFileSync(join(directory, "nonce"), "utf8").trim(), nonce);
  assert.equal(statSync(join(directory, "tls")).mode & 0o777, 0o700);
  for (const file of ["key.pem", "cert.pem"])
    assert.equal(statSync(join(directory, "tls", file)).mode & 0o777, 0o444);
  assert.equal(existsSync(join(directory, "tls", "ca-key.pem")), false);
});

test("disposable HTTPS certificate authenticates the routed IP and exact DNS fixture", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "antnest-egress-tls-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  certificates(directory, {
    dnsNames: ["egress-fixture.example"],
    ipAddresses: ["1.1.1.1"],
  });
  const certificate = new X509Certificate(
    readFileSync(join(directory, "cert.pem")),
  );
  assert.equal(certificate.checkIP("1.1.1.1"), "1.1.1.1");
  assert.equal(
    certificate.checkHost("egress-fixture.example"),
    "egress-fixture.example",
  );
  assert.equal(certificate.checkIP("1.1.1.2"), undefined);
  assert.equal(certificate.checkHost("example.com"), undefined);
});

test("HTTPS admission preserves transport, status and original response checks", () => {
  const nonce = "a".repeat(32);
  const input = {
    nonce,
    phase: "created",
    kind: "dns",
    exitCode: 0,
    httpStatus: "200",
    body: JSON.stringify({ nonce, phase: "created", kind: "dns" }),
  };
  verifyProbe(input);
  for (const change of [
    { exitCode: 60 },
    { httpStatus: "503" },
    { body: "" },
    {
      body: JSON.stringify({
        nonce: "b".repeat(32),
        phase: "created",
        kind: "dns",
      }),
    },
    { body: JSON.stringify({ nonce, phase: "updated", kind: "dns" }) },
  ])
    assert.throws(() => verifyProbe({ ...input, ...change }));
});

test("exact target inventory rejects lost, repeated, foreign and bypassed requests", () => {
  const nonce = "a".repeat(32),
    peer = "172.20.0.3";
  const requests = ["created", "updated"].flatMap((phase) =>
    ["ip", "dns"].map((kind) => ({
      nonce,
      phase,
      kind,
      peer,
      host: `${kind === "ip" ? "1.1.1.1" : "egress-fixture.example"}:8443`,
    })),
  );
  verifyInventory({ requests, errors: [] }, nonce, "updated", peer);
  verifyInventory(
    { requests: requests.slice(0, 2), errors: [] },
    nonce,
    "created",
    peer,
  );
  for (const bad of [
    requests.slice(1),
    [...requests, requests[0]],
    requests.map((r) => ({ ...r, peer: "100.64.0.2" })),
    requests.map((r) => ({ ...r, nonce: "b".repeat(32) })),
    requests.map((r) => ({ ...r, host: "example.com" })),
  ])
    assert.throws(() =>
      verifyInventory({ requests: bad, errors: [] }, nonce, "updated", peer),
    );
  assert.throws(() =>
    verifyInventory(
      { requests, errors: ["unexpected request"] },
      nonce,
      "updated",
      peer,
    ),
  );
});

test("fixture route setup rejects foreign scope or an extra target network", () => {
  const project = "antnest-https-test";
  const container = (service, ip) => ({
    Config: {
      Labels: {
        "com.docker.compose.service": service,
        "com.docker.compose.project": project,
      },
    },
    State: { Running: true },
    NetworkSettings: { Networks: { [`${project}_egress`]: { IPAddress: ip } } },
  });
  const target = container("egress-https-target", "172.20.0.2"),
    egress = container("runtime-egress", "172.20.0.3");
  assert.deepEqual(networkIdentity([target, egress], project), {
    target: "172.20.0.2",
    peer: "172.20.0.3",
  });
  const foreign = structuredClone(target);
  foreign.Config.Labels["com.docker.compose.project"] = "foreign";
  assert.throws(() => networkIdentity([foreign, egress], project));
  const bypass = structuredClone(target);
  bypass.NetworkSettings.Networks.extra = { IPAddress: "172.21.0.2" };
  assert.throws(() => networkIdentity([bypass, egress], project));
});

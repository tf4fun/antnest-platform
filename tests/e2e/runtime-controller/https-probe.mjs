import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { certificates } from "../edge-gateway/tls-certificates.mjs";
import {
  DNS_FIXTURE_IPV4,
  DNS_FIXTURE_NAME,
} from "../lifecycle-closeout/network-dns.mjs";
import { privateIPv4 } from "../lifecycle-closeout/network-evidence.mjs";
import {
  durablePath,
  shellStoragePreflight,
  writeEvidenceFile,
} from "../../support/storage.mjs";

const phases = ["created", "updated"];
const kinds = ["ip", "dns"];
export const hostname = DNS_FIXTURE_NAME.slice(0, -1);

export function prepare(directory) {
  assert(isAbsolute(directory));
  directory = durablePath(directory);
  shellStoragePreflight(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  certificates(join(directory, "tls"), {
    dnsNames: [hostname],
    ipAddresses: [DNS_FIXTURE_IPV4],
  });
  rmSync(join(directory, "tls", "ca-key.pem"));
  // Individual read-only binds are readable without DAC capabilities in the
  // target. Their host parent stays private and is never mounted wholesale.
  chmodSync(join(directory, "tls"), 0o700);
  for (const file of ["key.pem", "cert.pem"])
    chmodSync(join(directory, "tls", file), 0o444);
  const nonce = randomBytes(16).toString("hex");
  writeFileSync(join(directory, "nonce"), nonce + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  return nonce;
}

export function guardRules() {
  const source = 'iifname "antnest-egress0" ip saddr 100.64.0.0/10';
  return `table ip rc_https_fixture {
    chain forward { type filter hook forward priority 10; policy accept;
      ${source} ip daddr != ${DNS_FIXTURE_IPV4} drop
      ${source} meta l4proto != tcp drop
      ${source} tcp dport != 8443 drop
    }
  }`;
}

export function verifyProbe({
  nonce,
  phase,
  kind,
  exitCode,
  httpStatus,
  body,
}) {
  assert.match(nonce, /^[a-f0-9]{32}$/u);
  assert(phases.includes(phase) && kinds.includes(kind));
  assert.equal(exitCode, 0, `${phase}/${kind} HTTPS transport failed`);
  assert.equal(httpStatus, "200", `${phase}/${kind} HTTPS response status`);
  assert.deepEqual(JSON.parse(body), { nonce, phase, kind });
}

export function verifyInventory(inventory, nonce, phase, peer) {
  assert.match(nonce, /^[a-f0-9]{32}$/u);
  assert(phases.includes(phase));
  privateIPv4(peer);
  assert.deepEqual(Object.keys(inventory).sort(), ["errors", "requests"]);
  assert.deepEqual(inventory.errors, []);
  const expected = phases.slice(0, phases.indexOf(phase) + 1).flatMap((p) =>
    kinds.map((kind) => ({
      nonce,
      phase: p,
      kind,
      peer,
      host: `${kind === "ip" ? DNS_FIXTURE_IPV4 : hostname}:8443`,
    })),
  );
  assert.deepEqual(
    inventory.requests,
    expected,
    "HTTPS target inventory must contain exactly the original probes through Egress",
  );
}

export function networkIdentity(containers, project) {
  assert.match(project, /^[a-zA-Z0-9_-]+$/u);
  assert.equal(containers.length, 2);
  const find = (service) => {
    const found = containers.filter(
      (c) => c.Config.Labels["com.docker.compose.service"] === service,
    );
    assert.equal(found.length, 1);
    assert.equal(found[0].Config.Labels["com.docker.compose.project"], project);
    assert.equal(found[0].State.Running, true);
    return found[0];
  };
  const target = find("egress-https-target"),
    egress = find("runtime-egress");
  const network = `${project}_egress`;
  assert.deepEqual(Object.keys(target.NetworkSettings.Networks), [network]);
  return {
    target: privateIPv4(target.NetworkSettings.Networks[network].IPAddress),
    peer: privateIPv4(egress.NetworkSettings.Networks[network].IPAddress),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [operation, directory, phase, kind, exitCode, httpStatus] =
    process.argv.slice(2);
  if (operation !== "guard") shellStoragePreflight(directory);
  if (operation === "prepare") prepare(directory);
  else if (operation === "guard") process.stdout.write(guardRules());
  else if (operation === "record") {
    assert(phases.includes(phase) && kinds.includes(kind));
    const nonce = readFileSync(join(directory, "nonce"), "utf8").trim();
    const body = readFileSync(join(directory, `${phase}-${kind}.body`), "utf8");
    const receipt = {
      nonce,
      phase,
      kind,
      exitCode: Number(exitCode),
      httpStatus,
      bodySha256: createHash("sha256").update(body).digest("hex"),
    };
    writeEvidenceFile(
      directory,
      `${phase}-${kind}.json`,
      JSON.stringify(receipt) + "\n",
    );
    verifyProbe({ ...receipt, body });
    console.log(
      JSON.stringify({
        event: "egress_https_probe_passed",
        phase,
        kind,
        status: 200,
      }),
    );
  } else if (operation === "inventory") {
    const nonce = readFileSync(join(directory, "nonce"), "utf8").trim();
    verifyInventory(
      JSON.parse(
        readFileSync(join(directory, `${phase}-inventory.json`), "utf8"),
      ),
      nonce,
      phase,
      kind,
    );
  } else if (operation === "address") {
    assert(["target", "peer"].includes(kind));
    const addresses = networkIdentity(
      JSON.parse(readFileSync(join(directory, "network.json"), "utf8")),
      phase,
    );
    process.stdout.write(addresses[kind]);
  } else throw new Error("Unknown HTTPS fixture operation");
}

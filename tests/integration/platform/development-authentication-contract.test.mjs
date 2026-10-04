import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const contract = JSON.parse(
  readFileSync(
    resolve(
      root,
      "contracts/platform/development-authentication-contract.json",
    ),
    "utf8",
  ),
);

test("development provisioning derives 23 static pairs from the nine owning catalogs", () => {
  assert.equal(contract.version, 1);
  assert.equal(contract.profile, "disposable-development-token-http");
  const services = Object.keys(contract.static_services);
  assert.equal(services.length, 9);
  assert.deepEqual(contract.dynamic_receivers, ["antnest-runtime"]);
  assert(!services.includes("antnest-runtime"));
  const pairs = new Set();
  for (const [receiver, file] of Object.entries(contract.static_services)) {
    const catalog = JSON.parse(readFileSync(resolve(root, file), "utf8"));
    assert.equal(catalog.service, receiver);
    assert.equal(catalog.status, "enforced");
    for (const route of Object.values(catalog.routes)) {
      if (route.authentication !== "workload") continue;
      for (const caller of route.callers) {
        assert(services.includes(caller));
        assert.notEqual(
          caller,
          receiver,
          "current catalogs have no self-grants",
        );
        pairs.add(`${caller}->${receiver}`);
      }
    }
  }
  assert.equal(pairs.size, 23);
  assert(pairs.has("agent-controller->runtime-egress"));
  assert(pairs.has("runtime-controller->skill-registry"));
  assert(![...pairs].some((pair) => pair.includes("antnest-runtime")));
});

test("the bootstrap contract retains independent issuer and instance master formats", () => {
  const { token_provisioning: tokens, bootstrap_keys: keys } = contract;
  assert.equal(tokens.output_policy, "fresh-directory-only");
  assert.equal(tokens.random_bytes_per_pair, 32);
  assert.equal(tokens.directory_mode, "0700");
  assert.equal(tokens.file_mode, "0600");
  assert.equal(tokens.receiver_max_bytes, 8192);
  assert.equal(keys.identity_cct.algorithm, "Ed25519");
  assert.equal(keys.identity_cct.private_format, "PKCS8-PEM");
  assert.equal(keys.runtime_instance_master.encoding, "raw");
  assert.equal(keys.runtime_instance_master.random_bytes, 32);
  assert.equal(keys.skill_maintenance.enabled_by_default, false);
  assert.equal(contract.development_pki.ca_private_key_service_mount, false);
  assert.equal(contract.development_pki.native_runtime_tls_supported, false);
  assert.equal(contract.development_pki.algorithm, "ECDSA-P256");
  assert.equal(contract.development_pki.private_format, "PKCS8-PEM");
  assert.equal(contract.development_pki.ca.path_length, 0);
  assert.equal(contract.development_pki.ca.valid_days, 365);
  assert.equal(contract.development_pki.leaf.valid_days, 30);
  assert.deepEqual(contract.development_pki.leaf.extended_key_usages, [
    "serverAuth",
    "clientAuth",
  ]);
});

test("credentials and private verification output are ignored before generation", () => {
  const paths = [
    `${contract.token_provisioning.output_directory}identity-service/cct-signing.pem`,
    `${contract.development_pki.output_directory}ca.key`,
    "artifacts/verification/development-authentication/tokens/identity-service",
  ];
  const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
    cwd: root,
    input: paths.join("\n"),
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.trim().split("\n"), paths);
  const dockerIgnore = readFileSync(resolve(root, ".dockerignore"), "utf8");
  assert.match(dockerIgnore, /^artifacts$/mu);
});

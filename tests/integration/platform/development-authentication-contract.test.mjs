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

test("development provisioning derives 25 static pairs from the nine owning catalogs", () => {
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
  assert.equal(pairs.size, 25);
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
  assert.equal(
    tokens.docker_socket_gid_environment,
    "ANTNEST_DOCKER_SOCKET_GID",
  );
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

test("the development port contract makes diagnostics an explicit loopback-only overlay", () => {
  const ports = contract.host_ports;
  assert(ports, "missing deployment host-port contract");
  assert.equal(ports.revision, 2);
  assert.equal(ports.debug_publisher, "diagnostic-relay");
  assert.equal(ports.base_file, "compose.yaml");
  assert.equal(ports.debug_file, "compose.debug.yaml");
  assert.equal(ports.host_ip, "127.0.0.1");
  assert.deepEqual(ports.base_publications, {
    "edge-gateway": {
      target: 8080,
      environment: "ANTNEST_EDGE_HOST_PORT",
      default: 8090,
    },
  });
  assert.deepEqual(Object.keys(ports.debug_publications).sort(), [
    "agent-acp-service",
    "agent-controller",
    "identity-service",
    "jaeger",
    "postgres",
    "runtime-controller",
    "temporal",
  ]);
  for (const [service, publication] of Object.entries(
    ports.debug_publications,
  )) {
    assert.equal(Object.keys(publication).length, 3, service);
    assert(Number.isSafeInteger(publication.target), service);
    assert(publication.target > 0 && publication.target <= 65535, service);
    assert(Number.isSafeInteger(publication.default), service);
    assert(publication.default > 0 && publication.default <= 65535, service);
    assert.match(publication.environment, /^ANTNEST_[A-Z_]+_HOST_PORT$/u);
  }
  assert.equal(ports.authentication, "unchanged");
  assert.equal(ports.stage3_port_suppression, "explicit-test-override");
  assert.equal(ports.runtime_management_publications, false);
  assert.equal(ports.health_listener_publications, false);
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

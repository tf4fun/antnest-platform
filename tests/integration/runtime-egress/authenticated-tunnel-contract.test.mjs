import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { test } from "node:test";
import Ajv from "../../../services/agent-acp-service/node_modules/ajv/dist/2020.js";

const read = (path) =>
  JSON.parse(
    readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"),
  );

test("revision 2 delegates encryption, nonces and replay to the fixed WireGuard profile", () => {
  const packet = read("contracts/runtime/packet-contract.json");
  assert.equal(packet.revision, 2);
  assert.equal(packet.transport, "wireguard-over-udp");
  assert.equal(packet.authentication.implementation, "boringtun");
  assert.equal(packet.authentication.implementation_version, "0.7.1");
  assert.equal(
    packet.authentication.profile,
    "Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s",
  );
  assert.equal(packet.authentication.prefix_bytes, 20);
  assert.equal(packet.authentication.prefix_magic_hex, "414e5432");
  assert(
    packet.inner_mtu + packet.authentication.max_data_overhead + 28 <= 1500,
  );
  assert.equal(packet.authentication.raw_packet_fallback, false);
});

test("key registration is private, generation-scoped and does not carry the Runtime private key", () => {
  const schema = read("contracts/egress/tunnel-key-request.schema.json");
  const ajv = new Ajv({ strict: true });
  ajv.addFormat("ipv4", {
    validate: (value) => isIP(value) === 4,
  });
  const validate = ajv.compile(schema);
  const good = {
    key_id: "rtk_" + "a".repeat(32),
    runtime_revision: "rtv_" + "b".repeat(32),
    tunnel_ipv4: "10.243.1.2",
    egress_private_key: "A".repeat(43),
    runtime_public_key: "B".repeat(43),
    preshared_key: "C".repeat(43),
  };
  assert(validate(good), JSON.stringify(validate.errors));
  for (const bad of [
    { ...good, runtime_private_key: "D".repeat(43) },
    { ...good, key_id: "rtk_bad" },
    { ...good, runtime_revision: "generation-1" },
    { ...good, preshared_key: "" },
  ])
    assert.equal(validate(bad), false);
});

test("open requires a current key while close clears peer identity", () => {
  const schema = read("contracts/egress/attachment-state-request.schema.json");
  const ajv = new Ajv({ strict: true });
  ajv.addFormat("ipv4", {
    validate: (value) => isIP(value) === 4,
  });
  const validate = ajv.compile(schema);
  const open = {
    state: "open",
    expected_resource_version: 1,
    runtime_endpoint: "10.243.1.2",
    tunnel_key_id: "rtk_" + "a".repeat(32),
  };
  assert(validate(open), JSON.stringify(validate.errors));
  const { tunnel_key_id, ...missingKey } = open;
  assert.equal(validate(missingKey), false);
  assert(validate({ state: "closed", expected_resource_version: 1 }));
  assert.equal(
    validate({ state: "closed", expected_resource_version: 1, tunnel_key_id }),
    false,
  );
});

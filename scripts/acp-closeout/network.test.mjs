import assert from "node:assert/strict";
import test from "node:test";
import { selectNetworkOctet, discoverNetworkOctet } from "./network.mjs";

test("test subnet pairs avoid either occupied side and enclosing or contained networks", () => {
  assert.equal(selectNetworkOctet([], 45), 45);
  assert.equal(selectNetworkOctet(["10.242.45.0/24"], 45), 46);
  assert.equal(selectNetworkOctet(["10.243.45.0/24"], 45), 46);
  assert.equal(selectNetworkOctet(["10.242.45.128/25"], 45), 46);
  assert.equal(selectNetworkOctet(["10.242.44.0/23"], 45), 46);
  assert.equal(selectNetworkOctet(["10.242.200.0/24"], 200), 1);
  assert.equal(selectNetworkOctet(["172.18.0.0/16", "fd00::/64"], 45), 45);
});

test("Docker discovery fails closed on command errors or incomplete IPAM data", () => {
  const discovery = (inspect) => (args) =>
    args[1] === "ls" ? "one\ntwo\n" : inspect;
  assert.equal(
    discoverNetworkOctet(
      discovery(
        JSON.stringify([
          { IPAM: { Config: null } },
          { IPAM: { Config: [{ Subnet: "10.242.45.0/24" }] } },
        ]),
      ),
      45,
    ),
    46,
  );
  for (const data of [
    "{",
    "null",
    "[]",
    "[{},{}]",
    '[{"IPAM":{}},{"IPAM":{}}]',
  ])
    assert.throws(() => discoverNetworkOctet(discovery(data), 45));
  assert.throws(() =>
    discoverNetworkOctet(() => {
      throw new Error("Docker unavailable");
    }, 45),
  );
});

test("unavailable or invalid IPAM discovery cannot manufacture a free subnet", () => {
  for (const subnets of [["10.0.0.0/8"], ["10.243.0.0/16"], ["0.0.0.0/0"]])
    assert.throws(() => selectNetworkOctet(subnets, 45), /No unused/);
  assert.throws(() => selectNetworkOctet(["invalid"], 45));
  for (const start of [0, 201, 1.5, NaN])
    assert.throws(() => selectNetworkOctet([], start));
});

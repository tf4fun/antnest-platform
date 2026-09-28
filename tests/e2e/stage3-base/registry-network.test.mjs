import assert from "node:assert/strict";
import test from "node:test";
import { inspectRegistryNetwork } from "./registry-network.mjs";

test("Registry probe binds the actual development IPv4 and proves IPv6 is absent", () => {
  const project = "antnest-skill-test";
  const name = `${project}_development`;
  const container = {
    Config: {
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.service": "skill-registry",
      },
    },
    NetworkSettings: {
      Networks: { [name]: { IPAddress: "172.28.0.9", GlobalIPv6Address: "" } },
    },
  };
  const network = { Name: name, EnableIPv6: false };
  assert.equal(
    inspectRegistryNetwork(container, network, project),
    "172.28.0.9",
  );
  assert.throws(() =>
    inspectRegistryNetwork(
      {
        ...container,
        NetworkSettings: {
          Networks: {
            [name]: { IPAddress: "172.28.0.9", GlobalIPv6Address: "fd00::9" },
          },
        },
      },
      network,
      project,
    ),
  );
  assert.throws(() =>
    inspectRegistryNetwork(
      {
        ...container,
        NetworkSettings: {
          Networks: {
            ...container.NetworkSettings.Networks,
            [`${project}_skill-registry-database`]: {
              IPAddress: "172.29.0.3",
              GlobalIPv6Address: "fd00::3",
            },
          },
        },
      },
      network,
      project,
    ),
  );
  assert.throws(() =>
    inspectRegistryNetwork(
      container,
      { ...network, EnableIPv6: true },
      project,
    ),
  );
  assert.throws(() =>
    inspectRegistryNetwork(
      {
        ...container,
        Config: {
          Labels: {
            ...container.Config.Labels,
            "com.docker.compose.project": "foreign",
          },
        },
      },
      network,
      project,
    ),
  );
});

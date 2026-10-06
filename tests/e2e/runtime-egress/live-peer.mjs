import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  dockerClient,
  lines,
  scopeLabel,
} from "../lifecycle-closeout/docker.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const project = process.env.TEST_DOCKER_PROJECT;
const docker = dockerClient(process.env, undefined, 600000);

async function attachment(agentID) {
  assert.match(project, /^antnest-lifecycle-[a-f0-9]{8}$/u);
  const token = resolve(
    process.env.ANTNEST_SERVICE_AUTH_DIRECTORY,
    "agent-controller/tokens/runtime-egress",
  );
  return JSON.parse(
    await docker([
      "run",
      "--rm",
      "--pull",
      "never",
      "--label",
      `com.docker.compose.project=${project}`,
      "--network",
      `${project}_control`,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--mount",
      `type=bind,src=${token},dst=/proof/token,readonly`,
      "--mount",
      `type=bind,src=${resolve(root, "tests/e2e/runtime-egress/read-attachment.mjs")},dst=/proof/read.mjs,readonly`,
      "node:24.21.0-bookworm-slim",
      "node",
      "/proof/read.mjs",
      `http://${process.env.ANTNEST_EGRESS_CONTROL_IPV4}:8081`,
      agentID,
    ]),
  );
}

async function runtimeContainer(agentID) {
  const ids = lines(
    await docker([
      "ps",
      "-aq",
      "--filter",
      `label=${scopeLabel}=${project}`,
      "--filter",
      `label=io.antnest.agent-id=${agentID}`,
    ]),
  );
  const rows = JSON.parse(await docker(["inspect", ...ids]));
  const runtimes = rows.filter(
    (row) => row.Config.Labels["io.antnest.managed"] === "runtime",
  );
  assert.equal(runtimes.length, 1, "expected one fixture-owned Runtime");
  assert.equal(runtimes[0].Config.Labels[scopeLabel], project);
  return runtimes[0];
}

export async function assertLivePeer(agentID, inspection, state, phase) {
  const network = await attachment(agentID);
  assert.equal(network.attachment_state, state, phase);
  if (state === "closed") {
    assert.equal(
      network.runtime_endpoint ?? null,
      null,
      "closed attachment retained peer",
    );
    return { phase, state, version: network.attachment_resource_version };
  }
  const container = await runtimeContainer(agentID);
  const actualIP =
    container.NetworkSettings.Networks[
      process.env.ANTNEST_RUNTIME_MANAGEMENT_NETWORK
    ]?.IPAddress;
  assert(actualIP, "Runtime has no management-network IPv4");
  assert.equal(inspection.runtime_endpoint, actualIP, "RC differs from Docker");
  assert.equal(
    network.runtime_endpoint,
    actualIP,
    "Egress differs from current Runtime",
  );
  return {
    phase,
    state,
    version: network.attachment_resource_version,
    runtime_endpoint: actualIP,
  };
}

export async function restartWithNewPeer(agentID, inspect) {
  const before = await assertLivePeer(
    agentID,
    await inspect(),
    "open",
    "before_restart",
  );
  const container = await runtimeContainer(agentID);
  const management = process.env.ANTNEST_RUNTIME_MANAGEMENT_NETWORK;
  const [network] = JSON.parse(
    await docker(["network", "inspect", management]),
  );
  assert.equal(network.Labels["com.docker.compose.project"], project);
  const subnet = network.IPAM.Config[0].Subnet;
  assert.match(subnet, /^10\.243\.\d+\.0\/24$/u);
  const prefix = subnet.slice(0, subnet.lastIndexOf(".") + 1);
  const used = new Set(
    Object.values(network.Containers ?? {}).map(
      (value) => value.IPv4Address.split("/")[0],
    ),
  );
  const address = Array.from(
    { length: 50 },
    (_, index) => `${prefix}${40 + index}`,
  ).find((value) => !used.has(value) && value !== before.runtime_endpoint);
  assert(address, "no free test address");
  await docker(["stop", "-t", "20", container.Id], true);
  await docker(["network", "disconnect", management, container.Id]);
  await docker([
    "network",
    "connect",
    "--ip",
    address,
    management,
    container.Id,
  ]);
  await docker(["start", container.Id], true);
  for (let attempt = 0; attempt < 60; attempt++) {
    const current = await inspect();
    if (current.phase === "running" && current.runtime_endpoint === address) {
      const bound = await attachment(agentID);
      if (
        bound.attachment_state === "open" &&
        bound.runtime_endpoint === address
      ) {
        assert(
          bound.attachment_resource_version > before.version,
          "rebind reused old CAS version",
        );
        return assertLivePeer(agentID, current, "open", "restart_new_address");
      }
    }
    await delay(500);
  }
  throw new Error(
    "Controller did not rebind the restarted Runtime's current address",
  );
}

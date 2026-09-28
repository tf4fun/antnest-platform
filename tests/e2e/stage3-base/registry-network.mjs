import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

export function inspectRegistryNetwork(container, network, project) {
  const name = `${project}_development`;
  assert.equal(container.Config.Labels["com.docker.compose.project"], project);
  assert.equal(
    container.Config.Labels["com.docker.compose.service"],
    "skill-registry",
  );
  assert.equal(network.Name, name);
  assert.equal(
    network.EnableIPv6,
    false,
    "IPv6 enabled: add a real IPv6 denial probe",
  );
  const attachment = container.NetworkSettings.Networks[name];
  assert(attachment, "Registry is not attached to the development network");
  for (const attached of Object.values(container.NetworkSettings.Networks))
    assert(
      !attached.GlobalIPv6Address,
      "Registry has an untested IPv6 address",
    );
  assert.equal(isIP(attachment.IPAddress), 4);
  return attachment.IPAddress;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [containerPath, networkPath, project] = process.argv.slice(2);
  assert(containerPath && networkPath && project);
  const containers = JSON.parse(await readFile(containerPath, "utf8"));
  const networks = JSON.parse(await readFile(networkPath, "utf8"));
  assert.equal(containers.length, 1);
  assert.equal(networks.length, 1);
  process.stdout.write(
    inspectRegistryNetwork(containers[0], networks[0], project),
  );
}

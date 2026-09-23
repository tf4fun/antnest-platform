import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const ipaddr = require("ipaddr.js");

export function selectNetworkOctet(subnets, start) {
  assert(
    Number.isInteger(start) && start >= 1 && start <= 200,
    "Invalid subnet seed",
  );
  const occupied = subnets.map((subnet) => ipaddr.parseCIDR(subnet));
  for (let offset = 0; offset < 200; offset++) {
    const octet = 1 + ((start - 1 + offset) % 200);
    const free = [242, 243].every((second) => {
      const address = ipaddr.parse(`10.${second}.${octet}.0`);
      return occupied.every(
        ([network, prefix]) =>
          network.kind() !== "ipv4" ||
          !address.match(network, Math.min(prefix, 24)),
      );
    });
    if (free) return octet;
  }
  throw new Error("No unused Docker test subnet pair");
}

export function discoverNetworkOctet(docker, start) {
  const ids = docker(["network", "ls", "-q"])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const networks = ids.length
    ? JSON.parse(docker(["network", "inspect", ...ids]))
    : [];
  assert(
    Array.isArray(networks) && networks.length === ids.length,
    "Incomplete Docker network discovery",
  );
  const subnets = networks.flatMap((network) => {
    assert(
      network.IPAM && "Config" in network.IPAM,
      "Missing Docker IPAM configuration",
    );
    const configs = network.IPAM.Config ?? [];
    assert(Array.isArray(configs), "Invalid Docker IPAM configuration");
    return configs.map((config) => config.Subnet);
  });
  return selectNetworkOctet(subnets, start);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const docker = (args) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    process.stdout.write(
      String(discoverNetworkOctet(docker, Number(process.argv[2]))),
    );
  } catch {
    console.error(
      "Could not select unused Docker test networks; inspect Docker IPAM allocations.",
    );
    process.exitCode = 1;
  }
}

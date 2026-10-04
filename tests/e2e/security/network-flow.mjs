import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { planNetworkMatrix } from "./network-matrix.mjs";
import { owned } from "../lifecycle-closeout/docker.mjs";

export async function runNetworkMatrix({
  config,
  docker,
  root,
  image,
  output,
}) {
  const contract = JSON.parse(
    readFileSync(
      resolve(
        root,
        "contracts/platform/development-authentication-contract.json",
      ),
      "utf8",
    ),
  );
  const topology = JSON.parse(
    readFileSync(
      resolve(root, "contracts/platform/development-network-contract.json"),
      "utf8",
    ),
  );
  const catalogs = Object.fromEntries(
    Object.entries(contract.static_services).map(([service, path]) => [
      service,
      JSON.parse(readFileSync(resolve(root, path), "utf8")),
    ]),
  );
  const containers = await owned(docker, config.project, "container");
  const networkIds = await owned(docker, config.project, "network");
  const rows = JSON.parse(await docker(["inspect", ...containers]));
  const networks = JSON.parse(
    await docker(["network", "inspect", ...networkIds]),
  );
  await writeFile(
    resolve(output, "network-inventory.json"),
    JSON.stringify({
      networks: networks.map(({ Name, Internal, Options, IPAM }) => ({
        Name,
        Internal,
        Options,
        IPAM,
      })),
      workloads: rows.map((row) => ({
        service: row.Config.Labels["com.docker.compose.service"],
        networks: row.NetworkSettings.Networks,
      })),
    }),
    { mode: 0o600, flag: "wx" },
  );
  const plans = planNetworkMatrix({
    project: config.project,
    topology,
    catalogs,
    rows,
    networks,
  });
  const report = [];
  for (const [index, plan] of plans.entries()) {
    const name = `${config.project}-security-network-${index}`;
    try {
      const text = await docker(
        [
          "run",
          "--name",
          name,
          "--label",
          `com.docker.compose.project=${config.project}`,
          "--network",
          plan.name,
          "--user",
          "65532:65532",
          "--read-only",
          "--cap-drop",
          "ALL",
          "-v",
          `${root}/tests:/tests:ro`,
          image,
          "node",
          "/tests/e2e/security/probe-network.mjs",
          JSON.stringify(plan),
        ],
        true,
      );
      const result = JSON.parse(text.trim().split("\n").at(-1));
      assert.equal(result.status, "passed");
      report.push(result);
      console.log(JSON.stringify({ stage: "security-network", ...result }));
    } catch (error) {
      const logs = await docker(["logs", name]).catch(
        () => "probe logs unavailable",
      );
      await writeFile(resolve(output, `network-${index}-failure.log`), logs, {
        mode: 0o600,
        flag: "wx",
      });
      throw error;
    } finally {
      await docker(["rm", "-f", name]);
    }
  }
  await writeFile(
    resolve(output, "network-matrix.json"),
    JSON.stringify(report),
    { mode: 0o600, flag: "wx" },
  );
  return report;
}

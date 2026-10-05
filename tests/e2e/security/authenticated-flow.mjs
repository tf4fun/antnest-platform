import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scopeLabel } from "../lifecycle-closeout/docker.mjs";
import { authenticatedPlan } from "./authenticated-plan.mjs";

export async function runAuthenticatedPeer({
  config,
  docker,
  root,
  image,
  agentId,
  mode,
  output,
}) {
  assert.equal(
    config.credentials,
    resolve(
      root,
      "artifacts/verification/authenticated-e2e",
      config.project,
      "credentials",
    ),
  );
  const topology = JSON.parse(
    readFileSync(
      resolve(root, "contracts/platform/development-network-contract.json"),
      "utf8",
    ),
  );
  const plan = authenticatedPlan({ config, topology, agentId, mode });
  if (mode === "admission") {
    const [runtime] = JSON.parse(
      await docker(["inspect", `antnest-runtime-${agentId}`]),
    );
    assert.equal(runtime.Config.Labels[scopeLabel], config.project);
    const network = config.env.ANTNEST_RUNTIME_MANAGEMENT_NETWORK;
    const address = runtime.NetworkSettings.Networks[network]?.IPAddress;
    assert.match(address, /^10\.243\.[1-9]\d?\d?\.\d+$/u);
    const port = Number(runtime.Config.Labels["io.antnest.runtime-port"]);
    assert(Number.isInteger(port) && port > 0 && port <= 65535);
    plan.endpoints.runtime = `http://antnest-runtime-${agentId}:${port}`;
    plan.networks.push(network);
  }
  const name = `${config.project}-authenticated-${mode}`;
  try {
    await docker(
      [
        "create",
        "--name",
        name,
        "--label",
        `com.docker.compose.project=${config.project}`,
        "--network",
        plan.networks[0],
        "--read-only",
        "--cap-drop",
        "ALL",
        "--user",
        `${config.env.ANTNEST_SERVICE_AUTH_UID}:${config.env.ANTNEST_SERVICE_AUTH_GID}`,
        ...plan.mounts.flatMap(({ source, destination }) => [
          "-v",
          `${source}:${destination}:ro`,
        ]),
        "-v",
        `${root}/tests:/tests:ro`,
        image,
        "node",
        "/tests/e2e/security/authenticated-peer.mjs",
        JSON.stringify({ mode, agent_id: agentId, endpoints: plan.endpoints }),
      ],
      true,
    );
    for (const network of plan.networks.slice(1))
      await docker(["network", "connect", network, name]);
    const text = await docker(["start", "-a", name], true);
    const result = JSON.parse(text.trim().split("\n").at(-1));
    assert.equal(result.status, "passed");
    await writeFile(
      resolve(output, `${mode}-authenticated.json`),
      JSON.stringify(result),
      { flag: "wx", mode: 0o600 },
    );
    return result;
  } catch (error) {
    await writeFile(
      resolve(output, `${mode}-authenticated-failure.log`),
      await docker(["logs", name]).catch(() => "peer logs unavailable"),
      { flag: "wx", mode: 0o600 },
    );
    throw error;
  } finally {
    await docker(["rm", "-f", name]);
  }
}

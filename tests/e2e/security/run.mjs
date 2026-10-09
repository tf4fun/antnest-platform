import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configuration,
  dockerClient,
  composeArgs,
  cleanup,
} from "../lifecycle-closeout/docker.mjs";
import { setup } from "../workspace-closeout/c4-setup.mjs";
import { runNetworkMatrix } from "./network-flow.mjs";
import { runAuthenticatedPeer } from "./authenticated-flow.mjs";
import {
  productionOverlay,
  configureWorkspaceNetworks,
  configureProductionSigning,
  resources,
} from "./stack.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const budgetMs = 900_000;

export async function runAuthenticationMatrix({
  configure = configuration,
  createDocker = dockerClient,
  prepareAgent = setup,
  networkMatrix = runNetworkMatrix,
  authenticatedPeer = runAuthenticatedPeer,
  clean = cleanup,
} = {}) {
  const abort = new AbortController();
  const interrupt = () =>
    abort.abort(new Error("Authentication matrix interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timer = setTimeout(interrupt, budgetMs);
  const failures = [];
  let config, output, baseline, result;
  try {
    config = await configure(abort.signal, (project) => {
      config = { project, env: process.env };
    });
    output = resolve(
      root,
      "artifacts/verification/authentication-matrix",
      config.project,
    );
    await mkdir(output, { recursive: true, mode: 0o700 });
    configureWorkspaceNetworks(config);
    configureProductionSigning(config);
    Object.assign(config.env, {
      ANTNEST_C4_AGENT_ACP_IMAGE: "antnest/agent-acp-service:local",
      ANTNEST_C4_AGENT_UI_IMAGE: "antnest/agent-ui:local",
      ANTNEST_E2E_AGENT_CONTROLLER_IMAGE: "antnest/agent-controller:local",
      ANTNEST_E2E_DISCOVERY_REGISTRY_IMAGE: "antnest/skill-registry:local",
      ANTNEST_E2E_PROPAGATION_CONSOLE_IMAGE: "antnest/admin-console:local",
      ANTNEST_E2E_PROPAGATION_RC_IMAGE: "antnest/runtime-controller:local",
    });
    const docker = createDocker(config.env, abort.signal, budgetMs);
    baseline = await resources(docker);
    await docker(
      composeArgs(config.project, [
        ...productionOverlay,
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "180",
        "--no-build",
        "--pull",
        "never",
      ]),
      true,
    );
    const input = {
      config,
      docker,
      root,
      image: config.env.ANTNEST_C4_AGENT_ACP_IMAGE,
      output,
    };
    const networks = await networkMatrix(input);
    const fixture = await prepareAgent(config, abort.signal);
    const authenticated = await authenticatedPeer({
      ...input,
      agentId: fixture.agentID,
      mode: "admission",
    });
    result = {
      status: "passed",
      project: config.project,
      networks: networks.length,
      network_checks: networks.reduce((sum, row) => sum + row.checks, 0),
      authenticated_checks: authenticated.checks.length,
    };
  } catch (error) {
    failures.push(error);
  } finally {
    clearTimeout(timer);
    abort.abort(new Error("Authentication matrix finished"));
    try {
      if (config) {
        const credentials = resolve(
          root,
          "artifacts/verification/authenticated-e2e",
          config.project,
          "credentials",
        );
        if (!config.credentials && existsSync(credentials))
          config.credentials = credentials;
        await clean(config);
        if (baseline) {
          const after = await resources(
            createDocker(config.env, undefined, 180_000),
          );
          await writeFile(
            resolve(output, "cleanup.json"),
            JSON.stringify({ before: baseline, after }),
            {
              flag: "wx",
              mode: 0o600,
            },
          );
          assert.deepEqual(
            after,
            baseline,
            "authentication matrix must preserve pre-existing Docker resources",
          );
        }
      }
    } catch (error) {
      failures.push(error);
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      "Service authentication matrix or cleanup failed",
    );
  result.cleanup = "verified";
  await writeFile(resolve(output, "result.json"), JSON.stringify(result), {
    flag: "wx",
    mode: 0o600,
  });
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.chdir(root);
  console.log(JSON.stringify(await runAuthenticationMatrix()));
}

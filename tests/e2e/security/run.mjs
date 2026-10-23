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
  scopeLabel,
} from "../lifecycle-closeout/docker.mjs";
import { setup } from "../workspace-closeout/c4-setup.mjs";
import { runNetworkMatrix } from "./network-flow.mjs";
import { runAuthenticatedPeer } from "./authenticated-flow.mjs";
import { prepareOwnerProfile } from "./owner-profile.mjs";
import { readOwnerRegistration } from "./owner-registration.mjs";
import {
  productionOverlay,
  configureWorkspaceNetworks,
  configureProductionSigning,
  resources,
} from "./stack.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const budgetMs = 900_000;

const imageVariables = [
  ["agent-acp-service", ["ANTNEST_C4_AGENT_ACP_IMAGE"]],
  ["agent-ui", ["ANTNEST_C4_AGENT_UI_IMAGE"]],
  [
    "agent-controller",
    ["ANTNEST_E2E_AGENT_CONTROLLER_IMAGE", "ANTNEST_C4_AGENT_CONTROLLER_IMAGE"],
  ],
  [
    "edge-gateway",
    ["ANTNEST_E2E_GATEWAY_IMAGE", "ANTNEST_C4_EDGE_GATEWAY_IMAGE"],
  ],
  ["identity-service", ["ANTNEST_E2E_IDENTITY_IMAGE"]],
  ["skill-registry", ["ANTNEST_E2E_DISCOVERY_REGISTRY_IMAGE"]],
  ["admin-console", ["ANTNEST_E2E_PROPAGATION_CONSOLE_IMAGE"]],
  [
    "runtime-controller",
    [
      "ANTNEST_E2E_PROPAGATION_RC_IMAGE",
      "ANTNEST_E2E_RUNTIME_CONTROLLER_IMAGE",
    ],
  ],
  ["runtime-egress", ["ANTNEST_E2E_EGRESS_IMAGE"]],
  ["temporal", ["ANTNEST_E2E_TEMPORAL_IMAGE"]],
];

// Capture only image selection before configuration removes inherited fixture
// variables. Every alias receives one value, including the final overlay wins.
export function matrixImageSelection(input = {}) {
  const environment = {},
    services = {};
  const select = (names, fallback) => {
    const present = names.filter((name) => Object.hasOwn(input, name));
    for (const name of present)
      assert(
        typeof input[name] === "string" &&
          input[name].length > 0 &&
          !/\s/u.test(input[name]),
        `invalid ${name}`,
      );
    assert(
      new Set(present.map((name) => input[name])).size <= 1,
      `conflicting ${names.join(" and ")}`,
    );
    return present.length ? input[present[0]] : fallback;
  };
  for (const [service, names] of imageVariables) {
    const ref = select(names, `antnest/${service}:local`);
    services[service] = ref;
    for (const name of names) environment[name] = ref;
  }
  return {
    services,
    environment,
    runtime: select(
      ["ANTNEST_E2E_RUNTIME_IMAGE"],
      "antnest/antnest-runtime:local",
    ),
  };
}

async function resolveMatrixImages(docker, selection) {
  const result = {};
  for (const [service, ref] of Object.entries({
    ...selection.services,
    runtime: selection.runtime,
  })) {
    const id = (
      await docker(["image", "inspect", "--format", "{{.Id}}", ref])
    ).trim();
    assert.match(
      id,
      /^sha256:[a-f0-9]{64}$/u,
      `${service}: missing selected image ID`,
    );
    result[service] = { ref, id };
  }
  return result;
}

export async function inspectMatrixImages({
  docker,
  config,
  expected,
  agentId,
  overlay = productionOverlay,
}) {
  const ids = (
    await docker(composeArgs(config.project, [...overlay, "ps", "-q"]))
  )
    .split(/\s+/u)
    .filter(Boolean);
  assert(ids.length > 0, "matrix has no Compose containers");
  const containers = JSON.parse(await docker(["inspect", ...ids]));
  const receipts = [];
  for (const [service, selected] of Object.entries(expected)) {
    if (service === "runtime") continue;
    const matches = containers.filter(
      (container) =>
        container.Config.Labels?.["com.docker.compose.project"] ===
          config.project &&
        container.Config.Labels?.["com.docker.compose.service"] === service,
    );
    assert.equal(
      matches.length,
      1,
      `${service}: missing or duplicate selected container`,
    );
    const [container] = matches;
    assert.equal(
      container.Config.Image,
      selected.ref,
      `${service}: container image reference differs`,
    );
    assert.equal(
      container.Image,
      selected.id,
      `${service}: container image ID differs`,
    );
    receipts.push({
      service,
      selected_ref: selected.ref,
      selected_id: selected.id,
      container_id: container.Id,
      container_ref: container.Config.Image,
      container_image_id: container.Image,
    });
  }
  const runtime = JSON.parse(
    await docker(["inspect", `antnest-runtime-${agentId}`]),
  );
  assert.equal(runtime.length, 1, "missing actual native Runtime");
  assert.equal(
    runtime[0].Config.Labels?.[scopeLabel],
    config.project,
    "Runtime is outside the fixture scope",
  );
  assert.equal(
    runtime[0].Config.Labels?.["io.antnest.agent-id"],
    agentId,
    "Runtime Agent differs",
  );
  assert.equal(
    runtime[0].Config.Labels?.["io.antnest.managed"],
    "runtime",
    "Runtime managed label differs",
  );
  assert.equal(
    runtime[0].Image,
    expected.runtime.id,
    "Runtime image ID differs",
  );
  receipts.push({
    service: "runtime",
    selected_ref: expected.runtime.ref,
    selected_id: expected.runtime.id,
    container_id: runtime[0].Id,
    container_ref: runtime[0].Config.Image,
    container_image_id: runtime[0].Image,
    scope: runtime[0].Config.Labels[scopeLabel],
    agent_id: runtime[0].Config.Labels["io.antnest.agent-id"],
    managed: runtime[0].Config.Labels["io.antnest.managed"],
  });
  return receipts;
}

export async function runAuthenticationMatrix({
  environment = process.env,
  configure = configuration,
  createDocker = dockerClient,
  prepareAgent = setup,
  networkMatrix = runNetworkMatrix,
  authenticatedPeer = runAuthenticatedPeer,
  clean = cleanup,
  ownerProfile = false,
  prepareOwner = prepareOwnerProfile,
  ownerRegistration = readOwnerRegistration,
  ownerBusiness = async (input) =>
    (await import("./owner-business.mjs")).runOwnerBusiness(input),
} = {}) {
  assert.equal(typeof ownerProfile, "boolean");
  const overlay = ownerProfile
    ? [...productionOverlay, "-f", "tests/e2e/security/owner.compose.yaml"]
    : productionOverlay;
  const selected = matrixImageSelection(environment);
  const abort = new AbortController();
  const interrupt = () =>
    abort.abort(new Error("Authentication matrix interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timer = setTimeout(interrupt, budgetMs);
  const failures = [];
  let config, output, baseline, result;
  try {
    config = await configure(
      abort.signal,
      (project) => {
        config = { project, env: process.env };
      },
      selected.runtime,
    );
    if (ownerProfile) await prepareOwner(config);
    output = resolve(
      root,
      "artifacts/verification/authentication-matrix",
      config.project,
    );
    await mkdir(output, { recursive: true, mode: 0o700 });
    configureWorkspaceNetworks(config);
    configureProductionSigning(config);
    Object.assign(config.env, selected.environment);
    const docker = createDocker(config.env, abort.signal, budgetMs);
    baseline = await resources(docker);
    const expectedImages = await resolveMatrixImages(docker, selected);
    await writeFile(
      resolve(output, "selected-images.json"),
      JSON.stringify(expectedImages),
      { flag: "wx", mode: 0o600 },
    );
    await docker(
      composeArgs(config.project, [
        ...overlay,
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
      signal: abort.signal,
    };
    let registration, business;
    if (ownerProfile) {
      registration = await ownerRegistration(input);
      await writeFile(
        resolve(output, "owner-registration.json"),
        JSON.stringify(registration),
        { flag: "wx", mode: 0o600 },
      );
    }
    const networks = await networkMatrix(input);
    const fixture = await prepareAgent(config, abort.signal);
    const imageReceipts = await inspectMatrixImages({
      docker,
      config,
      expected: expectedImages,
      agentId: fixture.agentID,
      overlay,
    });
    await writeFile(
      resolve(output, "actual-images.json"),
      JSON.stringify(imageReceipts),
      { flag: "wx", mode: 0o600 },
    );
    const authenticated = await authenticatedPeer({
      ...input,
      agentId: fixture.agentID,
      mode: "admission",
    });
    if (ownerProfile) {
      business = await ownerBusiness({ ...input, fixture });
      abort.signal.throwIfAborted();
      await writeFile(
        resolve(output, "owner-business.json"),
        JSON.stringify(business),
        { flag: "wx", mode: 0o600 },
      );
    }
    abort.signal.throwIfAborted();
    result = {
      status: "passed",
      ...(ownerProfile
        ? { owner_registration: registration, owner_business: business }
        : {}),
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

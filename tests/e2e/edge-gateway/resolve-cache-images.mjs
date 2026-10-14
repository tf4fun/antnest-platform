import assert from "node:assert/strict";
import { loadParticipantServices } from "./resolve-cache-owner-drain.mjs";

export const cacheCandidateServices = [
  ["admin-console", "ANTNEST_TLS_E2E_CONSOLE_IMAGE"],
  ["agent-acp-service", "ANTNEST_C4_AGENT_ACP_IMAGE"],
  ["agent-ui", "ANTNEST_C4_AGENT_UI_IMAGE"],
  ["agent-controller", "ANTNEST_C4_AGENT_CONTROLLER_IMAGE"],
  ["edge-gateway", "ANTNEST_C4_EDGE_GATEWAY_IMAGE"],
  ["identity-service", "ANTNEST_SECURITY_E2E_IDENTITY_IMAGE"],
  ["runtime-controller", "ANTNEST_SECURITY_E2E_RC_IMAGE"],
];
const imageID = (id) =>
  assert.match(id ?? "", /^sha256:[a-f0-9]{64}$/u, "selected image ID missing");
const imageRef = (ref, name) =>
  assert(
    typeof ref === "string" && ref.length > 0 && !/\s/u.test(ref),
    `${name} image reference missing or invalid`,
  );

// configuration() deliberately filters fixture environment names. Capture
// this choice first and pass it as its explicit Runtime image argument.
export function selectCacheRuntimeImage(environment = {}) {
  const ref = Object.hasOwn(environment, "ANTNEST_E2E_RUNTIME_IMAGE")
    ? environment.ANTNEST_E2E_RUNTIME_IMAGE
    : "antnest/antnest-runtime:local";
  imageRef(ref, "Runtime");
  return ref;
}

// Read the final rendered Compose selection before starting containers. A
// running container cannot supply its own expected image. Candidate IDs came
// from this checkout's completed builds; the Runtime ID was pinned at setup.
export function cacheImagePlan(config, compose, candidates) {
  const plan = {};
  for (const [service, variable] of cacheCandidateServices) {
    const ref = config.env[variable],
      id = candidates.get(ref);
    imageRef(ref, service);
    imageID(id);
    assert.equal(
      compose.services?.[service]?.image,
      ref,
      `final ${service} image differs`,
    );
    plan[service] = { ref, id };
  }
  assert.equal(
    compose.services["runtime-controller"].environment
      ?.ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE,
    plan["runtime-controller"].ref,
    "RC preparer must use the selected controller image",
  );
  imageRef(config.image, "Runtime");
  imageID(config.resolvedImage);
  const jaeger = compose.services?.jaeger?.image;
  imageRef(jaeger, "Jaeger");
  plan.jaeger = { ref: jaeger };
  plan.runtime = { ref: config.image, id: config.resolvedImage };
  return Object.fromEntries(
    loadParticipantServices.map((service) => [service, plan[service]]),
  );
}

// Compose may pull its pinned collector image during startup. Resolve that
// preselected reference, and reject any candidate/Runtime tag moved since it
// was pinned. The owner lifecycle separately checks all eight actual images.
export async function resolveCacheLoadImages(docker, plan) {
  const result = {};
  for (const service of loadParticipantServices) {
    const selected = plan[service];
    imageRef(selected?.ref, service);
    const id = (
      await docker(["image", "inspect", "--format", "{{.Id}}", selected.ref])
    ).trim();
    imageID(id);
    if (selected.id !== undefined)
      assert.equal(id, selected.id, `${service} selected image changed`);
    result[service] = id;
  }
  return result;
}

export async function inspectCacheCandidateImages({
  docker,
  compose,
  project,
  environment,
  candidates,
}) {
  const receipts = [];
  for (const [service, variable] of cacheCandidateServices) {
    const ref = environment[variable],
      expected = candidates.get(ref);
    imageRef(ref, service);
    imageID(expected);
    const id = (await docker(compose(["ps", "-q", service]))).trim();
    assert.match(
      id,
      /^[a-f0-9]{64}$/u,
      `${service} container missing or duplicated`,
    );
    const rows = JSON.parse(await docker(["inspect", id]));
    assert.equal(rows.length, 1, `${service} container missing or duplicated`);
    const [row] = rows;
    assert.equal(row.Id, id);
    assert.equal(row.Config.Labels?.["com.docker.compose.project"], project);
    assert.equal(row.Config.Labels?.["com.docker.compose.service"], service);
    assert.equal(
      row.Config.Image,
      ref,
      `${service} container image reference differs`,
    );
    assert.equal(row.Image, expected, `${service} container image ID differs`);
    if (service === "runtime-controller")
      assert.deepEqual(
        row.Config.Env.filter((entry) =>
          entry.startsWith("ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE="),
        ),
        [`ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE=${ref}`],
        "actual RC preparer image differs or is duplicated",
      );
    receipts.push({
      service,
      selected_ref: ref,
      selected_id: expected,
      container_id: id,
      container_ref: row.Config.Image,
      container_image_id: row.Image,
    });
  }
  return receipts;
}

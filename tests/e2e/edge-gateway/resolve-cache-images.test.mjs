import assert from "node:assert/strict";
import test from "node:test";
import * as imageTools from "./resolve-cache-images.mjs";
import {
  cacheCandidateServices,
  cacheImagePlan,
  resolveCacheLoadImages,
  selectCacheRuntimeImage,
} from "./resolve-cache-images.mjs";

const expectedServices = [
  ["admin-console", "ANTNEST_TLS_E2E_CONSOLE_IMAGE"],
  ["agent-acp-service", "ANTNEST_C4_AGENT_ACP_IMAGE"],
  ["agent-ui", "ANTNEST_C4_AGENT_UI_IMAGE"],
  ["agent-controller", "ANTNEST_C4_AGENT_CONTROLLER_IMAGE"],
  ["edge-gateway", "ANTNEST_C4_EDGE_GATEWAY_IMAGE"],
  ["identity-service", "ANTNEST_SECURITY_E2E_IDENTITY_IMAGE"],
  ["runtime-controller", "ANTNEST_SECURITY_E2E_RC_IMAGE"],
];
const imageID = (n) => "sha256:" + n.toString(16).repeat(64);
function fixture() {
  const config = {
    env: {},
    image: "antnest/antnest-runtime:current-candidate",
    resolvedImage: imageID(8),
  };
  const compose = { services: {} },
    candidates = new Map();
  for (const [index, [service, variable]] of expectedServices.entries()) {
    const ref = `antnest/${service}:cache-current-candidate`;
    config.env[variable] = ref;
    compose.services[service] = { image: ref };
    candidates.set(ref, imageID(index + 1));
  }
  compose.services["runtime-controller"].environment = {
    ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE:
      config.env.ANTNEST_SECURITY_E2E_RC_IMAGE,
  };
  compose.services.jaeger = {
    image: "cr.jaegertracing.io/jaegertracing/jaeger:2.21.0",
  };
  return { config, compose, candidates };
}

test("cache builds the current Controller alongside all other changed services", () => {
  assert.deepEqual(cacheCandidateServices, expectedServices);
});

test("explicit Runtime selection survives configuration filtering", () => {
  const environment = {
    ANTNEST_E2E_RUNTIME_IMAGE: "antnest/antnest-runtime:current-candidate",
  };
  const selected = selectCacheRuntimeImage(environment);
  delete environment.ANTNEST_E2E_RUNTIME_IMAGE;
  assert.equal(selected, "antnest/antnest-runtime:current-candidate");
  assert.equal(selectCacheRuntimeImage({}), "antnest/antnest-runtime:local");
  for (const value of ["", "bad image", "\n", null])
    assert.throws(
      () => selectCacheRuntimeImage({ ANTNEST_E2E_RUNTIME_IMAGE: value }),
      /Runtime image/u,
    );
});

test("load participants are selected from final Compose before inspecting actual containers", async () => {
  const f = fixture();
  const plan = cacheImagePlan(f.config, f.compose, f.candidates);
  const calls = [];
  const docker = async (args) => {
    calls.push(args);
    assert.deepEqual(args.slice(0, 4), [
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
    ]);
    if (args[4] === f.config.image) return f.config.resolvedImage;
    if (args[4] === f.compose.services.jaeger.image) return imageID(9);
    assert(f.candidates.has(args[4]));
    return f.candidates.get(args[4]);
  };
  const selected = await resolveCacheLoadImages(docker, plan);
  assert.deepEqual(
    Object.keys(selected).sort(),
    [
      "agent-ui",
      "edge-gateway",
      "identity-service",
      "agent-acp-service",
      "agent-controller",
      "runtime-controller",
      "jaeger",
      "runtime",
    ].sort(),
  );
  assert.equal(selected["agent-controller"], imageID(4));
  assert.equal(selected.runtime, imageID(8));
  assert.equal(selected.jaeger, imageID(9));
  assert(calls.every((args) => args[0] === "image"));
  // A later mutation of config/Compose must not silently redefine the plan.
  f.compose.services["agent-controller"].image =
    "antnest/agent-controller:local";
  f.config.resolvedImage = imageID(1);
  assert.equal(plan.runtime.id, imageID(8));
  assert.equal(
    plan["agent-controller"].ref,
    "antnest/agent-controller:cache-current-candidate",
  );
});

for (const [name, mutate] of [
  [
    "stale final Controller",
    (f) => {
      f.compose.services["agent-controller"].image =
        "antnest/agent-controller:local";
    },
  ],
  [
    "missing built Controller",
    (f) => {
      f.candidates.delete(f.config.env.ANTNEST_C4_AGENT_CONTROLLER_IMAGE);
    },
  ],
  [
    "different RC preparer",
    (f) => {
      f.compose.services[
        "runtime-controller"
      ].environment.ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE =
        "antnest/runtime-controller:local";
    },
  ],
  [
    "unselected Runtime ID",
    (f) => {
      delete f.config.resolvedImage;
    },
  ],
  [
    "missing collector image",
    (f) => {
      delete f.compose.services.jaeger.image;
    },
  ],
])
  test(`cache image selection rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => cacheImagePlan(f.config, f.compose, f.candidates));
  });

for (const service of ["agent-controller", "runtime"])
  test(`load image resolution rejects a retagged ${service}`, async () => {
    const f = fixture();
    const plan = cacheImagePlan(f.config, f.compose, f.candidates);
    await assert.rejects(
      () =>
        resolveCacheLoadImages(async (args) => {
          if (args.at(-1) === plan[service].ref) return imageID(15);
          return (
            Object.values(plan).find((row) => row.ref === args.at(-1))?.id ??
            imageID(9)
          );
        }, plan),
      /selected image changed/u,
    );
  });

test("load image resolution rejects a missing actual collector image", async () => {
  const f = fixture();
  const plan = cacheImagePlan(f.config, f.compose, f.candidates);
  await assert.rejects(
    () =>
      resolveCacheLoadImages(async (args) => {
        const row = Object.values(plan).find(
          (entry) => entry.ref === args.at(-1),
        );
        return row.id ?? "";
      }, plan),
    /image ID/u,
  );
});

function deploymentFixture() {
  const f = fixture();
  const project = "antnest-lifecycle-abcdef12";
  const containers = expectedServices.map(([service, variable], index) => ({
    Id: (index + 1).toString(16).repeat(64),
    Image: f.candidates.get(f.config.env[variable]),
    Config: {
      Image: f.config.env[variable],
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.service": service,
      },
      Env:
        service === "runtime-controller"
          ? [`ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE=${f.config.env[variable]}`]
          : [],
    },
  }));
  const input = {
    project,
    environment: f.config.env,
    candidates: f.candidates,
    compose: (args) => ["compose", ...args],
    docker: async (args) => {
      if (args[0] === "compose")
        return containers.find(
          (row) =>
            row.Config.Labels["com.docker.compose.service"] === args.at(-1),
        ).Id;
      assert.equal(args[0], "inspect");
      return JSON.stringify(containers.filter((row) => row.Id === args[1]));
    },
  };
  return { input, containers };
}

test("actual deployment checks all seven candidates including setup Console and RC preparer", async () => {
  const f = deploymentFixture();
  const receipts = await imageTools.inspectCacheCandidateImages(f.input);
  assert.equal(receipts.length, 7);
  assert.equal(
    receipts.find((row) => row.service === "admin-console").container_id,
    f.containers[0].Id,
  );
});

for (const [name, mutate] of [
  [
    "same ID under wrong Console tag",
    (rows) => {
      rows[0].Config.Image = "antnest/admin-console:local";
    },
  ],
  [
    "wrong Controller image ID",
    (rows) => {
      rows[3].Image = imageID(15);
    },
  ],
  [
    "foreign project",
    (rows) => {
      rows[1].Config.Labels["com.docker.compose.project"] = "foreign";
    },
  ],
  [
    "wrong RC preparer",
    (rows) => {
      rows[6].Config.Env = [
        "ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE=antnest/runtime-controller:local",
      ];
    },
  ],
  [
    "duplicate RC preparer",
    (rows) => {
      rows[6].Config.Env.push(rows[6].Config.Env[0]);
    },
  ],
])
  test(`actual cache deployment rejects ${name}`, async () => {
    const f = deploymentFixture();
    mutate(f.containers);
    await assert.rejects(() => imageTools.inspectCacheCandidateImages(f.input));
  });

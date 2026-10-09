import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { composeConfig } from "../../support/compose-config.mjs";
import { dependencyPlan } from "../../support/dependencies.mjs";

const root = new URL("../../../", import.meta.url);
const require = createRequire(
  new URL("services/agent-acp-service/package.json", root),
);
const { parse } = require("yaml");
const source = (file) => readFileSync(new URL(file, root), "utf8");
const compose = parse(source("compose.yaml"));
const optIn = "ANTNEST_ALLOW_PUBLIC_DEV_SECRETS";
const checkers = [
  "postgres",
  "temporal-databases",
  "temporal-schema",
  "temporal",
  "skill-registry-database-init",
];
const scripts = {
  postgres: "scripts/postgres-entrypoint.sh",
  "temporal-databases": "scripts/temporal/init-databases.sh",
  "temporal-schema": "scripts/temporal/setup-schema.sh",
  "skill-registry-database-init": "scripts/skill-registry/init-database.sh",
};

function assertWiring(services) {
  for (const [name, file] of Object.entries(scripts)) {
    const service = services[name];
    const target = `/scripts/${file.split("/").at(-1)}`;
    assert.deepEqual(service.entrypoint, ["sh", target]);
    assert(
      service.volumes.some((volume) =>
        typeof volume === "string"
          ? volume === `./${file}:${target}:ro`
          : volume.source.endsWith(`/${file}`) &&
            volume.target === target &&
            volume.read_only === true,
      ),
      `${name} entrypoint mount`,
    );
    assert(
      service.volumes.some((volume) =>
        typeof volume === "string"
          ? volume ===
            "./scripts/development-secret-admission.sh:/scripts/development-secret-admission.sh:ro"
          : volume.source.endsWith(
              "/scripts/development-secret-admission.sh",
            ) &&
            volume.target === "/scripts/development-secret-admission.sh" &&
            volume.read_only === true,
      ),
      `${name} admission mount`,
    );
    assert(
      source(file).includes("sh /scripts/development-secret-admission.sh"),
    );
  }
  assert.deepEqual(services.postgres.command, ["postgres"]);
  assert.equal(
    services.temporal.build.dockerfile,
    "scripts/temporal/Dockerfile",
  );
  assert(services.temporal.entrypoint == null);
}

test("dependency source wiring gates every start with read-only admission mounts", () => {
  assertWiring(compose.services);
  assert.match(source(scripts.postgres), /exec docker-entrypoint\.sh "\$@"/u);
});

test("Temporal image preserves upstream entrypoint metadata, command, user and arguments", () => {
  const dockerfile = source("scripts/temporal/Dockerfile");
  assert.match(
    dockerfile,
    /FROM temporalio\/server:1\.32\.0 AS server\nFROM server/u,
  );
  assert.match(
    dockerfile,
    /COPY --from=server --chmod=0555 \/etc\/temporal\/entrypoint\.sh \/etc\/temporal\/entrypoint-upstream\.sh/u,
  );
  assert.match(
    dockerfile,
    /COPY --chmod=0555 scripts\/temporal\/entrypoint\.sh \/etc\/temporal\/entrypoint\.sh/u,
  );
  assert.match(
    dockerfile,
    /COPY --chmod=0555 scripts\/development-secret-admission\.sh \/etc\/temporal\/development-secret-admission\.sh/u,
  );
  assert.doesNotMatch(dockerfile, /^(?:ENTRYPOINT|CMD|USER|WORKDIR)\s/mu);
  const entry = source("scripts/temporal/entrypoint.sh");
  assert.match(entry, /POSTGRES_PWD/u);
  assert.match(
    entry,
    /sh \/etc\/temporal\/development-secret-admission\.sh ANTNEST_TEMPORAL_POSTGRES_PASSWORD/u,
  );
  assert.match(entry, /exec \/etc\/temporal\/entrypoint-upstream\.sh "\$@"/u);
});

test("all standard Compose files exclude the public-secret opt-in", () => {
  for (const file of [
    "compose.yaml",
    "compose.stage3.yaml",
    "compose.debug.yaml",
    "compose.controller-development.yaml",
  ])
    assert(!source(file).includes(optIn), file);
});

test("disposable fixture override explicitly opts in every checker and existing owner", () => {
  const policy = JSON.parse(
    source("contracts/platform/development-secrets.json"),
  );
  assert.deepEqual(
    Object.keys(policy.dependency_owners).sort(),
    [...checkers].sort(),
  );
  const { services } = parse(
    source("tests/support/compose.public-development-secrets.yaml"),
  );
  for (const name of [
    ...checkers,
    "identity-service",
    "agent-controller",
    "runtime-controller",
    "skill-registry",
    "agent-acp-service",
    "runtime-egress",
  ])
    assert.equal(
      services[name]?.environment[optIn],
      `\${${optIn}:?disposable fixture must opt in}`,
      name,
    );
});

test("Controller's isolated random-password fixture supplies admission scripts without an opt-in", () => {
  const { services } = parse(
    source("tests/e2e/service-authentication/controller/compose.yaml"),
  );
  for (const name of ["temporal-databases", "temporal-schema"])
    assert(
      services[name].volumes.includes(
        "../../../../scripts/development-secret-admission.sh:/scripts/development-secret-admission.sh:ro",
      ),
      name,
    );
  for (const name of [
    "postgres",
    "temporal-databases",
    "temporal-schema",
    "temporal",
  ])
    assert.equal(services[name].environment[optIn], undefined, name);
  const run = source("tests/e2e/service-authentication/controller/run.mjs");
  assert.match(run, /CONTROLLER_TEST_TEMPORAL_PASSWORD: randomBytes/u);
});

test("Tier A dependency passwords are private and pass admission without container opt-in", () => {
  const plan = dependencyPlan("temporal", {});
  const { published_values: published } = JSON.parse(
    source("contracts/platform/development-secrets.json"),
  );
  for (const variable of [
    "ANTNEST_POSTGRES_ADMIN_PASSWORD",
    "ANTNEST_TEMPORAL_POSTGRES_PASSWORD",
  ])
    assert(!published.includes(plan.env[variable]), variable);
  assert(
    !plan.compose.some((arg) =>
      arg.endsWith("compose.public-development-secrets.yaml"),
    ),
  );
});

test("Compose renders every dependency checker without an inherited gate and opts in only via the disposable override", () => {
  const standard = composeConfig([
    "compose.yaml",
    "compose.stage3.yaml",
    "compose.debug.yaml",
    "compose.controller-development.yaml",
  ]);
  assertWiring(standard.services);
  for (const service of Object.values(standard.services))
    assert.equal(service.environment?.[optIn], undefined);
  const disposable = composeConfig([
    "compose.yaml",
    "tests/support/compose.public-development-secrets.yaml",
  ]);
  assertWiring(disposable.services);
  for (const name of checkers)
    assert.equal(disposable.services[name].environment[optIn], "true", name);
  const plan = dependencyPlan("temporal", {});
  const dependencies = composeConfig(
    [
      "compose.yaml",
      "compose.debug.yaml",
      "tests/support/compose.dependencies.yaml",
    ],
    plan.env,
  );
  for (const name of checkers)
    assert.equal(
      dependencies.services[name].environment[optIn],
      undefined,
      name,
    );
});

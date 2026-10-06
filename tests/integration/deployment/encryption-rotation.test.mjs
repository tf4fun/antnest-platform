import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { composeConfig } from "../../support/compose-config.mjs";
import { fixtureEnvironment } from "../../support/authenticated-e2e.mjs";

const owners = [
  ["identity-service", "ANTNEST_IDENTITY"],
  ["agent-controller", "ANTNEST_AGENT_CONTROLLER"],
];
const first = Buffer.from("0123456789abcdef0123456789abcdef").toString(
  "base64",
);
const second = Buffer.from("fedcba9876543210fedcba9876543210").toString(
  "base64",
);

test("single-key and ring configuration also render with the CI Compose parser", () => {
  const command = process.env.ANTNEST_TEST_COMPOSE_BINARY
    ? [process.env.ANTNEST_TEST_COMPOSE_BINARY]
    : ["docker", "compose"];
  const files = [
    "compose.yaml",
    "compose.debug.yaml",
    "compose.stage3.yaml",
    "tests/e2e/lifecycle-closeout/compose.yaml",
  ];
  for (const [service, prefix] of owners) {
    for (const mode of ["single", "ring"]) {
      const values =
        mode === "single"
          ? {
              [`${prefix}_ENCRYPTION_KEY`]: first,
              [`${prefix}_ENCRYPTION_KEYS`]: undefined,
              [`${prefix}_ENCRYPTION_ACTIVE_KID`]: undefined,
            }
          : {
              [`${prefix}_ENCRYPTION_KEY`]: "",
              [`${prefix}_ENCRYPTION_KEYS`]: `kid2:${second}`,
              [`${prefix}_ENCRYPTION_ACTIVE_KID`]: "kid2",
            };
      const actual = composeConfig(
        files,
        {
          ...fixtureEnvironment(
            {},
            { project: "antnest-lifecycle-1234abcd", octet: 45 },
          ),
          ANTNEST_POSTGRES_HOST_PORT: "55432",
          ANTNEST_JAEGER_UI_HOST_PORT: "16686",
          ANTNEST_LIFECYCLE_MODEL_HOST_PORT: "18088",
          ...values,
        },
        command,
      );
      const environment = actual.services[service].environment;
      for (const [name, value] of Object.entries(values))
        assert.equal(environment[name], value ?? "", `${mode} ${name}`);
    }
  }
});

test("Compose leaves missing and conflicting modes unchanged for owner startup rejection", () => {
  for (const [service, prefix] of owners) {
    for (const mode of ["missing", "conflicting"]) {
      const values = {
        [`${prefix}_ENCRYPTION_KEY`]: mode === "missing" ? "" : first,
        [`${prefix}_ENCRYPTION_KEYS`]:
          mode === "missing" ? "" : `kid2:${second}`,
        [`${prefix}_ENCRYPTION_ACTIVE_KID`]: mode === "missing" ? "" : "kid2",
      };
      const actual = composeConfig(["compose.yaml"], values);
      for (const [name, value] of Object.entries(values))
        assert.equal(actual.services[service].environment[name], value);
    }
  }
});

test("each stored-secret owner can move from single key through rotation to retirement in standard Compose", () => {
  const baseline = composeConfig();
  for (const [service, prefix] of owners) {
    assert(baseline.services[service].environment[`${prefix}_ENCRYPTION_KEY`]);
    for (const [ring, active] of [
      [`local-v1:${first},kid2:${second}`, "local-v1"],
      [`local-v1:${first},kid2:${second}`, "kid2"],
      [`kid2:${second}`, "kid2"],
    ]) {
      const actual = composeConfig(["compose.yaml"], {
        [`${prefix}_ENCRYPTION_KEY`]: "",
        [`${prefix}_ENCRYPTION_KEYS`]: ring,
        [`${prefix}_ENCRYPTION_ACTIVE_KID`]: active,
      });
      const environment = actual.services[service].environment;
      assert.equal(environment[`${prefix}_ENCRYPTION_KEY`], "");
      assert.equal(environment[`${prefix}_ENCRYPTION_KEYS`], ring);
      assert.equal(environment[`${prefix}_ENCRYPTION_ACTIVE_KID`], active);
      assert.equal(
        actual.services["agent-acp-service"].environment
          .ANTNEST_ACP_CLIENT_MCP_KEY,
        baseline.services["agent-acp-service"].environment
          .ANTNEST_ACP_CLIENT_MCP_KEY,
      );
      assert.deepEqual(
        actual.services[service].networks,
        baseline.services[service].networks,
      );
    }
  }
});

test("both consumers include the encryption module in standalone builds, image inputs and CI", () => {
  const read = (file) =>
    readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
  for (const [service] of owners) {
    const dependency =
      "github.com/tf4fun/antnest-platform/modules/secret-encryption";
    assert(read(`services/${service}/go.mod`).includes(dependency));
    assert(
      read(`services/${service}/go.mod`).includes(
        "../../modules/secret-encryption",
      ),
    );
    assert(
      read(`services/${service}/Dockerfile`)
        .split("\n")
        .some(
          (line) =>
            line.startsWith("COPY modules/secret-encryption ") &&
            line.endsWith("/modules/secret-encryption"),
        ),
    );
    assert.equal(
      read(`.github/workflows/${service}.yml`).split(
        "- modules/secret-encryption/**",
      ).length,
      3,
    );
  }
  assert(read("go.work").includes("./modules/secret-encryption"));
  assert(
    read(".github/workflows/shared-go-encryption.yml").includes(
      'GOWORK: "off"',
    ),
  );
});

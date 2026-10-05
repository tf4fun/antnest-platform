import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { composeConfig } from "../../support/compose-config.mjs";

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

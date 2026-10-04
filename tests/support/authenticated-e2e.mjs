import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { provisionTokens } from "../../scripts/dev-service-tokens.mjs";
import { durablePath } from "./storage.mjs";

export function fixtureEnvironment(inherited, { project, octet }) {
  assert.match(project, /^antnest-lifecycle-[a-f0-9]{8}$/u);
  assert(Number.isInteger(octet) && octet >= 1 && octet <= 200);
  return {
    ...Object.fromEntries(
      Object.entries(inherited).filter(
        ([key]) => !/^(?:ANTNEST_|COMPOSE_|OTEL_)/u.test(key),
      ),
    ),
    COMPOSE_PROJECT_NAME: project,
    ANTNEST_SERVICE_NETWORK_PREFIX: `10.244.${octet}`,
    ANTNEST_RUNTIME_CONTROLLER_SCOPE: project,
    ANTNEST_RUNTIME_MANAGEMENT_NETWORK: `${project}-runtime-management`,
    ANTNEST_RUNTIME_SYSTEM_SKILLS_VOLUME: `${project}-system-skills`,
    ANTNEST_RUNTIME_MANAGEMENT_SUBNET: `10.243.${octet}.0/24`,
    ANTNEST_RUNTIME_MANAGEMENT_IP_RANGE: `10.243.${octet}.128/25`,
    ANTNEST_EGRESS_IPV4: `10.243.${octet}.3`,
    ANTNEST_RUNTIME_OTLP_INGRESS_IPV4: `10.243.${octet}.4`,
    ANTNEST_RUNTIME_CONTROLLER_MANAGEMENT_IPV4: `10.243.${octet}.5`,
    ANTNEST_ACP_MANAGEMENT_IPV4: `10.243.${octet}.6`,
    ANTNEST_EGRESS_CONTROL_SUBNET: `10.242.${octet}.0/24`,
    ANTNEST_EGRESS_CONTROL_IPV4: `10.242.${octet}.3`,
    ANTNEST_AGENT_CONTROLLER_CONTROL_IPV4: `10.242.${octet}.4`,
    ANTNEST_RUNTIME_OTEL_EXPORTER_OTLP_ENDPOINT: `http://10.243.${octet}.4:4318`,
    ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS: "false",
  };
}

export function prepareFixtureCredentials(project, root) {
  assert.match(project, /^antnest-lifecycle-[a-f0-9]{8}$/u);
  const parent = durablePath(
    resolve(root, "artifacts/verification/authenticated-e2e", project),
  );
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const credentials = resolve(parent, "credentials");
  provisionTokens({ output: credentials });
  return {
    credentials,
    environment: parseEnv(
      readFileSync(resolve(credentials, "deployment.env"), "utf8"),
    ),
  };
}

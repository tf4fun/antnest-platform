import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { prepareEgressOwnership } from "../../scripts/dev-egress-auth-owner.mjs";
import { provisionTokens } from "../../scripts/dev-service-tokens.mjs";
import { resolveDockerSocketGid } from "../../scripts/docker-socket-gid.mjs";
import { durablePath } from "./storage.mjs";
import { publicDevelopmentSecrets } from "./public-development-secrets.mjs";

const project =
  /^antnest-(?:lifecycle-[a-f0-9]{8}|stage3-e2e-[1-9][0-9]{0,9})$/u;

export function fixtureEnvironment(inherited, { project: name, octet }) {
  assert.match(name, project);
  assert(Number.isInteger(octet) && octet >= 1 && octet <= 200);
  return {
    ...Object.fromEntries(
      Object.entries(inherited).filter(
        ([key]) =>
          !/^(?:ANTNEST_|COMPOSE_|OTEL_|TEST_GATEWAY_PUBLIC_URL$)/u.test(key),
      ),
    ),
    ...publicDevelopmentSecrets(),
    COMPOSE_PROJECT_NAME: name,
    ANTNEST_SERVICE_NETWORK_PREFIX: `10.244.${octet}`,
    ANTNEST_RUNTIME_CONTROLLER_SCOPE: name,
    ANTNEST_RUNTIME_MANAGEMENT_NETWORK: `${name}-runtime-management`,
    ANTNEST_RUNTIME_SYSTEM_SKILLS_VOLUME: `${name}-system-skills`,
    ANTNEST_RUNTIME_MANAGEMENT_SUBNET: `10.243.${octet}.0/24`,
    ANTNEST_RUNTIME_MANAGEMENT_IP_RANGE: `10.243.${octet}.128/25`,
    ANTNEST_EGRESS_IPV4: `10.243.${octet}.3`,
    ANTNEST_RUNTIME_OTLP_INGRESS_IPV4: `10.243.${octet}.4`,
    ANTNEST_RUNTIME_CONTROLLER_MANAGEMENT_IPV4: `10.243.${octet}.5`,
    ANTNEST_ACP_MANAGEMENT_IPV4: `10.243.${octet}.6`,
    ANTNEST_EGRESS_CONTROL_SUBNET: `10.242.${octet}.0/24`,
    ANTNEST_EGRESS_CONTROL_IPV4: `10.242.${octet}.3`,
    ANTNEST_AGENT_CONTROLLER_CONTROL_IPV4: `10.242.${octet}.4`,
    ANTNEST_RUNTIME_CONTROLLER_CONTROL_IPV4: `10.242.${octet}.5`,
    ANTNEST_RUNTIME_OTEL_EXPORTER_OTLP_ENDPOINT: `http://10.243.${octet}.4:4318`,
    ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS: "false",
  };
}

export function prepareFixtureCredentials(name, root, dockerSocketGid = "") {
  assert.match(name, project);
  const parent = durablePath(
    resolve(root, "artifacts/verification/authenticated-e2e", name),
  );
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const credentials = resolve(parent, "credentials");
  provisionTokens({ output: credentials, dockerSocketGid });
  return {
    credentials,
    environment: parseEnv(
      readFileSync(resolve(credentials, "deployment.env"), "utf8"),
    ),
  };
}

export function shellExports(env) {
  return Object.entries(env)
    .map(([key, value]) => {
      assert.match(key, /^[A-Z_][A-Z0-9_]*$/u);
      return `export ${key}='${String(value).replaceAll("'", "'\\''")}'\n`;
    })
    .join("");
}

export async function shellEnvironment(name, octet, root, invoke) {
  const environment = fixtureEnvironment({}, { project: name, octet });
  const prepared = prepareFixtureCredentials(
    name,
    root,
    await resolveDockerSocketGid(invoke, ""),
  );
  await prepareEgressOwnership(invoke, prepared.credentials);
  return shellExports({ ...environment, ...prepared.environment });
}

// Shell entrypoints evaluate this output to join the same disposable
// deployment as the Node fixtures.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [name, octet] = process.argv.slice(2);
  process.stdout.write(
    await shellEnvironment(
      name,
      Number(octet),
      fileURLToPath(new URL("../../", import.meta.url)),
      // Socket GID detection reads the probe's stdout; this script's own
      // stdout is reserved for the exported environment.
      (args) =>
        execFileSync("docker", args, {
          encoding: "utf8",
          timeout: 30000,
          stdio: ["ignore", "pipe", "pipe"],
        }),
    ),
  );
}

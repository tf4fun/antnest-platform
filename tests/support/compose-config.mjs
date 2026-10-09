import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { publicDevelopmentSecrets } from "./public-development-secrets.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(
  new URL("../../services/agent-acp-service/package.json", import.meta.url),
);
const { parse } = require("yaml");
const source = parse(
  readFileSync(new URL("../../compose.yaml", import.meta.url), "utf8"),
);
const profiles = [
  ...new Set([
    ...Object.values(source.services).flatMap(
      (service) => service.profiles ?? [],
    ),
    "diagnostics",
  ]),
];

export function composeConfig(
  files = ["compose.yaml"],
  overrides = {},
  command = ["docker", "compose"],
) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(?:ANTNEST_|COMPOSE_|OTEL_)/u.test(key),
    ),
  );
  const result = spawnSync(
    command[0],
    [
      ...command.slice(1),
      "--env-file",
      "/dev/null",
      "--project-name",
      "antnest-wiring-contract",
      ...files.flatMap((file) => ["-f", file]),
      ...profiles.flatMap((profile) => ["--profile", profile]),
      "config",
      "--format",
      "json",
    ],
    {
      cwd: root,
      env: {
        ...env,
        ...publicDevelopmentSecrets(),
        COMPOSE_DISABLE_ENV_FILE: "1",
        ANTNEST_SERVICE_AUTH_DIRECTORY: "/never-mounted-deployment-credentials",
        ANTNEST_SERVICE_AUTH_UID: "65532",
        ANTNEST_SERVICE_AUTH_GID: "65532",
        ANTNEST_DOCKER_SOCKET_GID: "998",
        ANTNEST_IDENTITY_CCT_SIGNING_KID: "wiring-contract-unused",
        ...overrides,
      },
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

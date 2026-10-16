import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { composeListeners } from "./compose-listeners.mjs";
import { costHarnessArguments } from "../e2e/acp-cost/deployment.mjs";

const root = new URL("../../", import.meta.url);
const script = new URL("tests/support/service-hosts.sh", root).pathname;

test("client host pins follow every Compose service listener", () => {
  const expected = composeListeners();
  assert(expected.size >= 8, "Compose listeners not found");
  const output = execFileSync(
    "sh",
    ["-c", '. "$1"; printf "%s\\n" $service_hosts', "sh", script],
    { env: { ...process.env, ANTNEST_SERVICE_NETWORK_PREFIX: "10.9.8" } },
  )
    .toString()
    .trim()
    .split("\n");
  assert.deepEqual(
    new Map(
      output.map((option) => {
        const match = /^--add-host=([a-z-]+):10\.9\.8\.(\d+)$/u.exec(option);
        assert(match, `unexpected host option ${option}`);
        return [match[1], match[2]];
      }),
    ),
    expected,
  );
});

test("Stage 3a test clients pin service names", () => {
  const directory = new URL("tests/e2e/", root);
  const launches = readdirSync(directory)
    .filter((name) => name.endsWith(".sh"))
    .filter((name) =>
      /docker(?:_cmd)? create --name "\$client"/u.test(
        readFileSync(new URL(name, directory), "utf8"),
      ),
    );
  assert.deepEqual(launches.sort(), [
    "e2e-acp-closeout.sh",
    "e2e-acp-persistence.sh",
    "e2e-acp-restart.sh",
    "e2e-agent-access.sh",
    "e2e-managed-mcp.sh",
    "e2e-rpc-response-loss.sh",
    "e2e-stage3-base.sh",
    "e2e-tool-permissions.sh",
    "e2e-tool-progress.sh",
  ]);
  for (const name of launches) {
    const source = readFileSync(new URL(name, directory), "utf8");
    assert.match(source, /tests\/support\/service-hosts\.sh"/u, name);
    assert.match(source, /\$service_hosts/u, name);
  }
});

test("Cost deployment client pins its actual Compose listeners", () => {
  const runID = "2485d43c-9cb0-42a0-9c9f-186a2dc3e855";
  const tag = "cost-" + runID;
  const { client } = costHarnessArguments(
    {
      COMPOSE_PROJECT_NAME: "antnest-stage3-e2e-1234",
      ANTNEST_E2E_RUN_ID: runID,
      ANTNEST_ADMISSION_TAG: tag,
      ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF: `antnest/antnest-runtime:${tag}`,
      ANTNEST_SERVICE_AUTH_DIRECTORY: "/fixture/credentials",
      ANTNEST_SERVICE_AUTH_UID: "501",
      ANTNEST_SERVICE_AUTH_GID: "20",
      ANTNEST_SERVICE_NETWORK_PREFIX: "10.9.8",
    },
    {
      evidence: new URL("artifacts/verification/cost-host-pins", root).pathname,
    },
  );
  const listeners = composeListeners();
  assert.deepEqual(
    client.filter((value) => value.startsWith("--add-host=")).sort(),
    ["agent-acp-service", "edge-gateway", "identity-service"]
      .map((name) => {
        assert(listeners.has(name), `Compose listener missing for ${name}`);
        return `--add-host=${name}:10.9.8.${listeners.get(name)}`;
      })
      .sort(),
  );
  assert.match(
    readFileSync(new URL("tests/e2e/e2e-session-cost.sh", root), "utf8"),
    /acp-cost\/deployment\.mjs" create-harness/u,
  );
});

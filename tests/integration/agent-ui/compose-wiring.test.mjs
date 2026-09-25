import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("Stage 3 Compose deploys the Node Agent UI as Gateway's only workspace target", () => {
  const output = execFileSync(
    "docker",
    [
      "compose",
      "--profile",
      "stage3",
      "-f",
      "compose.yaml",
      "-f",
      "compose.stage3.yaml",
      "config",
      "--format",
      "json",
    ],
    { cwd: root, encoding: "utf8" },
  );
  const config = JSON.parse(output);
  const ui = config.services["agent-ui"];
  const gateway = config.services["edge-gateway"];
  assert.equal(ui.build.dockerfile, "services/agent-ui/Dockerfile");
  assert.equal(
    ui.environment.ANTNEST_AGENT_ACP_SERVICE_URL,
    "http://agent-acp-service:8080",
  );
  assert.equal(
    ui.environment.ANTNEST_AGENT_CONTROLLER_URL,
    "http://agent-controller:8080",
  );
  assert.equal(
    ui.environment.ANTNEST_AGENT_UI_ACP_MAX_PROMPT_BYTES,
    config.services["agent-acp-service"].environment
      .ANTNEST_ACP_MAX_PROMPT_BYTES,
  );
  assert.equal(
    gateway.environment.ANTNEST_AGENT_UI_URL,
    "http://agent-ui:8080",
  );
  assert.equal(gateway.depends_on["agent-ui"].condition, "service_healthy");
  assert.equal(gateway.environment.ANTNEST_AGENT_UI_BRIDGE_URL, undefined);
  assert.match(ui.stop_grace_period, /^\d+s$/);
  assert.ok(
    Number.parseInt(ui.stop_grace_period, 10) >= 30,
    "Agent UI needs time to finish its 15-second drain before Docker forces termination",
  );
});

test("Stage 3 Compose gives ACP and Node the same overridden Prompt POST bound", () => {
  const output = execFileSync(
    "docker",
    [
      "compose",
      "--profile",
      "stage3",
      "-f",
      "compose.yaml",
      "-f",
      "compose.stage3.yaml",
      "config",
      "--format",
      "json",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ANTNEST_ACP_MAX_PROMPT_BYTES: "8388608",
      },
    },
  );
  const config = JSON.parse(output);
  assert.equal(
    config.services["agent-acp-service"].environment
      .ANTNEST_ACP_MAX_PROMPT_BYTES,
    "8388608",
  );
  assert.equal(
    config.services["agent-ui"].environment
      .ANTNEST_AGENT_UI_ACP_MAX_PROMPT_BYTES,
    "8388608",
  );
});

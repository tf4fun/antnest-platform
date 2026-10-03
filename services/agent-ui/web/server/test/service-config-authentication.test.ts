import assert from "node:assert/strict";
import { test } from "node:test";
import { parseServiceConfig } from "../src/service-config.ts";
import { testSecurityEnvironment } from "./support/auth-fixture.ts";

test("service configuration requires workload mode, authenticated Identity and distinct dependency origins", async () => {
  const base = { ...testSecurityEnvironment(), ANTNEST_AGENT_ACP_SERVICE_URL: "http://acp.invalid/",
    ANTNEST_AGENT_CONTROLLER_URL: "http://controller.invalid/" };
  for (const invalid of [
    { ANTNEST_SERVICE_AUTH_MODE: undefined }, { ANTNEST_SERVICE_AUTH_MODE: "TOKEN" },
    { ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT: " true" },
    { ANTNEST_AGENT_UI_IDENTITY_URL: undefined }, { ANTNEST_AGENT_UI_IDENTITY_URL: "http://user:secret@identity.invalid/" },
    { ANTNEST_AGENT_UI_IDENTITY_URL: base.ANTNEST_AGENT_ACP_SERVICE_URL },
    { ANTNEST_AGENT_CONTROLLER_URL: base.ANTNEST_AGENT_ACP_SERVICE_URL },
    { ANTNEST_SERVICE_AUTH_TOKEN_DIR: "/__missing_ui_test_tokens__" },
  ]) assert.throws(() => parseServiceConfig({ ...base, ...invalid }));
  const config = parseServiceConfig(base);
  assert.ok(config.authentication); assert.ok(config.dependencyFetchers.acp); assert.ok(config.dependencyFetchers.controller);
  await config.authentication.workload.close();
});

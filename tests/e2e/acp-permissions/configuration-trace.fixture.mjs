import { costConfigurationTraceFixture } from "../acp-cost/configuration-trace.fixture.mjs";

// Mode and model use the same owning repository transaction. The existing
// fixture reads those SQL statements from the service, independently of the
// Permissions inspector. Keep the actual setting and receipt distinct.
export function permissionConfigurationFixture({
  version = 1,
  configId = "mode",
  value = "approve",
  outputReads = 1,
} = {}) {
  const f = costConfigurationTraceFixture({ version, outputReads });
  delete f.expected.modelSelection;
  delete f.expected.configurationReceipt;
  f.expected.configuration = { configId, value };
  f.expected.requestReceipt = {
    requestId: f.expected.requestId,
    params: {
      sessionId: f.expected.sessionId,
      configId,
      value,
      ...(version === 2 ? { type: "id" } : {}),
    },
    result: {
      configOptions: [
        {
          [version === 1 ? "id" : "configId"]: configId,
          name: configId,
          type: "select",
          currentValue: value,
          options: [{ value, name: value }],
        },
      ],
    },
  };
  return f;
}

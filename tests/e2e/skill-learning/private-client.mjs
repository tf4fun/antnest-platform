import { openBrowserPrivateACP } from "../identity-closeout/private-acp-browser.mjs";
import { createPrivateACPTelemetry } from "../identity-closeout/private-acp-telemetry.mjs";

async function finish(action, cleanups) {
  const errors = [];
  let result;
  try {
    result = await action();
  } catch (error) {
    errors.push(error);
  }
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(errors, "Skill ACP work and cleanup failed");
  return result;
}

export function createSkillACPConnector({
  open = openBrowserPrivateACP,
  createTelemetry = createPrivateACPTelemetry,
} = {}) {
  return async (version, agentId, browser, options) => {
    const telemetry = createTelemetry("http://jaeger:4318/v1/traces");
    const cleanups = [() => telemetry.flush(), () => telemetry.shutdown()];
    let client;
    try {
      client = await open(version, agentId, browser, {
        ...options,
        telemetry,
        secrets: options.secrets ?? [],
      });
    } catch (error) {
      return finish(() => {
        throw error;
      }, cleanups);
    }
    // Preserve the original SDK client and its live getters. Initialization has
    // already completed; a caller must not issue it again on this connection.
    const close = client.closeAndWait.bind(client);
    let closing;
    client.closeAndWait = () => (closing ??= finish(close, cleanups));
    return client;
  };
}

export const openSkillACP = createSkillACPConnector();

export function withSkillACPClient(client, action) {
  return finish(action, [() => client.closeAndWait()]);
}

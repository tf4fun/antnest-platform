import assert from "node:assert/strict";

const services = ["edge-gateway", "admin-console", "identity-service"];

export function assertSecretFree(text, secrets) {
  for (const secret of secrets.filter(Boolean)) {
    for (const value of new Set([secret, encodeURIComponent(secret)])) {
      assert(!text.includes(value), "secret credential appeared in evidence");
    }
  }
  assert(!text.includes("ant_api_"), "access credential appeared in evidence");
}

function records(logs) {
  return logs.split("\n").flatMap((line) => {
    const service = services.find((name) => line.startsWith(`${name}-`));
    if (!service) return [];
    try {
      return [{ service, ...JSON.parse(line.slice(line.indexOf("|") + 1)) }];
    } catch {
      return [];
    }
  });
}

export function summarizeServiceLogs(logs) {
  const summary = Object.fromEntries(
    services.map((name) => [name, { INFO: 0, WARN: 0, ERROR: 0 }]),
  );
  for (const record of records(logs)) {
    if (
      summary[record.service] &&
      Object.hasOwn(summary[record.service], record.level)
    )
      summary[record.service][record.level]++;
  }
  return summary;
}

export function inspectServiceLogs(logs, canaries, traceIDs) {
  assert(
    canaries.length > 0 && traceIDs.length > 0,
    "missing OIDC evidence inputs",
  );
  assertSecretFree(logs, canaries);
  const requests = records(logs);
  for (const service of services) {
    assert(
      requests.some(
        (record) =>
          record.service === service && traceIDs.includes(record.trace_id),
      ),
      "missing correlated service log evidence",
    );
  }
}

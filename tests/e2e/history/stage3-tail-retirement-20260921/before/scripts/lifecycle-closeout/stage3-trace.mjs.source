import assert from "node:assert/strict";

export function stage3TraceInput(traceID, terminal, cookieJar) {
  assert(/^[a-f0-9]{32}$/.test(traceID), "Gateway admission trace is required");
  assert.equal(terminal.state, "completed", "operation is not complete");
  assert.equal(
    terminal.kind,
    "create",
    "expected the admitted create operation",
  );
  for (const key of ["request_id", "agent_id"])
    assert(
      typeof terminal[key] === "string" && terminal[key].length > 0,
      `missing operation ${key}`,
    );
  const cookies = new Map();
  for (const line of cookieJar.split(/\r?\n/u)) {
    const normalized = line.replace(/^#HttpOnly_/u, "");
    if (!normalized || normalized.startsWith("#")) continue;
    const fields = normalized.split("\t");
    assert.equal(fields.length, 7, "invalid test cookie jar");
    cookies.set(fields[5], fields[6]);
  }
  for (const name of ["antnest_session", "antnest_csrf"])
    assert(cookies.get(name), `missing test cookie ${name}`);
  return {
    operation: {
      traceID,
      requestID: terminal.request_id,
      agentID: terminal.agent_id,
      kind: terminal.kind,
    },
    secrets: [
      "stage3-admin-password",
      "stage3-model-secret",
      "stage3-model-secret-v2",
      ...cookies.values(),
    ],
  };
}

import assert from "node:assert/strict";

export function assertSecretFree(text, secrets, message) {
  for (const secret of secrets.filter(Boolean))
    assert(!text.includes(secret), message);
}

export function redactSecrets(text, secrets) {
  for (const secret of secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    text = text.replaceAll(secret, "[redacted]");
  return text;
}

export function inspectResponse({
  response,
  text,
  status,
  code,
  label,
  secrets,
}) {
  // Check before parsing or reporting response fields. Parser errors and
  // equality assertions may retain private upstream text in their diagnostics.
  assertSecretFree(text, secrets, "response leaked private credential");
  assert(
    response.headers.get("Antnest-Caller-Context") === null,
    "response leaked caller context header",
  );
  assert.equal(response.status, status, label);
  let json = null;
  if (
    code ||
    (text && response.headers.get("content-type")?.includes("application/json"))
  ) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("response was not valid JSON");
    }
  }
  if (code) assert(json?.code === code, "response error code changed");
  return json;
}

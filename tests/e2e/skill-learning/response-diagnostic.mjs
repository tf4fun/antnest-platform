// Error bodies can echo request or upstream detail, so a failed status check
// reports only the machine-readable error code and retryability.
const CODE = /^[a-z][a-z0-9_]{0,63}$/u;

export async function unexpectedStatus(label, response) {
  let body = {};
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = {};
  }
  const raw = body?.code ?? body?.error?.code;
  const code =
    raw === undefined ? "none" : CODE.test(String(raw)) ? raw : "invalid";
  const retryable =
    typeof body?.retryable === "boolean" ? String(body.retryable) : "unknown";
  return `${label}: HTTP ${response.status()} code=${code} retryable=${retryable}`;
}

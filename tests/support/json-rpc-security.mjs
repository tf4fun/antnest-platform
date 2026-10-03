import assert from "node:assert/strict";

// Used by service-owned component/Docker tests with otherwise valid credentials.
// This helper is a negative probe, not production media-type middleware.
export async function assertJsonRpcContentTypeRejection({
  url,
  method = "POST",
  headers = {},
  body = new TextEncoder().encode("{}"),
  signal,
  request = fetch,
}) {
  const types = [
    null,
    "",
    "text/plain",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=fixture",
    "application/problem+json",
    "application/json; charset=iso-8859-1",
    "application/json, application/json",
    "application/json; charset=utf-8; charset=iso-8859-1",
  ];
  for (const type of types) {
    const supplied = new Headers(headers);
    supplied.delete("content-type");
    if (type !== null) supplied.set("content-type", type);
    const response = await request(url, {
      method,
      headers: supplied,
      body,
      signal,
      redirect: "error",
    });
    await response.body?.cancel();
    assert.equal(
      response.status,
      415,
      `${method} JSON RPC with ${type ?? "missing Content-Type"}: expected 415, got ${response.status}`,
    );
  }
  return types.length;
}

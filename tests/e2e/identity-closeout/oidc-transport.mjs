import assert from "node:assert/strict";
import { request as httpsRequest } from "node:https";

export function createFixtureClient({
  issuer,
  port,
  ca,
  request = httpsRequest,
}) {
  return async function idp(path, { method = "GET", account } = {}) {
    const target = new URL(path, issuer);
    assert(target.origin === issuer, "unexpected fixture issuer");
    try {
      return await new Promise((resolve, reject) => {
        // Map the published port without disabling certificate verification.
        const outgoing = request(
          target,
          {
            hostname: "127.0.0.1",
            port: Number(port),
            servername: "oidc-fixture",
            ca,
            method,
            headers: {
              Host: target.host,
              ...(account ? { Cookie: `oidc_fixture_account=${account}` } : {}),
            },
            signal: AbortSignal.timeout(10000),
          },
          (response) => {
            let text = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              text += chunk;
            });
            response.on("error", reject);
            response.on("end", () =>
              resolve({
                status: response.statusCode,
                headers: response.headers,
                text,
              }),
            );
          },
        );
        outgoing.on("error", reject);
        outgoing.end();
      });
    } catch {
      throw new Error("HTTPS IdP fixture request failed");
    }
  };
}

export function parseFixtureJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("HTTPS IdP fixture returned invalid JSON");
  }
}

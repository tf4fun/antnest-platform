import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";

const prefix = "/api/app/agents/agent-1";
const reads = [
  "/api/app/bootstrap",
  `${prefix}/state`,
  `${prefix}/state/watch`,
  `${prefix}/acp`,
  `${prefix}/v1/acp`,
  `${prefix}/v2/acp`,
];
const registrations = [
  ...reads.flatMap((path) => [
    ["GET", path],
    ["HEAD", path],
  ]),
  ...["acp", "v1/acp"].flatMap((suffix) => [
    ["POST", `${prefix}/${suffix}`],
    ["DELETE", `${prefix}/${suffix}`],
  ]),
];

// Send a valid wire upgrade. fetch rejects Upgrade locally and cannot prove
// that the real Gateway image rejected the request before forwarding it.
function upgrade(url, headers, signal) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      agent: false,
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      headers: {
        ...headers,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      },
    });
    request.once("error", reject);
    request.once("upgrade", (_response, socket) => {
      socket.destroy();
      request.destroy();
      reject(new Error("retired route accepted an upgrade"));
    });
    request.once("response", (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("error", reject);
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 4096) {
          response.destroy(
            new Error("retired response exceeded fixture bound"),
          );
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    request.end();
  });
}

export function assertRejection(status, headers, body, method, expected = 404) {
  assert.equal(status, expected);
  for (const name of [
    "set-cookie",
    "antnest-service-authorization",
    "antnest-caller-context",
  ])
    assert(headers[name] === undefined, `retired response leaked ${name}`);
  if (method === "HEAD") {
    assert(body === "", "retired HEAD response included a body");
    return;
  }
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("retired response was not public JSON");
  }
  // Closed public envelopes prevent a correct code from hiding leaked data.
  // Fixed Boolean assertion messages never print arbitrary upstream content.
  assert(
    value && !Array.isArray(value) && typeof value === "object",
    "retired response was not a public error object",
  );
  assert(
    Object.keys(value).sort().join(",") === "code,message",
    "retired response included unexpected fields",
  );
  assert(
    value.code === (expected === 404 ? "not_found" : "forbidden"),
    "retired response error code changed",
  );
  assert(
    value.message ===
      (expected === 404
        ? "Resource was not found"
        : "Request origin is not allowed"),
    "retired response public message changed",
  );
  // Both allowed values are fixed plain strings. Counting JSON member-name
  // tokens also rejects duplicates that JSON.parse would otherwise overwrite.
  assert(
    (body.match(/"(?:[^"\\]|\\.)*"\s*:/g) ?? []).length === 2,
    "retired response included duplicate fields",
  );
}

export async function retirementChecks({
  url,
  origin,
  cookies,
  signal,
  readEvidence,
}) {
  const before = await readEvidence();
  const cases = [];
  for (const authenticated of [false, true]) {
    const headers = {
      Origin: origin,
      ...(authenticated ? { Cookie: cookies } : {}),
      "Antnest-Caller-Context": "browser-forgery",
      "X-Antnest-Agent-ID": "forged-agent",
    };
    for (const [method, path] of registrations) {
      const response = await fetch(url + path, {
        method,
        headers,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      assertRejection(
        response.status,
        Object.fromEntries(response.headers),
        await response.text(),
        method,
      );
      cases.push({ method, path, authenticated, status: response.status });
    }
    for (const path of reads) {
      const response = await upgrade(url + path, headers, signal);
      assertRejection(response.status, response.headers, response.body, "GET");
      cases.push({
        method: "GET",
        path,
        upgrade: true,
        authenticated,
        status: response.status,
      });
    }
  }
  const foreign = await fetch(url + `${prefix}/v1/acp`, {
    method: "POST",
    headers: { Origin: "https://foreign.example.test", Cookie: cookies },
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  assertRejection(
    foreign.status,
    Object.fromEntries(foreign.headers),
    await foreign.text(),
    "POST",
    403,
  );
  cases.push({
    method: "POST",
    path: `${prefix}/v1/acp`,
    foreignOrigin: true,
    status: foreign.status,
  });
  const after = await readEvidence();
  assert.deepEqual(
    after,
    before,
    "retired route contacted Identity or an application dependency",
  );
  return {
    checks: cases.length + 1,
    cases,
    before,
    after,
    excluded: [
      "local fixture observation",
      "health",
      "process-owned session-revocation feed",
    ],
  };
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";

const [mode, raw = "{}"] = process.argv.slice(2);
const options = JSON.parse(raw);
const keys =
  mode === "unreachable"
    ? {}
    : JSON.parse(readFileSync("/run/auth/fixture.json", "utf8"));
const host = process.env.EGRESS_AUTH_CONTROL_ADDRESS;
let checks = 0;

async function request({
  method = "GET",
  path = "/internal/agent-networks/accepted",
  auth = "current",
  body,
  rawBody,
  media = "application/json",
  headers = {},
  status = 200,
  code,
} = {}) {
  const payload =
    rawBody !== undefined
      ? Buffer.from(rawBody)
      : body === undefined
        ? undefined
        : Buffer.from(JSON.stringify(body));
  const outgoing = { ...headers };
  if (auth !== null)
    outgoing["Antnest-Service-Authorization"] = "Bearer " + keys[auth];
  if (payload !== undefined) {
    outgoing["Content-Length"] = String(payload.length);
    if (media !== null && outgoing["Content-Type"] === undefined)
      outgoing["Content-Type"] = media;
  }
  const response = await new Promise((resolve, reject) => {
    const req = httpRequest(
      "http://" + host + path,
      {
        method,
        headers: outgoing,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 65536)
            response.destroy(new Error("response exceeds probe limit"));
          else chunks.push(chunk);
        });
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            rawHeaders: response.rawHeaders,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.setTimeout(10000, () => req.destroy(new Error("HTTP probe timed out")));
    req.once("error", reject);
    req.end(payload);
  });
  assert.equal(response.status, status, method + " " + path);
  const document = response.text ? JSON.parse(response.text) : null;
  if (code) {
    assert.equal(document.code, code);
    assert.equal(document.retryable, false);
    assert.deepEqual(Object.keys(document).sort(), [
      "code",
      "message",
      "retryable",
    ]);
  }
  const challenges = response.rawHeaders.filter(
    (_, index, values) =>
      index % 2 === 1 && values[index - 1].toLowerCase() === "www-authenticate",
  );
  assert.deepEqual(
    challenges,
    status === 401 ? ['Bearer realm="antnest-service"'] : [],
  );
  for (const secret of Object.values(keys))
    assert(
      !response.text.includes(secret),
      "response exposed an authority carrier",
    );
  assert.equal(response.headers["antnest-caller-context"], undefined);
  checks++;
  return document;
}

if (mode === "request") {
  process.stdout.write(JSON.stringify(await request(options)));
} else if (mode === "matrix") {
  const contract = JSON.parse(
    readFileSync("/fixture/control-contract.json", "utf8"),
  );
  for (const route of contract.routes) {
    if (route.path === "/status") continue;
    const path = route.path
      .replace("{agent_id}", "denied")
      .replace("{policy_id}", "denied-policy")
      .replace("{revision}", "1");
    const common = {
      path,
      method: route.method,
      ...(route.method === "GET" || path === "/internal/agent-networks/denied"
        ? {}
        : { body: {} }),
      headers: {
        Authorization: "Bearer " + keys.current,
        "X-Antnest-Service": "agent-controller",
        "X-Antnest-Role": "admin",
        "Antnest-Caller-Context": keys.context,
        Cookie: "authority=" + keys.context,
      },
    };
    await request({
      ...common,
      auth: null,
      status: 401,
      code: "service_unauthenticated",
    });
    await request({
      ...common,
      auth: "wrong",
      status: 403,
      code: "caller_not_allowed",
    });
    await request({
      ...common,
      auth: null,
      headers: {
        ...common.headers,
        "Antnest-Service-Authorization": [
          "Bearer " + keys.current,
          "Bearer " + keys.current,
        ],
      },
      status: 401,
      code: "service_unauthenticated",
    });
  }
  for (const [path, method, status, code] of [
    ["/status", "GET", 404, "route_not_found"],
    ["/internal/unlisted", "GET", 404, "route_not_found"],
    ["/internal/agent-networks/denied", "DELETE", 405, "method_not_allowed"],
    ["/internal/agent-networks/denied", "HEAD", 405, undefined],
  ]) {
    await request({ path, method, status, code });
    await request({
      path,
      method,
      auth: null,
      status: 401,
      ...(method === "HEAD" ? {} : { code: "service_unauthenticated" }),
    });
  }
  for (const authority of [
    "",
    "Bearer unknown",
    "Bearer  " + keys.current,
    "Bearer " + keys.current + "=",
    "Bearer " + keys.current + ", Bearer " + keys.next,
  ])
    await request({
      path: "/internal/agent-networks/denied",
      auth: null,
      headers: { "Antnest-Service-Authorization": authority },
      status: 401,
      code: "service_unauthenticated",
    });
  process.stdout.write(JSON.stringify({ checks }));
} else if (mode === "media") {
  const routes = [
    ["PUT", "/internal/agent-network-attachments/accepted"],
    ["POST", "/internal/agent-networks/accepted/release"],
    ["PUT", "/internal/policies/media-policy/revisions/1"],
    ["PUT", "/internal/agent-policy-assignments/accepted"],
  ];
  for (const [method, path] of routes) {
    for (const media of [
      null,
      "text/plain",
      "application/json; charset=latin1",
      "application/json; charset=utf-8; charset=utf-8",
    ])
      await request({
        path,
        method,
        body: {},
        media,
        status: 415,
        code: "unsupported_media_type",
      });
    await request({
      path,
      method,
      body: {},
      headers: { "Content-Type": ["application/json", "application/json"] },
      status: 415,
      code: "unsupported_media_type",
    });
    await request({
      path,
      method,
      body: {},
      headers: { "Content-Encoding": "gzip" },
      status: 415,
      code: "unsupported_media_type",
    });
    await request({
      path: path + "?ignored=1",
      method,
      body: {},
      status: 400,
      code: "invalid_request",
    });
    for (const rawBody of [
      "[]",
      "{} {}",
      Buffer.from([0xff]),
      '{"value":1,"v\\u0061lue":2}',
      "{".repeat(33),
      '{"spec":{"schema_version":1,"action":"allow_all","act\\u0069on":"deny_all"}}',
      '{"spec":{"schema_version":1,"action":"allow_all","extra":true}}',
    ])
      await request({
        path,
        method,
        rawBody,
        status: 400,
        code: "invalid_request",
      });
    await request({
      path,
      method,
      rawBody: " ".repeat(4097),
      status: 413,
      code: "invalid_request",
    });
  }
  for (const [method, path] of [
    ["PUT", "/internal/agent-networks/accepted"],
    ["GET", "/internal/agent-networks/accepted"],
    ["GET", "/internal/agent-policy-assignments/accepted"],
    ["GET", "/internal/policies/builtin%2Fdeny-all/revisions/1"],
  ]) {
    await request({
      method,
      path,
      rawBody: "{}",
      status: 400,
      code: "invalid_request",
    });
    await request({
      method,
      path: path + "?actor=forged",
      status: 400,
      code: "invalid_request",
    });
  }
  process.stdout.write(JSON.stringify({ checks }));
} else if (mode === "unreachable") {
  for (const address of [
    process.env.EGRESS_AUTH_CONTROL_IP,
    process.env.EGRESS_AUTH_PACKET_IP,
  ]) {
    for (const port of [8181, 8087]) {
      let reachable = false;
      try {
        const response = await fetch(`http://${address}:${port}/status`, {
          signal: AbortSignal.timeout(2000),
          redirect: "manual",
        });
        await response.arrayBuffer();
        reachable = true;
      } catch {
        // Refusal or bounded timeout is expected on the packet-only network.
      }
      assert(!reachable, "packet interface exposed control or health HTTP");
      checks++;
    }
  }
  process.stdout.write(JSON.stringify({ checks }));
} else {
  throw new Error("unknown Egress probe mode");
}

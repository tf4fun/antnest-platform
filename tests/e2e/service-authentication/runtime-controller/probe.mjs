import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";

const [mode, raw = "{}"] = process.argv.slice(2);
const options = JSON.parse(raw);
let checks = 0;
const credentials = () =>
  JSON.parse(readFileSync("/run/auth/fixture.json", "utf8"));
async function request({
  path = "/internal/runtimes",
  method = "GET",
  body,
  auth = "current",
  media = "application/json",
  headers = {},
  status = 200,
  code,
  host = "runtime-controller:8120",
} = {}) {
  const keys = credentials();
  const outgoing = { ...headers };
  if (auth !== null)
    outgoing["Antnest-Service-Authorization"] = "Bearer " + keys[auth];
  if (body !== undefined && media !== null) outgoing["Content-Type"] = media;
  const response = await fetch("http://" + host + path, {
    method,
    headers: outgoing,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  assert.equal(response.status, status, method + " " + path + ": " + text);
  const json = text ? JSON.parse(text) : null;
  if (code) assert.equal(json.code, code);
  if (status === 401)
    assert.equal(
      response.headers.get("www-authenticate"),
      'Bearer realm="antnest-service"',
    );
  for (const secret of Object.values(keys))
    assert(!text.includes(secret), "response leaked a workload credential");
  assert.equal(response.headers.get("antnest-caller-context"), null);
  checks++;
  return json;
}
if (mode === "request") {
  process.stdout.write(JSON.stringify(await request(options)));
} else if (mode === "matrix") {
  const contract = JSON.parse(
    readFileSync("/fixture/control-contract.json", "utf8"),
  );
  const keys = credentials();
  for (const route of contract.routes) {
    if (route.path === "/status") continue;
    const path = route.path
      .replace("{agent_id}", "auth-probe")
      .replace("{request_id}", "auth-request");
    const common = {
      path,
      method: route.method,
      ...(route.request_body ? { body: {} } : {}),
      headers: {
        "Idempotency-Key": "auth-request",
        "X-Antnest-Principal-ID": "pretend-controller",
        Authorization: "Bearer unrelated-user-token",
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
    const duplicateStatus = await new Promise((resolve, reject) => {
      const req = httpRequest(
        "http://runtime-controller:8120" + path,
        {
          method: route.method,
          headers: [
            "Host",
            "runtime-controller:8120",
            "Antnest-Service-Authorization",
            "Bearer " + keys.current,
            "Antnest-Service-Authorization",
            "Bearer " + keys.current,
            "Content-Type",
            "application/json",
          ],
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
        },
      );
      req.setTimeout(5000, () => req.destroy(new Error("probe timed out")));
      req.once("error", reject);
      req.end(route.request_body ? "{}" : undefined);
    });
    assert.equal(duplicateStatus, 401, route.operation_id);
    checks++;
  }
  for (const auth of ["current", "next"]) await request({ auth });
  await request({ path: "/status", auth: null, status: 404 });
  for (const media of [null, "text/plain", "application/json; charset=latin1"])
    await request({
      method: "POST",
      path: "/internal/runtimes/auth-probe/initialize",
      body: {},
      media,
      status: 415,
      code: "unsupported_media_type",
    });
  process.stdout.write(JSON.stringify({ checks }));
} else if (mode === "unreachable") {
  for (const port of [8120, 8085]) {
    let failure;
    try {
      await fetch("http://runtime-controller:" + port + "/internal/runtimes", {
        signal: AbortSignal.timeout(3000),
      });
    } catch (error) {
      failure = error;
    }
    assert(failure, "management interface exposed listener " + port);
    checks++;
  }
  process.stdout.write(JSON.stringify({ checks }));
} else {
  throw new Error("unknown probe mode");
}

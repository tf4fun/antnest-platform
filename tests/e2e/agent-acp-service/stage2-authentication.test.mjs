import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";
import { provisionTokens } from "../../../scripts/dev-service-tokens.mjs";
import {
  configureStage2Authentication,
  json,
  registerFixturePrincipal,
} from "./stage2-transport.mjs";

test("Stage2 private probes preserve organization, real session and route Agent scope", async (t) => {
  const directory = resolve(
    "artifacts/verification/stage2-authentication-" + randomUUID(),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  provisionTokens({ output: directory });
  const env = parseEnv(readFileSync(directory + "/deployment.env", "utf8"));
  for (const name of [
    "ANTNEST_SERVICE_AUTH_DIRECTORY",
    "ANTNEST_IDENTITY_CCT_SIGNING_KID",
  ]) {
    const previous = process.env[name];
    process.env[name] = env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.headers);
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      ),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  configureStage2Authentication({ "agent-controller": origin });
  const principal = {
    user_id: "admin",
    organization_id: "original",
    membership_id: "member-original",
    system_role: "admin",
    organization_role: "admin",
  };
  registerFixturePrincipal(principal, "session-original");
  registerFixturePrincipal(
    {
      ...principal,
      organization_id: "foreign",
      membership_id: "member-foreign",
    },
    "session-foreign",
  );
  const claims = (index) =>
    JSON.parse(
      Buffer.from(
        requests[index]["antnest-caller-context"].split(".")[1],
        "base64url",
      ),
    );
  await json(
    origin + "/internal/agents/agent_original?organization_id=original",
  );
  assert.equal(claims(0).agt, "agent_original");
  assert.equal(claims(0).org, "original");
  assert.equal(claims(0).sid, "session-original");
  assert.equal(
    requests[0]["antnest-service-authorization"],
    "Bearer " +
      readFileSync(
        directory + "/admin-console/tokens/agent-controller",
        "utf8",
      ),
  );
  await json(origin + "/internal/agent-templates", {
    organization_id: "foreign",
  });
  assert.equal(claims(1).agt, undefined);
  assert.equal(claims(1).org, "foreign");
  assert.equal(claims(1).sid, "session-foreign");
  await json(origin + "/internal/agents/agent_original", undefined, 200, {
    "x-antnest-fixture-authentication": "none",
  });
  assert.equal(requests[2]["antnest-service-authorization"], undefined);
  assert.equal(requests[2]["antnest-caller-context"], undefined);
  assert.equal(requests[2]["x-antnest-fixture-authentication"], undefined);
});

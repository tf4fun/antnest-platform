import { TestRequest as Request } from "./support/auth-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPermissionHandler } from "../src/http/permission-routes.ts";

const path =
  "http://localhost/api/app/workspace/v1/agents/agent-1/permissions/permission-1/decision";
const headers = {
  "x-antnest-organization-id": "org-1",
  "x-antnest-principal-id": "user-1",
  "x-antnest-agent-id": "agent-1",
  "content-type": "application/json",
};

test("permission decision requires trusted scope and exact advertised generation", async () => {
  const calls: Array<[string, number, string]> = [];
  const handler = createPermissionHandler({
    async decide(_scope, permissionId, generation, optionId) {
      calls.push([permissionId, generation, optionId]);
      return { sessionId: "session-1", permissions: [] };
    },
  });
  const body = JSON.stringify({ generation: 4, optionId: "allow" });
  assert.equal(
    (await handler(new Request(path, { method: "POST", body })))?.status,
    401,
  );
  assert.equal(
    (
      await handler(
        new Request(path, {
          method: "POST",
          headers: { ...headers, "x-antnest-agent-id": "agent-2" },
          body,
        }),
      )
    )?.status,
    403,
  );
  assert.equal(
    (
      await handler(
        new Request(path, {
          method: "POST",
          headers,
          body: JSON.stringify({
            generation: 4,
            optionId: "allow",
            extra: true,
          }),
        }),
      )
    )?.status,
    422,
  );
  const accepted = await handler(
    new Request(path, { method: "POST", headers, body }),
  );
  assert.equal(accepted?.status, 200);
  assert.deepEqual(await accepted?.json(), {
    sessionId: "session-1",
    permissions: [],
  });
  assert.deepEqual(calls, [["permission-1", 4, "allow"]]);
});

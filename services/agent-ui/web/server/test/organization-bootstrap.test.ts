import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { createBootstrapHandler } from "../src/http/bootstrap-routes.ts";
import { createWorkspaceHttpServer } from "../src/http/node-server.ts";
import { workspaceFromBridgeBootstrap } from "../../src/lib/bootstrap.ts";

const requireAcp = createRequire(new URL("../../../../agent-acp-service/package.json", import.meta.url));
const { Ajv2020 } = requireAcp("ajv/dist/2020.js");
const schema = JSON.parse(readFileSync(new URL("../../../../../contracts/agent-ui/workspace-api.schema.json", import.meta.url), "utf8"));
const compile = (name: string) => new Ajv2020({ strict: true, validateFormats: false }).compile({ $schema: schema.$schema, $defs: schema.$defs, $ref: `#/$defs/${name}` });
const validPrincipal = compile("verifiedWorkspacePrincipal");
const validBootstrap = compile("bootstrap");
const path = "http://workspace/api/app/workspace/v1/bootstrap";
const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const headers = {
  "x-antnest-organization-id": "org-1",
  "x-antnest-principal-id": "user-1",
  "x-antnest-administrator": "false",
  "x-antnest-organization-slug": encode("engineering"),
  "x-antnest-organization-name": encode("研发 · Équipe 🚀"),
};

test("real Bridge bootstrap preserves the frozen Gateway projection and the frontend accepts the same payload", async () => {
  const scopes: unknown[] = [];
  const handler = createBootstrapHandler({ epoch: "epoch-1", now: () => 1_700_000_000_000,
    discover: async (scope) => { scopes.push(scope); return []; } });
  for (const organizationName of ["研发 · Équipe 🚀", "\uFEFF 研发 · Équipe 🚀 "]) {
    for (const administrator of [false, true]) {
      for (const organizationId of ["org-1", "org-2"]) {
        const response = await handler(new Request(path + "?organization_name=forged", { headers: {
          ...headers, "x-antnest-administrator": String(administrator), "x-antnest-organization-id": organizationId,
          "x-antnest-organization-name": encode(organizationName),
        } }));
        assert.equal(response?.status, 200);
        const payload = await response!.json();
        assert.equal(validPrincipal(payload.principal), true, "real Node principal must satisfy the frozen shared schema");
        assert.equal(validBootstrap(payload), true, "real Node bootstrap must satisfy the active central schema");
        assert.deepEqual(payload.principal, { userId: "user-1", organizationId, organizationSlug: "engineering", organizationName, administrator });
        const workspace = workspaceFromBridgeBootstrap(payload);
        assert.equal(workspace.principal.organizationName, organizationName);
        assert.equal(workspace.principal.organizationId, organizationId);
        assert.equal(workspace.principal.administrator, administrator);
        assert.deepEqual(scopes.at(-1), { organizationId, principalId: "user-1" });
        assert.equal(response?.headers.get("cache-control"), "no-store");
      }
    }
  }
});

test("Bridge bootstrap rejects absent, duplicate, noncanonical or invalid UTF-8 display headers before discovery", async () => {
  let calls = 0;
  const handler = createBootstrapHandler({ epoch: "epoch", now: Date.now, discover: async () => { calls++; return []; } });
  for (const field of ["x-antnest-organization-slug", "x-antnest-organization-name"]) {
    for (const value of [undefined, "", encode(" \t\n"), encode("\uFEFF\u00A0\u2028"), "YQ==", "YR", "_w", "%61", `${encode("valid")}, ${encode("forged")}`]) {
      const input = new Headers(headers);
      if (value === undefined) input.delete(field); else input.set(field, value);
      const response = await handler(new Request(path, { headers: input }));
      assert.equal(response?.status, 401, `malformed ${field} must not admit bootstrap`);
    }
  }
  assert.equal(calls, 0);
});

test("real Node SSR authenticates the same display projection before rendering or discovery", async () => {
  let calls = 0;
  let renders = 0;
  const bootstrap = createBootstrapHandler({ epoch: "epoch", now: Date.now, discover: async () => { calls++; return []; } });
  const server = createWorkspaceHttpServer({ handle: bootstrap }, {
    async renderDocument(output, input) { renders++; output.end(JSON.stringify(input.bootstrap)); },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/workspace/`;
    const missing = new Headers(headers); missing.delete("x-antnest-organization-name");
    assert.equal((await fetch(url, { headers: missing })).status, 401);
    assert.equal(calls, 0); assert.equal(renders, 0);
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(validBootstrap(payload), true);
    assert.equal(workspaceFromBridgeBootstrap(payload).principal.organizationName, "研发 · Équipe 🚀");
    assert.equal(calls, 1); assert.equal(renders, 1);
  } finally {
    server.closeAllConnections(); server.close(); await once(server, "close");
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { trustedScope } from "../src/http/command-routes.ts";
import { readWorkspacePrincipal } from "../src/http/workspace-principal.ts";
import { copyAuthenticatedRequest, scopeHeaders, refreshScopeContext } from "../src/http/trusted-identity.ts";
import { TestRequest, testScope } from "./support/auth-fixture.ts";

test("raw and copied identity headers carry no verified authority", () => {
  const hints = { "x-antnest-organization-id": "org", "x-antnest-principal-id": "user", "x-antnest-agent-id": "agent" };
  const raw = new Request("http://workspace/internal", { headers: hints });
  assert.equal(trustedScope(raw), null);
  assert.equal(readWorkspacePrincipal(raw.headers), null);
  const verified = new TestRequest(raw);
  assert.deepEqual(trustedScope(verified), { organizationId: "org", principalId: "user", agentId: "agent" });
  const copied = new Request(verified);
  assert.equal(trustedScope(copied), null);
  copyAuthenticatedRequest(verified, copied);
  assert.deepEqual(trustedScope(copied), trustedScope(verified));
});

test("scope conditions cannot serialize credentials and only same-scope authenticated requests replace context", () => {
  const original = testScope({ organizationId: "研发,一", principalId: "user,一", agentId: "agent" });
  const first = scopeHeaders(original, "agent-acp-service");
  assert.deepEqual(Object.keys(first), ["Antnest-Caller-Context"]);
  assert.equal(JSON.stringify(original).includes(first["Antnest-Caller-Context"]), false);
  assert.throws(() => scopeHeaders({ ...original }, "agent-acp-service"));
  const newer = testScope({ ...original });
  refreshScopeContext(original, newer);
  assert.equal(scopeHeaders(original, "agent-acp-service")["Antnest-Caller-Context"], scopeHeaders(newer, "agent-acp-service")["Antnest-Caller-Context"]);
  const foreign = testScope({ ...original, principalId: "other" });
  assert.throws(() => refreshScopeContext(original, foreign));
});

test("expired context and missing downstream audience fail before a new upstream request", () => {
  const scope = { organizationId: "org", principalId: "user", agentId: "agent" };
  const now = Math.floor(Date.now() / 1000);
  assert.throws(() => scopeHeaders(testScope({ ...scope }, { iat: now - 100, exp: now - 40 }), "agent-acp-service"));
  assert.throws(() => scopeHeaders(testScope({ ...scope }, { aud: ["agent-ui"] }), "agent-acp-service"));
});

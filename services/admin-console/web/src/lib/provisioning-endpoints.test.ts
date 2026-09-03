import assert from "node:assert/strict";
import test from "node:test";
import { provisioningEndpoints } from "./provisioning-endpoints.ts";

test("provisioning endpoints stay on the public Edge origin", () => {
  assert.deepEqual(provisioningEndpoints("https://agents.example.com"), {
    oidcCallbackURL: "https://agents.example.com/protocol/oidc/callback",
    scimBaseURL: "https://agents.example.com/scim/v2",
  });
  assert.deepEqual(provisioningEndpoints("http://127.0.0.1:8090"), {
    oidcCallbackURL: "http://127.0.0.1:8090/protocol/oidc/callback",
    scimBaseURL: "http://127.0.0.1:8090/scim/v2",
  });
});

test("provisioning endpoint derivation discards non-origin browser state", () => {
  assert.deepEqual(provisioningEndpoints("https://agents.example.com/console?secret=value#provisioning"), {
    oidcCallbackURL: "https://agents.example.com/protocol/oidc/callback",
    scimBaseURL: "https://agents.example.com/scim/v2",
  });
});

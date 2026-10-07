import { randomUUID } from "node:crypto";
import { serviceClient } from "../../support/service-grants.mjs";

const rpc = (method) => `http://identity-service:8080/rpc/identity/${method}`;

// Fixtures call the owning Identity RPC as its real callers do: sign-in and
// revocation as edge-gateway, directory commands as Admin Console with a
// caller context scoped to the signed-in Organization.
export function identityFixture(services = serviceClient()) {
  const tokens = [];
  const gateway = (method, body) =>
    services.json(rpc(method), "gateway-identity", { body });
  async function signIn(account) {
    const login = await gateway("local-login", {
      request_id: randomUUID(),
      ...account,
    });
    tokens.push(login.access_token);
    const resolved = await gateway("resolve-access-token", {
      access_token: login.access_token,
      profile: "console",
    });
    return { principal: login.principal, context: resolved.caller_context };
  }
  // The Gateway session cookie is the Identity access token; its browser
  // owns it, so close() does not revoke it.
  async function browserSession(accessToken, principal) {
    const resolved = await gateway("resolve-access-token", {
      access_token: accessToken,
      profile: "console",
    });
    return { principal, context: resolved.caller_context };
  }
  const admin = (session, method, body) =>
    services.json(rpc(method), "console-identity", {
      body: {
        request_id: randomUUID(),
        actor_principal_id: session.principal.user_id,
        ...body,
      },
      context: session.context,
    });
  async function close() {
    for (const token of tokens.splice(0))
      await gateway("revoke-access-token", { access_token: token });
  }
  return { signIn, browserSession, admin, close };
}

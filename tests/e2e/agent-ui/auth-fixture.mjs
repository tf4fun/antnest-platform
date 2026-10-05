import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAuthFixture } from "../../../services/agent-ui/web/server/test/support/auth-fixture.mjs";
import {
  parseKeys,
  verifyCallerContext,
} from "../../../services/agent-ui/web/server/dist/adapters/caller-context.js";

const fixture = await createAuthFixture({ built: true });
const keys = await parseKeys(Buffer.from(JSON.stringify(fixture.jwks)));
export const {
  fetch: testFetch,
  headers: testHeaders,
  jwks: testJwks,
  context: testContext,
  workloadHeaders,
} = fixture;
export const dockerAuthenticationArgs = () => {
  const mount = (source, target) => {
    // The host parent remains private (0700). Only individual read-only files
    // are mounted so the production image's UID 1000 can read their contents.
    chmodSync(source, 0o644);
    return ["--mount", `type=bind,src=${source},dst=${target},readonly`];
  };
  const args = mount(
    join(fixture.directory, "callers.json"),
    "/run/antnest-service-auth/callers.json",
  );
  for (const name of [
    "identity-service",
    "agent-acp-service",
    "agent-controller",
  ])
    args.push(
      ...mount(
        join(fixture.directory, "tokens", name),
        `/run/antnest-service-auth/tokens/${name}`,
      ),
    );
  for (const [name, value] of Object.entries({
    ANTNEST_SERVICE_AUTH_MODE: "token",
    ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT: "true",
    ANTNEST_SERVICE_AUTH_CALLERS_FILE: "/run/antnest-service-auth/callers.json",
    ANTNEST_SERVICE_AUTH_TOKEN_DIR: "/run/antnest-service-auth/tokens",
  }))
    args.push("-e", `${name}=${value}`);
  return args;
};
export async function authenticateFixtureRequest(request, receiver) {
  const expected = `Bearer ${readFileSync(join(fixture.directory, "tokens", receiver), "utf8")}`;
  if (request.headers["antnest-service-authorization"] !== expected)
    throw new Error("fixture_workload_rejected");
  if (receiver === "identity-service") return undefined;
  const token = request.headers["antnest-caller-context"];
  if (typeof token !== "string") throw new Error("fixture_context_rejected");
  const decoded = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
  );
  return verifyCallerContext(token, keys, {
    consumer: receiver,
    agent: decoded.agt,
    organization: "org-1",
    now: Math.floor(Date.now() / 1000),
    tolerance: 30,
  });
}

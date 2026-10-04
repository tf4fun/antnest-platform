import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { test } from "node:test";
import { SERVICES } from "../src/adapters/service-authentication.ts";
import { testAuthentication, testContext, workloadHeaders } from "./support/auth-fixture.ts";

const catalog = JSON.parse(readFileSync(new URL("../../../../../contracts/agent-ui/callers.json", import.meta.url), "utf8"));
for (const [route, policy] of Object.entries(catalog.routes) as [string, { authentication: string; callers: string[]; caller_context: Record<string, string> }][]) {
  if (policy.authentication === "health") continue;
  test(`caller matrix: ${route}`, async () => {
    const [method, raw] = route.split(" ");
    const path = raw!.replace(/\{([^}]+)\}/gu, (_, name: string) => name === "agentId" ? "agent-1" : "fixture");
    const authentication = testAuthentication();
    for (const caller of SERVICES.filter(service => service !== "agent-ui")) {
      const socket = new Socket(); const request = new IncomingMessage(socket);
      try {
        request.method = method; request.url = path;
        request.rawHeaders = Object.entries({ ...workloadHeaders(caller),
          "Antnest-Caller-Context": testContext(path.startsWith("/api/app/workspace/v1/agents/") ? { agt: "agent-1" } : {}).token }).flat();
        const result = await authentication.admit(request);
        if (policy.callers.includes(caller)) {
          assert.equal("status" in result, false, caller);
          if (!("status" in result)) assert.equal(result.policy.known, true);
        } else {
          assert.equal("status" in result, true, caller);
          if ("status" in result) { assert.equal(result.status, 403); assert.equal(result.code, "caller_not_allowed"); }
        }
      } finally { socket.destroy(); }
    }
  });
}

for (const [route, policy] of Object.entries(catalog.routes) as [string, { caller_context: Record<string, string> }][]) {
  if (policy.caller_context["edge-gateway"] !== "required") continue;
  test(`missing caller context: ${route}`, async () => {
    const [method, raw] = route.split(" ");
    const path = raw!.replace(/\{([^}]+)\}/gu, (_, name: string) => name === "agentId" ? "agent-1" : "fixture");
    const socket = new Socket();
    const request = new IncomingMessage(socket);
    try {
      request.method = method; request.url = path;
      request.rawHeaders = Object.entries(workloadHeaders()).flat();
      assert.deepEqual(await testAuthentication().admit(request), { status: 401, code: "caller_context_required" });
    } finally { socket.destroy(); }
  });
}

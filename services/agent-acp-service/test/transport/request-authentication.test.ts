import { readFileSync } from "node:fs";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { expect, it } from "vitest";
import { SERVICES } from "../../src/adapters/service-authentication.js";
import { CALLER_CONTEXT_HEADER } from "../../src/adapters/caller-context.js";
import { signContext, testAuthentication, workloadHeaders } from "../support/auth-fixture.js";

const catalog = JSON.parse(
  readFileSync(new URL("../../../../contracts/agent-acp/callers.json", import.meta.url), "utf8"),
) as {
  routes: Record<
    string,
    { callers: string[]; authentication: string; caller_context: Record<string, string> }
  >;
};
const authentication = testAuthentication();

it.each(Object.entries(catalog.routes))(
  "enforces every catalog caller for %s",
  async (route, policy) => {
    const [method, path] = route.split(" ");
    for (const caller of SERVICES.filter((service) => service !== "agent-acp-service")) {
      const socket = new Socket();
      const request = new IncomingMessage(socket);
      request.method = method === "UPGRADE" ? "GET" : method;
      request.url = path!
        .replace("{agent_id}", "agent-1")
        .replace("{session_id}", "session-1")
        .replace("{intent_id}", "intent-1");
      const agent = caller === "admin-console" ? {} : { agt: "agent-1" };
      request.rawHeaders = Object.entries({
        ...workloadHeaders(caller),
        [CALLER_CONTEXT_HEADER]: signContext(agent),
      }).flat();
      try {
        const result = await authentication.admit(request, method === "UPGRADE");
        if (policy.authentication === "health" || policy.callers.includes(caller)) {
          expect(result, `${route}: ${caller}`).not.toHaveProperty("status");
        } else {
          expect(result, `${route}: ${caller}`).toMatchObject({
            status: 403,
            code: "caller_not_allowed",
          });
        }
        if (policy.caller_context[caller] === "required") {
          request.rawHeaders = Object.entries(workloadHeaders(caller)).flat();
          expect(await authentication.admit(request, method === "UPGRADE")).toMatchObject({
            status: 401,
            code: "caller_context_required",
          });
        }
      } finally {
        socket.destroy();
      }
    }
  },
);

it.each([
  ["empty", [CALLER_CONTEXT_HEADER, ""]],
  ["malformed", [CALLER_CONTEXT_HEADER, "bad"]],
  [
    "duplicate case-insensitive fields",
    [
      CALLER_CONTEXT_HEADER,
      signContext({ agt: "agent-1" }),
      "antnest-caller-context",
      signContext({ agt: "agent-1" }),
    ],
  ],
  [
    "comma joined",
    [
      CALLER_CONTEXT_HEADER,
      `${signContext({ agt: "agent-1" })},${signContext({ agt: "agent-1" })}`,
    ],
  ],
])("rejects %s caller context as invalid", async (_, contextFields) => {
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  request.method = "POST";
  request.url = "/v1/acp";
  request.rawHeaders = [
    ...Object.entries(workloadHeaders("edge-gateway")).flat(),
    ...contextFields,
  ];
  try {
    expect(await authentication.admit(request)).toMatchObject({
      status: 401,
      code: "caller_context_invalid",
    });
  } finally {
    socket.destroy();
  }
});

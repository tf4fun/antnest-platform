import { describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { WebSocket } from "ws";
import { commonError, errorHeaders } from "../../src/transport/public-error.js";
import { ERROR_METADATA } from "../../src/errors.gen.js";
import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { testHeaders } from "../support/auth-fixture.js";
import { sessionConfigurationView } from "../support/fixtures.js";
import type { IncomingHttpHeaders } from "node:http";
import { DomainError } from "../../src/domain/errors.js";
import { ModelBudgetExceededError } from "../../src/domain/model-budget.js";
import { publicError, httpFailure } from "../../src/transport/public-error.js";
import { runtimeAdmissionDenial } from "../../src/domain/runtime-admission-error.js";
import { temporaryErrorSchema } from "../../src/domain/temporary-skills.js";
import { testAuthentication } from "../support/auth-fixture.js";
import {
  AgentAcpHttpServer,
  type AgentAcpHttpServerOptions,
} from "../../src/transport/http-server.js";
import type { AcpApplicationPort } from "../../src/ports/acp-application.js";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CATEGORIES = new Set([
  "invalid_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "precondition_failed",
  "rate_limited",
  "unavailable",
  "internal",
]);

describe("common_error publicError", () => {
  it("common_error admission envelope preserves catalog fields and adds metadata", () => {
    const projected = publicError(new DomainError("agent_busy", "private-canary"), "admission");
    expect(projected.jsonRpcCode).toBe(-32030);
    expect(projected.httpStatus).toBe(409);
    expect(projected.message).not.toContain("private-canary");
    const data = projected.data as Record<string, unknown>;
    expect(data.code).toBe("agent_busy");
    expect(data.category).toBe("conflict");
    expect(data.retryable).toBe(true);
    expect(data.retry_after_ms).toBe(1000);
    expect(data.request_id).toMatch(SAFE_ID);
    expect(JSON.stringify(data)).not.toContain("private-canary");
  });

  it("common_error httpFailure emits five fields", () => {
    const { status, body } = httpFailure("access_denied");
    expect(status).toBe(403);
    const record = body as Record<string, unknown>;
    expect(record.code).toBe("access_denied");
    expect(record.category).toBe("forbidden");
    expect(record.retryable).toBe(false);
    expect(record.request_id).toMatch(SAFE_ID);
    expect(record.message).not.toContain("private-canary");
  });

  it("common_error untyped failure keeps legacy fallback", () => {
    const projected = publicError(new Error("private-canary"), "admission");
    expect((projected.data as Record<string, unknown>).code).toBe("internal_error");
    expect(projected.message).toBe("Agent request failed");
    const data = projected.data as Record<string, unknown>;
    expect(data.category).toBe("internal");
    expect(data.retryable).toBe(false);
    expect(data.request_id).toMatch(SAFE_ID);
    expect(JSON.stringify(data)).not.toContain("private-canary");
  });

  it("common_error budget details stays bounded and gains metadata", () => {
    const projected = publicError(new ModelBudgetExceededError("run_cost", "1", "2"), "admission");
    const data = projected.data as Record<string, unknown>;
    expect(data.category).toBeDefined();
    expect(data.request_id).toMatch(SAFE_ID);
    const details = data.details as { budget?: Record<string, unknown> } | undefined;
    expect(details?.budget).toBeDefined();
    expect(JSON.stringify(details)).not.toContain("private-canary");
  });
});

describe("common_error runtime admission denial", () => {
  const COMMON = {
    code: "runtime_unauthorized",
    category: "unauthenticated",
    message: "Runtime request rejected",
    retryable: false,
    request_id: "req-1",
  };
  const headers = new Headers({
    "content-type": "application/json",
    "www-authenticate": 'Bearer realm="antnest-service"',
    "x-request-id": "req-1",
  });
  const legacy = {
    code: "runtime_unauthorized",
    message: "Runtime request rejected",
    retryable: false,
  };

  it("common_error accepts new envelope and still accepts legacy", () => {
    const response = new Response("{}", { status: 401, headers });
    expect(runtimeAdmissionDenial(response, COMMON)).toBe("runtime_unauthorized");
    expect(runtimeAdmissionDenial(new Response("{}", { status: 401, headers }), legacy)).toBe(
      "runtime_unauthorized",
    );
  });

  it("common_error rejects partial metadata, mismatch, and extras", () => {
    const response = () => new Response("{}", { status: 401, headers });
    for (const mutation of [
      { ...COMMON, category: "forbidden" },
      { ...COMMON, request_id: "bad id with spaces" },
      { ...COMMON, request_id: "req-2" },
      { ...COMMON, retryable: true },
      { ...COMMON, cause: "private-canary" },
      (() => {
        const value = { ...COMMON };
        Reflect.deleteProperty(value, "category");
        return value;
      })(),
      (() => {
        const value = { ...COMMON };
        Reflect.deleteProperty(value, "request_id");
        return value;
      })(),
    ]) {
      expect(runtimeAdmissionDenial(response(), mutation)).toBeNull();
    }
  });
});

describe("common_error temporary error schema", () => {
  const NEW_SHAPE = {
    code: "outcome_unknown",
    category: "internal",
    message: "Temporary Skill request did not complete",
    retryable: true,
    request_id: "req-1",
    details: { effect_state: "unknown", runtime_call_stopped: false },
    error: {
      code: "outcome_unknown",
      category: "internal",
      message: "Temporary Skill request did not complete",
      retryable: true,
      request_id: "req-1",
      effect_state: "unknown",
      runtime_call_stopped: false,
    },
  };
  const LEGACY = {
    error: {
      code: "outcome_unknown",
      message: "Temporary Skill request did not complete",
      retryable: true,
      effect_state: "unknown",
      runtime_call_stopped: false,
    },
  };

  it("common_error accepts the runtime N+1 shape and the legacy alias", () => {
    const parsed = temporaryErrorSchema.safeParse(NEW_SHAPE);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.error.effect_state).toBe("unknown");
      expect(parsed.data.error.runtime_call_stopped).toBe(false);
    }
    expect(temporaryErrorSchema.safeParse(LEGACY).success).toBe(true);
  });

  it("common_error rejects mutations on the new shape", () => {
    for (const mutation of [
      { ...NEW_SHAPE, request_id: "bad id" },
      { ...NEW_SHAPE, category: "unavailable" },
      { ...NEW_SHAPE, error: { ...NEW_SHAPE.error, request_id: "req-2" } },
      { ...NEW_SHAPE, cause: "private-canary" },
      { ...NEW_SHAPE, details: { effect_state: "settled", runtime_call_stopped: false } },
      (() => {
        const value = { ...NEW_SHAPE };
        Reflect.deleteProperty(value, "error");
        return value;
      })(),
    ]) {
      expect(temporaryErrorSchema.safeParse(mutation).success).toBe(false);
    }
  });
});

describe("common_error actual HTTP envelope", () => {
  it("common_error emits common fields on the live 401 challenge", async () => {
    const server = new AgentAcpHttpServer({
      authentication: testAuthentication(),
      application: {} as AcpApplicationPort,
      ready: () => Promise.resolve(true),
      maxWebSocketPayloadBytes: 64 * 1024,
    });
    await server.listen("127.0.0.1", 0);
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no listener");
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/acp`);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="antnest-service"');
      expect(response.headers.get("cache-control")).toBe("no-store");
      const requestId = response.headers.get("x-request-id");
      expect(requestId).toMatch(SAFE_ID);
      const body = (await response.json()) as { request_id: string } & Record<string, unknown>;
      expect(body.code).toBe("service_unauthenticated");
      expect(body.category).toBe("unauthenticated");
      expect(body.retryable).toBe(false);
      expect(body.request_id).toBe(requestId);
      expect(CATEGORIES.has(body.category as string)).toBe(true);
      expect(JSON.stringify(body)).not.toContain("private-canary");
    } finally {
      await server.close();
    }
  });
});

describe("common_error helper boundaries", () => {
  it.each(["not_registered", "__proto__", "constructor", "toString", ""])(
    "common_error commonError canonicalizes unknown code %j",
    (code) => {
      const envelope = commonError(code, "Private diagnostic", true, "unsafe id");
      expect(envelope.code).toBe("internal");
      expect(envelope.category).toBe("internal");
      expect(envelope.message).not.toContain("Private");
      expect(envelope.retryable).toBe(false);
      expect(envelope.request_id).toMatch(SAFE_ID);
      expect(Object.hasOwn(envelope, "details")).toBe(false);
    },
  );

  it("common_error commonError keeps explicit retry override and caller request ID for a registered code", () => {
    const envelope = commonError("agent_busy", "Agent already has an active Run", true, "req-1");
    expect(envelope.code).toBe("agent_busy");
    expect(envelope.category).toBe("conflict");
    expect(envelope.retryable).toBe(true);
    expect(envelope.request_id).toBe("req-1");
  });

  it.each(["bad id with space", "x".repeat(129), "../../etc", "private\nheader"])(
    "common_error errorHeaders never echoes unsafe request ID %j",
    (requestId) => {
      const headers = errorHeaders({ request_id: requestId });
      expect(headers["cache-control"]).toBe("no-store");
      expect(Object.hasOwn(headers, "x-request-id")).toBe(false);
    },
  );

  it("common_error errorHeaders ignores inherited request_id", () => {
    const headers = errorHeaders(Object.create({ request_id: "req-1" }));
    expect(Object.hasOwn(headers, "x-request-id")).toBe(false);
  });
});

describe("common_error admission denial negatives", () => {
  const denial = (body: unknown, headers: Record<string, string>) =>
    runtimeAdmissionDenial(
      new Response(JSON.stringify(body), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": 'Bearer realm="antnest-service"',
          ...headers,
        },
      }),
      body,
    );
  const VALID = {
    code: "runtime_unauthorized",
    category: "unauthenticated",
    message: "Runtime request rejected",
    retryable: false,
    request_id: "req-1",
  };
  it("common_error registered foreign code on 403 does not prove denial", () => {
    const body = {
      code: "content_changed",
      category: "conflict",
      message: "Skill source content changed; choose again",
      retryable: false,
      request_id: "req-1",
    };
    const response = new Response(JSON.stringify(body), {
      status: 403,
      headers: { "content-type": "application/json", "x-request-id": "req-1" },
    });
    expect(runtimeAdmissionDenial(response, body)).toBeNull();
  });
  it.each([
    [{ ...VALID, message: "mutated message" }, { "x-request-id": "req-1" }],
    [{ ...VALID, details: { x: 1 } }, { "x-request-id": "req-1" }],
    [
      { ...VALID, error: { code: "runtime_unauthorized", message: "Runtime request rejected" } },
      { "x-request-id": "req-1" },
    ],
    [VALID, {}],
    [VALID, { "x-request-id": "other-id" }],
  ] as const)("common_error rejects common denial mutation %#", (body, headers) => {
    expect(denial(body, headers)).toBeNull();
  });
  it("common_error accepts a complete common denial", () => {
    expect(denial(VALID, { "x-request-id": "req-1" })).not.toBeNull();
  });
});

describe("common_error ModelError union slice parity", () => {
  it.each([
    "model_unsupported_content",
    "model_unavailable",
    "context_overflow",
    "model_http_error",
    "model_invalid_response",
    "provider_unavailable",
    "provider_endpoint_forbidden",
    "provider_endpoint_unavailable",
  ])("common_error ACP slice registers ModelError code %s", (code) => {
    expect(Object.hasOwn(ERROR_METADATA, code)).toBe(true);
  });
});

describe("common_error temporary schema registered foreign code", () => {
  it("common_error rejects a registered code outside the temporary vocabulary", () => {
    const body = {
      code: "access_denied",
      category: "forbidden",
      message: "Temporary Skill request did not complete",
      retryable: false,
      request_id: "req-1",
      error: {
        code: "access_denied",
        category: "forbidden",
        message: "Temporary Skill request did not complete",
        retryable: false,
        request_id: "req-1",
        effect_state: "unknown",
        runtime_call_stopped: false,
      },
      details: { effect_state: "unknown", runtime_call_stopped: false },
    };
    expect(temporaryErrorSchema.safeParse(body).success).toBe(false);
  });
});

async function upgradeRejection(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  const peer = new WebSocket(url, { headers });
  return await new Promise((resolve, reject) => {
    peer.once("open", () => {
      peer.terminate();
      reject(new Error("upgrade unexpectedly accepted"));
    });
    peer.once("unexpected-response", (_request, response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
      );
    });
    peer.once("error", reject);
  });
}

function liveApplication(): AcpApplicationPort {
  const unexpected = () => Promise.reject(new Error("unexpected"));
  return {
    assertAccess: vi.fn(() => Promise.resolve()),
    getSessionConfiguration: vi.fn(() => Promise.resolve(sessionConfigurationView())),
    setSessionConfiguration: vi.fn(() => Promise.resolve(sessionConfigurationView())),
    createSession: vi.fn(() => Promise.resolve({ sessionId: "session-1" })),
    listSessions: vi.fn(() => Promise.resolve({ sessions: [] })),
    deleteSession: unexpected,
    forkSession: unexpected,
    resumeSession: vi.fn(() => Promise.resolve({ replay: [], sequence: 0 })),
    readSessionOutput: unexpected,
    closeSession: unexpected,
    cancelRun: unexpected,
    acceptPrompt: unexpected,
  };
}

describe("common_error live upgrade and flat envelopes", () => {
  const start = async (options: AgentAcpHttpServerOptions) => {
    const server = new AgentAcpHttpServer(options);
    await server.listen("127.0.0.1", 0);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no listener");
    return { server, port: address.port };
  };

  it("common_error live 401 upgrade emits common body, challenge and matching headers", async () => {
    const { server, port } = await start({
      authentication: testAuthentication(),
      application: liveApplication(),
      ready: () => Promise.resolve(true),
      maxWebSocketPayloadBytes: 64 * 1024,
    });
    try {
      const received = await upgradeRejection(`ws://127.0.0.1:${port}/v1/acp`);
      expect(received.status).toBe(401);
      expect(received.headers["www-authenticate"]).toBe('Bearer realm="antnest-service"');
      expect(received.headers["cache-control"]).toBe("no-store");
      const body = JSON.parse(received.body) as { request_id: string } & Record<string, unknown>;
      expect(body.code).toBe("service_unauthenticated");
      expect(body.category).toBe("unauthenticated");
      expect(body.retryable).toBe(false);
      expect(body.request_id).toMatch(SAFE_ID);
      expect(received.headers["x-request-id"]).toBe(body.request_id);
    } finally {
      await server.close();
    }
  });

  it("common_error live 404 upgrade emits common route envelope", async () => {
    const { server, port } = await start({
      authentication: testAuthentication(),
      application: liveApplication(),
      ready: () => Promise.resolve(true),
      maxWebSocketPayloadBytes: 64 * 1024,
    });
    try {
      const received = await upgradeRejection(
        `ws://127.0.0.1:${port}/internal/acp-owner/incarnation/probe`,
      );
      expect(received.status).toBe(404);
      expect(received.headers["cache-control"]).toBe("no-store");
      const body = JSON.parse(received.body) as { request_id: string } & Record<string, unknown>;
      expect(body.code).toBe("route_not_found");
      expect(body.category).toBe("not_found");
      expect(body.request_id).toMatch(SAFE_ID);
      expect(received.headers["x-request-id"]).toBe(body.request_id);
    } finally {
      await server.close();
    }
  });

  it("common_error live 503 upgrade emits common availability envelope", async () => {
    const { server, port } = await start({
      authentication: testAuthentication(),
      application: liveApplication(),
      ready: () => Promise.resolve(false),
      maxWebSocketPayloadBytes: 64 * 1024,
    });
    try {
      const received = await upgradeRejection(
        `ws://127.0.0.1:${port}/v1/acp`,
        testHeaders({ "X-Antnest-Agent-Id": "agent-1" }),
      );
      expect(received.status).toBe(503);
      expect(received.headers["cache-control"]).toBe("no-store");
      const body = JSON.parse(received.body) as { request_id: string } & Record<string, unknown>;
      expect(body.code).toBe("agent_unavailable");
      expect(body.category).toBe("unavailable");
      expect(body.retryable).toBe(true);
      expect(body.request_id).toMatch(SAFE_ID);
      expect(received.headers["x-request-id"]).toBe(body.request_id);
    } finally {
      await server.close();
    }
  });

  it("common_error live 429 quota upgrade emits common body with Retry-After", async () => {
    const { server, port } = await start({
      authentication: testAuthentication(),
      application: liveApplication(),
      ready: () => Promise.resolve(true),
      maxWebSocketPayloadBytes: 64 * 1024,
      connectionLimits: { global: 1, organization: 1, principal: 1 },
    });
    const headers = testHeaders({ "X-Antnest-Agent-Id": "agent-1" });
    const held = new WebSocket(`ws://127.0.0.1:${port}/v1/acp`, { headers });
    try {
      await once(held, "open");
      const received = await upgradeRejection(`ws://127.0.0.1:${port}/v1/acp`, headers);
      expect(received.status).toBe(429);
      expect(received.headers["retry-after"]).toBe("1");
      expect(received.headers["cache-control"]).toBe("no-store");
      const body = JSON.parse(received.body) as { request_id: string } & Record<string, unknown>;
      expect(body.code).toBe("connection_quota_exceeded");
      expect(body.request_id).toMatch(SAFE_ID);
      expect(received.headers["x-request-id"]).toBe(body.request_id);
    } finally {
      held.terminate();
      await server.close();
    }
  });

  it("common_error live ordinary 404 and readiness 503 carry common envelopes", async () => {
    const { server, port } = await start({
      authentication: testAuthentication(),
      application: liveApplication(),
      ready: () => Promise.resolve(false),
      maxWebSocketPayloadBytes: 64 * 1024,
    });
    try {
      const missing = await fetch(`http://127.0.0.1:${port}/internal/acp-owner/incarnation/probe`, {
        method: "POST",
      });
      expect(missing.status).toBe(404);
      expect(missing.headers.get("cache-control")).toBe("no-store");
      const missingBody = (await missing.json()) as { request_id: string } & Record<
        string,
        unknown
      >;
      expect(missingBody.code).toBe("route_not_found");
      expect(missingBody.status).toBe("not_found");
      expect(missing.headers.get("x-request-id")).toBe(missingBody.request_id);
      const status = await fetch(`http://127.0.0.1:${port}/status`);
      expect(status.status).toBe(503);
      const statusBody = (await status.json()) as { request_id: string } & Record<string, unknown>;
      expect(statusBody.code).toBe("agent_unavailable");
      expect(statusBody.category).toBe("unavailable");
      expect(statusBody.retryable).toBe(true);
      expect(statusBody.status).toBe("not_ready");
      expect(status.headers.get("x-request-id")).toBe(statusBody.request_id);
    } finally {
      await server.close();
    }
  });
});

const PROJECTION_BOUNDARIES = new Map([
  ["commonError", 0],
  ["httpFailure", 0],
  ["errorBody", 0],
  ["failure", 1],
  ["json", 1],
]);
const CONSTRUCTOR_BOUNDARIES = new Set(["PeerFailure", "ProbeFailure", "SkillSourceError"]);

function literalViolations(text: string, filename: string): string[] {
  const violations: string[] = [];
  const ast = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const position = (node: ts.Node) => ast.getLineAndCharacterOfPosition(node.getStart(ast));
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const name = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : undefined;
      const codeArgument = name === undefined ? undefined : PROJECTION_BOUNDARIES.get(name);
      if (codeArgument !== undefined) {
        const argument = node.arguments[codeArgument];
        if (argument !== undefined && ts.isStringLiteralLike(argument)) {
          const { line, character } = position(argument);
          violations.push(
            `${filename}:${line + 1}:${character + 1} literal code argument to ${name}()`,
          );
        }
      }
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      CONSTRUCTOR_BOUNDARIES.has(node.expression.text)
    ) {
      const argument = node.arguments?.[0];
      if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        const { line, character } = position(argument);
        violations.push(
          `${filename}:${line + 1}:${character + 1} literal code argument to ${node.expression.text}()`,
        );
      }
    }
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "code" &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      const { line, character } = position(node.initializer);
      violations.push(`${filename}:${line + 1}:${character + 1} literal code field value`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return violations;
}

describe("common_error transport literal gate", () => {
  const transportRoot = new URL("../../src/transport/", import.meta.url);
  const transportFiles: string[] = [];
  const collect = (directory: URL) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const location = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
      if (entry.isDirectory()) collect(location);
      else if (entry.name.endsWith(".ts")) transportFiles.push(location.pathname);
    }
  };
  collect(transportRoot);

  it("common_error reads every transport source file and finds no literal code arguments", () => {
    expect(transportFiles.length).toBeGreaterThan(10);
    const violations: string[] = [];
    for (const file of transportFiles) {
      const source = readFileSync(file, "utf8");
      expect(source.length).toBeGreaterThan(0);
      violations.push(...literalViolations(source, file));
    }
    expect(violations).toEqual([]);
  });

  it.each([
    'failure(response, "access_denied");',
    'failure(\n  response, // forwarded\n  "access_denied"\n);',
    'httpFailure("service_unauthenticated")',
    'commonError("route_not_found", "message", false)',
    'new PeerFailure("internal_error")',
    'new ProbeFailure(\n  "method_not_allowed"\n)',
    'const body = { code: "route_not_found" };',
    'return { code: "access_denied", retryable: false };',
  ])("common_error literal gate flags %#", (snippet) => {
    expect(literalViolations(snippet, "fixture.ts").length).toBeGreaterThan(0);
  });

  it.each([
    "failure(response, ERROR_CODES.ACCESS_DENIED);",
    "failure(\n  response,\n  ERROR_CODES.METHOD_NOT_ALLOWED\n);",
    "httpFailure(ERROR_CODES.SERVICE_UNAUTHENTICATED)",
    'commonError(ERROR_CODES.ROUTE_NOT_FOUND, "ACP route was not found", false)',
    "new PeerFailure(ERROR_CODES.INTERNAL_ERROR)",
    "const body = { code: definition.code };",
    "return { code: error.code, retryable: false };",
    "httpFailure(admission.code)",
    'new DomainError("access_denied", "private")',
    'throw new acp.RequestError(-32022, "Agent Run failed", data)',
  ])("common_error literal gate permits %#", (snippet) => {
    expect(literalViolations(snippet, "fixture.ts")).toEqual([]);
  });
});

describe("common_error slice and catalog parity", () => {
  const registry = JSON.parse(
    readFileSync(new URL("../../../../contracts/common/errors.json", import.meta.url), "utf8"),
  ) as { errors: { code: string }[] };
  const slice = new Set(
    (
      JSON.parse(
        readFileSync(
          new URL("../../../../contracts/common/slices/agent-acp-service.json", import.meta.url),
          "utf8",
        ),
      ) as { codes: string[] }
    ).codes,
  );
  const registryCodes = new Set(registry.errors.map((entry) => entry.code));
  const catalog = JSON.parse(
    readFileSync(new URL("../../../../contracts/agent-acp/errors.json", import.meta.url), "utf8"),
  ) as { errors: Record<string, unknown>; fallback: { data_code: string } };

  it("common_error every catalog code is registered and sliced", () => {
    for (const code of [...Object.keys(catalog.errors), catalog.fallback.data_code]) {
      expect(registryCodes.has(code), `registry covers ${code}`).toBe(true);
      expect(slice.has(code), `slice covers ${code}`).toBe(true);
      expect(Object.hasOwn(ERROR_METADATA, code), `generated metadata covers ${code}`).toBe(true);
    }
  });
});

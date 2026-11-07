import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import type { CallerClaims } from "../../src/adapters/caller-context.js";
import type { AuditPermission } from "../../src/domain/execution-audit.js";
import type { LearningStatus } from "../../src/application/learning-status-reader.js";
import { BridgeObservationService } from "../../src/application/bridge-observation.js";
import { ExecutionAudits } from "../../src/application/execution-audit.js";
import { LearningChangeReader } from "../../src/application/learning-change-reader.js";
import { LearningStatusReader } from "../../src/application/learning-status-reader.js";
import { LearningChangeCursor } from "../../src/domain/learning-change-cursor.js";
import type {
  BridgeIntentReceipt,
  BridgeSessionExecution,
} from "../../src/ports/bridge-observation.js";
import { serveBridgeObservation } from "../../src/transport/bridge-observation.js";
import { serveExecutionAudit } from "../../src/transport/execution-audit.js";
import { serveLearningChanges } from "../../src/transport/learning-changes.js";
import { serveLearningStatus } from "../../src/transport/learning-status.js";
import { bindAuthenticatedRequest } from "../../src/transport/trusted-identity.js";

interface SharedGoldenHelpers {
  assertGolden: (path: URL, actual: unknown, options?: { update?: boolean }) => void;
  validateGolden: (schema: string, value: unknown) => Promise<true>;
}

const { assertGolden, validateGolden } = (await import(
  new URL("../../../../tests/support/contracts/golden.mjs", import.meta.url).href
)) as SharedGoldenHelpers;

const update = { update: process.env.UPDATE_GOLDEN === "1" };

const golden = (area: string, name: string) =>
  new URL(`../../../../contracts/${area}/examples/${name}`, import.meta.url);

const fixedSeconds = Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000);

function fakeRequest(method: string, url: string, body?: unknown): IncomingMessage {
  const request = Readable.from([
    Buffer.from(body === undefined ? "" : JSON.stringify(body)),
  ]) as unknown as IncomingMessage;
  request.method = method;
  request.url = url;
  request.headers = { host: "localhost", "content-type": "application/json" };
  request.rawHeaders = ["Host", "localhost", "Content-Type", "application/json"];
  return request;
}

class FakeResponse extends EventEmitter {
  public status = 0;
  public readonly headers: Record<string, string> = {};
  public body = "";
  public writable = true;
  public destroyed = false;
  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  getHeader(name: string) {
    return this.headers[name.toLowerCase()];
  }
  writeHead(status: number, headers?: Record<string, string>) {
    this.status = status;
    if (headers !== undefined) Object.assign(this.headers, headers);
    return this;
  }
  end(chunk?: string | Buffer) {
    if (chunk !== undefined) this.body += chunk.toString();
    this.writable = false;
    return this;
  }
}

const ready = () => Promise.resolve(true);

const access = {
  withAccess: <T>(_identity: unknown, work: () => Promise<T>) => work(),
};

const agentClaims: CallerClaims = {
  iss: "antnest://service/identity-service",
  sub: "owner-1",
  org: "org-1",
  mbr: "membership-1",
  sys_role: "user",
  org_role: "member",
  sid: "session-1",
  aud: ["agent-acp-service"],
  jti: "golden-claims",
  iat: fixedSeconds,
  exp: fixedSeconds + 60,
  agt: "agent-1",
};

const adminClaims: CallerClaims = {
  ...agentClaims,
  agt: undefined,
  sys_role: "admin",
  org_role: "admin",
};

async function capture(
  area: string,
  name: string,
  schema: string,
  serve: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const response = new FakeResponse();
  await serve(request, response as unknown as ServerResponse);
  expect(response.status).toBe(200);
  if (response.headers["content-type"] !== undefined)
    expect(response.headers["content-type"]).toContain("json");
  const actual = JSON.parse(response.body) as Record<string, unknown>;
  await validateGolden(schema, actual);
  assertGolden(golden(area, name), actual, update);
  return actual;
}

const receipt: BridgeIntentReceipt = {
  intentId: "intent1",
  sessionId: "session1",
  runId: "run1",
  phase: "running",
  appendVersion: 1,
  outputWatermark: 2,
  stopReason: null,
  errorClass: null,
};

const session: BridgeSessionExecution = {
  sessionId: "session1",
  appendVersion: 1,
  outputWatermark: 2,
  activeRunId: "run1",
  recentReceipts: [receipt],
  configurationRevision: "a".repeat(64),
};

describe("Agent ACP producer goldens", () => {
  it("captures workspace execution and intent observations", async () => {
    const service = new BridgeObservationService({
      access: { assert: () => Promise.resolve() },
      sessions: { requireAuthorized: () => Promise.resolve() },
      repository: {
        readIntent: () => Promise.resolve(receipt),
        readSession: () => Promise.resolve(session),
      },
    });
    for (const [name, schema, route] of [
      [
        "workspace-execution.running.json",
        "agent-acp/workspace-bridge.schema.json#/$defs/executionObservation",
        { kind: "session", sessionId: "session1" },
      ],
      [
        "workspace-intent.running.json",
        "agent-acp/workspace-bridge.schema.json#/$defs/intentReceipt",
        { kind: "intent", sessionId: "session1", intentId: "intent1" },
      ],
    ] as const) {
      const request = fakeRequest("GET", `/internal/workspace/${route.kind}`);
      bindAuthenticatedRequest(request, "edge-gateway", agentClaims);
      await capture(
        "agent-acp",
        name,
        schema,
        (req, res) => serveBridgeObservation(req, res, route, service, ready),
        request,
      );
    }
  });

  it("captures the blocked learning status", async () => {
    const reader = new LearningStatusReader(access, {
      read: (): Promise<LearningStatus> =>
        Promise.resolve({
          agentId: "agent-1",
          blocked: {
            reason: "model_unavailable",
            skillName: "docs",
            sourceSessionId: "session-1",
            sourceRunId: "run-1",
          },
        }),
    });
    const request = fakeRequest("GET", "/internal/agents/agent-1/skill-learning-status");
    bindAuthenticatedRequest(request, "edge-gateway", agentClaims);
    await capture(
      "skill-learning",
      "learning-status.blocked.json",
      "skill-learning/learning-api.schema.json#/$defs/learning_status",
      (req, res) =>
        serveLearningStatus(req, res, { agentId: "agent-1", invalid: false }, reader, ready),
      request,
    );
  });

  it("captures the empty learning change page", async () => {
    const reader = new LearningChangeReader(
      access,
      {
        page: () =>
          Promise.resolve({
            sealedSequence: "0",
            items: [],
            hasMoreOlder: false,
            hasMoreForward: false,
          }),
      },
      new LearningChangeCursor(Buffer.alloc(32, 1), () => fixedSeconds),
    );
    const request = fakeRequest("GET", "/internal/agents/agent-1/skill-learning-changes");
    bindAuthenticatedRequest(request, "edge-gateway", agentClaims);
    await capture(
      "skill-learning",
      "learning-changes.empty.json",
      "skill-learning/learning-api.schema.json#/$defs/change_page",
      (req, res) =>
        serveLearningChanges(
          req,
          res,
          { agentId: "agent-1", input: {}, limit: 20, invalid: false },
          reader,
          ready,
        ),
      request,
    );
  });

  it("captures current execution events and asserts schema_version markers", async () => {
    const event = {
      id: "event-1",
      sequence: 1,
      kind: "run_started",
      visible: true,
      payload: { text: "started" },
      created_at: "2026-09-01T00:00:00Z",
    };
    const audits = new ExecutionAudits({
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(null),
      events: () => Promise.resolve([event]),
      permissions: () => Promise.resolve([]),
    });
    const request = fakeRequest("POST", "/rpc/agent-acp/list-execution-events", {
      run_id: "run-1",
      stream: "execution",
    });
    bindAuthenticatedRequest(request, "admin-console", adminClaims);
    const actual = await capture(
      "agent-acp",
      "execution-events.current.json",
      "agent-acp/execution-audit-events.schema.json",
      (req, res) =>
        serveExecutionAudit(
          req,
          res,
          { method: "events", name: "list_execution_events" },
          audits,
          64 * 1024,
          ready,
        ),
      request,
    );
    expect(actual.schema_version).toBe(1);
    for (const item of actual.items as Record<string, unknown>[]) {
      expect(item.schema_version).toBe(1);
    }
  });

  it("captures current permission events and asserts schema_version markers", async () => {
    const permission: AuditPermission = {
      tool_call_id: "tool-1",
      request: { tool_name: "read" },
      decision: "allow_once",
      reason: null,
      created_at: "2026-09-01T00:00:00Z",
      decided_at: "2026-09-01T00:00:00Z",
    };
    const audits = new ExecutionAudits({
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(null),
      events: () => Promise.resolve([]),
      permissions: () => Promise.resolve([permission]),
    });
    const request = fakeRequest("POST", "/rpc/agent-acp/list-execution-events", {
      run_id: "run-1",
      stream: "permissions",
    });
    bindAuthenticatedRequest(request, "admin-console", adminClaims);
    const actual = await capture(
      "agent-acp",
      "execution-events.permissions.json",
      "agent-acp/execution-audit-events.schema.json",
      (req, res) =>
        serveExecutionAudit(
          req,
          res,
          { method: "events", name: "list_execution_events" },
          audits,
          64 * 1024,
          ready,
        ),
      request,
    );
    expect(actual.schema_version).toBe(1);
    for (const item of actual.items as Record<string, unknown>[]) {
      expect(item.schema_version).toBe(1);
    }
  });
});

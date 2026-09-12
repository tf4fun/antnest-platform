import { describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { NOOP_TELEMETRY, type TelemetryPort } from "../../src/ports/telemetry.js";
import { PermissionConnections } from "../../src/application/permission-connections.js";
import { ToolPermissions } from "../../src/application/tool-permissions.js";
import { InstrumentedToolPermissions } from "../../src/telemetry/instrumented-permissions.js";
import { RunToolAuthorization } from "../../src/application/run-tool-authorization.js";
import { DomainError } from "../../src/domain/errors.js";
import type { PermissionRepository, PermissionRequest } from "../../src/ports/tool-permissions.js";
import { binding, snapshot } from "../support/fixtures.js";

const request: PermissionRequest = {
  runId: "run-1",
  sessionId: "session-1",
  call: { id: "call-1", name: "write", arguments: { path: "/tmp/a", content: "exact input" } },
  tool: {
    source: "runtime",
    sourceId: "runtime",
    name: "write",
    modelName: "write",
    description: "write",
  },
};
function setup() {
  const connections = new PermissionConnections();
  const identity = binding();
  const repository = {
    open: vi.fn<PermissionRepository["open"]>().mockResolvedValue(identity),
    decide: vi.fn<PermissionRepository["decide"]>().mockResolvedValue(true),
    cancelAbandoned: vi.fn<PermissionRepository["cancelAbandoned"]>().mockResolvedValue(),
  };
  const access = { assert: vi.fn().mockResolvedValue(undefined) };
  const service = new ToolPermissions(repository, connections, access);
  const cancellation = new AbortController();
  const input = {
    ...structuredClone(request),
    signal: cancellation.signal,
    authoritySignal: new AbortController().signal,
  };
  const attach = (
    handler: (request: PermissionRequest, signal: AbortSignal) => Promise<unknown>,
    id = "first",
    owner = identity,
  ) => {
    const lifetime = new AbortController();
    connections.attach({
      binding: { ...owner, connectionId: id },
      sessionId: request.sessionId,
      signal: lifetime.signal,
      request: handler,
    });
    return lifetime;
  };
  return { connections, repository, access, service, cancellation, input, attach };
}
const selected = (optionId: string) => ({ outcome: { outcome: "selected", optionId } });

describe("Durable Tool permissions", () => {
  it("judges only unannotated Smart calls; rules, other modes and explicit hints win", async () => {
    const h = setup();
    const snap = snapshot();
    snap.executionSpec.configuration = {
      modelProfileId: "m",
      modelProfileRevisionId: "r",
      authorizationRevision: 1,
      authorization: { mode: "smart_approve", toolRules: [] },
      digest: "a".repeat(64),
    };
    const input = { ...h.input, snapshot: snap, credential: "test", context: [] };
    const permission = {
      request: vi.fn().mockResolvedValue({ decision: "reject_once", reason: "client_response" }),
    };
    const judge = { readOnly: vi.fn().mockResolvedValue(true) };
    const policy = new RunToolAuthorization(permission, judge);
    expect(await policy.check(input, request)).toBeNull();
    expect(judge.readOnly).toHaveBeenCalledOnce();
    judge.readOnly.mockClear();
    for (const annotations of [
      { readOnlyHint: false },
      { destructiveHint: true },
      { readOnlyHint: true, destructiveHint: true },
    ]) {
      expect(
        await policy.check(input, { ...request, tool: { ...request.tool, annotations } }),
      ).not.toBeNull();
    }
    expect(
      await policy.check(input, { ...request, tool: { ...request.tool, source: "client" } }),
    ).not.toBeNull();
    snap.executionSpec.configuration.authorization.toolRules = [
      { source: "runtime", sourceId: "runtime", toolName: "write", decision: "deny" },
    ];
    expect(await policy.check(input, request)).not.toBeNull();
    snap.executionSpec.configuration.authorization.toolRules = [];
    snap.executionSpec.configuration.authorization.mode = "approve";
    expect(await policy.check(input, request)).not.toBeNull();
    expect(judge.readOnly).not.toHaveBeenCalled();
  });
  it("observes the approval lifecycle without copying arguments to telemetry", async () => {
    const h = setup();
    h.attach(() => Promise.resolve(selected("allow_once")));
    const spans = vi.fn();
    const span: TelemetryPort["span"] = (name, attributes, operation) => {
      spans(name, attributes);
      return operation();
    };
    const telemetry = {
      ...NOOP_TELEMETRY,
      span,
      log: vi.fn(),
      count: vi.fn(),
    };
    await new InstrumentedToolPermissions(
      new ToolPermissions(h.repository, h.connections, h.access),
      telemetry,
    ).request(h.input);
    expect(spans).toHaveBeenCalledWith("acp.permission.wait", {
      "run.id": request.runId,
      "session.id": request.sessionId,
      "tool.call_id": request.call.id,
    });
    expect(telemetry.count).toHaveBeenCalledWith("antnest.acp.permission.decisions", {
      decision: "allow_once",
      reason: "client_response",
    });
    expect(
      JSON.stringify([telemetry.log.mock.calls, spans.mock.calls, telemetry.count.mock.calls]),
    ).not.toContain("exact input");
  });
  it("releases Session registrations without closing other Sessions on a shared connection", async () => {
    const h = setup();
    const lifetime = new AbortController();
    const handler = vi.fn(() => Promise.resolve(selected("allow_once")));
    const connection = { binding: binding(), signal: lifetime.signal, request: handler };
    h.connections.attach({ ...connection, sessionId: request.sessionId });
    const count = getEventListeners(lifetime.signal, "abort").length;
    for (let index = 0; index < 30; index++) {
      h.connections.attach({ ...connection, sessionId: `closed-${index}` });
      h.connections.detach(`closed-${index}`);
    }
    expect(getEventListeners(lifetime.signal, "abort")).toHaveLength(count);
    expect(await h.service.request(h.input)).toMatchObject({ decision: "allow_once" });
    h.connections.detach(request.sessionId);
    expect(getEventListeners(lifetime.signal, "abort")).toHaveLength(0);
  });
  it("persists before asking and commits before returning approval", async () => {
    const h = setup();
    const response = Promise.withResolvers<unknown>();
    const handler = vi.fn().mockImplementation(() => response.promise);
    h.attach(handler);
    const pending = h.service.request(h.input);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(h.repository.open).toHaveBeenCalledWith(request);
    expect(h.repository.decide).not.toHaveBeenCalled();
    response.resolve(selected("allow_always"));
    expect(await pending).toMatchObject({ decision: "allow_always" });
    expect(h.access.assert).toHaveBeenCalledTimes(2);
    expect(h.repository.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        rule: {
          source: "runtime",
          sourceId: "runtime",
          toolName: "write",
          decision: "allow",
        },
      }),
    );
  });

  it("rejects a revoked identity even when the reply allows always", async () => {
    const h = setup();
    h.access.assert
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new DomainError("connection_binding_stale", "revoked"));
    h.attach(() => Promise.resolve(selected("allow_always")));
    expect(await h.service.request(h.input)).toEqual({
      decision: "cancelled",
      reason: "connection_binding_stale",
    });
    expect(h.repository.decide.mock.calls[0]?.[0].rule).toBeUndefined();
  });

  it("reissues on reconnect and ignores a late approval on the old connection", async () => {
    const h = setup();
    const old = Promise.withResolvers<unknown>();
    const handler = vi.fn(() => old.promise);
    const disconnected = h.attach(handler);
    const pending = h.service.request(h.input);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    disconnected.abort();
    h.attach(() => Promise.resolve(selected("reject_once")), "second");
    old.resolve(selected("allow_always"));
    expect(await pending).toMatchObject({ decision: "reject_once" });
    expect(h.repository.open).toHaveBeenCalledOnce();
    expect(h.repository.decide).toHaveBeenCalledOnce();
    expect(h.repository.decide.mock.calls[0]?.[0].rule).toBeUndefined();
  });

  it("does not route an approval to another principal or access revision", async () => {
    const h = setup();
    const wrong = vi.fn(() => Promise.resolve(selected("allow_always")));
    h.attach(wrong, "foreign", { ...binding(), principalId: "other" });
    const pending = h.service.request(h.input);
    await vi.waitFor(() => expect(h.repository.open).toHaveBeenCalledOnce());
    h.attach(wrong, "stale", { ...binding(), accessRevision: "old" });
    h.cancellation.abort();
    expect(await pending).toMatchObject({ decision: "cancelled" });
    expect(wrong).not.toHaveBeenCalled();
  });

  it("ends an unresponsive wait on cancellation without accepting a late answer", async () => {
    const h = setup();
    const response = Promise.withResolvers<unknown>();
    const handler = vi.fn(() => response.promise);
    h.attach(handler);
    const pending = h.service.request(h.input);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    h.cancellation.abort();
    response.resolve(selected("allow_always"));
    expect(await pending).toEqual({ decision: "cancelled", reason: "run_cancelled" });
    expect(h.repository.decide.mock.calls[0]?.[0].rule).toBeUndefined();
  });

  it("fails closed for unsupported handlers and terminal-state conflicts", async () => {
    const h = setup();
    h.attach(() => Promise.reject(new Error("Method not found")));
    expect(await h.service.request(h.input)).toMatchObject({
      decision: "cancelled",
      reason: "permission_unavailable",
    });
    h.repository.decide.mockResolvedValue(false);
    h.attach(() => Promise.resolve(selected("allow_once")), "second");
    expect(await h.service.request(h.input)).toMatchObject({
      decision: "cancelled",
      reason: "permission_stale",
    });
  });

  it("does not write a response after worker authority is lost", async () => {
    const h = setup();
    const authority = new AbortController();
    h.attach(() => {
      authority.abort();
      return Promise.resolve(selected("allow_always"));
    });
    await expect(
      h.service.request({ ...h.input, authoritySignal: authority.signal }),
    ).rejects.toThrow();
    expect(h.repository.decide).not.toHaveBeenCalled();
  });

  it("applies always within this Run but never promotes once or changes the frozen snapshot", async () => {
    const h = setup();
    const snap = snapshot();
    snap.executionSpec.configuration = {
      modelProfileId: "m",
      modelProfileRevisionId: "r",
      authorizationRevision: 1,
      authorization: { mode: "approve", toolRules: [] },
      digest: "a".repeat(64),
    };
    const input = { ...h.input, snapshot: snap, credential: "test", context: [] };
    const permission = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ decision: "allow_once", reason: "client_response" })
        .mockResolvedValue({ decision: "allow_always", reason: "client_response" }),
    };
    const policy = new RunToolAuthorization(permission);
    expect(await policy.check(input, request)).toBeNull();
    expect(await policy.check(input, request)).toBeNull();
    expect(await policy.check(input, request)).toBeNull();
    expect(permission.request).toHaveBeenCalledTimes(2);
    expect(snap.executionSpec.configuration.authorization.toolRules).toEqual([]);
  });
});

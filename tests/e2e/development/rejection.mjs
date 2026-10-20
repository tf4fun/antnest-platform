import assert from "node:assert/strict";
import { inspect } from "node:util";
import { createWorkspacePrivateAccess } from "../workspace-closeout/private-access.mjs";
import { collectPrivateACPTrace } from "../identity-closeout/private-acp-trace.mjs";
import { audioData } from "../acp-multimodal/fixtures.mjs";
import {
  assertCaptureDisabled,
  tag,
  traceTopology,
} from "../observability/trace-tree.mjs";

function collectTrace(base, expected, options) {
  return collectPrivateACPTrace(base, expected, {
    ...options,
    inspect(trace, bound) {
      const tree = traceTopology(trace);
      assertCaptureDisabled(trace);
      const prompts = trace.spans.filter(
        (span) =>
          tree.service(span) === "agent-acp-service" &&
          tag(span, "rpc.method") === "session/prompt" &&
          tag(span, "span.kind") === "server",
      );
      assert.equal(prompts.length, 1);
      assert.equal(tag(prompts[0], "antnest.session.id"), bound.sessionId);
      assert(JSON.stringify(trace).includes("model_unsupported_content"));
      assert(
        !trace.spans.some(
          (span) =>
            span.operationName === "HTTP POST model" ||
            (tree.service(span) === "antnest-runtime" &&
              tag(span, "rpc.method") === "tools/call"),
        ),
      );
      return {
        trace_id: trace.traceID,
        error_class: "model_unsupported_content",
        model_requests: 0,
        runtime_tool_calls: 0,
      };
    },
  });
}

export async function runDevelopmentRejection(
  config,
  { privateAccess, directory, agentId, browser, principal, secrets, signal },
  { createAccess = createWorkspacePrivateAccess } = {},
) {
  signal?.throwIfAborted();
  const access = await createAccess(
    { ...config, privateAccess, evidence: directory },
    { signal, secrets, collectTrace },
  );
  const errors = [],
    result = {};
  try {
    const client = await access.open(
      agentId,
      { accessToken: browser.accessToken },
      principal,
    );
    const { sessionId } = await client.request("new", {
      cwd: "/workspace",
      mcpServers: [],
    });
    result.sessionId = sessionId;
    await assert.rejects(
      client.request("prompt", {
        sessionId,
        prompt: [
          { type: "text", text: "Development unsupported audio" },
          { type: "audio", mimeType: "audio/wav", data: audioData },
        ],
      }),
      (error) => {
        assert.equal(error.code, -32022);
        assert.equal(error.data?.code, "model_unsupported_content");
        assert.equal(error.data.retryable, false);
        result.code = error.data.code;
        result.error = inspect(error, { depth: 8 });
        return true;
      },
    );
    await client.closeAndWait();
    const prompts = client.requestEvidence.filter(
      (row) => row.method === "session/prompt",
    );
    assert.equal(prompts.length, 1);
    const [receipt] = prompts;
    assert.equal(receipt.agentId, agentId);
    assert.equal(receipt.sessionId, sessionId);
    assert.equal(receipt.inputSessionID, sessionId);
    assert.equal(receipt.outcome, "failed");
    assert.deepEqual(receipt.rejectionReceipt, {
      rpcCode: -32022,
      code: "model_unsupported_content",
      retryable: false,
    });
    result.receipt = structuredClone(receipt);
    // WS receipts identify the connection and wire request, not the RPC Trace.
    // The existing collector resolves its real linked root and retains three
    // stable full sources while the original CLIENT exporter is still alive.
    result.trace = await access.collect({ ...receipt, kind: "request" }, []);
    assert.match(result.trace.trace_id ?? "", /^[a-f0-9]{32}$/u);
    assert.notEqual(result.trace.trace_id, receipt.connectionTraceID);
    result.traceID = result.trace.trace_id;
  } catch (error) {
    errors.push(error);
  }
  try {
    await access.closeAndWait();
  } catch (error) {
    errors.push(error);
  }
  if (signal?.aborted) errors.push(signal.reason);
  if (errors.length)
    throw new AggregateError(
      [...new Set(errors)],
      "Development rejection or cleanup failed",
    );
  return result;
}

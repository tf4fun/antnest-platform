import { once } from "node:events";
import { finished } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SpanStatusCode } from "@opentelemetry/api";
import { DEFAULT_STATE_DELIVERY_TIMEOUT_MS } from "../config.js";
import { agentExecutionStateRequestSchema } from "../domain/agent-execution-state.js";
import type {
  AgentExecutionStatePort,
  ExecutionStateSink,
} from "../ports/agent-execution-state.js";
import { activeHttpSpan } from "../telemetry/http.js";
import { recordBoundaryError, rpcContent } from "../telemetry/diagnostics.js";
import { readRpcRequest, rpcJson, RpcRequestError } from "./rpc-request.js";
import { trustedIdentity } from "./trusted-identity.js";

export const AGENT_EXECUTION_STATE_PATH = "/rpc/agent-acp/get-agent-execution-state";
export const AGENT_EXECUTION_WATCH_PATH = "/rpc/agent-acp/watch-agent-execution-state";

export async function serveAgentExecutionState(
  request: IncomingMessage,
  response: ServerResponse,
  service: AgentExecutionStatePort | undefined,
  maxBytes: number,
  ready: () => Promise<boolean>,
  deliveryTimeoutMs = DEFAULT_STATE_DELIVERY_TIMEOUT_MS,
): Promise<void> {
  const streaming = request.url === AGENT_EXECUTION_WATCH_PATH;
  const span = activeHttpSpan();
  span?.setAttributes({
    "rpc.system.name": "json-over-http",
    "rpc.service": "agent-acp",
    "rpc.method": streaming ? "watch_agent_execution_state" : "get_agent_execution_state",
  });
  const disconnected = new AbortController();
  const isDisconnected = () => disconnected.signal.aborted;
  const onClose = () => disconnected.abort();
  response.once("close", onClose);
  try {
    const identity = trustedIdentity(request.headers);
    if (identity === null)
      throw new RpcRequestError(401, "access_denied", "Trusted caller identity is required");
    const input = agentExecutionStateRequestSchema.safeParse(
      await readRpcRequest(request, maxBytes),
    );
    if (!input.success)
      throw new RpcRequestError(
        400,
        "invalid_request",
        "State requests require an empty JSON object",
      );
    if (!streaming && span !== undefined) rpcContent(span, "request", input.data);
    if (service === undefined || !(await ready())) throw new Error("State service is unavailable");
    span?.setAttributes({
      "antnest.organization.id": identity.organizationId,
      "antnest.agent.id": identity.agentId,
    });
    const send: ExecutionStateSink = (state, signal) => {
      signal.throwIfAborted();
      if (streaming) return writeState(response, state, signal, deliveryTimeoutMs);
      if (span !== undefined) rpcContent(span, "response", state);
      rpcJson(response, 200, state);
      return Promise.resolve();
    };
    if (streaming) {
      await service.watch(identity, send, disconnected.signal);
      await finishResponse(response, disconnected.signal, deliveryTimeoutMs);
    } else {
      await service.read(identity, send, disconnected.signal);
    }
  } catch (error) {
    if (isDisconnected()) return;
    const failure = stateError(error);
    if (span !== undefined) {
      recordBoundaryError(span, error, "agent.execution_state");
      if (failure.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      if (!streaming) rpcContent(span, "response", failure.body);
    }
    if (error instanceof StateDeliveryTimeoutError) {
      response.destroy();
    } else if (response.headersSent) {
      try {
        await finishResponse(
          response,
          disconnected.signal,
          deliveryTimeoutMs,
          frame("workspace_error", failure.body),
        );
      } catch (deliveryError) {
        if (span !== undefined && !isDisconnected())
          recordBoundaryError(span, deliveryError, "agent.execution_state.delivery");
        response.destroy();
      }
    } else {
      response.setHeader("Connection", "close");
      rpcJson(response, failure.status, failure.body);
    }
  } finally {
    response.off("close", onClose);
  }
}

async function writeState(
  response: ServerResponse,
  state: unknown,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  signal.throwIfAborted();
  if (!response.headersSent)
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
  if (!response.write(frame("workspace_state", state)))
    await withDeliveryDeadline(signal, timeoutMs, async (bounded) => {
      await once(response, "drain", { signal: bounded });
    });
}

async function finishResponse(
  response: ServerResponse,
  signal: AbortSignal,
  timeoutMs: number,
  body?: string,
): Promise<void> {
  await withDeliveryDeadline(signal, timeoutMs, async (bounded) => {
    const completion = finished(response, { cleanup: true, signal: bounded });
    response.end(body);
    await completion;
  });
}

class StateDeliveryTimeoutError extends Error {
  public constructor() {
    super("Workspace state delivery timed out");
    this.name = "StateDeliveryTimeoutError";
  }
}

async function withDeliveryDeadline(
  signal: AbortSignal,
  timeoutMs: number,
  action: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  signal.throwIfAborted();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new StateDeliveryTimeoutError()), timeoutMs);
  timer.unref();
  try {
    await action(AbortSignal.any([signal, deadline.signal]));
  } catch (error) {
    if (deadline.signal.aborted && !signal.aborted) throw deadline.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function stateError(error: unknown) {
  if (error instanceof RpcRequestError)
    return {
      status: error.status,
      body: { code: error.code, message: error.message, retryable: false },
    };
  return {
    status: 503,
    body: {
      code: "execution_state_unavailable",
      message: "Agent execution state is unavailable",
      retryable: true,
    },
  };
}

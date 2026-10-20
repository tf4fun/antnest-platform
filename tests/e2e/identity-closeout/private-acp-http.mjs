import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";

const failure = (message = "private ACP HTTP transport failed") =>
  new Error(message);
const requireValue = (condition, message) => {
  if (!condition) throw failure(message);
};
const stamp = () => ({ unixMs: Date.now(), monotonicMs: performance.now() });

function configuration(endpoint, options) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw failure("invalid private ACP HTTP endpoint");
  }
  requireValue(
    ["http:", "https:"].includes(url.protocol) &&
      url.pathname === "/v1/acp" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "invalid private ACP HTTP endpoint",
  );
  requireValue(
    typeof options.headersFor === "function",
    "private HTTP credentials provider required",
  );
  requireValue(
    typeof options.telemetry?.startHTTP === "function" &&
      typeof options.telemetry?.flush === "function",
    "exporting private HTTP telemetry required",
  );
  const initializationTimeoutMs = options.initializationTimeoutMs ?? 10000;
  const closeTimeoutMs = options.closeTimeoutMs ?? 5000;
  requireValue(
    Number.isSafeInteger(initializationTimeoutMs) &&
      initializationTimeoutMs > 0 &&
      initializationTimeoutMs <= 10000,
    "invalid private HTTP initialization timeout",
  );
  requireValue(
    Number.isSafeInteger(closeTimeoutMs) &&
      closeTimeoutMs > 0 &&
      closeTimeoutMs <= 5000,
    "invalid private HTTP cleanup timeout",
  );
  return { endpoint: url.href, initializationTimeoutMs, closeTimeoutMs };
}

function credentialHeaders(input) {
  try {
    const headers = new Headers(input);
    const context = headers.get("antnest-caller-context");
    const grant = headers.get("antnest-service-authorization");
    requireValue(
      [...headers.keys()].length === 2 &&
        typeof context === "string" &&
        context.length <= 8192 &&
        /^[\x21-\x7e]+$/u.test(context) &&
        /^Bearer [A-Za-z0-9_-]{43}$/u.test(grant ?? ""),
      "invalid private HTTP credentials",
    );
    return headers;
  } catch {
    throw failure("invalid private HTTP credentials");
  }
}

// One raw reader owns all reads and cancellation. Its completion is independent
// of the SDK's willingness to read an ACK, and never joins its own cancel hook.
function ownBody(response, signal, receipt, recordFailure, end) {
  if (!response.body) {
    receipt.bodyOutcome = "eof";
    end();
    return { response, closed: Promise.resolve() };
  }
  const reader = response.body.getReader();
  let controller,
    reading,
    cancellation,
    ending = false,
    released = false;
  let terminalFailed = false,
    terminalError;
  const { promise: closed, resolve, reject } = Promise.withResolvers();
  void closed.catch(() => {});
  const event = (kind) => receipt.events.push({ kind, ...stamp() });
  const bodyFailure = (reason) => {
    receipt.bodyOutcome = "failed";
    recordFailure(
      receipt.method === "DELETE" ? "delete_body" : "response_body",
      receipt,
      reason,
    );
  };
  const observeError = (error) => {
    // Identity, not an error name or the mere fact of closing, identifies the
    // abort we own. Independent reset/cancel errors remain errors while closing.
    if (signal.aborted && error === signal.reason) {
      if (receipt.bodyOutcome === "pending") receipt.bodyOutcome = "cancelled";
    } else bodyFailure("read");
  };
  const rawClosed = reader.closed.then(
    () => {},
    (error) => {
      terminalFailed = true;
      terminalError = error;
      if (!released) {
        observeError(error);
        finish();
      }
    },
  );
  const finish = () => {
    if (ending) return;
    ending = true;
    signal.removeEventListener("abort", abort);
    void Promise.resolve()
      .then(async () => {
        await reading;
        await cancellation;
        await rawClosed;
        try {
          released = true;
          reader.releaseLock();
        } catch {
          bodyFailure("release");
        }
        event("body_closed");
        end();
        if (receipt.bodyOutcome === "failed")
          throw failure("private ACP HTTP body failed");
      })
      .then(resolve, () => reject(failure("private ACP HTTP body failed")));
  };
  const cancelRaw = () => {
    if (ending || cancellation) return;
    event("cancel");
    if (receipt.bodyOutcome === "pending") receipt.bodyOutcome = "cancelled";
    cancellation = (async () => {
      try {
        await reader.cancel();
      } catch (error) {
        // Rejection with undefined/null is still a failure unless it is exactly
        // the raw reader's independently observed, already terminal error.
        if (!terminalFailed || error !== terminalError) bodyFailure("cancel");
      } finally {
        finish();
        try {
          controller.close();
        } catch {
          /* Wrapper already cancelled/errored. */
        }
      }
    })();
  };
  const abort = () => cancelRaw();
  const body = new ReadableStream(
    {
      start(value) {
        controller = value;
      },
      pull(output) {
        reading = (async () => {
          try {
            const next = await reader.read();
            if (ending || cancellation) return;
            if (next.done) {
              receipt.bodyOutcome = "eof";
              event("eof");
              finish();
              output.close();
            } else {
              receipt.bytes += next.value.byteLength;
              if (receipt.method === "DELETE" && receipt.bytes > 65536) {
                bodyFailure("limit");
                cancelRaw();
                output.error(
                  failure("private ACP HTTP cleanup body exceeded limit"),
                );
              } else output.enqueue(next.value);
            }
          } catch (error) {
            observeError(error);
            finish();
            output.error(failure("private ACP HTTP body failed"));
          }
        })();
        return reading;
      },
      cancel() {
        cancelRaw();
        return closed;
      },
    },
    { highWaterMark: 0 },
  );
  const forwarded = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return { response: forwarded, closed };
}

export function createPrivateACPHTTP(endpoint, options = {}) {
  const config = configuration(endpoint, options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const traffic = new AbortController(),
    cleanup = new AbortController();
  const pending = new Set(),
    requests = [],
    failures = [];
  let connection, closing, cleanupTimer, initializationTimer;
  let initialized = false,
    closingStarted = false,
    streamJoined = false;
  let targetID,
    deletes = 0,
    cancelInitialization;
  let connectionCloseAttempted = false;
  const recordFailure = (phase, receipt, reason) => {
    if (receipt) receipt.failed = true;
    const value = {
      phase,
      ...(receipt ? { requestIndex: receipt.index } : {}),
      ...(reason ? { reason } : {}),
    };
    if (
      !failures.some((prior) => JSON.stringify(prior) === JSON.stringify(value))
    )
      failures.push(value);
  };
  const track = (task) => {
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };
  const closeConnection = (reason) => {
    if (!connection || connectionCloseAttempted) return;
    connectionCloseAttempted = true;
    try {
      connection.close(reason);
    } catch {
      recordFailure("connection_close");
    }
  };
  const detachInitialization = () => {
    clearTimeout(initializationTimer);
    if (cancelInitialization)
      options.signal?.removeEventListener("abort", cancelInitialization);
  };
  const beginClose = () => {
    if (closingStarted) return;
    closingStarted = true;
    detachInitialization();
    cleanupTimer = setTimeout(() => {
      recordFailure("deadline");
      cleanup.abort(failure("private ACP HTTP cleanup deadline"));
      traffic.abort();
    }, config.closeTimeoutMs);
  };

  const dispatch = async (_input, init) => {
    const method = init.method;
    const deleting = method === "DELETE";
    if (deleting) {
      deletes++;
      beginClose();
    }
    const headers = new Headers(init.headers);
    const initializing = method === "POST" && !headers.has("acp-connection-id");
    const signal = AbortSignal.any([
      ...(init.signal ? [init.signal] : []),
      deleting ? cleanup.signal : traffic.signal,
    ]);
    const receipt = {
      index: requests.length,
      method,
      connectionID: headers.get("acp-connection-id"),
      sessionID: headers.get("acp-session-id"),
      status: null,
      bodyOutcome: "pending",
      bytes: 0,
      failed: false,
      wireStarted: false,
      started: stamp(),
      events: [],
    };
    requests.push(receipt);
    let client,
      endAttempted = false,
      bodyOwned = false,
      phase = "headers";
    const end = () => {
      if (endAttempted) return;
      endAttempted = true;
      try {
        client?.end(
          receipt.status,
          receipt.failed ? "failed" : receipt.bodyOutcome,
          receipt.bytes,
          receipt.bodyOutcome,
        );
      } catch {
        recordFailure("telemetry_end", receipt);
        throw failure("private ACP HTTP telemetry end failed");
      }
      receipt.ended = stamp();
    };
    try {
      if (method === "POST") {
        requireValue(
          typeof init.body === "string",
          "private HTTP requires the SDK JSON message",
        );
        const message = JSON.parse(init.body);
        receipt.rpcMethod =
          typeof message.method === "string" ? message.method : null;
        receipt.requestID = message.id ?? null;
        receipt.rpcSessionID =
          typeof message.params?.sessionId === "string"
            ? message.params.sessionId
            : null;
      }
      signal.throwIfAborted();
      const current = credentialHeaders(
        await options.headersFor({ method, signal }),
      );
      signal.throwIfAborted();
      current.forEach((value, key) => headers.set(key, value));
      client = options.telemetry.startHTTP(method);
      Object.assign(receipt, {
        traceID: client.traceID,
        clientSpanID: client.clientSpanID,
      });
      headers.set("traceparent", client.traceparent);
      phase = deleting ? "delete_request" : "request";
      receipt.wireStarted = true;
      const response = await fetchImpl(config.endpoint, {
        ...init,
        headers,
        signal,
        credentials: "omit",
        redirect: "error",
      });
      receipt.status = response.status;
      receipt.events.push({ kind: "headers", ...stamp() });
      if (
        initializing &&
        response.ok &&
        response.headers.has("acp-connection-id")
      ) {
        targetID = response.headers.get("acp-connection-id");
        receipt.responseConnectionID = targetID;
      }
      const expected = method === "GET" || initializing ? 200 : 202;
      if (response.status !== expected)
        recordFailure(deleting ? "delete_status" : "response_status", receipt);
      phase = deleting ? "delete_body" : "response_body";
      // DELETE can fail after its body has cancelled normally. Keep its CLIENT
      // open until the exact status, full body and cleanup outcome are known.
      const owned = ownBody(
        response,
        signal,
        receipt,
        recordFailure,
        deleting ? () => {} : end,
      );
      bodyOwned = true;
      track(owned.closed);
      if (!deleting) return owned.response;
      const bodyReader = owned.response.body?.getReader();
      try {
        if (bodyReader)
          while (!(await bodyReader.read()).done) {
            /* Bounded raw body is owned above. */
          }
        await owned.closed;
      } finally {
        bodyReader?.releaseLock();
        await owned.closed.catch(() => {});
      }
      if (receipt.bodyOutcome !== "eof")
        recordFailure("delete_body", receipt, "incomplete");
      if (receipt.failed) throw failure("private ACP HTTP DELETE failed");
      return owned.response;
    } catch (error) {
      const cancelled = signal.aborted && error === signal.reason;
      if (deleting || !cancelled) recordFailure(phase, receipt);
      if (!bodyOwned) {
        receipt.bodyOutcome = cancelled ? "cancelled" : "failed";
        end();
      }
      throw failure();
    } finally {
      if (deleting) end();
    }
  };
  const raw = createHttpStream(config.endpoint, {
    cookies: "omit",
    fetch: (input, init) => track(dispatch(input, init)),
  });
  const reader = raw.readable.getReader(),
    writer = raw.writable.getWriter();
  let readerFailed = false,
    readerError,
    writerFailed = false,
    writerError,
    pulling;
  void reader.closed.catch((error) => {
    readerFailed = true;
    readerError = error;
  });
  void writer.closed.catch((error) => {
    writerFailed = true;
    writerError = error;
  });
  const stream = {
    readable: new ReadableStream({
      pull(controller) {
        pulling = (async () => {
          try {
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          } catch {
            controller.error(failure());
          }
        })();
        return pulling;
      },
      cancel: () => closeAndWait(),
    }),
    writable: new WritableStream({
      async write(message) {
        try {
          await writer.write(message);
        } catch {
          throw failure();
        }
      },
      close: () => closeAndWait(),
      abort: () => closeAndWait(),
    }),
  };
  async function stopStream() {
    const settled = await Promise.allSettled([reader.cancel(), writer.abort()]);
    for (const [index, result] of settled.entries()) {
      if (result.status !== "rejected") continue;
      const original =
        index === 0
          ? readerFailed && result.reason === readerError
          : writerFailed && result.reason === writerError;
      if (!original) recordFailure("stream_cleanup");
    }
    await pulling;
    try {
      reader.releaseLock();
      writer.releaseLock();
      streamJoined = true;
    } catch {
      recordFailure("stream_cleanup");
    }
  }
  function closeAndWait() {
    if (closing) return closing;
    beginClose();
    closing = Promise.resolve().then(async () => {
      try {
        closeConnection();
        const stopped = stopStream();
        traffic.abort();
        await stopped.catch(() => recordFailure("stream_cleanup"));
        // Both the original writer and this dynamic set must settle: SDK
        // errorReadable detaches DELETE, and late initialize can add it later.
        while (pending.size) await Promise.allSettled([...pending]);
        if (
          targetID &&
          (deletes !== 1 ||
            requests.filter(
              (r) => r.method === "DELETE" && r.connectionID === targetID,
            ).length !== 1)
        )
          recordFailure("receipt_count");
        if (failures.length)
          throw new AggregateError(
            failures.map((value) =>
              failure(`private ACP HTTP ${value.phase} failed`),
            ),
            "private ACP HTTP cleanup failed",
          );
      } finally {
        clearTimeout(cleanupTimer);
        detachInitialization();
      }
    });
    void closing.catch(() => {});
    return closing;
  }
  return Object.freeze({
    stream,
    bindConnection(value) {
      requireValue(
        !connection &&
          !closingStarted &&
          typeof value?.close === "function" &&
          typeof value?.closed?.then === "function",
        "private HTTP requires one active SDK connection",
      );
      connection = value;
      cancelInitialization = () => {
        beginClose();
        closeConnection(failure("private ACP HTTP initialization cancelled"));
        void closeAndWait().catch(() => {});
      };
      initializationTimer = setTimeout(
        cancelInitialization,
        config.initializationTimeoutMs,
      );
      options.signal?.addEventListener("abort", cancelInitialization, {
        once: true,
      });
      if (options.signal?.aborted) cancelInitialization();
      void connection.closed.then(() => closeAndWait()).catch(() => {});
    },
    completeInitialization() {
      requireValue(
        connection &&
          !closingStarted &&
          !initialized &&
          !options.signal?.aborted &&
          requests.some(
            (r) =>
              r.rpcMethod === "initialize" &&
              r.status === 200 &&
              r.bodyOutcome === "eof" &&
              r.responseConnectionID === targetID &&
              !r.failed,
          ),
        "private ACP HTTP initialization did not complete",
      );
      initialized = true;
      detachInitialization();
    },
    closeAndWait,
    snapshot: () =>
      structuredClone({
        initialized,
        closing: closingStarted,
        streamJoined,
        pendingRequests: pending.size,
        requests,
        failures,
      }),
  });
}

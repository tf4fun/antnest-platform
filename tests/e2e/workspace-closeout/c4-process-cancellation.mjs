import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Observe the caller's original AbortSignal. HTTP ERR_ABORTED alone cannot
// distinguish a superseded process read from a real application deadline.
export async function observeC4ProcessCancellation(
  page,
  { gateway, agentId, signal },
) {
  signal?.throwIfAborted();
  const origin = new URL(gateway).origin;
  const prefix = `/api/app/workspace/v1/agents/${encodeURIComponent(agentId)}/sessions/`;
  const binding = `__c4ProcessCancellation_${randomUUID().replaceAll("-", "")}`;
  const stateKey = `${binding}_state`;
  const records = [],
    documents = new Map(),
    requests = new Map();
  let generation = 0,
    sequence = 0,
    currentDocument = null,
    closing;
  const selected = (url) =>
    url.origin === origin &&
    !url.hash &&
    url.pathname.startsWith(prefix) &&
    /^[^/]+\/turns\/[^/]+\/process$/u.test(url.pathname.slice(prefix.length));
  const requested = (request) => {
    if (
      request.method() !== "GET" ||
      request.frame() !== page.mainFrame() ||
      request.redirectedFrom() !== null ||
      !selected(new URL(request.url()))
    )
      return;
    requests.set(request, {
      documentId: currentDocument,
      generation,
      url: request.url(),
      started: ++sequence,
      terminal: null,
    });
  };
  const terminal = (request) => {
    const value = requests.get(request);
    if (value) value.terminal = ++sequence;
  };
  page.on("request", requested);
  page.on("requestfinished", terminal);
  page.on("requestfailed", terminal);
  const detach = () => {
    page.off("request", requested);
    page.off("requestfinished", terminal);
    page.off("requestfailed", terminal);
  };
  try {
    await page.exposeBinding(binding, (source, event) => {
      if (source.frame !== page.mainFrame()) return;
      if (event.type === "document") {
        assert.equal(typeof event.documentId, "string");
        assert(!documents.has(event.documentId));
        // The init script runs once per actual Document. SPA history changes
        // retain this identity and must not invalidate its original Requests.
        documents.set(event.documentId, {
          generation: ++generation,
          fetches: [],
        });
        currentDocument = event.documentId;
        return;
      }
      const document = documents.get(event.documentId);
      assert(document, "Process cancellation has no original document");
      if (event.type === "start") {
        assert(selected(new URL(event.url)));
        assert.equal(event.method, "GET");
        assert(!document.fetches.some((row) => row.fetchId === event.fetchId));
        document.fetches.push({ ...event, cancellation: null });
      } else if (event.type === "abort") {
        const original = document.fetches.find(
          (row) => row.fetchId === event.fetchId,
        );
        assert(original && original.cancellation === null);
        assert(
          Number.isFinite(event.abortedAt) &&
            event.abortedAt >= original.startedAt,
        );
        assert(
          ["default_abort", "deadline", "session_changed", "unknown"].includes(
            event.reasonKind,
          ),
        );
        const record = Object.freeze({
          documentId: event.documentId,
          fetchId: event.fetchId,
          method: original.method,
          path: new URL(original.url).pathname,
          startedAt: original.startedAt,
          abortedAt: event.abortedAt,
          reasonKind: event.reasonKind,
        });
        original.cancellation = record;
        records.push(record);
      } else throw new Error("Unknown process cancellation observation");
    });
    await page.addInitScript(
      ({ binding, stateKey, origin, prefix }) => {
        if (globalThis !== globalThis.top || location.origin !== origin) return;
        const originalFetch = globalThis.fetch;
        const documentId = crypto.randomUUID();
        let fetchSequence = 0,
          stopped = false;
        const pending = new Set(),
          listeners = new Set(),
          failures = [];
        const send = (event) => {
          const work = globalThis[binding]({ documentId, ...event });
          pending.add(work);
          void work.then(
            () => pending.delete(work),
            (error) => {
              failures.push(error);
              pending.delete(work);
            },
          );
        };
        send({ type: "document" });
        const defaultReason = AbortSignal.abort().reason;
        const reasonKind = (reason) => {
          if (
            reason instanceof DOMException &&
            reason.name === defaultReason.name &&
            reason.message === defaultReason.message &&
            reason.code === defaultReason.code
          )
            return "default_abort";
          if (
            reason instanceof Error &&
            reason.name === "Error" &&
            reason.message === "Workspace request timed out"
          )
            return "deadline";
          if (
            reason instanceof Error &&
            reason.name === "BrowserSessionChanged"
          )
            return "session_changed";
          return "unknown";
        };
        const wrapped = function (...args) {
          const [input, init] = args;
          // Do not coerce arbitrary objects or inspect headers/bodies. Even a
          // failed observation must leave the original fetch call unchanged.
          let url, method, requestSignal;
          if (
            !stopped &&
            (typeof input === "string" ||
              input instanceof URL ||
              input instanceof Request)
          ) {
            try {
              url = new URL(
                input instanceof Request ? input.url : input,
                location.href,
              );
              method = (
                init?.method ??
                (input instanceof Request ? input.method : "GET")
              ).toUpperCase();
              requestSignal =
                init && Object.hasOwn(init, "signal")
                  ? init.signal
                  : input instanceof Request
                    ? input.signal
                    : undefined;
            } catch {
              /* Original fetch retains its own validation behavior. */
            }
          }
          if (
            url &&
            url.origin === origin &&
            url.origin === location.origin &&
            !url.hash &&
            url.pathname.startsWith(prefix) &&
            /^[^/]+\/turns\/[^/]+\/process$/u.test(
              url.pathname.slice(prefix.length),
            ) &&
            method === "GET" &&
            requestSignal instanceof AbortSignal &&
            !requestSignal.aborted
          ) {
            const fetchId = `${documentId}:${++fetchSequence}`;
            const startedAt = performance.timeOrigin + performance.now();
            send({ type: "start", fetchId, method, url: url.href, startedAt });
            const aborted = () => {
              listeners.delete(detachSignal);
              send({
                type: "abort",
                fetchId,
                abortedAt: performance.timeOrigin + performance.now(),
                reasonKind: reasonKind(requestSignal.reason),
              });
            };
            const detachSignal = () =>
              requestSignal.removeEventListener("abort", aborted);
            listeners.add(detachSignal);
            requestSignal.addEventListener("abort", aborted, { once: true });
          }
          // Return the very same native Promise; no response wrapper or retry.
          return Reflect.apply(originalFetch, this, args);
        };
        globalThis.fetch = wrapped;
        const flush = async () => {
          while (pending.size) await Promise.allSettled([...pending]);
          if (failures.length)
            throw new AggregateError(
              failures,
              "Process observer delivery failed",
            );
        };
        globalThis[stateKey] = {
          flush,
          async close() {
            stopped = true;
            if (globalThis.fetch === wrapped) globalThis.fetch = originalFetch;
            for (const detach of listeners) detach();
            listeners.clear();
            await flush();
          },
        };
      },
      { binding, stateKey, origin, prefix },
    );
    signal?.throwIfAborted();
  } catch (error) {
    detach();
    throw error;
  }
  const match = (request) => {
    if (signal?.aborted || !currentDocument) return null;
    const original = requests.get(request),
      document = documents.get(currentDocument);
    if (
      !original ||
      original.documentId !== currentDocument ||
      original.generation !== generation ||
      document?.generation !== generation
    )
      return null;
    const candidates = document.fetches.filter(
      (row) => row.url === original.url,
    );
    const native = [...requests.entries()].filter(
      ([, row]) =>
        row.documentId === currentDocument &&
        row.generation === generation &&
        row.url === original.url,
    );
    if (candidates.length !== native.length) return null;
    // Match only a complete, unambiguous sequence. Concurrent identical URLs
    // have no cross-protocol identifier and must never borrow another signal.
    for (let index = 1; index < candidates.length; index++) {
      const previous = candidates[index - 1],
        earlier = native[index - 1][1];
      if (
        !(previous.cancellation?.abortedAt <= candidates[index].startedAt) &&
        !(
          earlier.terminal !== null &&
          earlier.terminal < native[index][1].started
        )
      )
        return null;
    }
    const index = native.findIndex(([value]) => value === request);
    return candidates[index]?.cancellation ?? null;
  };
  return {
    ready: Promise.resolve(),
    records,
    match,
    async flushAndWait() {
      signal?.throwIfAborted();
      await page.evaluate(async (key) => {
        const state = globalThis[key];
        if (!state)
          throw new Error(
            "Original process observation document is unavailable",
          );
        await state.flush();
      }, stateKey);
      signal?.throwIfAborted();
    },
    closeAndWait() {
      return (closing ??= (async () => {
        try {
          if (!page.isClosed())
            await page.evaluate(async (key) => {
              await globalThis[key]?.close();
            }, stateKey);
          signal?.throwIfAborted();
        } finally {
          detach();
        }
      })());
    },
  };
}

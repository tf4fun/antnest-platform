import {
  createTestWorkspaceHttpServer as createWorkspaceHttpServer,
  testFetch as fetch,
  testHeaders,
} from "./auth-fixture.mjs";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { get } from "node:http";
import {
  setImmediate as nextTurn,
  setTimeout as delay,
} from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { StreamJournal } from "../../../services/agent-ui/web/server/dist/bridge/stream-journal.js";
import { createEventHandler } from "../../../services/agent-ui/web/server/dist/http/event-routes.js";

const soak = process.env.ANTNEST_UI_SSE_SOAK === "1";
const waves = soak ? Number(process.env.ANTNEST_UI_SSE_SOAK_WAVES ?? 36) : 12;
if (!Number.isSafeInteger(waves) || waves < 12 || waves > 240)
  throw new Error(
    "ANTNEST_UI_SSE_SOAK_WAVES must be an integer from 12 to 240",
  );
const slowIntervals = soak ? [10, 20, 50] : [10];
const subscribers = slowIntervals.length + 1;
const runMs = waves * 5_000;

test(
  "Node SSE backpressure bounds throttled observers during sustained output",
  { timeout: runMs + 90_000 },
  async () => {
    assert.equal(
      typeof global.gc,
      "function",
      "Retained-heap verification requires --expose-gc",
    );
    const scope = {
      organizationId: "org-1",
      principalId: "user-1",
      agentId: "agent-1",
    };
    const journal = new StreamJournal({
      scope,
      sessionId: "session-1",
      epoch: "epoch-1",
      projectionId: "projection-1",
      key: Buffer.alloc(32, 7),
      maxSubscriberBytes: 32 * 1024,
    });
    let subscriptions = 0;
    const slowResets = slowIntervals.map(() => 0);
    let releases = 0;
    let latestOperationId = null;
    const eventHandler = createEventHandler({
      subscribe: async (_scope, _sessionId, cursor) => {
        const index = subscriptions++;
        return {
          events: journal.subscribe(cursor, (streamCursor) => {
            if (index < slowIntervals.length) slowResets[index]++;
            return {
              agentId: "agent-1",
              selectedSessionId: "session-1",
              streamCursor,
              lastOperation:
                latestOperationId === null
                  ? null
                  : { operationId: latestOperationId },
            };
          }),
          release: () => {
            releases++;
          },
        };
      },
    });
    const server = createWorkspaceHttpServer({ handle: eventHandler });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const slowRequests = [];
    let fastResponse;
    let reader;
    const slowReadTimers = [];
    const slowBytes = slowIntervals.map(() => 0);
    const samples = [];
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const url = `http://127.0.0.1:${address.port}/api/app/workspace/v1/agents/agent-1/events?sessionId=session-1`;
      const headers = {
        "x-antnest-organization-id": "org-1",
        "x-antnest-principal-id": "user-1",
        "x-antnest-agent-id": "agent-1",
      };
      for (const [index, interval] of slowIntervals.entries()) {
        const response = await new Promise((resolve, reject) => {
          const request = get(url, { headers: testHeaders(headers) }, resolve);
          slowRequests.push(request);
          request.once("error", reject);
        });
        assert.equal(response.statusCode, 200);
        response.pause();
        slowReadTimers.push(
          setInterval(() => {
            const chunk = response.read(1024);
            if (chunk) slowBytes[index] += chunk.length;
          }, interval),
        );
      }
      fastResponse = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(runMs + 60_000),
      });
      assert.equal(fastResponse.status, 200);
      reader = fastResponse.body.getReader();
      let received = "";
      const fastReads = (async () => {
        for (;;) {
          const next = await reader.read();
          if (next.done) return false;
          received += new TextDecoder().decode(next.value);
          if (received.includes(`"operationId":"final-${waves}"`)) return true;
          if (received.length > 256 * 1024)
            received = received.slice(-128 * 1024);
        }
      })();
      global.gc?.();
      const baselineHeapBytes = process.memoryUsage().heapUsed;
      const startedAt = performance.now();
      for (let wave = 1; wave <= waves; wave++) {
        let peakQueuedBytes = 0;
        let peakRetainedBytes = 0;
        const observeBudget = () => {
          const current = journal.snapshotMetrics();
          peakQueuedBytes = Math.max(peakQueuedBytes, current.queuedBytes);
          peakRetainedBytes = Math.max(
            peakRetainedBytes,
            current.retainedBytes,
          );
          assert.ok(
            current.queuedBytes <= subscribers * 32 * 1024,
            `Pending journal bytes exceeded ${subscribers} subscriber limits: ${current.queuedBytes}`,
          );
          assert.ok(
            current.retainedBytes <= 256 * 1024,
            `Journal suffix exceeded its retained byte limit: ${current.retainedBytes}`,
          );
        };
        for (let index = 0; index < 500; index++) {
          latestOperationId = `${wave}-${index}`;
          journal.publish({
            type: "operation",
            operation: {
              operationId: `${wave}-${index}`,
              value: "x".repeat(16 * 1024),
            },
          });
          observeBudget();
          if (index % 8 === 0) await nextTurn();
        }
        latestOperationId = `final-${wave}`;
        journal.publish({
          type: "operation",
          operation: { operationId: `final-${wave}` },
        });
        observeBudget();
        const metrics = journal.snapshotMetrics();
        assert.equal(metrics.subscribers, subscribers);
        assert.ok(
          metrics.queuedBytes <= subscribers * 32 * 1024,
          `Pending journal bytes exceeded ${subscribers} subscriber limits: ${metrics.queuedBytes}`,
        );
        assert.ok(
          metrics.retainedBytes <= 256 * 1024,
          `Journal suffix exceeded its retained byte limit: ${metrics.retainedBytes}`,
        );
        await delay(5_000);
        const memory = process.memoryUsage();
        samples.push({
          wave,
          elapsedMs: Math.round(performance.now() - startedAt),
          slowReadBytes: [...slowBytes],
          slowResets: [...slowResets],
          heapUsedBytes: memory.heapUsed,
          rssBytes: memory.rss,
          peakQueuedBytes,
          peakRetainedBytes,
          queuedBytesBeforeIdle: metrics.queuedBytes,
          retainedBytesBeforeIdle: metrics.retainedBytes,
          ...journal.snapshotMetrics(),
        });
      }
      assert.ok(
        performance.now() - startedAt >= runMs,
        "Throttled observers must remain connected through the sustained load",
      );
      const deadline = new AbortController();
      try {
        assert.equal(
          await Promise.race([
            fastReads,
            delay(15_000, false, { signal: deadline.signal }).catch(
              () => false,
            ),
          ]),
          true,
          "The fast HTTP observer must receive the final event or authoritative reset View",
        );
      } finally {
        deadline.abort();
      }
      for (const [index, resets] of slowResets.entries()) {
        assert.ok(
          resets > 3,
          `Throttled observer ${index} must reset instead of retaining every event`,
        );
        assert.ok(
          slowBytes[index] > 1024 * 1024,
          `Throttled observer ${index} must keep reading throughout the load`,
        );
      }
      for (const request of slowRequests) request.destroy();
      await reader.cancel();
      for (let attempt = 0; attempt < 100 && releases < subscribers; attempt++)
        await delay(20);
      assert.equal(
        releases,
        subscribers,
        "Disconnected HTTP observers release their leases",
      );
      assert.equal(journal.snapshotMetrics().subscribers, 0);
      assert.equal(journal.snapshotMetrics().queuedBytes, 0);
      await delay(10_000);
      global.gc?.();
      const afterDisconnect = process.memoryUsage();
      assert.ok(
        afterDisconnect.heapUsed < baselineHeapBytes + 32 * 1024 * 1024,
        `Retained heap grew after observers disconnected: ${afterDisconnect.heapUsed - baselineHeapBytes}`,
      );
      if (global.gc)
        assert.ok(
          afterDisconnect.heapUsed < baselineHeapBytes + 16 * 1024 * 1024,
          `Retained heap grew after observers disconnected: ${afterDisconnect.heapUsed - baselineHeapBytes}`,
        );
      const evidencePath = fileURLToPath(
        new URL(
          "../../../artifacts/verification/agent-ui-sustained-sse/",
          import.meta.url,
        ),
      );
      await mkdir(evidencePath, { recursive: true });
      await writeFile(
        `${evidencePath}/${
          soak
            ? waves === 36
              ? "metrics-soak.json"
              : `metrics-soak-${waves}-waves.json`
            : "metrics.json"
        }`,
        JSON.stringify(
          {
            capturedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - startedAt),
            publishedEvents: waves * 501,
            slowIntervals,
            slowReadBytes: slowBytes,
            slowResets,
            baselineHeapBytes,
            gcAvailable: Boolean(global.gc),
            afterDisconnect: {
              heapUsedBytes: afterDisconnect.heapUsed,
              rssBytes: afterDisconnect.rss,
              ...journal.snapshotMetrics(),
            },
            samples,
          },
          null,
          2,
        ) + "\n",
      );
    } finally {
      for (const timer of slowReadTimers) clearInterval(timer);
      for (const request of slowRequests) request.destroy();
      await reader?.cancel().catch(() => {});
      journal.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

const scopedWaves = soak ? 12 : 1;
const scopedRunMs = soak ? scopedWaves * 5_000 : 0;

test(
  "independent identity and Session streams isolate slow observers over HTTP",
  { timeout: scopedRunMs + 90_000 },
  async () => {
    const streams = ["user-a", "user-b"].map((principalId, index) => {
      const sessionId = `session-${index + 1}`;
      const marker = `private-${principalId}`;
      let slowResets = 0;
      let subscriptions = 0;
      let releases = 0;
      let latest = "initial";
      const journal = new StreamJournal({
        scope: { organizationId: "org-1", principalId, agentId: "agent-1" },
        sessionId,
        epoch: "epoch-1",
        projectionId: `projection-${index + 1}`,
        key: Buffer.alloc(32, index + 1),
        maxSubscriberBytes: 32 * 1024,
      });
      return {
        principalId,
        sessionId,
        marker,
        journal,
        get slowResets() {
          return slowResets;
        },
        get releases() {
          return releases;
        },
        set latest(value) {
          latest = value;
        },
        subscribe: (cursor) => {
          const slow = subscriptions++ === 0;
          return {
            events: journal.subscribe(cursor, (streamCursor) => {
              if (slow) slowResets++;
              return { streamCursor, marker, latest };
            }),
            release: () => {
              releases++;
            },
          };
        },
      };
    });
    const handler = createEventHandler({
      subscribe: async (scope, sessionId, cursor) => {
        const stream = streams.find(
          (item) =>
            item.principalId === scope.principalId &&
            item.sessionId === sessionId,
        );
        if (!stream) throw new Error("Unexpected stream scope");
        return stream.subscribe(cursor);
      },
    });
    const server = createWorkspaceHttpServer({ handle: handler });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const slowRequests = [];
    const slowResponses = [];
    const slowReadTimers = [];
    const slowReadBytes = streams.map(() => 0);
    const fastResponses = [];
    const scopedSamples = [];
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const connections = streams.map((stream) => ({
        url: `http://127.0.0.1:${address.port}/api/app/workspace/v1/agents/agent-1/events?sessionId=${stream.sessionId}`,
        headers: {
          "x-antnest-organization-id": "org-1",
          "x-antnest-principal-id": stream.principalId,
          "x-antnest-agent-id": "agent-1",
        },
      }));
      for (const [index, connection] of connections.entries()) {
        const response = await new Promise((resolve, reject) => {
          const request = get(
            connection.url,
            { headers: testHeaders(connection.headers) },
            resolve,
          );
          slowRequests.push(request);
          request.once("error", reject);
        });
        assert.equal(response.statusCode, 200);
        response.pause();
        slowResponses.push(response);
        if (soak)
          slowReadTimers.push(
            setInterval(
              () => {
                const chunk = response.read(1024);
                if (chunk) slowReadBytes[index] += chunk.length;
              },
              index === 0 ? 10 : 50,
            ),
          );
        const fast = await fetch(connection.url, {
          headers: connection.headers,
        });
        assert.equal(fast.status, 200);
        fastResponses.push(fast);
      }
      const fastReads = fastResponses.map(async (response, index) => {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let tail = "";
        let crossed = false;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) return { complete: false, crossed };
            tail += decoder.decode(next.value, { stream: true });
            crossed ||= tail.includes(streams[1 - index].marker);
            if (tail.includes(`final-${scopedWaves}-${streams[index].marker}`))
              return { complete: true, crossed };
            if (tail.length > 128 * 1024) tail = tail.slice(-64 * 1024);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      });
      global.gc?.();
      const baselineHeapBytes = process.memoryUsage().heapUsed;
      const startedAt = performance.now();
      for (let wave = 1; wave <= scopedWaves; wave++) {
        const peaks = streams.map(() => ({ queuedBytes: 0, retainedBytes: 0 }));
        const observeBudget = (stream, streamIndex) => {
          const metrics = stream.journal.snapshotMetrics();
          peaks[streamIndex].queuedBytes = Math.max(
            peaks[streamIndex].queuedBytes,
            metrics.queuedBytes,
          );
          peaks[streamIndex].retainedBytes = Math.max(
            peaks[streamIndex].retainedBytes,
            metrics.retainedBytes,
          );
          assert.ok(
            metrics.queuedBytes <= 2 * 32 * 1024,
            `${stream.marker} pending bytes exceeded its own subscriber limits`,
          );
          assert.ok(
            metrics.retainedBytes <= 256 * 1024,
            `${stream.marker} retained suffix exceeded its own limit`,
          );
        };
        for (let index = 0; index < 500; index++) {
          for (const [streamIndex, stream] of streams.entries()) {
            stream.latest = `${stream.marker}-${wave}-${index}`;
            stream.journal.publish({
              type: "operation",
              operation: {
                operationId: `${stream.marker}-${wave}-${index}`,
                value: "x".repeat(16 * 1024),
              },
            });
            observeBudget(stream, streamIndex);
          }
          if (index % 8 === 0) await nextTurn();
        }
        for (const [streamIndex, stream] of streams.entries()) {
          stream.latest = `final-${wave}-${stream.marker}`;
          stream.journal.publish({
            type: "operation",
            operation: {
              operationId: `final-${wave}-${stream.marker}`,
            },
          });
          observeBudget(stream, streamIndex);
        }
        if (soak) await delay(5_000);
        scopedSamples.push({
          wave,
          elapsedMs: Math.round(performance.now() - startedAt),
          slowReadBytes: [...slowReadBytes],
          slowResets: streams.map((stream) => stream.slowResets),
          heapUsedBytes: process.memoryUsage().heapUsed,
          peaks,
          journals: streams.map((stream) => stream.journal.snapshotMetrics()),
        });
      }
      if (soak)
        assert.ok(
          performance.now() - startedAt >= scopedRunMs,
          "Both scoped slow observers must stay connected through the sustained load",
        );
      const deadline = new AbortController();
      let results;
      try {
        results = await Promise.race([
          Promise.all(fastReads),
          delay(15_000, null, { signal: deadline.signal }).catch(() => null),
        ]);
      } finally {
        deadline.abort();
      }
      assert.deepEqual(
        results,
        [
          { complete: true, crossed: false },
          { complete: true, crossed: false },
        ],
        "Both authorized observers must receive only their own final View or event",
      );
      for (const [index, stream] of streams.entries()) {
        assert.ok(
          stream.slowResets > (soak ? 3 : 0),
          "Each slow observer must reset its own queue",
        );
        if (soak)
          assert.ok(
            slowReadBytes[index] > 1024 * 1024,
            "Each scoped slow observer must continue reading through the load",
          );
      }
      for (const request of slowRequests) request.destroy();
      for (
        let attempt = 0;
        attempt < 100 && streams.some((item) => item.releases < 2);
        attempt++
      )
        await delay(20);
      for (const stream of streams) {
        assert.equal(stream.releases, 2);
        assert.equal(stream.journal.snapshotMetrics().subscribers, 0);
        assert.equal(stream.journal.snapshotMetrics().queuedBytes, 0);
      }
      if (soak) {
        await delay(10_000);
        global.gc?.();
        const afterDisconnect = process.memoryUsage();
        assert.ok(
          afterDisconnect.heapUsed < baselineHeapBytes + 16 * 1024 * 1024,
          "Scoped streams retained excessive heap after both observers disconnected",
        );
        const evidencePath = fileURLToPath(
          new URL(
            "../../../artifacts/verification/agent-ui-sustained-sse/",
            import.meta.url,
          ),
        );
        await mkdir(evidencePath, { recursive: true });
        await writeFile(
          `${evidencePath}/metrics-scoped-soak.json`,
          JSON.stringify(
            {
              capturedAt: new Date().toISOString(),
              durationMs: Math.round(performance.now() - startedAt),
              publishedEventsPerScope: scopedWaves * 501,
              slowReadBytes,
              slowResets: streams.map((stream) => stream.slowResets),
              baselineHeapBytes,
              afterDisconnect: {
                heapUsedBytes: afterDisconnect.heapUsed,
                rssBytes: afterDisconnect.rss,
              },
              samples: scopedSamples,
            },
            null,
            2,
          ) + "\n",
        );
      }
    } finally {
      for (const timer of slowReadTimers) clearInterval(timer);
      for (const request of slowRequests) request.destroy();
      for (const response of slowResponses) response.destroy();
      for (const response of fastResponses)
        await response.body?.cancel().catch(() => {});
      for (const stream of streams) stream.journal.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { runBrowser } from "./c4-browser.mjs";

test("C4 entry retains page, response and business failures while joining browser cleanup", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ requests: [], pending: [], errors: [] }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const gateway = `http://127.0.0.1:${server.address().port}`;
  const pageError = new Error("original page failure"),
    responseError = new Error("original finite response failure"),
    businessError = new Error("original business failure");
  const page = new EventEmitter();
  const frame = {};
  let closed = false;
  page.mainFrame = () => frame;
  page.url = () => gateway + "/workspace/";
  page.setDefaultTimeout = () => {};
  page.isClosed = () => closed;
  page.goto = async () => {
    page.emit("pageerror", pageError);
    page.emit("websocket", {});
    page.emit("response", {
      url: () => gateway + "/api/app/workspace/v1/bootstrap",
      headers: () => ({ "content-type": "application/json" }),
      request: () => ({}),
      text: async () => {
        throw responseError;
      },
    });
    closed = true;
    throw businessError;
  };
  const cleanup = [];
  const cdp = new EventEmitter();
  let detached = false;
  cdp.send = async (method) => {
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { id: "main-frame" } } };
    if (method === "Performance.getMetrics")
      return {
        metrics: [
          { name: "Timestamp", value: (performance.now() + 100000) / 1000 },
        ],
      };
    return {};
  };
  cdp.detach = async () => {
    detached = true;
  };
  const context = {
    newPage: async () => page,
    newCDPSession: async () => cdp,
    close: async () => cleanup.push("context"),
  };
  page.context = () => context;
  const browser = {
    newContext: async () => context,
    close: async () => cleanup.push("browser"),
  };
  const report = { checks: [], sessions: {} };
  await assert.rejects(
    runBrowser(
      { gateway, model: gateway },
      { agentID: "c4-agent" },
      new AbortController().signal,
      "unused-output",
      report,
      async () => assert.fail("failed business cannot checkpoint success"),
      { launch: async () => browser },
    ),
    (error) => {
      assert(error instanceof AggregateError);
      const failures = new Set(error.errors);
      assert(failures.has(pageError), "original page error was omitted");
      assert(
        failures.has(responseError),
        "original response error was omitted",
      );
      assert(
        failures.has(businessError),
        "original business error was omitted",
      );
      assert(
        [...failures].some(
          (value) => value.message === "unexpected browser WebSocket",
        ),
        "unexpected WebSocket was omitted",
      );
      return true;
    },
  );
  assert.deepEqual(cleanup, ["context", "browser"]);
  assert.deepEqual(report.model, { requests: [], pending: [], errors: [] });
  assert.deepEqual(report.page_streams, []);
  assert.equal(detached, true);
  assert.equal(report.page_network_observations.length, 1);
  assert.equal(report.page_network_observations[0].clock_samples.length, 1);
});

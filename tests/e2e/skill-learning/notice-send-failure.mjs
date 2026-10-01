import { createServer } from "node:http";

import { LearningNoticePublisher } from "/app/dist/application/learning-notice-publisher.js";

// Test-only preload in the disposable ACP container. Fail the first committed
// learning notice at the SDK send boundary, after the change is durable.
const originalSubscribe = LearningNoticePublisher.prototype.subscribe;
let failures = 0;
LearningNoticePublisher.prototype.subscribe = function (binding, send, close) {
  return originalSubscribe.call(
    this,
    binding,
    (sessionId, item) => {
      if (failures === 0) {
        failures++;
        return Promise.reject(
          new Error("Injected SDK learning notice send failure"),
        );
      }
      return send(sessionId, item);
    },
    close,
  );
};

createServer((request, response) => {
  if (request.method !== "GET" || request.url !== "/status") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ failures }));
}).listen(18094, "127.0.0.1");

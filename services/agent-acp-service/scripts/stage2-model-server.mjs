import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const maximumBodyBytes = 1024 * 1024;
export function createModelFixture({ credential, controls = false }) {
  let expectedCredential = credential;
  let generation = 1;
  let holdNext = false;
  const pending = new Set();
  const requests = [];
  const attempts = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/status") {
      writeJson(response, 200, { status: "ready", completion_count: requests.length });
      return;
    }
    if (controls && request.method === "GET" && request.url === "/fixture/state") {
      writeJson(response, 200, { held: pending.size, requests, attempts });
      return;
    }
    if (controls && request.method === "POST" && request.url === "/fixture/control") {
      try {
        const command = JSON.parse(await readBody(request));
        if (typeof command.credential === "string" && command.credential.length > 0) {
          expectedCredential = command.credential;
          generation += 1;
        }
        if (command.hold_next === true) holdNext = true;
        if (command.release === true) for (const release of pending) release();
        writeJson(response, 200, { credential_generation: generation });
      } catch {
        writeJson(response, 400, { error: "invalid_control" });
      }
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    const authorized = request.headers.authorization === `Bearer ${expectedCredential}`;
    const attempt = {
      credential_generation: authorized ? generation : null,
      trace_id: validTraceparent(request.headers.traceparent)
        ? request.headers.traceparent.split("-")[1]
        : null,
      status: null,
    };
    attempts.push(attempt);
    response.once("finish", () => {
      attempt.status = response.statusCode;
    });
    response.once("close", () => {
      attempt.status ??= 499;
    });
    if (!authorized) {
      writeJson(response, 401, { error: "invalid_credential" });
      return;
    }
    if (!validTraceparent(request.headers.traceparent)) {
      writeJson(response, 400, { error: "missing_trace_context" });
      return;
    }

    try {
      const payload = JSON.parse(await readBody(request));
      if (!Array.isArray(payload.messages)) {
        throw new Error("messages must be an array");
      }
      const lastUser = payload.messages.findLastIndex((message) => message?.role === "user");
      const hasToolResult = payload.messages
        .slice(lastUser + 1)
        .some((message) => message?.role === "tool");
      requests.push({
        request_number: requests.length + 1,
        credential_generation: generation,
        trace_id: request.headers.traceparent.split("-")[1],
        has_tool_result: hasToolResult,
      });
      if (holdNext) {
        holdNext = false;
        await new Promise((resolve) => {
          const release = () => {
            pending.delete(release);
            response.off("close", release);
            resolve();
          };
          pending.add(release);
          response.once("close", release);
        });
        if (response.destroyed) return;
      }
      if (hasToolResult) {
        writeJson(response, 200, finalCompletion());
        return;
      }
      if (!advertisesWrite(payload.tools)) {
        throw new Error("Runtime write Tool was not advertised");
      }
      writeJson(response, 200, writeToolCompletion());
    } catch (error) {
      writeJson(response, 400, {
        error: error instanceof Error ? error.message : "invalid_request",
      });
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createModelFixture({
    credential: process.env.ANTNEST_STAGE2_MODEL_CREDENTIAL ?? "stage2-model-secret",
    controls: process.env.ANTNEST_STAGE2_MODEL_CONTROLS === "true",
  }).listen(Number(process.env.ANTNEST_STAGE2_MODEL_PORT ?? "8080"), "0.0.0.0");
}

function advertisesWrite(tools) {
  return advertisedToolNames(tools).includes("write");
}

function advertisedToolNames(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools
    .filter((tool) => tool?.type === "function" && typeof tool.function?.name === "string")
    .map((tool) => tool.function.name);
}

function writeToolCompletion() {
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "stage2-write-call",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({
                  path: { root: "workspace", path: "stage2-evidence.txt" },
                  content: "stage2-runtime-tool-ok",
                }),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 32, completion_tokens: 12 },
  };
}

function finalCompletion() {
  return {
    choices: [
      {
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: "Stage 2 Runtime Tool execution completed.",
        },
      },
    ],
    usage: { prompt_tokens: 48, completion_tokens: 9 },
  };
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBodyBytes) {
      throw new Error("request body is too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validTraceparent(value) {
  return typeof value === "string" && /^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$/u.test(value);
}

function writeJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

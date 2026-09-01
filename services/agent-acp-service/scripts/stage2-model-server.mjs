import { createServer } from "node:http";

const listenPort = Number(process.env.ANTNEST_STAGE2_MODEL_PORT ?? "8080");
const expectedCredential = process.env.ANTNEST_STAGE2_MODEL_CREDENTIAL ?? "stage2-model-secret";
const maximumBodyBytes = 1024 * 1024;
let completionCount = 0;

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/status") {
    writeJson(response, 200, { status: "ready", completion_count: completionCount });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    writeJson(response, 404, { error: "not_found" });
    return;
  }
  if (request.headers.authorization !== `Bearer ${expectedCredential}`) {
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
    completionCount += 1;
    console.log(
      JSON.stringify({
        event: "stage2_model_request",
        request_number: completionCount,
        has_trace_context: validTraceparent(request.headers.traceparent),
        has_tool_result: payload.messages.some((message) => message?.role === "tool"),
        tool_names: advertisedToolNames(payload.tools),
      }),
    );
    if (payload.messages.some((message) => message?.role === "tool")) {
      writeJson(response, 200, finalCompletion());
      return;
    }
    if (!advertisesWrite(payload.tools)) {
      throw new Error("Runtime write Tool was not advertised");
    }
    writeJson(response, 200, writeToolCompletion());
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "stage2_model_rejected",
        reason: error instanceof Error ? error.message : "invalid_request",
      }),
    );
    writeJson(response, 400, {
      error: error instanceof Error ? error.message : "invalid_request",
    });
  }
});

server.listen(listenPort, "0.0.0.0");

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

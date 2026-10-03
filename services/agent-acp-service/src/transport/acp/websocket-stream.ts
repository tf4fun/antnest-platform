import type * as acpV1 from "@agentclientprotocol/sdk";
import type * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import type WebSocket from "ws";
import type { RawData } from "ws";
import { strictJson } from "../../adapters/strict-json.js";

export function createAcpV1WebSocketStream(
  socket: WebSocket,
  authorized = () => true,
): acpV1.Stream {
  return createWebSocketJsonStream<acpV1.AnyMessage>(socket, authorized);
}

export function createAcpV2WebSocketWireStream(
  socket: WebSocket,
  authorized = () => true,
): acpV2.WireStream {
  return createWebSocketJsonStream<acpV2.AnyWireMessage>(socket, authorized);
}

function createWebSocketJsonStream<Message>(
  socket: WebSocket,
  authorized: () => boolean,
): {
  readable: ReadableStream<Message>;
  writable: WritableStream<Message>;
} {
  let readableController: ReadableStreamDefaultController<Message> | undefined;
  let closed = false;

  const readable = new ReadableStream<Message>({
    start(controller) {
      readableController = controller;
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          socket.close(1003, "ACP requires text JSON messages");
          return;
        }
        try {
          const message = strictJson(textFrame(data));
          if (
            !authorized() &&
            typeof message === "object" &&
            message !== null &&
            "method" in message
          ) {
            socket.close(1008, "caller_context_expired");
            return;
          }
          controller.enqueue(message as Message);
        } catch {
          sendParseError(socket);
        }
      });
      socket.once("close", () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      });
      socket.once("error", (error) => {
        if (!closed) {
          closed = true;
          controller.error(error);
        }
      });
    },
    cancel() {
      closed = true;
      socket.close(1000, "ACP stream closed");
    },
  });

  const writable = new WritableStream<Message>({
    write(message) {
      return new Promise<void>((resolve, reject) => {
        socket.send(JSON.stringify(message), (error) => {
          if (error == null) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
    close() {
      socket.close(1000, "ACP stream completed");
    },
    abort(reason) {
      if (!closed) {
        closed = true;
        readableController?.error(reason);
      }
      socket.close(1011, "ACP stream aborted");
    },
  });

  return { readable, writable };
}

function sendParseError(socket: WebSocket): void {
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    }),
    (error) => {
      if (error != null) {
        socket.close(1011, "ACP parse error response failed");
      }
    },
  );
}

function textFrame(data: RawData): Buffer {
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (Buffer.isBuffer(data)) {
    return data;
  }
  throw new TypeError("Unsupported WebSocket text frame");
}

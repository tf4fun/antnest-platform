import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type WebSocket from "ws";
import type { RawData } from "ws";

export function createAcpV2WebSocketWireStream(socket: WebSocket): acp.WireStream {
  let readableController: ReadableStreamDefaultController<acp.AnyWireMessage> | undefined;
  let closed = false;

  const readable = new ReadableStream<acp.AnyWireMessage>({
    start(controller) {
      readableController = controller;
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          socket.close(1003, "ACP requires text JSON messages");
          return;
        }
        try {
          controller.enqueue(JSON.parse(textFrame(data)) as acp.AnyWireMessage);
        } catch (error) {
          closed = true;
          controller.error(error);
          socket.close(1007, "Invalid JSON");
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

  const writable = new WritableStream<acp.AnyWireMessage>({
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

function textFrame(data: RawData): string {
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  throw new TypeError("Unsupported WebSocket text frame");
}

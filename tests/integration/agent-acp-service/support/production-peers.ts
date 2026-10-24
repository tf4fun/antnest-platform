import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { RunningAgentAcpService } from "../../../../services/agent-acp-service/src/composition.js";

export function serviceOrigin(
  service: RunningAgentAcpService,
  control = false,
): string {
  const address = control ? service.controlAddress() : service.address();
  if (address === null || typeof address === "string")
    throw new Error("ACP did not listen");
  return `http://127.0.0.1:${address.port}`;
}

export async function startPeer(
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
) {
  const pending = new Set<Promise<void>>();
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    const running = handle(request, response).catch((error: unknown) => {
      errors.push(error);
      response.destroy();
    });
    pending.add(running);
    void running.then(() => pending.delete(running));
  });
  server.requestTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Peer did not listen");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
        server.closeAllConnections();
      });
      await Promise.allSettled(pending);
      if (errors.length > 0)
        throw new AggregateError(errors, "Warm peer request failed");
    },
  };
}

export async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
    );
  return Buffer.concat(chunks);
}

export async function within<T>(
  promise: Promise<T>,
  label: string,
  budgetMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded its test budget`)),
          budgetMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

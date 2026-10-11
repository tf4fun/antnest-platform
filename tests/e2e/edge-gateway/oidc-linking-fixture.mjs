import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { createOIDCProvider } from "../identity-closeout/oidc-provider.mjs";
import { member } from "../workspace-closeout/c4-setup.mjs";

export const opaqueSubject = " <b>opaque subject 中文</b> ";

// One issuer is reachable by the real Identity container and Chromium. Only
// disposable IdP credentials live here; no Gateway/Identity API is intercepted.
export async function startLinkingProvider({
  directory,
  callback,
  signal,
  listenHost = "0.0.0.0",
}) {
  signal.throwIfAborted();
  let provider, closing;
  const sockets = new Set();
  const server = createServer(
    {
      key: readFileSync(join(directory, "key.pem")),
      cert: readFileSync(join(directory, "cert.pem")),
    },
    (request, response) => {
      if (provider && request.url?.startsWith("/linking/"))
        provider.handle(request, response);
      else response.writeHead(404).end();
    },
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const close = () => {
    signal.removeEventListener("abort", onAbort);
    closing ??= new Promise((resolve, reject) => {
      // HTTP connection bookkeeping excludes incomplete TLS handshakes.
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      server.close((error) =>
        error && error.code !== "ERR_SERVER_NOT_RUNNING"
          ? reject(error)
          : resolve(),
      );
    });
    return closing;
  };
  const onAbort = () => {
    void close().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    server.listen(0, listenHost);
    await once(server, "listening", { signal });
    signal.throwIfAborted();
    const issuer = `https://host.docker.internal:${server.address().port}/linking`;
    provider = createOIDCProvider({
      issuer,
      callback,
      additionalAccounts: {
        workspace: { sub: "workspace-subject", email: member.email },
        opaque: { sub: opaqueSubject },
      },
    });
    return { issuer, stats: provider.stats, close };
  } catch (error) {
    await close();
    throw error;
  }
}

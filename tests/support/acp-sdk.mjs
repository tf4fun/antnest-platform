import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(
  new URL("../../services/agent-acp-service/package.json", import.meta.url),
);

const PUBLIC_SPECIFIERS = {
  acp: "@agentclientprotocol/sdk/unstable",
  httpClient: "@agentclientprotocol/sdk/experimental/http-client",
  server: "@agentclientprotocol/sdk/experimental/server",
  node: "@agentclientprotocol/sdk/experimental/node",
};
const entry = (specifier) =>
  import(pathToFileURL(require.resolve(specifier)).href);

export const acp = await entry(PUBLIC_SPECIFIERS.acp);
export const { createHttpStream } = await entry(PUBLIC_SPECIFIERS.httpClient);
export const { AcpServer } = await entry(PUBLIC_SPECIFIERS.server);
export const { createNodeHttpHandler } = await entry(PUBLIC_SPECIFIERS.node);

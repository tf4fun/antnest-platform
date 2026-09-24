import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

type Route = { agentId: string; sessionId: string | null };
type Renderer = (output: ServerResponse, input: {
  bootstrap?: unknown;
  route: Route;
  nonce: string;
  script: string;
  stylesheet: string;
}) => Promise<void>;

export async function loadWorkspaceDocument(): Promise<{
  assetRoot: string;
  renderDocument(output: ServerResponse, input: {
    bootstrap?: unknown;
    route: Route;
    nonce: string;
  }): Promise<void>;
}> {
  const root = fileURLToPath(new URL("../../dist/client/assets/", import.meta.url));
  const manifestPath = fileURLToPath(new URL("../../dist/client/.vite/manifest.json", import.meta.url));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, {
    file: string;
    css?: string[];
  }>;
  const entry = manifest["src/entry-client.tsx"];
  if (!entry?.file || !entry.css?.[0]) throw new Error("Workspace client manifest is incomplete");
  const serverEntry = new URL("../../dist/ssr/entry-server.js", import.meta.url).href;
  const module = await import(serverEntry) as { renderWorkspaceDocument: Renderer };
  return {
    assetRoot: root,
    renderDocument: (output, input) => module.renderWorkspaceDocument(output, {
      ...input,
      script: `/workspace/${entry.file}`,
      stylesheet: `/workspace/${entry.css![0]}`,
    }),
  };
}

import { PassThrough, type Writable } from "node:stream";
import { renderToPipeableStream } from "react-dom/server";
import BridgeApp from "./BridgeApp";
import type { WorkspaceRoute } from "./lib/navigation";

export type WorkspaceDocumentInput = {
  bootstrap?: unknown;
  route: WorkspaceRoute;
  nonce: string;
  script: string;
  stylesheet: string;
};

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function escapeAttribute(value: string): string {
  return value.replace(/[&"'<>]/g, (character) => ({
    "&": "&amp;", '"': "&quot;", "'": "&#39;", "<": "&lt;", ">": "&gt;",
  })[character]!);
}

export function renderWorkspaceDocument(output: Writable, input: WorkspaceDocumentInput): Promise<void> {
  return new Promise((resolve, reject) => {
    let started = false;
    let cancelled = false;
    const nonce = escapeAttribute(input.nonce);
    const script = escapeAttribute(input.script);
    const stylesheet = escapeAttribute(input.stylesheet);
    const head = `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><meta name="theme-color" content="#f7f7f5"/><title>Antnest Workspace</title><link rel="stylesheet" href="${stylesheet}"/></head><body>`;
    const tail = (bootstrap: unknown) => `<script id="workspace-bootstrap" type="application/json" nonce="${nonce}">${safeJson({ bootstrap, route: input.route })}</script><script type="module" src="${script}" nonce="${nonce}"></script></body></html>`;
    const stream = renderToPipeableStream(
      <BridgeApp initialBootstrap={input.bootstrap} initialRoute={input.route} />,
      {
        nonce: input.nonce,
        onShellReady() {
          if (cancelled) return;
          started = true;
          output.write(`${head}<div id="root">`);
          const body = new PassThrough();
          body.on("error", reject);
          output.on("error", reject);
          body.on("end", () => {
            if (!cancelled) output.end(`</div>${tail(input.bootstrap ?? null)}`);
          });
          output.once("finish", resolve);
          body.pipe(output, { end: false });
          stream.pipe(body);
        },
        onShellError() {
          if (started || cancelled) return;
          started = true;
          output.once("finish", resolve);
          output.end(`${head}<div id="root" data-ssr="fallback"><main class="loading-page"><span class="loading-mark" aria-hidden="true"></span><p role="status">Opening workspace</p></main></div>${tail(null)}`);
        },
        onError(error) {
          if (!cancelled)
            console.error("Workspace SSR render failed", error instanceof Error ? error.name : "unknown");
        },
      },
    );
    output.once("close", () => {
      if (output.writableFinished) return;
      cancelled = true;
      stream.abort();
      resolve();
    });
  });
}

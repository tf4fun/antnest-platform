import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadWorkspaceDocument } from "../../../services/agent-ui/web/server/dist/ssr-assets.js";
import { createTestWorkspaceHttpServer, testHeaders } from "./auth-fixture.mjs";
import { verifyExternalIdentitiesBrowser } from "../../support/agent-ui/external-identities-browser.mjs";

test(
  "Workspace external identities and notices use the validated shell on desktop and mobile",
  { timeout: 90_000 },
  async (context) => {
    const server = createTestWorkspaceHttpServer(
      {
        async handle(request) {
          if (
            new URL(request.url).pathname !== "/api/app/workspace/v1/bootstrap"
          )
            return null;
          return Response.json({
            principal: {
              userId: "user-1",
              organizationId: "org-1",
              organizationSlug: "engineering",
              organizationName: "Engineering",
              administrator: false,
            },
            agents: [],
            renderedAt: new Date().toISOString(),
            bridgeEpoch: "external-identities-epoch",
          });
        },
      },
      await loadWorkspaceDocument(),
    );
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      await verifyExternalIdentitiesBrowser({
        base: `http://127.0.0.1:${server.address().port}`,
        signal: context.signal,
        headersForRequest: testHeaders,
        output: fileURLToPath(
          new URL(
            "../../../artifacts/verification/issue-61/agent-ui-browser/external/",
            import.meta.url,
          ),
        ),
      });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
